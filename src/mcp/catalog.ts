import { asRecord } from "../core/canonical.ts";
import { CapsuleError } from "../core/errors.ts";
import type { EffectName, Manifest } from "../format/manifest.ts";
import { confusableSkeleton, sanitizeModelText, scanTextTree } from "../security/text.ts";

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
 * Sanitises every string *value* in a JSON Schema, at any depth. Property names are deliberately
 * left alone: they are the argument names the model has to send back, so rewriting one would ask
 * the model for a field the guest never reads.
 */
function sanitizeSchemaLeaves(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizeModelText(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeSchemaLeaves);
  }
  const record = asRecord(value);
  if (record === undefined) {
    return value;
  }
  return Object.fromEntries(Object.entries(record).map(([key, v]) => [key, sanitizeSchemaLeaves(v)]));
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
    const inputSchema = sanitizeSchemaLeaves(tool.inputSchema) as Record<string, unknown>;
    const outputSchema =
      tool.outputSchema === undefined
        ? undefined
        : (sanitizeSchemaLeaves(tool.outputSchema) as Record<string, unknown>);

    // Screened after sanitising, because what reaches the model is the sanitised text: a marker that
    // only survives in the raw string is not a marker the model would ever have seen.
    const markers = scanTextTree([title, description, inputSchema, outputSchema]);
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
