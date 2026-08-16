import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { claudeStoreConfigPath } from "../commands/inject.ts";
import { buildSharePayload } from "../commands/share.ts";
import { asRecord } from "../core/canonical.ts";
import { CapsuleError } from "../core/errors.ts";
import type { LoadedCapsule } from "../format/capsule.ts";
import { assertNoToolNameCollision, buildToolList, type CatalogTool } from "../mcp/catalog.ts";
import { DECISION, INPUT_REQUIRED, type Decision } from "../mcp/mrtr.ts";
import { invokeTool, type InvokeError, type InvokeResult } from "../runtime/invoke.ts";
import { buildPolicy } from "../runtime/policy.ts";
import { addGrant, loadGrants, saveGrants, type GrantsStore } from "../security/grants.ts";

/** The only interface this server is ever allowed to answer on. */
const HOST = "127.0.0.1";
/** 32 bytes of `randomBytes`, hex — the whole authority of a browser tab, so it is not shortened. */
const TOKEN_BYTES = 32;
/** A tool call is a small JSON document; anything larger is not one. */
const MAX_BODY_BYTES = 64 * 1024;
/** Half an hour of nobody using it is long enough to be sure nobody is. */
const DEFAULT_IDLE_MS = 30 * 60 * 1000;

/**
 * The `Host` values that name *this* server, for the DNS-rebinding check. A browser leaves the port
 * out of `Host` when it is the scheme's default, so on port 80 `127.0.0.1` and `localhost` are the
 * same origin as `127.0.0.1:80` — spelling, not a rebinding attempt. On any other port a port-less
 * `Host` names a different origin and stays refused.
 */
export function allowedHosts(port: number): string[] {
  return port === 80
    ? [`${HOST}:80`, "localhost:80", HOST, "localhost"]
    : [`${HOST}:${port}`, `localhost:${port}`];
}

/**
 * Container entries the static route may serve, by name, exactly as `ui/**` and nothing else. The
 * character class is the container's own (`assertLegalPath`), so a name this accepts is a name the
 * container could hold — and `%2e%2e`, a backslash or a space fail the pattern before any lookup.
 */
const UI_PATH = /^\/ui\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

/**
 * A CSP source expression this server is willing to write into a header: scheme, host, optional
 * port. A manifest cannot currently carry anything else — `parseManifest` requires every
 * `connectDomains` entry to resolve to a host in `capabilities.net.allowed_hosts`, and that
 * allow-list is a strict hostname pattern — but the header must not depend on that chain holding:
 * one space or semicolon reaching this string would end the directive and let the manifest author
 * write the rest of the policy.
 */
const CSP_SOURCE = /^https?:\/\/(\*\.)?[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:\d{1,5})?$/;

/**
 * Enough to serve a UI, and nothing whose type invites the browser to run it. Anything else is
 * `application/octet-stream`, which under `nosniff` is a download rather than a guess.
 */
const CONTENT_TYPES = new Map<string, string>([
  ["html", "text/html; charset=utf-8"],
  ["js", "text/javascript; charset=utf-8"],
  ["mjs", "text/javascript; charset=utf-8"],
  ["css", "text/css; charset=utf-8"],
  ["json", "application/json"],
  ["txt", "text/plain; charset=utf-8"],
  ["svg", "image/svg+xml"],
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["ico", "image/x-icon"],
]);

export type UiServerOptions = {
  capsule: LoadedCapsule;
  /** Ephemeral by default: a fixed port is a port something else can be waiting on. */
  port?: number;
  token?: string;
  /** The user's answers as the caller supplies them; absent means the grant store in the home. */
  grants?: Record<string, boolean> | GrantsStore;
  statePath?: string;
  journalPath?: string;
  homeDir?: string;
  /** Milliseconds of inactivity after which the server closes itself. `0` disables it. */
  idleTimeoutMs?: number;
  /** Where diagnostics go. Defaults to stderr, because stdout carries the URL. */
  warn?: (line: string) => void;
};

