import { asRecord } from "../core/canonical.ts";
import { CapsuleError } from "../core/errors.ts";
import type { EffectName, Manifest } from "../format/manifest.ts";
import {
  confusableSkeleton,
  sanitizeModelText,
  sanitizeValue,
  scanTextTree,
  stringLeaves,
} from "../security/text.ts";

/**
 * A tool as an agent sees it: every piece of prose already sanitised, the declared effects attached
 * so a client can show what a call may do, and the ui resource — when the tool declares one — in
 * `_meta` where the MCP revision puts server extensions.
 */
export type CatalogTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  effects: EffectName[];
  _meta?: { ui: { resourceUri: string } };
};

export type CatalogResource = { uri: string; name: string; mimeType: string };

/**
 * Two names that a human reads as one are a phishing vector inside the tool list itself, so a
 * capsule that carries such a pair does not get served at all: suppressing one of the two would
 * make which one wins depend on manifest order. Task 20's built-ins go through the same check,
 * which is why this takes names rather than a manifest.
 */
export function assertNoToolNameCollision(names: readonly string[]): void {
  const seen = new Map<string, string>();
  for (const name of names) {
    const skeleton = confusableSkeleton(name);
    const first = seen.get(skeleton);
    if (first !== undefined) {
      throw new CapsuleError("E_CONTENT", `tool name collision: ${first} ~ ${name}`, { first, name });
    }
    seen.set(skeleton, name);
  }
}

/**
 * The keywords a JSON Schema validator matches *literally* against an argument. The guest's own
 * validator runs on the raw schema out of the signed manifest, so anything served here that differs
 * from the raw bytes is a contract the model is asked to satisfy and the guest then rejects: a
 * cleaned `enum` advertises a value that fails validation, and a cleaned `required` entry demands a
 * property whose key — keys are never rewritten — the schema does not declare.
 */
const LITERAL_KEYWORDS = new Set(["required", "enum", "const", "pattern"]);

/** Keywords whose value maps a *name* to a subschema, so its keys are names, not keywords. */
const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions"]);

/**
 * The identifiers of a JSON Schema: every object key at every depth, plus every string inside a
 * literally matched keyword (`required` names properties, `enum`/`const`/`pattern` name accepted
 * values). Those are the parts of a schema that cannot be cleaned — see `LITERAL_KEYWORDS` — so an
 * identifier carrying hidden text is answered by suppressing the whole tool instead, and the
 * identifiers of a tool that *is* served are already their own sanitised form, which is what makes
 * serving them verbatim safe.
 *
 * The offending identifier is deliberately not reported: it holds the escape sequences this exists to
 * catch, and the warning is written to somebody's terminal.
 */
function hasUnsafeIdentifier(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(hasUnsafeIdentifier);
  }
  const record = asRecord(value);
  if (record === undefined) {
    return false;
  }
  for (const [key, v] of Object.entries(record)) {
    if (key !== sanitizeModelText(key)) {
      return true;
    }
    const unsafe = LITERAL_KEYWORDS.has(key)
      ? stringLeaves(v).some((leaf) => leaf !== sanitizeModelText(leaf))
      : hasUnsafeIdentifier(v);
    if (unsafe) {
      return true;
    }
  }
  return false;
}

/**
 * A schema with its prose cleaned and its literally matched slots left exactly as the manifest wrote
 * them: `title`, `description` and every other string are model-facing text and go through
 * `sanitizeModelText`; the value of a `LITERAL_KEYWORDS` keyword is copied through untouched.
 *
 * `keysAreNames` is what keeps the two apart inside a `SCHEMA_MAPS` value: a property may legitimately
 * be *called* `enum`, and its subschema's prose still has to be cleaned.
 */
function sanitizeSchemaProse(value: unknown, keysAreNames = false): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSchemaProse(item));
  }
  const record = asRecord(value);
  if (record === undefined) {
    return sanitizeValue(value);
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, v]) =>
      !keysAreNames && LITERAL_KEYWORDS.has(key)
        ? [key, v]
        : [key, sanitizeSchemaProse(v, !keysAreNames && SCHEMA_MAPS.has(key))],
    ),
  );
}

/**
 * The tool list, sanitised, screened and sorted by name — the sort is what lets a client cache the
 * list and a prompt cache hit, since the same capsule must always produce the same bytes.
 */
export function buildToolList(
  manifest: Manifest,
  opts: { allowSuspicious: boolean; warn: (line: string) => void },
): CatalogTool[] {
  const tools: CatalogTool[] = [];

  for (const tool of manifest.tools) {
    const title = sanitizeModelText(tool.title);
    const description = sanitizeModelText(tool.description);
    const inputSchema = sanitizeSchemaProse(tool.inputSchema) as Record<string, unknown>;
    const outputSchema =
      tool.outputSchema === undefined
        ? undefined
        : (sanitizeSchemaProse(tool.outputSchema) as Record<string, unknown>);

    // Screened after sanitising, because what reaches the model is the sanitised text: a marker that
    // only survives in the raw string is not a marker the model would ever have seen. Schema keys are
    // part of that text — `scanTextTree` walks them — but identifiers are screened on the *raw*
    // schema, since they are served verbatim and so sanitising is what a clean one has to survive.
    const markers = scanTextTree([title, description, inputSchema, outputSchema]);
    if (hasUnsafeIdentifier(tool.inputSchema) || hasUnsafeIdentifier(tool.outputSchema)) {
      markers.push("unsafe_schema_identifier");
      markers.sort();
    }
    if (markers.length > 0 && !opts.allowSuspicious) {
      // The name is safe to interpolate: capsule.json restricts it to `[a-zA-Z0-9_-]{1,64}`.
      opts.warn(`suppressed tool ${tool.name}: markers=${markers.join(",")}`);
      continue;
    }

    tools.push({
      name: tool.name,
      title,
      description,
      inputSchema,
      ...(outputSchema === undefined ? {} : { outputSchema }),
      effects: [...tool.effects],
      ...(tool.ui === undefined ? {} : { _meta: { ui: { resourceUri: tool.ui } } }),
    });
  }

  return tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Manifest order is kept: it is fixed by the signed statement, so it is already deterministic. */
export function listResources(manifest: Manifest): CatalogResource[] {
  return manifest.resources.map((resource) => ({
    uri: resource.uri,
    name: sanitizeModelText(resource.name),
    mimeType: resource.mimeType,
  }));
}

/** `text` for text/* and JSON, base64 `blob` for everything else. */
export function isTextMimeType(mimeType: string): boolean {
  const type = (mimeType.split(";")[0] ?? "").trim().toLowerCase();
  return type.startsWith("text/") || type === "application/json";
}
