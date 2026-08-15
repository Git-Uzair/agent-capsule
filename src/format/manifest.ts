import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SchemaObject } from "ajv/dist/2020.js";
import { CapsuleError } from "../core/errors.ts";
import { newValidator } from "../core/schema.ts";

export type EffectName =
  | "clock.now"
  | "random.bytes"
  | "sql.query"
  | "sql.exec"
  | "kv.get"
  | "kv.set"
  | "net.fetch"
  | "log.write"
  | "pack.write";

export type ManifestMeta = {
  name: string;
  version: string;
  title: string;
  description: string;
  author?: { name?: string; key_id?: string };
};

export type ManifestRuntime = {
  type: "quickjs-1";
  entry: string;
  memory_limit_mb: number;
  timeout_ms: number;
  determinism: "strict";
};

export type ManifestCapabilities = {
  sql: boolean;
  kv: boolean;
  pack: boolean;
  net: { allowed_hosts: string[]; allow_localhost: boolean };
};

export type ManifestTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  effects: EffectName[];
  ui?: string;
};

export type ManifestResource = { uri: string; name: string; mimeType: string; path: string };

export type ManifestCsp = {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
};

export type ManifestUi = {
  app?: { resourceUri: string; path: string; csp?: ManifestCsp };
  local?: { path: string };
};

export type Manifest = {
  spec_version: "0.1.0";
  meta: ManifestMeta;
  runtime: ManifestRuntime;
  capabilities: ManifestCapabilities;
  tools: ManifestTool[];
  resources: ManifestResource[];
  ui?: ManifestUi;
};

const SCHEMA_PATH = join(import.meta.dirname, "..", "..", "schema", "capsule-0.1.schema.json");
const SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as SchemaObject;

const ajv = newValidator();
const validate = ajv.compile<Manifest>(SCHEMA);

/** Effects that are only legal when the matching capability flag is on. Shared with the policy
 * engine, which re-checks it at call time: two copies of this table could drift apart. */
export const EFFECT_CAPABILITY: Partial<Record<EffectName, "sql" | "kv" | "pack">> = {
  "sql.query": "sql",
  "sql.exec": "sql",
  "kv.get": "kv",
  "kv.set": "kv",
  "pack.write": "pack",
};

function fail(message: string, detail: Record<string, unknown> = {}): never {
  throw new CapsuleError("E_MANIFEST", message, detail);
}

function assertValid(valid: boolean): void {
  if (!valid) {
    fail(`invalid capsule.json: ${ajv.errorsText(validate.errors)}`, { errors: validate.errors ?? [] });
  }
}

function toData(input: string | object): unknown {
  try {
    return typeof input === "string" ? JSON.parse(input) : structuredClone(input);
  } catch (err) {
    return fail(`invalid capsule.json: ${(err as Error).message}`);
  }
}

/**
 * `useDefaults` only fills properties of objects that are present, so absent parent
 * objects are materialised here and the validator is run a second time to fill their
 * nested defaults (and to re-check whatever was inserted).
 */
function fillParents(data: Record<string, unknown>): void {
  data.capabilities ??= {};
  const capabilities = data.capabilities as Record<string, unknown>;
  capabilities.net ??= {};
  data.resources ??= [];
}

function assertNoTraversal(paths: string[]): void {
  for (const path of paths) {
    if (path.split("/").includes("..")) fail(`path must not contain '..': ${path}`, { path });
  }
}

function assertSemantics(m: Manifest): void {
  const seen = new Set<string>();
  for (const tool of m.tools) {
    if (seen.has(tool.name)) fail(`duplicate tool name: ${tool.name}`, { tool: tool.name });
    seen.add(tool.name);

    for (const effect of tool.effects) {
      const capability = EFFECT_CAPABILITY[effect];
      if (capability !== undefined && !m.capabilities[capability]) {
        fail(`tool ${tool.name} requests ${effect} but capabilities.${capability} is false`, {
          tool: tool.name,
          effect,
        });
      }
      if (
        effect === "net.fetch" &&
        m.capabilities.net.allowed_hosts.length === 0 &&
        !m.capabilities.net.allow_localhost
      ) {
        fail(`tool ${tool.name} requests net.fetch but capabilities.net.allowed_hosts is empty`, {
          tool: tool.name,
        });
      }
    }

    if (tool.ui !== undefined && tool.ui !== m.ui?.app?.resourceUri) {
      fail(
        `tool ${tool.name} references ${tool.ui} but ui.app.resourceUri is ${m.ui?.app?.resourceUri ?? "absent"}`,
        { tool: tool.name, ui: tool.ui },
      );
    }
  }

  assertNoTraversal([
    m.runtime.entry,
    ...m.resources.map((r) => r.path),
    ...(m.ui?.app?.path === undefined ? [] : [m.ui.app.path]),
    ...(m.ui?.local?.path === undefined ? [] : [m.ui.local.path]),
  ]);
}

export function parseManifest(input: string | object): Manifest {
  const data = toData(input);
  assertValid(validate(data));
  const filled = data as Record<string, unknown>;
  fillParents(filled);
  assertValid(validate(filled));
  const manifest = filled as unknown as Manifest;
  assertSemantics(manifest);
  return manifest;
}
