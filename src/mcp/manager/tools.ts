import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { exportMcpb } from "../../commands/export-mcpb.ts";
import { asRecord } from "../../core/canonical.ts";
import { CapsuleError } from "../../core/errors.ts";
import { loadCapsule, type LoadedCapsule } from "../../format/capsule.ts";
import type { Manifest } from "../../format/manifest.ts";
import { BUILTIN_TOOLS } from "../builtin.ts";
import { assertNoToolNameCollision, buildToolList, type CatalogTool } from "../catalog.ts";
import { declaredCapabilities } from "../server.ts";
import { JSON_RPC_ERROR, RpcFailure } from "../transport.ts";
import { scanTextTree } from "../../security/text.ts";
import { resolveDownloadsDir, scanDownloads, type DownloadCandidate } from "./downloads.ts";
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

/**
 * The capsule name alphabet the authoring tools accept: the schema's `meta.name` pattern minus `.`,
 * which is also the gateway namespace alphabet. Narrower than `GATEWAY_NAME_PATTERN` on purpose — the
 * name becomes a directory under `workspaces/` before any manifest is parsed, so `MyCapsule` and
 * `Mycapsule` must not be two capsules on a case-insensitive filesystem. It lives here, beside the
 * schemas that describe it, so `capsule_create`'s `name` description can be built from this very
 * source string instead of from a copy of it that could drift.
 */
export const AUTHORED_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** What `capsule_create`'s and `capsule_update`'s `name` promises, in the rule's own words. */
const AUTHORED_NAME_DESCRIPTION =
  `Name of the capsule: must match ${AUTHORED_NAME_PATTERN.source} — lowercase a-z and 0-9, ` +
  `underscore and hyphen, first character alphanumeric, 1-64 characters. Uppercase letters and dots ` +
  `are refused. Its tools are served to the agent as '<name>__<toolName>'.`;

/**
 * Every trust state a listing can report — which is not every state `LoadedCapsule["trust"]` has. The
 * list is taken from the producer, `verifyInstalled` (src/mcp/manager/server.ts): it loads with the
 * trust store live but deliberately without `acceptDrift`, so the loader can only hand it `pinned` or
 * `ok`, and `corrupt`/`unverifiable` are the two ways that same function refuses the installed file.
 * `drift-accepted` is absent on purpose: only `capsule_install`/`capsule_update` may re-pin a changed
 * tool catalog, and only when the user said so (§6.2), so it can only ever be the trust state of
 * *their* result — the re-pinned capsule reads as `ok` on every listing after it. It is `Exclude`d
 * below so putting it back is a compile error, not a description that over-promises. `ListedCapsule["trust"]`
 * is this list, so a state no listing produces cannot be assigned — which is what keeps `capsule_list`'s
 * description from naming one.
 */
export const LISTED_TRUST_STATES = [
  "pinned",
  "ok",
  "corrupt",
  "unverifiable",
] as const satisfies readonly (
  | Exclude<LoadedCapsule["trust"], "drift-accepted">
  | "corrupt"
  | "unverifiable"
)[];

/**
 * What a tool's `effects` list means, in the words a capsule author needs. Declaring an effect is not
 * paperwork about intent: `buildPolicy`'s check refuses any op missing from the list of the tool being
 * run (src/runtime/policy.ts), so a handler that calls `capsule.log` without `log.write` is created,
 * conformed and installed, and then fails on its first call. `capsule_create` and `capsule_update`
 * take the same list and say this once, from here — two copies of the rule would drift apart, and it
 * was a drifted copy (`log.write` missing from the enumeration) that made the omission look legal.
 */
const EFFECTS_DESCRIPTION =
  "Declared effect identifiers for this tool. Every runtime op the handler calls must appear here, or " +
  "that call is refused when the tool runs ('tool <name> did not declare effect <op>'). The ops are " +
  "kv.get and kv.set (`capsule.kv.get` / `capsule.kv.set`), sql.query and sql.exec " +
  "(`capsule.sql.query` / `capsule.sql.exec`), net.fetch (`capsule.fetch`), log.write (`capsule.log`), " +
  "clock.now (`capsule.now()`, `new Date()`, `Date.now()`) and random.bytes (`capsule.random(n)`, " +
  "`Math.random()`). The kv, sql and net effects additionally require the matching capability; " +
  "log.write, clock.now and random.bytes require none. pack.write is a legal effect name too, but no " +
  "guest API in this host performs it, so a tool has nothing to declare it for.";

