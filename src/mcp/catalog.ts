import { asRecord } from "../core/canonical.ts";
import { CapsuleError } from "../core/errors.ts";
import type { EffectName, Manifest } from "../format/manifest.ts";
import { confusableSkeleton, sanitizeModelText, sanitizeValue, scanTextTree } from "../security/text.ts";

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
 * The identifiers of a JSON Schema: every object key, plus every entry of a `required` array, since
 * those name properties too. Identifiers are the one part of a schema that cannot be cleaned —
 * rewriting one would ask the model for a field the guest never reads, and rewriting a `required`
 * entry without its key would leave the schema demanding a property that `properties` does not
 * declare. So an identifier carrying hidden text is answered by suppressing the whole tool instead,
 * and the identifiers of a tool that *is* served are already their own sanitised form, which is what
 * makes cleaning the schema unable to break the two apart.
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
  const required = record["required"];
  if (Array.isArray(required)) {
    if (required.some((name) => typeof name === "string" && name !== sanitizeModelText(name))) {
      return true;
    }
  }
  return Object.entries(record).some(([key, v]) => key !== sanitizeModelText(key) || hasUnsafeIdentifier(v));
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
    const inputSchema = sanitizeValue(tool.inputSchema) as Record<string, unknown>;
    const outputSchema =
      tool.outputSchema === undefined
        ? undefined
        : (sanitizeValue(tool.outputSchema) as Record<string, unknown>);

    // Screened after sanitising, because what reaches the model is the sanitised text: a marker that
    // only survives in the raw string is not a marker the model would ever have seen. Schema keys are
    // part of that text — `scanTextTree` walks them — but they are screened on the *raw* schema,
    // since sanitising is what a clean identifier has to survive unchanged.
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
