import { asRecord } from "../core/canonical.ts";
import { CapsuleError } from "../core/errors.ts";
import type { LoadedCapsule } from "../format/capsule.ts";
import type { Manifest } from "../format/manifest.ts";
import type { GrantsStore } from "../security/grants.ts";
import { sanitizeModelText } from "../security/text.ts";
import { readUiResource, UI_EXTENSION, UI_MIME_TYPE } from "./apps.ts";
import { BUILTIN_TOOLS } from "./builtin.ts";
import { handleToolsCall, type McpServerContext } from "./call.ts";
import { assertNoToolNameCollision, buildToolList, isTextMimeType, listResources } from "./catalog.ts";
import {
  JSON_RPC_ERROR,
  type JsonRpcErrorResponse,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcResponse,
  RpcFailure,
  type Transport,
} from "./transport.ts";

/** The one MCP revision this server speaks natively. */
export const MCP_PROTOCOL_VERSION = "2026-07-28";

/**
 * Every revision `initialize` may settle on, newest first. The pre-2026 entries exist because real
 * clients lag the specification — Claude Desktop 1.x handshakes with the newest pre-`2026-07-28`
 * revision it knows (`2025-11-25` in its extension host as of 1.28929) and disconnects when the
 * reply names a revision outside its own list. Every method this server answers is shape-compatible
 * with these revisions except the MRTR consent flow, which they cannot carry; `tools/call` degrades
 * that one case to a readable `E_CONSENT` result instead (see `handleToolsCall`).
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  MCP_PROTOCOL_VERSION,
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];

/**
 * The revision `initialize` settles on for a request. A supported revision is echoed back. An
 * unknown one is answered with the newest supported revision no newer than it — revisions are ISO
 * dates, so `<=` orders them — because the requester demonstrably lives at that date: Claude
 * Desktop's extension handshake asks with the newest pre-`2026-07-28` revision it knows and hangs
 * up on any reply newer than its request, so answering the native revision to a request this list
 * merely lags behind would refuse exactly the legacy clients the list exists for. A request older
 * than every entry gets the oldest entry, the nearest this server can serve. No request at all
 * stays native: the stateless profile lets a `2026-07-28` client skip `initialize` entirely, so
 * absence reads as native, not legacy. Disconnecting on a reply it cannot use is the client's call.
 */
export function negotiateProtocolVersion(requested: unknown): string {
  if (typeof requested !== "string") {
    return MCP_PROTOCOL_VERSION;
  }
  const nearest = SUPPORTED_PROTOCOL_VERSIONS.find((version) => version <= requested);
  return nearest ?? (SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1] as string);
}
/** The capsule specification the container itself conforms to. */
export const CAPSULE_SPEC = "agentcapsule.org/0.1";

/** A catalog is cheap to rebuild and may be re-signed by its author, so one hour. */
export const CATALOG_TTL_MS = 3_600_000;
/** Capsule content is immutable by construction — the statement digest covers it — so one day. */
const CONTENT_TTL_MS = 86_400_000;

/**
 * The contents entry `resources/read` serves for one URI of one capsule: the UI app when the URI is
 * its `resourceUri`, a declared resource when the URI matches one, `undefined` otherwise. Shared
 * with the manager gateway so a capsule's UI reads byte-identically through either server — and so
 * only declared paths are readable either way, since every byte served here is covered by the
 * signed statement digest.
 */
export async function readCapsuleResourceContents(
  capsule: LoadedCapsule,
  uri: string,
): Promise<Record<string, unknown> | undefined> {
  const manifest = capsule.manifest;
  if (manifest.ui?.app !== undefined && uri === manifest.ui.app.resourceUri) {
    return await readUiResource(capsule);
  }
  const resource = manifest.resources.find((candidate) => candidate.uri === uri);
  if (resource === undefined) {
    return undefined;
  }
  const bytes = await capsule.reader.read(resource.path);
  return {
    uri: resource.uri,
    mimeType: resource.mimeType,
    ...(isTextMimeType(resource.mimeType)
      ? { text: bytes.toString("utf8") }
      : { blob: bytes.toString("base64") }),
  };
}

/** The `_meta` key every result stamps this server's identity into. */
export const SERVER_INFO_META = "io.modelcontextprotocol/serverInfo";

/** One JSON-RPC method: params in, the body of a `result` out. */
export type RpcHandler = (params: unknown) => Record<string, unknown> | Promise<Record<string, unknown>>;

/**
 * The `_meta` a capsule's own results carry. The name is namespaced (`capsule/<name>`) so an agent
 * talking to several servers can tell a capsule from a native MCP server; the `serverInfo`/`server`
 * fields carry the capsule's own name. The gateway stamps the same identity on a routed call, so a
 * result reads the same whether the capsule was served directly or through the manager.
 */
