import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
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
 * The page itself is served byte-for-byte out of the signed container. Nothing is injected into it:
 * the bytes the browser renders are the bytes the statement digest covers, so the page's own
 * bootstrap reads the token out of `location.search` and calls `/rpc` with it. Assets under `/ui/`
 * need the token too, which is why a page that loads its own script asks for it as
 * `/ui/app.js?t=<token>` rather than with a bare `<script src>`.
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
  // one capsule, one UI, served two ways.
  const pagePath = manifest.ui?.local?.path ?? manifest.ui?.app?.path;
  if (pagePath === undefined) {
    throw new CapsuleError("E_MANIFEST", "capsule does not declare a ui page to serve (ui.local.path)", {
      file: capsule.file,
    });
  }

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

  const page = await capsule.reader.read(pagePath);
  const connectDomains = (manifest.ui?.app?.csp?.connectDomains ?? []).filter((domain) => {
    if (CSP_SOURCE.test(domain)) return true;
    warn("ui: ignoring an unusable connect-src source in capsule.json");
    return false;
  });
  const csp = contentSecurityPolicy(page.toString("utf8"), connectDomains);
  const toolsBody = Buffer.from(JSON.stringify({ tools }), "utf8");

  const token = opts.token ?? randomBytes(TOKEN_BYTES).toString("hex");
  const idleMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_MS;

  const securityHeaders: Record<string, string> = {
    "content-security-policy": csp,
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
    if (host !== `${HOST}:${boundPort}` && host !== `localhost:${boundPort}`) {
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
            return send(res, 200, "text/html; charset=utf-8", page);
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
