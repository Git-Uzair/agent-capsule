import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConformanceReport, ConformanceResult } from "../../conformance/checks.ts";
import { runConformance } from "../../conformance/run.ts";
import { asRecord } from "../../core/canonical.ts";
import { CapsuleError } from "../../core/errors.ts";
import { loadCapsule, packDirectory, type LoadedCapsule, type PackResult } from "../../format/capsule.ts";
import { parseManifest, type EffectName, type Manifest, type ManifestTool } from "../../format/manifest.ts";
import { homeSidecarPaths, invokeTool } from "../../runtime/invoke.ts";
import { openJournal } from "../../runtime/journal.ts";
import { capsuleHome } from "../../security/signing.ts";
import { JSON_RPC_ERROR, RpcFailure } from "../transport.ts";
import {
  installedCapsulePath,
  loadInstalledStore,
} from "./registry.ts";
import {
  AUTHORING_TOOLS,
  GATEWAY_NAME_PATTERN,
  installLoadedCapsule,
  type ToolExecutionResult,
} from "./tools.ts";

export { AUTHORING_TOOLS };

/** Maximum allowed payload size for conversational authoring workspace (5 MB). */
export const MAX_WORKSPACE_PAYLOAD_BYTES = 5 * 1024 * 1024;

/** Maximum allowed tool runtime timeout in ms (30 seconds). */
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

const VALID_EFFECTS: readonly EffectName[] = [
  "clock.now",
  "random.bytes",
  "sql.query",
  "sql.exec",
  "kv.get",
  "kv.set",
  "net.fetch",
  "log.write",
  "pack.write",
];

