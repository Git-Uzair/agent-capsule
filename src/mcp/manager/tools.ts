import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { asRecord } from "../../core/canonical.ts";
import { CapsuleError } from "../../core/errors.ts";
import { loadCapsule, type LoadedCapsule } from "../../format/capsule.ts";
import type { CatalogTool } from "../catalog.ts";
import { declaredCapabilities } from "../server.ts";
import { JSON_RPC_ERROR, RpcFailure } from "../transport.ts";
import { scanTextTree } from "../../security/text.ts";
import { scanDownloads, type DownloadCandidate } from "./downloads.ts";
import {
  addInstalledCapsule,
  installedCapsulePath,
  loadInstalledStore,
  removeInstalledCapsule,
  removeInstalledCapsulesByName,
} from "./registry.ts";

export const MANAGER_TOOLS: readonly CatalogTool[] = [
  {
    name: "capsule_install",
    title: "Install Capsule",
    description:
      "Install an Agent Capsule from a local file path or automatically from the Downloads folder.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative file path to the .capsule file to install.",
        },
        from_downloads: {
          type: "boolean",
          description:
            "Scan the user's Downloads folder for .capsule files. If exactly 1 is found, install it; if multiple, list candidates.",
        },
        accept_drift: {
          type: "boolean",
          description:
            "Explicitly accept tool catalog drift for an updated capsule signed by the same publisher key.",
        },
        allow_suspicious: {
          type: "boolean",
          description:
            "Explicitly allow installing a capsule despite suspicious prompt injection markers or formatting in descriptions/schemas.",
        },
      },
    },
    effects: [],
  },
  {
    name: "capsule_uninstall",
    title: "Uninstall Capsule",
    description: "Uninstall an installed Agent Capsule by capsuleId or name.",
    inputSchema: {
      type: "object",
      properties: {
        capsuleId: {
          type: "string",
          description: "Payload digest ID of the capsule to uninstall.",
        },
        name: {
          type: "string",
          description: "Name of the capsule to uninstall.",
        },
      },
    },
    effects: [],
  },
  {
    name: "capsule_list",
    title: "List Installed Capsules",
    description: "List all installed Agent Capsules, their publisher keys, trust state, and exposed tools.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    effects: [],
  },
  {
    name: "capsule_create",
    title: "Create Capsule",
    description: "Create and sign a new Agent Capsule from specification and guest source code (P2-4).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        source: { type: "string" },
        tools: { type: "array" },
      },
      required: ["name", "title", "description", "source", "tools"],
    },
    effects: [],
  },
  {
    name: "capsule_update",
    title: "Update Capsule",
    description: "Update an existing Agent Capsule with new source or tools (P2-4).",
    inputSchema: {
      type: "object",
      properties: {
        capsuleId: { type: "string" },
        source: { type: "string" },
        tools: { type: "array" },
      },
      required: ["capsuleId"],
    },
    effects: [],
  },
  {
    name: "capsule_open_ui",
    title: "Open Capsule UI",
    description: "Launch the local UI server for an installed capsule (P2-4).",
    inputSchema: {
      type: "object",
      properties: {
        capsuleId: { type: "string" },
        name: { type: "string" },
      },
    },
    effects: [],
  },
  {
    name: "capsule_test_tool",
    title: "Test Capsule Tool",
    description: "Execute a tool inside an installed capsule for testing and diagnostics (P2-4).",
    inputSchema: {
      type: "object",
      properties: {
        capsuleId: { type: "string" },
        tool: { type: "string" },
        args: { type: "object" },
      },
      required: ["capsuleId", "tool"],
    },
    effects: [],
  },
];

export type ToolExecutionResult = {
  text: string;
  structured: Record<string, unknown>;
  isError: boolean;
};