export function capsuleResultMeta(manifest: Manifest): Record<string, unknown> {
  return { [SERVER_INFO_META]: { name: `capsule/${manifest.meta.name}`, version: manifest.meta.version } };
}

/**
 * The `result` builder, bound to one server's identity. The server's own metadata is written last,
 * so a run's `_meta` can never displace the identity of the server that produced it.
 */
export function createResultBuilder(
  resultMeta: Record<string, unknown>,
): (body: Record<string, unknown>, meta?: Record<string, unknown>) => Record<string, unknown> {
  return (body, meta) => ({
    resultType: "complete",
    ...body,
    _meta: { ...meta, ...resultMeta },
  });
}

/**
 * The JSON-RPC envelope every server on this host answers in: method lookup, the `result` wrapper,
 * and the two failure shapes. It is a function of the handler table alone, so the capsule server and
 * the manager gateway differ only in the handlers they register — never in what a peer sees on the
 * wire for an unknown method or a thrown handler.
 */
export function createRpcDispatcher(
  handlers: ReadonlyMap<string, RpcHandler>,
  warn: (line: string) => void,
): (msg: JsonRpcMessage) => Promise<JsonRpcResponse | JsonRpcErrorResponse | void> {
  const errorResponse = (id: JsonRpcId, code: number, message: string): JsonRpcErrorResponse => ({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });

  return async function handleMessage(
    msg: JsonRpcMessage,
  ): Promise<JsonRpcResponse | JsonRpcErrorResponse | void> {
    // Notifications and responses are answered with nothing: this revision has no server-initiated
    // requests, so there is never anything to say back.
    if (!("method" in msg) || !("id" in msg)) {
      return;
    }
    const handler = handlers.get(msg.method);
    if (handler === undefined) {
      return errorResponse(
        msg.id,
        JSON_RPC_ERROR.MethodNotFound,
        `method not found: ${sanitizeModelText(msg.method, 120)}`,
      );
    }
    try {
      return { jsonrpc: "2.0", id: msg.id, result: await handler(msg.params) };
    } catch (err) {
      if (err instanceof RpcFailure) {
        return errorResponse(msg.id, err.code, err.message);
      }
      // A container or host failure is our problem, not the peer's: it gets a code and a diagnostic
      // on stderr, never our internals on the wire.
      const detail = err instanceof CapsuleError ? `${err.code}: ${err.message}` : String(err);
      warn(`${msg.method} failed: ${detail}`);
      return errorResponse(msg.id, JSON_RPC_ERROR.InternalError, "internal error");
    }
  };
}

export type McpServerOptions = {
  capsule: LoadedCapsule;
  /** The user's answers, as `tools/call` resolves them; absent means the grant store in the home. */
  grants?: Record<string, boolean> | GrantsStore;
  statePath?: string;
  journalPath?: string;
  homeDir?: string;
  /** Serve tools whose text trips the injection scanner instead of suppressing them. */
  allowSuspicious?: boolean;
  /** Where diagnostics go. Defaults to stderr, because stdout is the JSON-RPC channel. */
  warn?: (line: string) => void;
};

export type McpServer = {
  handleMessage(msg: JsonRpcMessage): Promise<JsonRpcResponse | JsonRpcErrorResponse | void>;
  serve(transport: Transport): void;
};

/** The capability sentence in `instructions`: what this capsule may do, in the user's terms. */
export function declaredCapabilities(manifest: Manifest): string {
  const capabilities = manifest.capabilities;
  const declared: string[] = [];
  if (capabilities.sql) declared.push("sql");
  if (capabilities.kv) declared.push("kv");
  if (capabilities.pack) declared.push("pack");
  const hosts = [...capabilities.net.allowed_hosts, ...(capabilities.net.allow_localhost ? ["localhost"] : [])];
  if (hosts.length > 0) declared.push(`net(${hosts.join(", ")})`);
  return declared.length === 0 ? "none" : declared.join(", ");
}

