import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { asRecord } from "../../core/canonical.ts";
import { CapsuleError } from "../../core/errors.ts";
import { loadCapsule, type LoadedCapsule } from "../../format/capsule.ts";
import { BUILTIN_TOOLS } from "../builtin.ts";
import { assertNoToolNameCollision, buildToolList, type CatalogTool } from "../catalog.ts";
import { declaredCapabilities } from "../server.ts";
import { JSON_RPC_ERROR, RpcFailure } from "../transport.ts";
import { scanTextTree } from "../../security/text.ts";
import { scanDownloads, type DownloadCandidate } from "./downloads.ts";
import {
  addInstalledCapsule,
  installedCapsulePath,
  removeInstalledCapsule,
  removeInstalledCapsulesByName,
} from "./registry.ts";

/**
 * The alphabet a gateway name is built from. Both halves of `<capsuleName>__<toolName>` have to obey
 * it, and only one half does by construction: capsule.json restricts a *tool* name to
 * `^[a-zA-Z0-9_-]{1,64}$`, but `meta.name` also permits `.`, so nothing except this check keeps a
 * dotted capsule name out of the merged namespace. Such a name is refused rather than rewritten into
 * `a_b`: the rewrite would advertise tools under a name the capsule never declared, and `a.b` and a
 * genuine `a_b` capsule would then claim the same prefix — the confusable pair this host refuses a
 * capsule for in the first place.
 */