export async function handleCapsuleInstall(
  rawArgs: unknown,
  opts: {
    homeDir?: string;
    downloadsDir?: string;
    warn: (line: string) => void;
    notifyListChanged: () => void;
    invalidateCache: () => void;
  },
): Promise<ToolExecutionResult> {
  const args = asRecord(rawArgs) ?? {};
  const fromDownloads = args["from_downloads"] === true;
  const rawPath = typeof args["path"] === "string" ? args["path"].trim() : undefined;
  const acceptDrift = args["accept_drift"] === true;
  const allowSuspicious = args["allow_suspicious"] === true;

  let targetFile: string;

  if (fromDownloads || (rawPath === undefined && fromDownloads)) {
    const candidates = scanDownloads(opts.downloadsDir);
    if (candidates.length === 0) {
      const text = "No .capsule files found in Downloads folder. Please specify the file path directly with { path: \"...\" }.";
      return { text, structured: { ok: false, error: "NO_FILES", message: text }, isError: false };
    }
    if (candidates.length > 1) {
      const text =
        `Found ${candidates.length} capsule files in Downloads. Please specify which file to install using { path: "..." }:\n` +
        candidates.map((c, i) => `${i + 1}. ${c.name} (${c.path})`).join("\n");
      return {
        text,
        structured: {
          ok: false,
          status: "ambiguous",
          candidates: candidates.map((c) => ({ name: c.name, path: c.path, mtime: new Date(c.mtime).toISOString() })),
          message: text,
        },
        isError: false,
      };
    }
    targetFile = (candidates[0] as DownloadCandidate).path;
  } else if (rawPath !== undefined && rawPath !== "") {
    targetFile = rawPath;
  } else {
    throw new RpcFailure(
      JSON_RPC_ERROR.InvalidParams,
      "capsule_install requires either 'path' or 'from_downloads: true'",
    );
  }

  let loaded: LoadedCapsule;
  try {
    loaded = await loadCapsule(targetFile, {
      trust: true,
      acceptDrift,
      homeDir: opts.homeDir,
    });
  } catch (err) {
    if (err instanceof CapsuleError) {
      if (err.code === "E_TRUST" && err.message.includes("tool catalog changed")) {
        const name = (err.detail["name"] as string) ?? "unknown";
        const text =
          `Security Alert (Key Drift): The publisher key for capsule '${name}' is already pinned, but its tool catalog has changed. ` +
          `This could indicate an unexpected modification or rug-pull. ` +
          `If you trust this updated tool catalog, re-run capsule_install with { path: "${targetFile}", accept_drift: true }.`;
        return { text, structured: { ok: false, error: "E_TRUST_DRIFT", message: text }, isError: true };
      }
      if (err.code === "E_TRUST" && err.message.includes("publisher key changed")) {
        const name = (err.detail["name"] as string) ?? "unknown";
        const text =
          `Security Alert (Key Rotation): The publisher key for capsule '${name}' does not match the previously pinned key. ` +
          `Installation refused.`;
        return { text, structured: { ok: false, error: "E_TRUST_KEY", message: text }, isError: true };
      }
      const text = `${err.code}: ${err.message}`;
      return { text, structured: { ok: false, error: err.code, message: text }, isError: true };
    }
    const text = `Failed to load capsule: ${err instanceof Error ? err.message : String(err)}`;
    return { text, structured: { ok: false, error: "E_CONTAINER", message: text }, isError: true };
  }

  // Screen for suspicious prompt injection markers or identifiers
  const suspiciousMarkers: string[] = [];
  for (const tool of loaded.manifest.tools) {
    const markers = scanTextTree([tool.title, tool.description, tool.inputSchema, tool.outputSchema]);
    if (markers.length > 0) {
      suspiciousMarkers.push(`tool '${tool.name}': ${markers.join(", ")}`);
    }
  }
  const metaMarkers = scanTextTree([loaded.manifest.meta.title, loaded.manifest.meta.description]);
  if (metaMarkers.length > 0) {
    suspiciousMarkers.push(`metadata: ${metaMarkers.join(", ")}`);
  }

  if (suspiciousMarkers.length > 0 && !allowSuspicious) {
    const text =
      `Security Warning (Suspicious Content): Capsule contains suspicious patterns or prompt injection markers (${suspiciousMarkers.join("; ")}). ` +
      `To install anyway, re-run capsule_install with { path: "${targetFile}", allow_suspicious: true }.`;
    return {
      text,
      structured: { ok: false, error: "E_SUSPICIOUS", findings: suspiciousMarkers, message: text },
      isError: true,
    };
  }

  const destPath = installedCapsulePath(loaded.capsuleId, opts.homeDir);
  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, loaded.bytes);

  addInstalledCapsule(
    loaded.capsuleId,
    {
      name: loaded.manifest.meta.name,
      version: loaded.manifest.meta.version,
      file: destPath,
      installedAt: new Date().toISOString(),
    },
    opts.homeDir,
  );

  opts.invalidateCache();
  opts.notifyListChanged();

  const caps = declaredCapabilities(loaded.manifest);
  const gatewayTools = loaded.manifest.tools.map((t) => `${loaded.manifest.meta.name}__${t.name}`);
  const text =
    `Installed capsule '${loaded.manifest.meta.name}@${loaded.manifest.meta.version}' successfully.\n` +
    `• Capsule ID: ${loaded.capsuleId}\n` +
    `• Publisher Key: ${loaded.keyId}\n` +
    `• Trust State: ${loaded.trust}\n` +
    `• Declared Capabilities: ${caps}\n` +
    `• Exposed Tools: ${gatewayTools.length > 0 ? gatewayTools.join(", ") : "none"}`;

  return {
    text,
    structured: {
      ok: true,
      capsuleId: loaded.capsuleId,
      name: loaded.manifest.meta.name,
      version: loaded.manifest.meta.version,
      keyId: loaded.keyId,
      trust: loaded.trust,
      capabilities: caps,
      tools: gatewayTools,
      message: text,
    },
    isError: false,
  };
}