/**
 * What `ui_html` really is, taught in the schema because the agent authoring a capsule writes this
 * document blind: the contract below is the MCP Apps wire protocol as Claude Desktop actually speaks
 * it, extracted from a rendering client — an app that skips the size report, or waits on a bridge
 * global that does not exist, renders as nothing and reads as "the UI is broken".
 */
const UI_HTML_DESCRIPTION =
  "Optional interactive UI bundled with the capsule, rendered by MCP-Apps-capable clients (e.g. " +
  "Claude Desktop) in a sandboxed iframe whenever one of this capsule's tools is called. Provide a " +
  "COMPLETE HTML document (<!DOCTYPE html><html>…</html>) with all CSS/JS inline and a transparent " +
  "page background. The host speaks JSON-RPC 2.0 over postMessage; there is no host global like " +
  "window.capsule or window.host. Boot handshake: send " +
  "window.parent.postMessage({jsonrpc:'2.0',id:0,method:'ui/initialize',params:{appInfo:{name,version}," +
  "appCapabilities:{},protocolVersion:'2025-11-21'}},'*'); when the response with that id arrives, " +
  "post the notification {jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}}. The " +
  "triggering tool's result then arrives as the notification 'ui/notifications/tool-result' with " +
  "params={content,structuredContent,isError}: prefer structuredContent but fall back to parsing " +
  "content[0].text — some clients strip structured payloads. REQUIRED: report rendered height via " +
  "{jsonrpc:'2.0',method:'ui/notifications/size-changed',params:{height,width}} after every render, " +
  "from a ResizeObserver, and on a timer fallback shortly after boot — a frame that never reports a " +
  "size is given no height and stays invisible. The UI may call this capsule's tools by posting " +
  "{jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments}} to window.parent and matching the " +
  "response by id; through this gateway a tool's name is '<capsuleName>__<toolName>' (a direct " +
  "`capsule mcp` server serves the bare name, so try the prefixed name and retry bare on an " +
  "'unknown tool' error).";

