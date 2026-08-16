import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConformanceReport, ConformanceResult } from "../../conformance/checks.ts";
import { runConformance } from "../../conformance/run.ts";
import { asRecord } from "../../core/canonical.ts";
import { CapsuleError } from "../../core/errors.ts";
import { loadCapsule, packDirectory, type LoadedCapsule, type PackResult } from "../../format/capsule.ts";
import { parseManifest, type EffectName, type Manifest, type ManifestTool } from "../../format/manifest.ts";
import { capsuleHome } from "../../security/signing.ts";
import { JSON_RPC_ERROR, RpcFailure } from "../transport.ts";
import { loadInstalledStore, type InstalledEntry } from "./registry.ts";
import {
  installLoadedCapsule,
  loadRefusal,
  screenManifest,
  type ToolExecutionResult,
} from "./tools.ts";

/** Maximum allowed payload size for conversational authoring workspace (5 MB). */
export const MAX_WORKSPACE_PAYLOAD_BYTES = 5 * 1024 * 1024;

/** The `runtime.timeout_ms` an authored capsule gets. The plan's ceiling, and the tool takes no
 * timeout from the caller, so no authored capsule can ask for longer than this. */
export const MAX_AUTHORING_TIMEOUT_MS = 30_000;

export function workspacesDir(homeDir: string = capsuleHome()): string {
  return join(homeDir, "workspaces");
}

export function workspaceDir(name: string, homeDir: string = capsuleHome()): string {
  return join(workspacesDir(homeDir), name);
}

export function bumpPatchVersion(version: string): string {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!match) return "0.1.1";
  const major = parseInt(match[1]!, 10);
  const minor = parseInt(match[2]!, 10);
  const patch = parseInt(match[3]!, 10) + 1;
  return `${major}.${minor}.${patch}`;
}

export type ManagerAuthoringOptions = {
  homeDir?: string;
  warn: (line: string) => void;
  notifyListChanged: () => void;
  invalidateCache: () => void;
  servedTools: (capsuleId: string) => Promise<string[]>;
};

/**
 * The capsule name alphabet this tool accepts: the schema's `meta.name` pattern minus `.`, which is
 * also the gateway namespace alphabet. Checked here rather than left to `parseManifest`, because the
 * name becomes a directory under `workspaces/` before any manifest is parsed.
 */
const AUTHORED_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export async function handleCapsuleCreate(
  rawArgs: unknown,
  opts: ManagerAuthoringOptions,
): Promise<ToolExecutionResult> {
  return executeAuthoringPipeline(rawArgs, opts, false);
}

export async function handleCapsuleUpdate(
  rawArgs: unknown,
  opts: ManagerAuthoringOptions,
): Promise<ToolExecutionResult> {
  return executeAuthoringPipeline(rawArgs, opts, true);
}