export function handleCapsuleUninstall(
  rawArgs: unknown,
  opts: {
    homeDir?: string;
    notifyListChanged: () => void;
    invalidateCache: () => void;
  },
): ToolExecutionResult {
  const args = asRecord(rawArgs) ?? {};
  const capsuleId = typeof args["capsuleId"] === "string" ? args["capsuleId"].trim() : undefined;
  const name = typeof args["name"] === "string" ? args["name"].trim() : undefined;

  if (!capsuleId && !name) {
    throw new RpcFailure(JSON_RPC_ERROR.InvalidParams, "capsule_uninstall requires either 'capsuleId' or 'name'");
  }

  if (capsuleId) {
    const res = removeInstalledCapsule(capsuleId, opts.homeDir);
    if (!res.ok) {
      const text = `Capsule with ID '${capsuleId}' is not installed.`;
      return { text, structured: { ok: false, message: text }, isError: true };
    }
    opts.invalidateCache();
    opts.notifyListChanged();
    const text = `Uninstalled capsule '${res.entry?.name ?? ""}' (${capsuleId}).`;
    return {
      text,
      structured: { ok: true, capsuleId, name: res.entry?.name, message: text },
      isError: false,
    };
  } else {
    const res = removeInstalledCapsulesByName(name as string, opts.homeDir);
    if (res.removed.length === 0) {
      const text = `No installed capsule found with name '${name}'.`;
      return { text, structured: { ok: false, message: text }, isError: true };
    }
    opts.invalidateCache();
    opts.notifyListChanged();
    const text = `Uninstalled ${res.removed.length} capsule(s) named '${name}'.`;
    return {
      text,
      structured: { ok: true, count: res.removed.length, name, message: text },
      isError: false,
    };
  }
}

export async function handleCapsuleList(opts: {
  homeDir?: string;
  getCapsule: (capsuleId: string, file: string) => Promise<LoadedCapsule | undefined>;
}): Promise<ToolExecutionResult> {
  const store = loadInstalledStore(opts.homeDir);
  const entries = Object.entries(store.capsules);
  if (entries.length === 0) {
    const text = "No capsules currently installed. Use capsule_install to install a capsule.";
    return { text, structured: { capsules: [], message: text }, isError: false };
  }

  const capsulesInfo: Array<Record<string, unknown>> = [];
  const lines: string[] = [`Installed Capsules (${entries.length}):`];

  for (const [capsuleId, entry] of entries) {
    const loaded = await opts.getCapsule(capsuleId, entry.file);
    const tools = loaded ? loaded.manifest.tools.map((t) => `${loaded.manifest.meta.name}__${t.name}`) : [];
    const caps = loaded ? declaredCapabilities(loaded.manifest) : "unknown";
    capsulesInfo.push({
      capsuleId,
      name: entry.name,
      version: entry.version,
      file: entry.file,
      installedAt: entry.installedAt,
      publisherKey: loaded?.keyId ?? "unknown",
      trust: loaded?.trust ?? "ok",
      capabilities: caps,
      tools,
    });
    lines.push(`• ${entry.name}@${entry.version} (id: ${capsuleId})`);
    lines.push(`  - Installed: ${entry.installedAt}`);
    lines.push(`  - Capabilities: ${caps}`);
    lines.push(`  - Tools: ${tools.length > 0 ? tools.join(", ") : "none"}`);
  }

  const text = lines.join("\n");
  return {
    text,
    structured: { capsules: capsulesInfo, message: text },
    isError: false,
  };
}