const HOST_PATTERN = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

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

  let existingEntry = capsuleId ? store.capsules[capsuleId] : undefined;
  if (!existingEntry && name) {
    existingEntry = Object.values(store.capsules).find((e) => e.name === name);
  }

  if (isUpdate) {
    if (!name && !capsuleId) {
      throw new RpcFailure(
        JSON_RPC_ERROR.InvalidParams,
        "capsule_update requires either 'name' or 'capsuleId'",
      );
    }
    if (existingEntry) {
      if (!name) name = existingEntry.name;
    } else {
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

  if (!GATEWAY_NAME_PATTERN.test(name) || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) {
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
      const currentVer = existingManifest?.meta.version ?? existingEntry?.version ?? "0.1.0";
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
  const seenToolNames = new Set<string>();

  for (let i = 0; i < rawTools.length; i++) {
    const t = asRecord(rawTools[i]);
    if (!t) {
      const text = `Tool at index ${i} is malformed: expected object.`;
      return { text, structured: { ok: false, error: "E_USAGE", message: text }, isError: true };
    }
    const tName = typeof t["name"] === "string" ? t["name"].trim() : "";
    if (!tName || !/^[a-zA-Z0-9_-]{1,64}$/.test(tName)) {
      const text = `Invalid tool name '${tName}': must match ^[a-zA-Z0-9_-]{1,64}$.`;
      return { text, structured: { ok: false, error: "E_CONTENT", message: text }, isError: true };
    }
    if (tName.startsWith("capsule_")) {
      const text = `Reserved tool name '${tName}': guest tool names must not start with 'capsule_'.`;
      return { text, structured: { ok: false, error: "E_CONTENT", message: text }, isError: true };
    }
    if (seenToolNames.has(tName)) {
      const text = `Duplicate tool name '${tName}' declared in capsule.`;
      return { text, structured: { ok: false, error: "E_CONTENT", message: text }, isError: true };
    }
    seenToolNames.add(tName);

    const rawEffects = Array.isArray(t["effects"]) ? t["effects"] : [];
    for (const eff of rawEffects) {
      if (typeof eff !== "string" || !VALID_EFFECTS.includes(eff as EffectName)) {
        const text = `Unknown effect '${eff}' declared in tool '${tName}'.`;
        return { text, structured: { ok: false, error: "E_MANIFEST", message: text }, isError: true };
      }
    }

    const tTitle =
      typeof t["title"] === "string" && t["title"].trim() ? t["title"].trim() : tName;
    const tDesc =
      typeof t["description"] === "string" && t["description"].trim()
        ? t["description"].trim()
        : tTitle;
    const tInputSchema = asRecord(t["inputSchema"]) ?? { type: "object" };
    if (tInputSchema["type"] !== "object") {
      const text = `Tool '${tName}' inputSchema must be a JSON Schema with type: 'object'.`;
      return { text, structured: { ok: false, error: "E_MANIFEST", message: text }, isError: true };
    }
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

  let allowedHosts: string[] = [];
  if (explicitCaps?.["net"] !== undefined) {
    const netObj = asRecord(explicitCaps["net"]);
    if (!netObj || !Array.isArray(netObj["allowed_hosts"])) {
      const text = "capabilities.net.allowed_hosts must be an array of host strings.";
      return { text, structured: { ok: false, error: "E_USAGE", message: text }, isError: true };
    }
    const rawHosts = netObj["allowed_hosts"] as unknown[];
    if (rawHosts.length === 0) {
      const text = "capabilities.net.allowed_hosts must be non-empty when capabilities.net is specified.";
      return { text, structured: { ok: false, error: "E_USAGE", message: text }, isError: true };
    }
    for (const h of rawHosts) {
      if (typeof h !== "string" || !HOST_PATTERN.test(h)) {
        const text =
          `Invalid host pattern '${h}' in allowed_hosts. Must be a valid domain or *.domain pattern without standalone wildcard.`;
        return { text, structured: { ok: false, error: "E_USAGE", message: text }, isError: true };
      }
    }
    allowedHosts = rawHosts as string[];
  } else if (existingManifest?.capabilities.net.allowed_hosts) {
    allowedHosts = existingManifest.capabilities.net.allowed_hosts;
  }

  const usesNet = tools.some((t) => t.effects.includes("net.fetch"));
  if (usesNet && allowedHosts.length === 0) {
    const text =
      "Tool requests net.fetch but no allowed_hosts were declared in capabilities.net. Creation refused.";
    return { text, structured: { ok: false, error: "E_MANIFEST", message: text }, isError: true };
  }

  // 4. Guardrail: Timeout limit
  const timeoutMs = 30000;
  if (timeoutMs > MAX_AUTHORING_TIMEOUT_MS) {
    const text = `timeout_ms cannot exceed ${MAX_AUTHORING_TIMEOUT_MS}ms.`;
    return { text, structured: { ok: false, error: "E_USAGE", message: text }, isError: true };
  }

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
      timeout_ms: timeoutMs,
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

  // Validate manifest with Ajv and assertSemantics
  try {
    parseManifest(manifestObj);
  } catch (err) {
    const detail = err instanceof CapsuleError ? `${err.code}: ${err.message}` : String(err);
    const text = `Manifest validation failed: ${detail}`;
    return {
      text,
      structured: { ok: false, error: err instanceof CapsuleError ? err.code : "E_MANIFEST", message: text },
      isError: true,
    };
  }

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

  // Load and verify
  let loaded: LoadedCapsule;
  try {
    loaded = await loadCapsule(packRes.file, {
      trust: true,
      acceptDrift: isUpdate,
      homeDir: opts.homeDir,
    });
  } catch (err) {
    const detail = err instanceof CapsuleError ? `${err.code}: ${err.message}` : String(err);
    const text = `Failed to load packed capsule: ${detail}`;
    return {
      text,
      structured: { ok: false, error: err instanceof CapsuleError ? err.code : "E_TRUST", message: text },
      isError: true,
    };
  }

  // Run conformance suite
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

  // Install into manager registry via the shared P2-2 install pipeline
  const allowSuspicious = args["allow_suspicious"] === true;
  return installLoadedCapsule(loaded, opts, {
    allowSuspicious,
    actionWord: isUpdate ? "Updated" : "Created",
    exportMcpb: true,
    shareHint: "Send the .mcpb file (or .capsule) — recipients can double-click it to install.",
  });
}

export async function handleCapsuleTestTool(
  rawArgs: unknown,
  opts: ManagerAuthoringOptions,
): Promise<ToolExecutionResult> {
  const args = asRecord(rawArgs) ?? {};
  const toolName = typeof args["tool"] === "string" ? args["tool"].trim() : "";
  const capsuleId = typeof args["capsuleId"] === "string" ? args["capsuleId"].trim() : undefined;
  const name = typeof args["name"] === "string" ? args["name"].trim() : undefined;
  const toolArgs = asRecord(args["args"]) ?? {};

  if (!toolName) {
    throw new RpcFailure(JSON_RPC_ERROR.InvalidParams, "capsule_test_tool requires 'tool'");
  }
  if (!capsuleId && !name) {
    throw new RpcFailure(
      JSON_RPC_ERROR.InvalidParams,
      "capsule_test_tool requires either 'capsuleId' or 'name'",
    );
  }

  const store = loadInstalledStore(opts.homeDir);
  let targetFile: string | undefined;

  if (capsuleId) {
    const entry = store.capsules[capsuleId];
    if (entry?.file && existsSync(entry.file)) {
      targetFile = entry.file;
    } else {
      const fallbackPath = installedCapsulePath(capsuleId, opts.homeDir);
      if (existsSync(fallbackPath)) targetFile = fallbackPath;
    }
  } else if (name) {
    const entry = Object.values(store.capsules).find((e) => e.name === name);
    if (entry?.file && existsSync(entry.file)) {
      targetFile = entry.file;
    }
  }

  if (!targetFile) {
    const text = `Capsule '${capsuleId || name}' is not installed.`;
    return {
      text,
      structured: { ok: false, error: "E_USAGE", message: text },
      isError: true,
    };
  }

  let loaded: LoadedCapsule;
  try {
    loaded = await loadCapsule(targetFile, { trust: true, homeDir: opts.homeDir });
  } catch (err) {
    const detail = err instanceof CapsuleError ? `${err.code}: ${err.message}` : String(err);
    const text = `Failed to load capsule: ${detail}`;
    return {
      text,
      structured: { ok: false, error: "E_CONTAINER", message: detail },
      isError: true,
    };
  }

  const sidecars = homeSidecarPaths(loaded.capsuleId, opts.homeDir);
  const res = await invokeTool({
    capsule: loaded,
    tool: toolName,
    args: toolArgs,
    statePath: sidecars.app,
    journalPath: sidecars.journal,
    homeDir: opts.homeDir,
  });

  let runEffects: unknown[] = [];
  try {
    const journal = openJournal(sidecars.journal);
    runEffects = journal.effects(res.runId);
    journal.close();
  } catch {
    // Best-effort journal reading
  }

  if (res.ok) {
    const outputText =
      typeof res.value === "string" ? res.value : JSON.stringify(res.value, null, 2);
    const text = `Tool '${toolName}' executed successfully in ${res.ms}ms.\nOutput:\n${outputText}`;
    return {
      text,
      structured: {
        ok: true,
        output: res.value,
        effects: runEffects,
        runId: res.runId,
        ms: res.ms,
        message: text,
      },
      isError: false,
    };
  } else {
    const errorMsg = res.error ? `${res.error.code}: ${res.error.message}` : "Invocation failed";
    const text = `Tool '${toolName}' execution failed (${res.ms}ms):\n${errorMsg}`;
    return {
      text,
      structured: {
        ok: false,
        error: errorMsg,
        effects: runEffects,
        runId: res.runId,
        ms: res.ms,
        message: text,
      },
      isError: true,
    };
  }
}