async function executeAuthoringPipeline(
  rawArgs: unknown,
  opts: ManagerAuthoringOptions,
  isUpdate: boolean,
): Promise<ToolExecutionResult> {
  const args = asRecord(rawArgs) ?? {};
  const home = opts.homeDir ?? capsuleHome();
  const store = loadInstalledStore(opts.homeDir);

  let name = typeof args["name"] === "string" ? args["name"].trim() : "";
  const capsuleId = typeof args["capsuleId"] === "string" ? args["capsuleId"].trim() : undefined;

  // The entry this pipeline may consult for the version to bump. Only ever an entry whose own name
  // is the name being built, so the bump cannot be read off a capsule that is not being rebuilt.
  // `capsule_create` takes no `capsuleId` at all, so this is `capsule_update`'s question alone.
  let existingEntry: InstalledEntry | undefined;

  if (isUpdate) {
    if (!name && !capsuleId) {
      throw new RpcFailure(
        JSON_RPC_ERROR.InvalidParams,
        "capsule_update requires either 'name' or 'capsuleId'",
      );
    }

    const addressed = capsuleId ? store.capsules[capsuleId] : undefined;

    // Two ways of naming one capsule, so they have to name the same one. Refused rather than
    // resolved: with a disagreeing pair, either answer rebuilds and installs a capsule the caller
    // did not address while the one it did address is left untouched — and the patch bump would come
    // from the version of the capsule that is not being built. Same refusal `capsule_install` makes
    // for `path` + `from_downloads`: the caller re-sends the one it meant.
    if (capsuleId && name && addressed?.name !== name) {
      throw new RpcFailure(
        JSON_RPC_ERROR.InvalidParams,
        `capsule_update was given capsuleId '${capsuleId}' (` +
          (addressed === undefined ? "not installed" : `capsule '${addressed.name}'`) +
          `) and name '${name}', which address different capsules: send one or the other`,
      );
    }

    if (!name && addressed) name = addressed.name;
    existingEntry = addressed ?? Object.values(store.capsules).find((e) => e.name === name);

    if (!existingEntry) {
      // Check if a workspace already exists by name
      const ws = workspaceDir(name, home);
      if (!existsSync(join(ws, "capsule.json"))) {
        const text = `No installed capsule or workspace found for '${capsuleId || name}'.`;
        return { text, structured: { ok: false, error: "E_USAGE", message: text }, isError: true };
      }
    }
  }

  // 1. Guardrail: Capsule Name validation
  if (!name) {
    throw new RpcFailure(JSON_RPC_ERROR.InvalidParams, "capsule_create requires 'name'");
  }

  if (!AUTHORED_NAME_PATTERN.test(name)) {
    const text =
      `Invalid capsule name '${name}': must match ^[a-z0-9][a-z0-9_-]{0,63}$ ` +
      `(lowercase alphanumeric, underscores, hyphens, 1-64 characters).`;
    return { text, structured: { ok: false, error: "E_CONTENT", message: text }, isError: true };
  }

  const ws = workspaceDir(name, home);
  let existingManifest: Manifest | undefined;
  if (existsSync(join(ws, "capsule.json"))) {
    try {
      existingManifest = parseManifest(readFileSync(join(ws, "capsule.json"), "utf8"));
    } catch {
      // Ignore if unparseable
    }
  }

  // Version resolution
  let version = typeof args["version"] === "string" ? args["version"].trim() : undefined;
  if (!version) {
    if (isUpdate) {
      // The bump counts from what is *installed*, and only falls back to the workspace when nothing
      // is: the workspace may hold a draft that was refused and never shipped, and a refused attempt
      // must not consume a version number the user never saw.
      const currentVer = existingEntry?.version ?? existingManifest?.meta.version ?? "0.1.0";
      version = bumpPatchVersion(currentVer);
    } else {
      version = "0.1.0";
    }
  }

  const title =
    typeof args["title"] === "string" && args["title"].trim()
      ? args["title"].trim()
      : existingManifest?.meta.title ?? name;

  const description =
    typeof args["description"] === "string" && args["description"].trim()
      ? args["description"].trim()
      : existingManifest?.meta.description ?? title;

  // Source code resolution
  let source = typeof args["source"] === "string" ? args["source"] : undefined;
  if (source === undefined && isUpdate && existsSync(join(ws, "src", "main.js"))) {
    source = readFileSync(join(ws, "src", "main.js"), "utf8");
  }

  if (source === undefined || source.trim() === "") {
    const text = `Guest JavaScript source code is required (${isUpdate ? "capsule_update" : "capsule_create"}).`;
    return { text, structured: { ok: false, error: "E_USAGE", message: text }, isError: true };
  }

  const sourceBytes = Buffer.byteLength(source, "utf8");
  if (sourceBytes > MAX_WORKSPACE_PAYLOAD_BYTES) {
    const text = `Source code size (${Math.round(sourceBytes / 1024)} KB) exceeds 5 MB limit.`;
    return { text, structured: { ok: false, error: "E_USAGE", message: text }, isError: true };
  }

  // UI HTML resolution
  let uiHtml = typeof args["ui_html"] === "string" ? args["ui_html"] : undefined;
  if (uiHtml === undefined && isUpdate && existsSync(join(ws, "ui", "index.html"))) {
    uiHtml = readFileSync(join(ws, "ui", "index.html"), "utf8");
  }

  // Tools array resolution
  const rawTools = args["tools"] ?? existingManifest?.tools;
  if (!Array.isArray(rawTools) || rawTools.length === 0) {
    const text = "Capsule must declare a non-empty array of tools.";
    return { text, structured: { ok: false, error: "E_USAGE", message: text }, isError: true };
  }

  const tools: ManifestTool[] = [];

  // Only the shape the assembly below dereferences is checked here. Everything a manifest may not
  // say — an illegal or reserved or repeated tool name, an unknown effect, an `inputSchema` that is
  // not an object schema — is `parseManifest`'s single answer below, so this tool cannot drift from
  // the schema by holding a second copy of it.
  for (let i = 0; i < rawTools.length; i++) {
    const t = asRecord(rawTools[i]);
    if (!t) {
      const text = `Tool at index ${i} is malformed: expected object.`;
      return { text, structured: { ok: false, error: "E_USAGE", message: text }, isError: true };
    }
    const tName = typeof t["name"] === "string" ? t["name"].trim() : "";
    const rawEffects = Array.isArray(t["effects"]) ? t["effects"] : [];
    const tTitle =
      typeof t["title"] === "string" && t["title"].trim() ? t["title"].trim() : tName;
    const tDesc =
      typeof t["description"] === "string" && t["description"].trim()
        ? t["description"].trim()
        : tTitle;
    const tInputSchema = asRecord(t["inputSchema"]) ?? { type: "object" };
    const tOutputSchema = asRecord(t["outputSchema"]);

    tools.push({
      name: tName,
      title: tTitle,
      description: tDesc,
      inputSchema: tInputSchema,
      ...(tOutputSchema ? { outputSchema: tOutputSchema } : {}),
      effects: rawEffects as EffectName[],
      ...(uiHtml !== undefined ? { ui: `ui://${name}` } : {}),
    });
  }

  // 2. Guardrail: Capabilities and Network Egress
  const explicitCaps = asRecord(args["capabilities"]);
  const rawCaps = explicitCaps ?? existingManifest?.capabilities;
  const sqlCap =
    rawCaps?.["sql"] === true || tools.some((t) => t.effects.some((e) => e.startsWith("sql.")));
  const kvCap =
    rawCaps?.["kv"] === true || tools.some((t) => t.effects.some((e) => e.startsWith("kv.")));
  const packCap =
    rawCaps?.["pack"] === true || tools.some((t) => t.effects.includes("pack.write"));

  // The hosts the caller listed, verbatim — this tool never invents a host or widens one to a
  // wildcard (§6-6). Their shape is `parseManifest`'s business: it owns the host pattern, and it is
  // also what refuses a tool that declares `net.fetch` with no host to fetch from.
  const allowedHosts: unknown =
    explicitCaps?.["net"] === undefined
      ? existingManifest?.capabilities.net.allowed_hosts ?? []
      : asRecord(explicitCaps["net"])?.["allowed_hosts"] ?? [];

  // Build manifest object
  const manifestObj: Record<string, unknown> = {
    spec_version: "0.1.0",
    meta: {
      name,
      version,
      title,
      description,
    },
    runtime: {
      type: "quickjs-1",
      entry: "src/main.js",
      memory_limit_mb: 64,
      timeout_ms: MAX_AUTHORING_TIMEOUT_MS,
      determinism: "strict",
    },
    capabilities: {
      sql: sqlCap,
      kv: kvCap,
      pack: packCap,
      net: {
        allowed_hosts: allowedHosts,
        allow_localhost: false,
      },
    },
    tools,
    resources: [],
    ...(uiHtml !== undefined
      ? {
          ui: {
            app: {
              resourceUri: `ui://${name}`,
              path: "ui/index.html",
            },
          },
        }
      : {}),
  };

  // The one manifest gate: the schema and its semantics, in the one place this project keeps them.
  const toolName = isUpdate ? "capsule_update" : "capsule_create";
  const allowSuspicious = args["allow_suspicious"] === true;
  let manifest: Manifest;
  try {
    manifest = parseManifest(manifestObj);
  } catch (err) {
    const detail = err instanceof CapsuleError ? `${err.code}: ${err.message}` : String(err);
    const text = `Manifest validation failed: ${detail}`;
    return {
      text,
      structured: { ok: false, error: err instanceof CapsuleError ? err.code : "E_MANIFEST", message: text },
      isError: true,
    };
  }

  // Screened here, on the manifest that was just assembled, and not one step later: a refusal after
  // the capsule is signed and loaded would already have pinned this name's key and tool catalog, so
  // the corrected draft — the flagged description removed — would come back as tool-catalog drift and
  // the agent would have no way to clear the finding. Nothing is written, packed or pinned until this
  // returns clean. `installLoadedCapsule` runs the same screen on the verified manifest.
  const refusal = screenManifest(manifest, {
    allowSuspicious,
    retry: `${toolName} with { allow_suspicious: true }`,
  });
  if (refusal !== undefined) return refusal;

  // Total workspace payload size check
  const totalPayloadSize =
    sourceBytes +
    Buffer.byteLength(JSON.stringify(manifestObj), "utf8") +
    (uiHtml ? Buffer.byteLength(uiHtml, "utf8") : 0);

  if (totalPayloadSize > MAX_WORKSPACE_PAYLOAD_BYTES) {
    const text = `Total workspace payload size (${Math.round(totalPayloadSize / 1024)} KB) exceeds the 5 MB limit.`;
    return { text, structured: { ok: false, error: "E_USAGE", message: text }, isError: true };
  }

  // Scaffold workspace files
  mkdirSync(join(ws, "src"), { recursive: true });
  if (uiHtml !== undefined) {
    mkdirSync(join(ws, "ui"), { recursive: true });
    writeFileSync(join(ws, "ui", "index.html"), uiHtml, "utf8");
  }
  writeFileSync(join(ws, "src", "main.js"), source, "utf8");
  writeFileSync(join(ws, "capsule.json"), JSON.stringify(manifestObj, null, 2) + "\n", "utf8");

  // Pack directory to capsule file
  const tmpCapsuleOut = join(ws, `${name}-${version}.capsule`);
  let packRes: PackResult;
  try {
    packRes = await packDirectory(ws, tmpCapsuleOut, { homeDir: opts.homeDir });
  } catch (err) {
    const detail = err instanceof CapsuleError ? `${err.code}: ${err.message}` : String(err);
    const text = `Failed to pack capsule: ${detail}`;
    return {
      text,
      structured: { ok: false, error: err instanceof CapsuleError ? err.code : "E_CONTAINER", message: text },
      isError: true,
    };
  }

  // Run the conformance suite. It examines the file without pinning it (`trust: false` inside), which
  // is what lets a capsule be judged before this host commits to its identity.
  let report: ConformanceReport;
  try {
    report = await runConformance(packRes.file, { homeDir: opts.homeDir });
  } catch (err) {
    const detail = err instanceof CapsuleError ? `${err.code}: ${err.message}` : String(err);
    const text = `Conformance suite execution failed: ${detail}`;
    return { text, structured: { ok: false, error: "E_CONFORMANCE", message: text }, isError: true };
  }

  if (!report.ok) {
    const failedVectors: ConformanceResult[] = report.results.filter((r: ConformanceResult) => r.status === "fail");
    const failureSummary = failedVectors.map((f: ConformanceResult) => `[${f.id}] ${f.title}: ${f.detail}`).join("; ");
    try {
      if (existsSync(packRes.file)) unlinkSync(packRes.file);
    } catch {}
    const text =
      `Conformance check failed for capsule '${name}':\n` +
      failedVectors.map((f: ConformanceResult) => `• [${f.id}] ${f.title}: ${f.detail}`).join("\n");
    return {
      text,
      structured: {
        ok: false,
        error: "E_CONFORMANCE",
        message: `Conformance check failed: ${failureSummary}`,
        failures: failedVectors.map((f: ConformanceResult) => ({ id: f.id, title: f.title, detail: f.detail })),
      },
      isError: true,
    };
  }

  // Verified with the trust store live, and last: this is the step that pins, so by the time it runs
  // every refusal this tool can make has already been made. Drift is the same decision here as it is
  // for a downloaded capsule — a named `accept_drift`, never implied by the fact that this is an
  // update (§6-2). An update that only changes its source does not drift: the pin is over the tool
  // catalog, so only a change to the tools themselves needs the flag.
  const acceptDrift = args["accept_drift"] === true;
  let loaded: LoadedCapsule;
  try {
    loaded = await loadCapsule(packRes.file, {
      trust: true,
      acceptDrift,
      homeDir: opts.homeDir,
    });
  } catch (err) {
    return loadRefusal(err, `${toolName} with { accept_drift: true }`);
  }

  // Install into manager registry via the shared P2-2 install pipeline
  return installLoadedCapsule(loaded, opts, {
    allowSuspicious,
    actionWord: isUpdate ? "Updated" : "Created",
    exportMcpb: true,
    shareHint: "Send the .mcpb file (or .capsule) — recipients can double-click it to install.",
  });
}