export const AUTHORING_TOOLS: readonly CatalogTool[] = [
  {
    name: "capsule_create",
    title: "Create Capsule",
    description:
      "Create, test, conform, sign, and install a brand-new Agent Capsule from guest JavaScript source code in conversation. Scaffolds the workspace, packages and signs with local key, runs automated conformance tests, installs into the gateway so tools are immediately callable under '<name>__<toolName>', and saves a double-clickable .mcpb sharing bundle to the user's Downloads folder.",
    inputSchema: {
      type: "object",
      required: ["name", "source", "tools"],
      properties: {
        name: {
          type: "string",
          description: AUTHORED_NAME_DESCRIPTION,
        },
        title: {
          type: "string",
          description: "Human-readable display title (1-80 characters).",
        },
        description: {
          type: "string",
          description: "Summary of the capsule's purpose and capabilities (1-500 characters).",
        },
        version: {
          type: "string",
          description: "Semver version string (defaults to '0.1.0').",
        },
        source: {
          type: "string",
          description:
            "Guest JavaScript source code evaluated in the QuickJS sandbox. Must define tool handlers on `globalThis.tools` (e.g. `globalThis.tools = { my_tool(args) { return { result: 'ok' }; } }`). Sandboxed runtime APIs are available on `globalThis.capsule`: `capsule.fetch(url, init)` (when net capability is declared), `capsule.kv.get(key)` / `capsule.kv.set(key, val)` (when kv enabled), `capsule.sql.query(sql, params)` / `capsule.sql.exec(sql, params)` (when sql enabled), and `capsule.log(message)`, `capsule.now()` (an ISO-8601 timestamp string) and `capsule.random(n)` (n random bytes as lowercase hex) (no capability required). Every op a handler calls must also be declared in that tool's `effects`, or that call is refused when the tool runs: `capsule.log` needs \"log.write\", `capsule.kv.get` / `capsule.kv.set` need \"kv.get\" / \"kv.set\", `capsule.sql.query` / `capsule.sql.exec` need \"sql.query\" / \"sql.exec\", `capsule.fetch` needs \"net.fetch\", and reading the clock or randomness (`capsule.now()`, `new Date()`, `Date.now()`, `capsule.random(n)`, `Math.random()`) needs \"clock.now\" / \"random.bytes\".",
        },
        tools: {
          type: "array",
          description: "Array of tool definitions exposed to the LLM agent (1-64 tools).",
          items: {
            type: "object",
            required: ["name"],
            properties: {
              name: {
                type: "string",
                description:
                  "Tool name ([a-zA-Z0-9_-], 1-64 characters) that must not start with 'capsule_', which is " +
                  "reserved for this host's built-in tools. Exposed as '<capsuleName>__<toolName>'.",
              },
              title: {
                type: "string",
                description: "Human-readable tool title (1-80 characters).",
              },
              description: {
                type: "string",
                description: "Clear operating instructions for the tool (1-1024 characters).",
              },
              inputSchema: {
                type: "object",
                description: "JSON Schema object for tool arguments.",
              },
              outputSchema: {
                type: "object",
                description: "Optional JSON Schema object for tool return value.",
              },
              effects: {
                type: "array",
                items: { type: "string" },
                description: EFFECTS_DESCRIPTION,
              },
            },
          },
        },
        capabilities: {
          type: "object",
          description: "Capabilities required by the capsule.",
          properties: {
            kv: {
              type: "boolean",
              description: "Enable persistent key-value storage (`capsule.kv.get(key)`, `capsule.kv.set(key, val)`).",
            },
            sql: {
              type: "boolean",
              description: "Enable persistent SQLite storage (`capsule.sql.query(sql, params)`, `capsule.sql.exec(sql, params)`).",
            },
            net: {
              type: "object",
              description: "Network egress capability configuration for `capsule.fetch`.",
              properties: {
                allowed_hosts: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Hosts `capsule.fetch` may reach, as lowercase domain names, at most 32 of them. An entry is either an exact host (`api.example.com`), or a `*.`-prefixed pattern (`*.example.com`) matching any subdomain below it but not the apex `example.com`, which has to be listed on its own. Every host that no entry matches is blocked, and IP addresses and loopback are never reachable through this list. Put only the hosts the user named here; never add a host of your own choosing.",
                },
              },
            },
          },
        },
        ui_html: {
          type: "string",
          description: UI_HTML_DESCRIPTION,
        },
        allow_suspicious: {
          type: "boolean",
          description:
            "Explicitly allow installing a capsule despite suspicious prompt injection markers or formatting in descriptions/schemas.",
        },
        accept_drift: {
          type: "boolean",
          description:
            "Explicitly accept re-pinning the tool catalog when a capsule of this name is already pinned to a different one.",
        },
      },
    },
    effects: [],
  },
  {
    name: "capsule_update",
    title: "Update Capsule",
    description:
      "Update an existing Agent Capsule's guest JavaScript source code, tool definitions, capabilities, or metadata. Re-signs with local key, runs conformance tests, updates installation, and refreshes the .mcpb bundle.",
    inputSchema: {
      type: "object",
      properties: {
        capsuleId: {
          type: "string",
          description:
            "ID of the installed capsule to update. If 'name' is given too, both must address the same capsule.",
        },
        name: {
          type: "string",
          description: `Name of the capsule to update. ${AUTHORED_NAME_DESCRIPTION}`,
        },
        title: {
          type: "string",
          description: "Updated title (1-80 characters).",
        },
        description: {
          type: "string",
          description: "Updated description (1-500 characters).",
        },
        version: {
          type: "string",
          description: "Explicit semver version string (auto-bumps patch if omitted).",
        },
        source: {
          type: "string",
          description: "Updated guest JavaScript source code evaluated in the QuickJS sandbox defining `globalThis.tools`.",
        },
        tools: {
          type: "array",
          description: "Updated array of tool definitions.",
          items: {
            type: "object",
            required: ["name"],
            properties: {
              name: { type: "string" },
              title: { type: "string" },
              description: { type: "string" },
              inputSchema: { type: "object" },
              outputSchema: { type: "object" },
              effects: { type: "array", items: { type: "string" }, description: EFFECTS_DESCRIPTION },
            },
          },
        },
        capabilities: {
          type: "object",
          properties: {
            kv: { type: "boolean" },
            sql: { type: "boolean" },
            net: {
              type: "object",
              properties: {
                allowed_hosts: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
        ui_html: {
          type: "string",
          description: `Updated UI content. ${UI_HTML_DESCRIPTION}`,
        },
        allow_suspicious: {
          type: "boolean",
          description:
            "Explicitly allow installing a capsule despite suspicious prompt injection markers or formatting in descriptions/schemas.",
        },
        accept_drift: {
          type: "boolean",
          description:
            "Explicitly accept re-pinning this capsule's tool catalog when the update changes the tools it declares.",
        },
      },
    },
    effects: [],
  },
  {
    name: "capsule_test_tool",
    title: "Test Capsule Tool",
    description:
      "Run one sandboxed test invocation of a tool in an installed capsule and return the exact output, run ID, and journaled effect count that a real call through the gateway produces, enabling verification before presenting to the user.",
    inputSchema: {
      type: "object",
      required: ["tool"],
      properties: {
        capsuleId: {
          type: "string",
          description: "ID of the capsule to test.",
        },
        name: {
          type: "string",
          description: "Name of the capsule to test.",
        },
        tool: {
          type: "string",
          description: "Bare name of the tool to invoke (without '<capsuleName>__' prefix).",
        },
        args: {
          type: "object",
          description: "Arguments to pass to the tool.",
        },
      },
    },
    effects: [],
  },
];

export const MANAGER_TOOLS: readonly CatalogTool[] = [
  {
    name: "capsule_install",
    title: "Install Capsule",
    description:
      "Install an Agent Capsule from a local file path (.capsule) or automatically from the Downloads folder. Performs full signature verification and TOFU pinning. Once installed, its tools are immediately exposed under '<capsuleName>__<toolName>' without restarting the agent.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative file path to the .capsule file to install. Use when the user specifies a path.",
        },
        from_downloads: {
          type: "boolean",
          description:
            "Scan the user's Downloads folder for .capsule files. If exactly 1 candidate is found, install it; if multiple, list candidates.",
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
    description: "Uninstall an installed Agent Capsule by capsuleId or name. Immediately removes its tools from the gateway.",
    inputSchema: {
      type: "object",
      properties: {
        capsuleId: {
          type: "string",
          description: "Payload digest ID (SHA-256) of the capsule to uninstall.",
        },
        name: {
          type: "string",
          description: "Name of the capsule to uninstall (uninstalls all instances with this name).",
        },
      },
    },
    effects: [],
  },
  {
    name: "capsule_list",
    title: "List Installed Capsules",
    description:
      "List all installed Agent Capsules, their publisher keys, trust state, declared capabilities, and " +
      "exposed gateway tools ('<capsuleName>__<toolName>'). Verifying an installed file against the trust " +
      "store never re-pins anything, and how long one verdict lasts depends on which way it went: a file " +
      "that verified is cached, and every later listing repeats that verdict until the next registry change " +
      "(install, update, uninstall) clears it, so a valid file altered underneath a running manager is " +
      "noticed on the next session or after the next registry change, not on the next listing; a file that " +
      "failed verification is not cached and is re-read from disk on every listing, so corrupt or " +
      "unverifiable state — and the tools it withheld — clears as soon as the file and the trust store are " +
      "right again, with no registry change needed. The trust state is one of exactly four: " +
      "'pinned' (this load pinned the name's publisher key and tool catalog), 'ok' (key and tool catalog " +
      "match the pin), 'corrupt' (the file failed signature, digest or trust verification — a tool catalog " +
      "that no longer matches its pin reads as corrupt here until accept_drift re-pins it), or " +
      "'unverifiable' (the file no longer matches the capsuleId it is pinned under). A corrupt or " +
      "unverifiable capsule serves no tools. 'drift-accepted' is not a state a listing reports: it belongs " +
      "to the capsule_install or capsule_update result that re-pinned a changed tool catalog, and that " +
      "capsule reads as 'ok' on every listing after it.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    effects: [],
  },
  ...AUTHORING_TOOLS,
];

export type ToolExecutionResult = {
  text: string;
  structured: Record<string, unknown>;
  isError: boolean;
};

/**
 * What every road into installation needs from the running manager: the two roads (`capsule_install`
 * and authoring's `capsule_create`/`capsule_update`) hand the same bag to `installLoadedCapsule`, so
 * one type names it once.
 */
export type ManagerPipelineOptions = {
  homeDir?: string;
  /** The user's Downloads override: where installs scan from and where sharing bundles are emitted. */
  downloadsDir?: string;
  warn: (line: string) => void;
  notifyListChanged: () => void;
  invalidateCache: () => void;
  /** The names the gateway really serves for a capsuleId, so the summary cannot over-promise. */
  servedTools: (capsuleId: string) => Promise<string[]>;
};

export type InstallLoadedOptions = {
  allowSuspicious?: boolean;
  actionWord?: "Installed" | "Created" | "Updated";
  targetFile?: string;
  exportMcpb?: boolean;
  shareHint?: string;
};

/**
 * Every reason this host refuses a capsule by reading its manifest alone: a name the gateway cannot
 * namespace, two tool names one human reads as one name, and text that screens as prompt injection.
 * `undefined` means it found nothing.
 *
 * Both roads into installation come through here, and for the authoring road *when* matters as much as
 * what: `loadCapsule` pins the name's key and tool catalog on first use, so a draft refused after that
 * load would leave a pin describing bytes this host never accepted — and the corrected draft, with the
 * offending description gone, would then read as tool-catalog drift. So authoring screens the manifest
 * it assembled before it packs and signs anything, and `installLoadedCapsule` screens the verified
 * manifest of a file that came from somewhere else. Same findings, same sentence, either way.
 */
export function screenManifest(
  manifest: Manifest,
  opts: { allowSuspicious: boolean; retry: string },
): ToolExecutionResult | undefined {
  const name = manifest.meta.name;

  // The gateway prefixes every tool with this name, so a name outside the namespace alphabet is
  // refused before the file is copied anywhere. Safe to interpolate: capsule.json already limits
  // `meta.name` to `[a-z0-9._-]`, and it is the `.` this rejects.
  if (!GATEWAY_NAME_PATTERN.test(name)) {
    const text =
      `Capsule '${name}' cannot be served by the gateway: its name must match ` +
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
      ...manifest.tools.map((tool) => tool.name),
      ...BUILTIN_TOOLS.map((tool) => tool.name),
    ]);
  } catch (err) {
    const detail = err instanceof CapsuleError ? err.message : String(err);
    const text =
      `Security Alert (Confusable Tool Names): Capsule '${name}' declares two tool ` +
      `names that read as the same name (${detail}). Installation refused.`;
    return { text, structured: { ok: false, error: "E_CONTENT", message: text }, isError: true };
  }

  // The catalog build is the screen: it is the same pass that decides what a model would be shown, so
  // a finding here is a finding about text the agent would have read. `meta` is scanned too, since the
  // title and description reach the model through `capsule_list` and the install summary.
  const findings: string[] = [];
  buildToolList(manifest, { allowSuspicious: false, warn: (line) => findings.push(line) });
  const metaMarkers = scanTextTree([manifest.meta.title, manifest.meta.description]);
  if (metaMarkers.length > 0) {
    findings.push(`metadata: ${metaMarkers.join(", ")}`);
  }
  if (findings.length > 0 && !opts.allowSuspicious) {
    const text =
      `Security Warning (Suspicious Content): Capsule contains suspicious patterns or prompt injection markers (${findings.join("; ")}). ` +
      `To install anyway, re-run ${opts.retry}.`;
    return {
      text,
      structured: { ok: false, error: "E_SUSPICIOUS", findings, message: text },
      isError: true,
    };
  }

  return undefined;
}

/**
 * A `loadCapsule` failure as a result the agent reads, with the two trust refusals named in plain
 * language instead of as an E-code. `retry` names how to re-run the caller's *own* tool with the drift
 * accepted, so an authored capsule and a downloaded one both end on a sentence the agent can act on —
 * and neither one re-pins a changed tool catalog without the user having said so (§6-2).
 */
export function loadRefusal(err: unknown, retry: string): ToolExecutionResult {
  if (err instanceof CapsuleError) {
    if (err.code === "E_TRUST" && err.message.includes("tool catalog changed")) {
      const name = (err.detail["name"] as string) ?? "unknown";
      const text =
        `Security Alert (Key Drift): The publisher key for capsule '${name}' is already pinned, but its tool catalog has changed. ` +
        `This could indicate an unexpected modification or rug-pull. ` +
        `If you trust this updated tool catalog, re-run ${retry}.`;
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

export async function installLoadedCapsule(
  loaded: LoadedCapsule,
  opts: ManagerPipelineOptions,
  installOpts: InstallLoadedOptions = {},
): Promise<ToolExecutionResult> {
  const allowSuspicious = installOpts.allowSuspicious === true;
  const actionWord = installOpts.actionWord ?? "Installed";
  const isAuthoring = actionWord === "Created" || actionWord === "Updated";
  const callerToolName = isAuthoring
    ? actionWord === "Created"
      ? "capsule_create"
      : "capsule_update"
    : "capsule_install";

  const refusal = screenManifest(loaded.manifest, {
    allowSuspicious,
    retry:
      installOpts.targetFile === undefined
        ? `${callerToolName} with { allow_suspicious: true }`
        : `capsule_install with { path: "${installOpts.targetFile}", allow_suspicious: true }`,
  });
  if (refusal !== undefined) return refusal;

  const destPath = installedCapsulePath(
    loaded.manifest.meta.name,
    loaded.manifest.meta.version,
    opts.homeDir,
  );
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

  let mcpbFile: string | undefined;
  if (installOpts.exportMcpb) {
    try {
      // Into the user's Downloads folder, not under `~/.agent-capsule/`: this file exists to be
      // found and sent onward, and a dotfolder is where share artifacts go to be forgotten.
      const mcpbDest = join(
        resolveDownloadsDir(opts.downloadsDir),
        `${loaded.manifest.meta.name}-${loaded.manifest.meta.version}.mcpb`,
      );
      // Manager-seeded on purpose: the bundle an author shares from conversation carries the
      // platform with the app, so the recipient can author and share capsules too — a bare
      // single-app bundle remains available via `capsule export-mcpb` without `--manager`.
      mcpbFile = await exportMcpb(destPath, mcpbDest, { manager: true });
    } catch (err) {
      opts.warn(`Warning: failed to export .mcpb bundle: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const caps = declaredCapabilities(loaded.manifest);
  // Read back from the gateway rather than from this manifest: a capsule whose names collide with one
  // already installed is suppressed there, and a summary that named tools nobody can call would send
  // the agent looking for them.
  const gatewayTools = await opts.servedTools(loaded.capsuleId);

  const titleLine =
    actionWord === "Installed"
      ? `Installed capsule '${loaded.manifest.meta.name}@${loaded.manifest.meta.version}' successfully.`
      : `${actionWord} and installed capsule '${loaded.manifest.meta.name}@${loaded.manifest.meta.version}' successfully.`;

  const lines: string[] = [
    titleLine,
    `• Capsule ID: ${loaded.capsuleId}`,
    `• Publisher Key: ${loaded.keyId}`,
    `• Trust State: ${loaded.trust}`,
    `• Declared Capabilities: ${caps}`,
  ];

  if (isAuthoring) {
    lines.push(`• File: ${destPath}`);
    if (mcpbFile) {
      lines.push(`• MCPB Bundle: ${mcpbFile}`);
    }
  }

  lines.push(`• Exposed Tools: ${gatewayTools.length > 0 ? gatewayTools.join(", ") : "none"}`);

  if (gatewayTools.length === 0) {
    lines.push(
      `• Warning: no tools are exposed — its tool names collide with an already installed capsule, ` +
        `so this capsule is suppressed. Uninstall the other capsule to use this one.`,
    );
  }

  if (installOpts.shareHint) {
    lines.push(`• Share: ${installOpts.shareHint}`);
  }

  const text = lines.join("\n");

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
      ...(isAuthoring ? { file: destPath } : {}),
      ...(mcpbFile ? { mcpb_file: mcpbFile } : {}),
      tools: gatewayTools,
      ...(installOpts.shareHint ? { share_hint: installOpts.shareHint } : {}),
      message: text,
    },
    isError: false,
  };
}

export async function handleCapsuleInstall(
  rawArgs: unknown,
  opts: ManagerPipelineOptions,
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
    return loadRefusal(err, `capsule_install with { path: "${targetFile}", accept_drift: true }`);
  }

  return installLoadedCapsule(loaded, opts, {
    allowSuspicious,
    actionWord: "Installed",
    targetFile,
  });
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
  /** One of `LISTED_TRUST_STATES`: `pinned`/`ok` from the loader, or how the installed file failed. */
  trust: (typeof LISTED_TRUST_STATES)[number];
  capabilities: string;
  tools: string[];
  note?: string;
};

/**
 * The trust state a listing reports for a file that verified. A listing loads without `acceptDrift`
 * (src/mcp/manager/server.ts), so `drift-accepted` cannot come back from that load; if it ever did,
 * something re-pinned a changed tool catalog where §6.2 says only a user-approved install or update
 * may, and the honest row for such bytes is `corrupt` — not a listing state this host does not have.
 */
export function listedTrust(trust: LoadedCapsule["trust"]): ListedCapsule["trust"] {
  return trust === "drift-accepted" ? "corrupt" : trust;
}

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