export type UiServer = {
  port: number;
  token: string;
  url: string;
  /** Resolves once the server has stopped listening, whether it was closed or timed out. */
  closed: Promise<void>;
  close(): Promise<void>;
};

/** What `POST /rpc` answers: a finished call, or the consent question that has to come first. */
export type UiCallResponse =
  | {
      status: "complete";
      ok: boolean;
      tool: string;
      value?: unknown;
      error?: InvokeError;
      runId?: string;
      ms?: number;
      events?: number;
      effects?: number;
    }
  | { status: typeof INPUT_REQUIRED; tool: string; missingGrants: string[] };

/** The media type alone: `application/json; charset=utf-8` is `application/json`. */
function mediaType(value: string | undefined): string {
  return (value ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/**
 * The sha256 of every inline script in the page, as CSP source expressions.
 *
 * This is the one place this server departs from the plan's literal header, and it is a narrowing
 * rather than a widening. `script-src 'self'` alone blocks every inline script, so a single-file
 * capsule page — which is all `ui.local.path` can be, the schema requires one `.html` — could never
 * run the code that calls `/rpc`, and the consent prompt in the plan's own item 7 would be
 * unreachable. `'unsafe-inline'` would fix that by also permitting any script injected later into
 * the page's DOM, and tool output *is* rendered into that DOM. A hash permits exactly the scripts
 * the signed container carries and nothing else.
 *
 * The extraction is deliberately fail-closed: a script this misses is a script the browser refuses,
 * and a hash for text that is not a script permits only a script byte-identical to text the signed
 * page already contains. Elements with `src` are left to `'self'`.
 */
function inlineScriptHashes(html: string): string[] {
  const hashes = new Set<string>();
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attributes = match[1] ?? "";
    const source = match[2] ?? "";
    if (source === "" || /\bsrc\s*=/i.test(attributes)) continue;
    hashes.add(`'sha256-${createHash("sha256").update(source, "utf8").digest("base64")}'`);
  }
  return [...hashes];
}

/**
 * One policy for every response, built once from the page and the manifest. `default-src 'none'` is
 * the point of it: what the page may do is the union of the directives below, so a directive nobody
 * wrote — `font-src`, `frame-src`, `object-src` — is denied rather than inherited.
 */
function contentSecurityPolicy(html: string, connectDomains: readonly string[]): string {
  return [
    "default-src 'none'",
    ["script-src", "'self'", ...inlineScriptHashes(html)].join(" "),
    // Inline *styles* are permitted where inline scripts are not: the worst a style can do to this
    // page is look wrong, and it has no way to reach `/rpc`.
    "style-src 'self' 'unsafe-inline'",
    // `resourceDomains` is deliberately absent: unlike `connectDomains` it is not required to be
    // covered by `capabilities.net.allowed_hosts`, so honouring it here would hand a capsule that
    // declared no network capability an image URL to exfiltrate through.
    "img-src 'self' data:",
    ["connect-src", "'self'", ...connectDomains].join(" "),
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** Constant-time so a wrong token cannot be improved on by measuring how wrong it was. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function renderInstallerHtml(capsule: LoadedCapsule, token?: string): string {
  const manifest = capsule.manifest;
  const share = buildSharePayload(capsule, capsule.file);
  const title = manifest.meta.title || manifest.meta.name;
  const description = manifest.meta.description || "";
  const netHosts = manifest.capabilities?.net?.allowed_hosts?.length
    ? manifest.capabilities.net.allowed_hosts.join(", ")
    : manifest.capabilities?.net?.allow_localhost
      ? "localhost only"
      : "None";
  const hasGuestUi = Boolean(manifest.ui?.local?.path ?? manifest.ui?.app?.path);
  const uiUrl = token ? `/?t=${encodeURIComponent(token)}` : "/";
  // The page never writes a client config, so it names the file a human would edit instead — and
  // names the Store overlay when that is the copy Claude Desktop actually reads (see inject.ts).
  const classicClaudeConfig =
    process.env.APPDATA === undefined
      ? undefined
      : join(process.env.APPDATA, "Claude", "claude_desktop_config.json");
  const claudeConfigPath =
    classicClaudeConfig === undefined
      ? "claude_desktop_config.json"
      : (claudeStoreConfigPath(classicClaudeConfig) ?? classicClaudeConfig);
  const mcpServersJson = JSON.stringify(share.mcp_servers_config, null, 2);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} - Agent Capsule</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --primary: #38bdf8;
      --primary-hover: #0ea5e9;
      --code-bg: #0b1120;
      --badge-bg: #334155;
      --badge-text: #e2e8f0;
      --success: #22c55e;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f8fafc;
        --card-bg: #ffffff;
        --border: #e2e8f0;
        --text: #0f172a;
        --text-muted: #64748b;
        --primary: #0284c7;
        --primary-hover: #0369a1;
        --code-bg: #f1f5f9;
        --badge-bg: #e2e8f0;
        --badge-text: #334155;
        --success: #16a34a;
      }
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      padding: 2rem 1rem;
    }
    .container { max-width: 800px; margin: 0 auto; }
    header { margin-bottom: 2rem; }
    h1 { font-size: 1.875rem; font-weight: 700; display: flex; align-items: baseline; gap: 0.75rem; flex-wrap: wrap; }
    .version { font-size: 1rem; font-weight: normal; color: var(--text-muted); }
    .description { margin-top: 0.5rem; color: var(--text-muted); font-size: 1.125rem; }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 0.75rem;
      padding: 1.5rem;
      margin-bottom: 1.5rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    .card h2 { font-size: 1.25rem; font-weight: 600; margin-bottom: 1rem; }
    .meta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; }
    .meta-item { display: flex; flex-direction: column; gap: 0.25rem; }
    .meta-label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
    .meta-value { font-family: monospace; font-size: 0.875rem; word-break: break-all; }
    .badge {
      display: inline-block;
      padding: 0.25rem 0.5rem;
      border-radius: 0.375rem;
      font-size: 0.75rem;
      font-weight: 500;
      background: var(--badge-bg);
      color: var(--badge-text);
    }
    .badge-success { background: rgba(34, 197, 94, 0.15); color: var(--success); }
    .tools-list { display: flex; flex-direction: column; gap: 1rem; }
    .tool-item {
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      padding: 1rem;
      background: var(--bg);
    }
    .tool-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 0.5rem; flex-wrap: wrap; gap: 0.5rem; }
    .tool-name { font-family: monospace; font-weight: 600; color: var(--primary); }
    .tool-effects { display: flex; gap: 0.375rem; flex-wrap: wrap; }
    .install-tabs { display: flex; flex-direction: column; gap: 1rem; }
    .install-option {
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      padding: 1.25rem;
      background: var(--bg);
    }
    .install-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; flex-wrap: wrap; gap: 0.5rem; }
    .install-title { font-weight: 600; font-size: 1rem; }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0.5rem 1rem;
      border-radius: 0.375rem;
      font-weight: 500;
      font-size: 0.875rem;
      cursor: pointer;
      text-decoration: none;
      border: 1px solid transparent;
      transition: all 0.15s;
    }
    .btn-primary { background: var(--primary); color: #fff; }
    .btn-primary:hover { background: var(--primary-hover); }
    .btn-secondary { background: var(--card-bg); border-color: var(--border); color: var(--text); }
    .btn-secondary:hover { background: var(--border); }
    pre {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 0.375rem;
      padding: 0.75rem 1rem;
      font-family: monospace;
      font-size: 0.8125rem;
      overflow-x: auto;
      margin-top: 0.5rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:1rem">
        <div>
          <h1>
            ${escapeHtml(title)}
            <span class="version">v${escapeHtml(manifest.meta.version)}</span>
          </h1>
          ${description ? `<p class="description">${escapeHtml(description)}</p>` : ""}
        </div>
        ${hasGuestUi ? `<a href="${escapeHtml(uiUrl)}" class="btn btn-primary">Open Capsule UI</a>` : ""}
      </div>
    </header>

    <div class="card">
      <h2>Capsule Identity &amp; Trust</h2>
      <div class="meta-grid">
        <div class="meta-item">
          <span class="meta-label">Capsule ID</span>
          <span class="meta-value">${escapeHtml(capsule.capsuleId)}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Publisher Key ID</span>
          <span class="meta-value">${escapeHtml(capsule.keyId)}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Trust Status</span>
          <span class="meta-value"><span class="badge badge-success">${escapeHtml(capsule.trust ?? "unpinned")}</span></span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Capsule File</span>
          <span class="meta-value">${escapeHtml(share.file)}</span>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Client Installation &amp; Sharing</h2>
      <div class="install-tabs">
        <div class="install-option">
          <div class="install-header">
            <span class="install-title">Add to Claude Desktop</span>
            <div style="display:flex;gap:0.5rem;align-items:center">
              ${share.mcpb_file ? `<span class="badge badge-success">Ready</span>` : ""}
              ${
                share.mcpb_file
                  ? `<button class="btn btn-secondary copy-btn" data-snippet="${escapeHtml(share.mcpb_file)}">Copy Bundle Path</button>`
                  : `<button class="btn btn-secondary copy-btn" data-snippet="capsule export-mcpb &quot;${escapeHtml(share.file)}&quot;">Copy Export Command</button>`
              }
            </div>
          </div>
          ${
            share.mcpb_file
              ? `<p style="color:var(--text-muted);font-size:0.875rem">Double-click the .mcpb bundle on your machine:</p><pre><code>${escapeHtml(share.mcpb_file)}</code></pre>`
              : `<p style="color:var(--text-muted);font-size:0.875rem">Export as a double-clickable bundle using:</p><pre><code>capsule export-mcpb "${escapeHtml(share.file)}"</code></pre>`
          }
          <p style="color:var(--text-muted);font-size:0.875rem">Or configure it by hand: this page writes nothing — paste the block below into <code>${escapeHtml(claudeConfigPath)}</code> yourself and restart Claude Desktop.</p>
          <pre><code>${escapeHtml(mcpServersJson)}</code></pre>
          <button class="btn btn-secondary copy-btn" data-snippet="${escapeHtml(mcpServersJson)}">Copy Claude Desktop JSON</button>
        </div>

        <div class="install-option">
          <div class="install-header">
            <span class="install-title">Cursor</span>
            <div style="display:flex;gap:0.5rem">
              <a href="${escapeHtml(share.cursor_deeplink)}" class="btn btn-primary">Install in Cursor</a>
              <button class="btn btn-secondary copy-btn" data-snippet="${escapeHtml(share.cursor_deeplink)}">Copy Link</button>
            </div>
          </div>
          <pre><code>${escapeHtml(share.cursor_deeplink)}</code></pre>
        </div>

        <div class="install-option">
          <div class="install-header">
            <span class="install-title">VS Code</span>
            <div style="display:flex;gap:0.5rem">
              <a href="${escapeHtml(share.vscode_deeplink)}" class="btn btn-primary">Install in VS Code</a>
              <button class="btn btn-secondary copy-btn" data-snippet="${escapeHtml(share.vscode_deeplink)}">Copy Link</button>
            </div>
          </div>
          <pre><code>${escapeHtml(share.vscode_deeplink)}</code></pre>
        </div>

        <div class="install-option">
          <div class="install-header">
            <span class="install-title">Claude Code / Terminal (npx)</span>
            <button class="btn btn-secondary copy-btn" data-snippet="${escapeHtml(share.npx_command)}">Copy Command</button>
          </div>
          <pre><code>${escapeHtml(share.npx_command)}</code></pre>
        </div>

        <div class="install-option">
          <div class="install-header">
            <span class="install-title">Generic MCP Client (mcpServers JSON)</span>
            <button class="btn btn-secondary copy-btn">Copy JSON</button>
          </div>
          <pre><code>${escapeHtml(mcpServersJson)}</code></pre>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Declared Capabilities</h2>
      <div class="meta-grid">
        <div class="meta-item">
          <span class="meta-label">KV Storage</span>
          <span class="meta-value">${manifest.capabilities?.kv ? "Enabled" : "Disabled"}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">SQL Database</span>
          <span class="meta-value">${manifest.capabilities?.sql ? "Enabled" : "Disabled"}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Package Export</span>
          <span class="meta-value">${manifest.capabilities?.pack ? "Enabled" : "Disabled"}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Network Egress</span>
          <span class="meta-value">${escapeHtml(netHosts)}</span>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Tools (${manifest.tools.length})</h2>
      <div class="tools-list">
        ${manifest.tools
          .map(
            (tool) => `
          <div class="tool-item">
            <div class="tool-header">
              <span class="tool-name">${escapeHtml(tool.name)}</span>
              <div class="tool-effects">
                ${(tool.effects || []).map((eff) => `<span class="badge">${escapeHtml(eff)}</span>`).join(" ")}
              </div>
            </div>
            ${tool.description ? `<p style="color:var(--text-muted);font-size:0.875rem">${escapeHtml(tool.description)}</p>` : ""}
          </div>
        `,
          )
          .join("")}
      </div>
    </div>
  </div>

  <script>
    document.querySelectorAll(".copy-btn").forEach(function(btn) {
      btn.addEventListener("click", function() {
        var text = btn.getAttribute("data-snippet");
        if (!text) {
          var target = btn.closest(".install-option").querySelector("pre code");
          text = target ? target.innerText : "";
        }
        navigator.clipboard.writeText(text).then(function() {
          var orig = btn.innerText;
          btn.innerText = "Copied!";
          setTimeout(function() { btn.innerText = orig; }, 2000);
        });
      });
    });
  </script>
</body>
</html>`;
}

/**
 * A loopback HTTP server for the capsule's own page, and the only component of this system a browser
 * can reach. Three things keep it from being an authority anybody else can borrow:
 *
 *  * it listens on `127.0.0.1` only, so nothing off this machine has a route to it at all;
 *  * every route requires the per-process token, which is minted here and printed once; and
 *  * every request's `Host` header must name this port on a loopback name, so a DNS rebinding attack
 *    — the browser resolving the attacker's own domain to `127.0.0.1` and carrying the token for
 *    them — arrives with the attacker's hostname in it and is refused.
 *
 * The page itself is served byte-for-byte out of the signed container when a UI page is declared.
 * When no guest UI page is declared, it serves a standalone discovery and installer page with
 * client connection snippets.
 */
export async function startUiServer(opts: UiServerOptions): Promise<UiServer> {
  const { capsule } = opts;
  const manifest = capsule.manifest;
  const warn =
    opts.warn ??
    ((line: string): void => {
      process.stderr.write(`${line}\n`);
    });

  // The local page is `ui.local.path` when the manifest names one, and the MCP App's page otherwise:
  // one capsule, one UI, served two ways. If none is declared, the installer discovery page is served.
  const pagePath = manifest.ui?.local?.path ?? manifest.ui?.app?.path;
  const hasGuestUi = pagePath !== undefined;

  // Refused here rather than on first request, and before a port exists: a capsule whose tool list
  // cannot be shown safely must not be reachable at all. The names a human reads in a browser are
  // the same phishing surface as the names a model reads over MCP.
  assertNoToolNameCollision(manifest.tools.map((tool) => tool.name));
  const declared = new Set(manifest.tools.map((tool) => tool.name));
  // The catalog's own list, so a tool suppressed for hostile text is not callable here either — the
  // UI must not be a way around a decision MCP already made. Built-ins are left out: this server
  // invokes through `invokeTool`, which only knows the capsule's own tools.
  const tools: CatalogTool[] = buildToolList(manifest, { allowSuspicious: false, warn }).filter((tool) =>
    declared.has(tool.name),
  );
  const served = new Set(tools.map((tool) => tool.name));

  const token = opts.token ?? randomBytes(TOKEN_BYTES).toString("hex");
  const idleMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_MS;

  const installerHtml = renderInstallerHtml(capsule, token);
  const installerBuffer = Buffer.from(installerHtml, "utf8");

  let pageBuffer: Buffer;
  let guestPageCsp: string;
  const installerCsp = contentSecurityPolicy(installerHtml, []);

  const connectDomains = (manifest.ui?.app?.csp?.connectDomains ?? []).filter((domain) => {
    if (CSP_SOURCE.test(domain)) return true;
    warn("ui: ignoring an unusable connect-src source in capsule.json");
    return false;
  });

  if (hasGuestUi && pagePath) {
    const rawPage = await capsule.reader.read(pagePath);
    pageBuffer = rawPage;
    guestPageCsp = contentSecurityPolicy(rawPage.toString("utf8"), connectDomains);
  } else {
    pageBuffer = installerBuffer;
    guestPageCsp = installerCsp;
  }

  const toolsBody = Buffer.from(JSON.stringify({ tools }), "utf8");

  const securityHeaders: Record<string, string> = {
    "content-security-policy": guestPageCsp,
    "x-content-type-options": "nosniff",
    // Redundant beside `frame-ancestors 'none'` and free: the two are read by different browsers.
    "x-frame-options": "DENY",
    // The token is in the URL of the page, so nothing may carry that URL anywhere.
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
    "cross-origin-resource-policy": "same-origin",
  };

  const send = (
    res: ServerResponse,
    status: number,
    contentType: string,
    body: Buffer,
    extra: Record<string, string> = {},
  ): void => {
    res.writeHead(status, {
      ...securityHeaders,
      ...extra,
      "content-type": contentType,
      "content-length": body.byteLength,
    });
    res.end(body);
  };

  // Refusals say only what happened. Nothing from the request is echoed, so a response can never be
  // made to carry text somebody else chose.
  const refuse = (res: ServerResponse, status: number, reason: string, extra?: Record<string, string>): void => {
    send(res, status, "text/plain; charset=utf-8", Buffer.from(`${status} ${reason}\n`, "utf8"), extra);
  };

  const sendJson = (res: ServerResponse, status: number, value: unknown): void => {
    send(res, status, "application/json", Buffer.from(JSON.stringify(value), "utf8"));
  };

  /**
   * Everything the run needs, and the consent answers the user has just given. A grant approved for
   * one call is passed as this call's own answers rather than written anywhere: `allow-once` means
   * once. By the time a run is opened nothing the tool needs is missing, so handing it every grant
   * the tool requires is the same set the store would have produced — without a store.
   */
  const call = async (tool: string, args: unknown, decisions: Record<string, Decision>): Promise<UiCallResponse> => {
    const policy = buildPolicy({
      manifest,
      capsuleId: capsule.capsuleId,
      grants: opts.grants ?? loadGrants(opts.homeDir),
    });

    const approved = new Set<string>();
    const missing = policy.missingGrants(tool);
    for (const grant of missing) {
      const decision = Object.hasOwn(decisions, grant) ? decisions[grant] : undefined;
      if (decision === DECISION.deny) {
        return {
          status: "complete",
          ok: false,
          tool,
          error: { code: "E_POLICY", message: `user denied ${grant}` },
        };
      }
      if (decision === DECISION.alwaysAllow) {
        // Read, add, write: the file is the user's, and another capsule's answers in it are none of
        // this call's business.
        const store = loadGrants(opts.homeDir);
        addGrant(store, capsule.capsuleId, grant);
        saveGrants(store, opts.homeDir);
        approved.add(grant);
      } else if (decision === DECISION.allowOnce) {
        approved.add(grant);
      }
    }

    // The policy resolved the store when it was built, so this is the same list as above: what the
    // user has just answered is what changes it, not what `always-allow` wrote to disk.
    const unanswered = missing.filter((grant) => !approved.has(grant));
    if (unanswered.length > 0) {
      return { status: INPUT_REQUIRED, tool, missingGrants: unanswered };
    }

    const result: InvokeResult = await invokeTool({
      capsule,
      tool,
      args,
      grants:
        approved.size === 0
          ? opts.grants
          : Object.fromEntries(policy.requiredGrants(tool).map((grant) => [grant, true])),
      ...(opts.statePath === undefined ? {} : { statePath: opts.statePath }),
      ...(opts.journalPath === undefined ? {} : { journalPath: opts.journalPath }),
      ...(opts.homeDir === undefined ? {} : { homeDir: opts.homeDir }),
    });
    return { status: "complete", ...result };
  };

  /**
   * The request body, or nothing at all when it is too big to be a tool call. The cap is applied to
   * what has arrived rather than to what was declared, so a client that understates its
   * `Content-Length` is stopped by the same check.
   */
  const readBody = (req: IncomingMessage): Promise<Buffer | undefined> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > MAX_BODY_BYTES) {
          req.pause();
          resolve(undefined);
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });

  /**
   * `POST /rpc` and `POST /rpc/consent`. Two headers stand between an HTML form on another page and
   * a tool call: a form can only ever send `text/plain`, `multipart/form-data` or
   * `application/x-www-form-urlencoded`, so requiring `application/json` refuses all three, and a
   * browser that sends `Sec-Fetch-Site` has already told us whether the request came from our own
   * page. Neither replaces the token; both are free.
   */
  const handleCall = async (req: IncomingMessage, res: ServerResponse, consent: boolean): Promise<void> => {
    const site = req.headers["sec-fetch-site"];
    if (typeof site === "string" && site !== "same-origin") {
      return refuse(res, 403, "forbidden");
    }
    if (mediaType(req.headers["content-type"]) !== "application/json") {
      return refuse(res, 415, "unsupported media type");
    }
    const body = await readBody(req);
    if (body === undefined) {
      // The request was not read to the end, so the socket goes with the answer.
      return refuse(res, 413, "payload too large", { connection: "close" });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      return refuse(res, 400, "bad request");
    }
    const request = asRecord(parsed);
    const tool = request?.["tool"];
    if (typeof tool !== "string" || tool === "") {
      return refuse(res, 400, "bad request");
    }
    const rawArgs = request?.["args"];
    const args = rawArgs === undefined ? {} : asRecord(rawArgs);
    if (args === undefined) {
      return refuse(res, 400, "bad request");
    }

    // The three answers, and only for the route that asks for them. A `/rpc` retry that carried its
    // own decisions would be a page granting itself a capability.
    const decisions: Record<string, Decision> = Object.create(null) as Record<string, Decision>;
    if (consent) {
      const given = asRecord(request?.["decisions"]);
      if (given === undefined) return refuse(res, 400, "bad request");
      for (const [grant, decision] of Object.entries(given)) {
        if (decision !== DECISION.allowOnce && decision !== DECISION.alwaysAllow && decision !== DECISION.deny) {
          return refuse(res, 400, "bad request");
        }
        decisions[grant] = decision;
      }
    }

    if (!served.has(tool)) {
      // Shaped like any other refused call: a page has to be able to render it.
      return sendJson(res, 200, {
        status: "complete",
        ok: false,
        tool,
        error: { code: "E_USAGE", message: "unknown tool" },
      } satisfies UiCallResponse);
    }
    sendJson(res, 200, await call(tool, args, decisions));
  };

  const handleStatic = async (path: string, res: ServerResponse): Promise<void> => {
    // The container's entry names are the whole of the namespace: an exact lookup, nothing joined,
    // nothing resolved, so `..` is a name that is not in the map rather than a path that escapes it.
    const entry = path.slice(1);
    const dotted = (segment: string): boolean => segment === "." || segment === "..";
    if (!UI_PATH.test(path) || path.split("/").some(dotted) || !capsule.reader.has(entry)) {
      return refuse(res, 404, "not found");
    }
    const extension = (entry.split(".").pop() ?? "").toLowerCase();
    send(res, 200, CONTENT_TYPES.get(extension) ?? "application/octet-stream", await capsule.reader.read(entry));
  };

  const server: Server = createServer();
  // Assigned in the listen callback, before any request can be dispatched: the `Host` check compares
  // against it, so it must never be read as the 0 that asked for an ephemeral port.
  let boundPort = 0;
  let markClosed: () => void = (): void => {};
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  let closing: Promise<void> | undefined;
  let idle: NodeJS.Timeout | undefined;

  const close = (): Promise<void> => {
    closing ??= (async (): Promise<void> => {
      if (idle !== undefined) clearTimeout(idle);
      // `close` alone waits for keep-alive sockets that nothing is going to close, and a browser
      // leaves one open on every page it has ever loaded from here.
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      markClosed();
    })();
    return closing;
  };

  /**
   * The idle clock, restarted by every *authorised* request. An unauthenticated one does not count:
   * anything that can reach the port could otherwise keep the server alive by knocking on it.
   * Unref'd, so the clock is never the reason a process stays up — the listening socket is.
   */
  const touch = (): void => {
    if (idleMs <= 0) return;
    if (idle !== undefined) clearTimeout(idle);
    idle = setTimeout(() => {
      void close();
    }, idleMs);
    idle.unref();
  };

  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    // A client that hangs up mid-request is ordinary, not a reason to take the process with it.
    req.on("error", () => {});
    res.on("error", () => {});

    const target = req.url ?? "/";
    const mark = target.indexOf("?");
    // The path is taken as the client wrote it. Parsing it as a URL would resolve `..` away and turn
    // `/assets/../capsule.json` into a request for a file outside `ui/`.
    const path = mark === -1 ? target : target.slice(0, mark);
    const query = new URLSearchParams(mark === -1 ? "" : target.slice(mark + 1));

    const host = (req.headers.host ?? "").toLowerCase();
    if (!allowedHosts(boundPort).includes(host)) {
      return refuse(res, 403, "forbidden");
    }

    const authorization = req.headers.authorization ?? "";
    const bearer = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
    const header = req.headers["x-capsule-token"];
    // The ways a page can present it: the URL the user opened, or either header a `fetch` can set
    // without putting the token in a URL. The *first* one presented is the one that has to match, so
    // a request gets one attempt rather than one per place a token can go.
    const presented = [
      query.get("t"),
      query.get("token"),
      bearer === "" ? null : bearer,
      typeof header === "string" ? header : null,
    ].find((value) => value !== null);
    if (presented === undefined || presented === "" || !tokenMatches(presented, token)) {
      return refuse(res, 401, "unauthorized", { "www-authenticate": "Bearer" });
    }
    touch();

    const route = `${req.method ?? ""} ${path}`;
    void (async (): Promise<void> => {
      try {
        switch (route) {
          case "GET /":
          case "GET /index.html":
            return send(res, 200, "text/html; charset=utf-8", pageBuffer);
          case "GET /installer":
          case "GET /installer.html":
            return send(res, 200, "text/html; charset=utf-8", installerBuffer, {
              "content-security-policy": installerCsp,
            });
          case "GET /api/tools":
            return send(res, 200, "application/json", toolsBody);
          case "POST /rpc":
          case "POST /api/call":
            return await handleCall(req, res, false);
          case "POST /rpc/consent":
            return await handleCall(req, res, true);
          default:
            if (req.method === "GET") return await handleStatic(path, res);
            return refuse(res, 404, "not found");
        }
      } catch (err) {
        // Our failure, not the page's business: a code on stderr and a bare 500 on the wire.
        warn(`ui: ${route} failed: ${err instanceof CapsuleError ? `${err.code}: ${err.message}` : String(err)}`);
        if (!res.headersSent) refuse(res, 500, "internal error");
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      reject(new CapsuleError("E_USAGE", `cannot listen on ${HOST}:${opts.port ?? 0}: ${err.message}`));
    };
    server.once("error", onError);
    // `exclusive` so a second capsule on a named port is an error the user sees rather than a
    // silent share of the same port with whatever is already there.
    server.listen({ host: HOST, port: opts.port ?? 0, exclusive: true }, () => {
      server.off("error", onError);
      boundPort = (server.address() as AddressInfo).port;
      resolve();
    });
  });
  server.on("error", (err: Error) => warn(`ui: server error: ${err.message}`));

  touch();

  return { port: boundPort, token, url: `http://${HOST}:${boundPort}/?t=${token}`, closed, close };
}