export function createMcpServer(opts: McpServerOptions): McpServer {
  const capsule = opts.capsule;
  const manifest = capsule.manifest;
  const warn =
    opts.warn ??
    ((line: string): void => {
      process.stderr.write(`${line}\n`);
    });

  // Both refusals happen here rather than on first request: a capsule whose catalog cannot be served
  // safely must not get as far as answering `initialize`. The built-ins are checked alongside the
  // manifest's own tools, because the reserved-prefix rule is case-sensitive: `Capsule_info` is a
  // legal manifest name and the same name as `capsule_info` to whoever reads the list.
  assertNoToolNameCollision([
    ...manifest.tools.map((tool) => tool.name),
    ...BUILTIN_TOOLS.map((tool) => tool.name),
  ]);
  const tools = buildToolList(manifest, { allowSuspicious: opts.allowSuspicious === true, warn });
  const resources = listResources(manifest);

  // The revision this session settled on. Until `initialize` says otherwise the server is native:
  // the stateless profile allows a client to skip `initialize` entirely, and such a client is a
  // `2026-07-28` client by definition — no earlier revision permits the skip.
  let negotiatedVersion: string = MCP_PROTOCOL_VERSION;

  const serverInfo = { name: manifest.meta.name, version: manifest.meta.version };
  const resultMeta = capsuleResultMeta(manifest);

  // Everything `tools/call` is allowed to know, settled once. The served names are the catalog's own,
  // so a tool suppressed for suspicious text is not callable by name either — suppression is a
  // decision about the tool, not about the list it would have appeared in.
  const ctx: McpServerContext = {
    capsule,
    served: new Set(tools.map((tool) => tool.name)),
    grants: opts.grants,
    statePath: opts.statePath,
    journalPath: opts.journalPath,
    homeDir: opts.homeDir,
    warn,
    resultMeta,
    // A closure, not a value: the context is built before `initialize` has run.
    legacySession: () => negotiatedVersion !== MCP_PROTOCOL_VERSION,
  };

  const result = createResultBuilder(resultMeta);

  const capabilities = (): Record<string, unknown> => ({
    tools: { listChanged: false },
    resources: { listChanged: false },
    // Advertised only when there is an app to render: a client that sees the extension will ask for
    // the ui resource.
    ...(manifest.ui?.app === undefined
      ? {}
      : { extensions: { [UI_EXTENSION]: { mimeTypes: [UI_MIME_TYPE] } } }),
  });

  const instructions = (): string =>
    `${sanitizeModelText(manifest.meta.title)}: ${sanitizeModelText(manifest.meta.description)} ` +
    `This capsule is sandboxed; its declared capabilities are ${declaredCapabilities(manifest)}.`;

  async function readResource(params: unknown): Promise<Record<string, unknown>> {
    const uri = asRecord(params)?.["uri"];
    if (typeof uri !== "string") {
      throw new RpcFailure(JSON_RPC_ERROR.InvalidParams, "resources/read needs a string uri");
    }
    const contents = await readCapsuleResourceContents(capsule, uri);
    if (contents === undefined) {
      throw new RpcFailure(JSON_RPC_ERROR.InvalidParams, `unknown resource: ${sanitizeModelText(uri, 200)}`);
    }
    return result({ contents: [contents], ttlMs: CONTENT_TTL_MS, cacheScope: "public" });
  }

  const handlers = new Map<string, RpcHandler>([
    [
      "initialize",
      (params) => {
        negotiatedVersion = negotiateProtocolVersion(asRecord(params)?.["protocolVersion"]);
        // `instructions` rides along for every revision: a legacy client never calls
        // `server/discover`, so this is the only place it can learn what the capsule may do.
        return result({
          protocolVersion: negotiatedVersion,
          serverInfo,
          capabilities: capabilities(),
          instructions: instructions(),
        });
      },
    ],
    [
      "server/discover",
      () =>
        result({
          spec: MCP_PROTOCOL_VERSION,
          supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
          server: serverInfo,
          capsule: {
            capsuleId: capsule.capsuleId,
            keyId: capsule.keyId,
            spec: CAPSULE_SPEC,
            trust: capsule.trust,
          },
          capabilities: capabilities(),
          instructions: instructions(),
          ttlMs: CATALOG_TTL_MS,
          cacheScope: "public",
        }),
    ],
    ["tools/list", () => result({ tools, ttlMs: CATALOG_TTL_MS, cacheScope: "public" })],
    // The one handler that may answer something other than a `complete` result: a call the user has
    // not yet consented to comes back as `input_required`.
    ["tools/call", (params) => handleToolsCall(params, ctx)],
    ["resources/list", () => result({ resources, ttlMs: CONTENT_TTL_MS, cacheScope: "public" })],
    ["resources/read", readResource],
    ["ping", () => result({})],
  ]);

  const handleMessage = createRpcDispatcher(handlers, warn);

  return {
    handleMessage,
    serve(transport: Transport): void {
      transport.onMessage(async (msg) => {
        const response = await handleMessage(msg);
        if (response !== undefined) {
          transport.send(response);
        }
      });
    },
  };
}