export const GATEWAY_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

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
    /** The names the gateway really serves for a capsuleId, so the summary cannot over-promise. */
    servedTools: (capsuleId: string) => Promise<string[]>;
  },
): Promise<ToolExecutionResult> {
  const args = asRecord(rawArgs) ?? {};
  const fromDownloads = args["from_downloads"] === true;
  const rawPath = typeof args["path"] === "string" ? args["path"].trim() : undefined;
  const acceptDrift = args["accept_drift"] === true;
  const allowSuspicious = args["allow_suspicious"] === true;
  const named = rawPath !== undefined && rawPath !== "";

  // Refused rather than resolved: with both supplied, either answer installs a file the caller did
  // not ask about, and installing something the user never named is the one thing this tool may not
  // do. The caller re-sends the one it meant.
  if (named && fromDownloads) {
    throw new RpcFailure(
      JSON_RPC_ERROR.InvalidParams,
      "capsule_install takes either 'path' or 'from_downloads: true', not both",
    );
  }

  let targetFile: string;

  if (named) {
    targetFile = rawPath as string;
  } else if (fromDownloads) {
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

  // The gateway prefixes every tool with this name, so a name outside the namespace alphabet is
  // refused before the file is copied anywhere. Safe to interpolate: capsule.json already limits
  // `meta.name` to `[a-z0-9._-]`, and it is the `.` this rejects.
  if (!GATEWAY_NAME_PATTERN.test(loaded.manifest.meta.name)) {
    const text =
      `Capsule '${loaded.manifest.meta.name}' cannot be served by the gateway: its name must match ` +
      `[a-zA-Z0-9_-] (1-64 characters) so that '<capsuleName>__<toolName>' names one capsule ` +
      `unambiguously. Installation refused.`;
    return { text, structured: { ok: false, error: "E_CONTENT", message: text }, isError: true };
  }

  // Refused at the door, exactly as the direct server refuses such a capsule before it serves
  // anything: two tool names that read as one name are a phishing vector inside the capsule's own
  // list, and `<capsuleName>__` prefixes both halves of the pair alike, so the gateway namespace
  // inherits the ambiguity. Not overridable — there is no honest reason to declare both. Built-ins
  // join the check because the reserved-prefix rule is case-sensitive (`Capsule_info` is legal).
  // Names are `[a-zA-Z0-9_-]{1,64}` per schema, so the reported pair is safe to interpolate.
  try {
    assertNoToolNameCollision([
      ...loaded.manifest.tools.map((tool) => tool.name),
      ...BUILTIN_TOOLS.map((tool) => tool.name),
    ]);
  } catch (err) {
    const detail = err instanceof CapsuleError ? err.message : String(err);
    const text =
      `Security Alert (Confusable Tool Names): Capsule '${loaded.manifest.meta.name}' declares two tool ` +
      `names that read as the same name (${detail}). Installation refused.`;
    return { text, structured: { ok: false, error: "E_CONTENT", message: text }, isError: true };
  }

  // Screen for suspicious prompt injection markers or identifiers
  const screeningWarnings: string[] = [];
  buildToolList(loaded.manifest, {
    allowSuspicious: false,
    warn: (line) => screeningWarnings.push(line),
  });

  const metaMarkers = scanTextTree([loaded.manifest.meta.title, loaded.manifest.meta.description]);
  if (metaMarkers.length > 0) {
    screeningWarnings.push(`metadata: ${metaMarkers.join(", ")}`);
  }

  if (screeningWarnings.length > 0 && !allowSuspicious) {
    const text =
      `Security Warning (Suspicious Content): Capsule contains suspicious patterns or prompt injection markers (${screeningWarnings.join("; ")}). ` +
      `To install anyway, re-run capsule_install with { path: "${targetFile}", allow_suspicious: true }.`;
    return {
      text,
      structured: { ok: false, error: "E_SUSPICIOUS", findings: screeningWarnings, message: text },
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
      ...(allowSuspicious ? { allowSuspicious: true } : {}),
    },
    opts.homeDir,
  );

  opts.invalidateCache();
  opts.notifyListChanged();

  const caps = declaredCapabilities(loaded.manifest);
  // Read back from the gateway rather than from this manifest: a capsule whose names collide with one
  // already installed is suppressed there, and a summary that named tools nobody can call would send
  // the agent looking for them.
  const gatewayTools = await opts.servedTools(loaded.capsuleId);
  const text =
    `Installed capsule '${loaded.manifest.meta.name}@${loaded.manifest.meta.version}' successfully.\n` +
    `• Capsule ID: ${loaded.capsuleId}\n` +
    `• Publisher Key: ${loaded.keyId}\n` +
    `• Trust State: ${loaded.trust}\n` +
    `• Declared Capabilities: ${caps}\n` +
    `• Exposed Tools: ${gatewayTools.length > 0 ? gatewayTools.join(", ") : "none"}` +
    (gatewayTools.length === 0
      ? `\n• Warning: no tools are exposed — its tool names collide with an already installed capsule, ` +
        `so this capsule is suppressed. Uninstall the other capsule to use this one.`
      : "");

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

/**
 * One installed capsule as the gateway resolved it: its verified metadata, its trust state, and the
 * gateway names it actually serves.
 */
export type ListedCapsule = {
  capsuleId: string;
  name: string;
  version: string;
  file: string;
  installedAt: string;
  publisherKey: string;
  /** `LoadedCapsule["trust"]`, or `corrupt`/`unverifiable` when the installed file failed its gates. */
  trust: string;
  capabilities: string;
  tools: string[];
  note?: string;
};

/**
 * Formatting only. The rows come from the same pass that built `tools/list` and the dispatch table, so
 * what the user is told is served is what is served — this cannot recompute it differently, because it
 * does not recompute it at all.
 */
export function handleCapsuleList(capsules: readonly ListedCapsule[]): ToolExecutionResult {
  if (capsules.length === 0) {
    const text = "No capsules currently installed. Use capsule_install to install a capsule.";
    return { text, structured: { capsules: [], message: text }, isError: false };
  }

  const lines: string[] = [`Installed Capsules (${capsules.length}):`];

  for (const capsule of capsules) {
    const verified = capsule.trust !== "corrupt" && capsule.trust !== "unverifiable";
    lines.push(
      `• ${capsule.name}@${capsule.version} (id: ${capsule.capsuleId})` +
        (verified ? "" : " [CORRUPT/UNVERIFIABLE]"),
    );
    lines.push(`  - Installed: ${capsule.installedAt}`);
    lines.push(`  - Trust: ${capsule.trust}`);
    if (verified) {
      lines.push(`  - Capabilities: ${capsule.capabilities}`);
      lines.push(`  - Tools: ${capsule.tools.length > 0 ? capsule.tools.join(", ") : "none"}`);
    } else {
      lines.push(`  - File: ${capsule.file} (failed to load or verify)`);
    }
    if (capsule.note !== undefined) {
      lines.push(`  - Note: ${capsule.note}`);
    }
  }

  const text = lines.join("\n");
  return {
    text,
    structured: { capsules: capsules.map((capsule) => ({ ...capsule })), message: text },
    isError: false,
  };
}
