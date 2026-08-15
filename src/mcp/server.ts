import { asRecord } from "../core/canonical.ts";
import { CapsuleError } from "../core/errors.ts";
import type { LoadedCapsule } from "../format/capsule.ts";
import type { Manifest } from "../format/manifest.ts";
import { invokeTool } from "../runtime/invoke.ts";
import type { GrantsStore } from "../security/grants.ts";
import { sanitizeModelText } from "../security/text.ts";
import { assertNoToolNameCollision, buildToolList, isTextMimeType, listResources } from "./catalog.ts";
import { parseMeta, type Meta } from "./meta.ts";
import {
  JSON_RPC_ERROR,
  type JsonRpcErrorResponse,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcResponse,
  type Transport,
} from "./transport.ts";

/** The one MCP revision this server speaks. */
export const MCP_PROTOCOL_VERSION = "2026-07-28";
/** The capsule specification the container itself conforms to. */
export const CAPSULE_SPEC = "agentcapsule.org/0.1";

const UI_MIME_TYPE = "text/html;profile=mcp-app";
/** A catalog is cheap to rebuild and may be re-signed by its author, so one hour. */
const CATALOG_TTL_MS = 3_600_000;
/** Capsule content is immutable by construction — the statement digest covers it — so one day. */
const CONTENT_TTL_MS = 86_400_000;

/** How much of a failure message a caller — ultimately a model's context — is given. */
const MAX_MESSAGE_CHARS = 500;

const SERVER_INFO_META = "io.modelcontextprotocol/serverInfo";
const UI_EXTENSION = "io.modelcontextprotocol/ui";

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

/**
 * A failure with a JSON-RPC code already chosen. Anything else a handler throws is ours, not the
 * peer's, and becomes an internal error with no detail on the wire.
 */
class RpcFailure extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "RpcFailure";
    this.code = code;
  }
}

/** The capability sentence in `instructions`: what this capsule may do, in the user's terms. */
function declaredCapabilities(manifest: Manifest): string {
  const capabilities = manifest.capabilities;
  const declared: string[] = [];
  if (capabilities.sql) declared.push("sql");
  if (capabilities.kv) declared.push("kv");
  if (capabilities.pack) declared.push("pack");
  const hosts = [...capabilities.net.allowed_hosts, ...(capabilities.net.allow_localhost ? ["localhost"] : [])];
  if (hosts.length > 0) declared.push(`net(${hosts.join(", ")})`);
  return declared.length === 0 ? "none" : declared.join(", ");
}

/**
 * Who asked, as far as the caller chose to say. A host runs one capsule for many agents, so a
 * failure nobody can attribute is a failure nobody can chase; both fields are already validated by
 * `parseMeta` — the caller name is sanitised there and the traceparent matched against its
 * pattern — which is what makes them safe to write to a terminal.
 */
function attribution(meta: Meta | undefined): string {
  const parts: string[] = [];
  if (meta?.caller !== undefined) parts.push(`caller=${meta.caller.name}`);
  if (meta?.traceparent !== undefined) parts.push(`traceparent=${meta.traceparent}`);
  return parts.length === 0 ? "" : ` (${parts.join(" ")})`;
}

/** The one content shape this server produces: text, cleaned before it reaches a model. */
function textContent(value: string): Record<string, unknown> {
  return { type: "text", text: value };
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
  // safely must not get as far as answering `initialize`.
  assertNoToolNameCollision(manifest.tools.map((tool) => tool.name));
  const tools = buildToolList(manifest, { allowSuspicious: opts.allowSuspicious === true, warn });
  const resources = listResources(manifest);
  // Suppression is a decision about a tool, not about the list it would have appeared in: a tool the
  // catalog refused to serve must not be reachable by name either. `allowSuspicious` serves every
  // tool, so this set is then empty.
  const suppressed = new Set(
    manifest.tools
      .map((tool) => tool.name)
      .filter((name) => !tools.some((served) => served.name === name)),
  );

  const serverInfo = { name: manifest.meta.name, version: manifest.meta.version };
  // The `_meta` name is namespaced (`capsule/<name>`) so an agent talking to several servers can tell
  // a capsule from a native MCP server; the `serverInfo`/`server` fields carry the capsule's own name.
  const resultMeta = { [SERVER_INFO_META]: { name: `capsule/${serverInfo.name}`, version: serverInfo.version } };

  const result = (body: Record<string, unknown>, meta?: Record<string, unknown>): Record<string, unknown> => ({
    resultType: "complete",
    ...body,
    // The server's own metadata is written last, so a run's `_meta` can never displace the identity
    // of the server that produced it.
    _meta: { ...meta, ...resultMeta },
  });

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
    // Only what the manifest declares is readable, so every byte returned is covered by the signed
    // statement digest. A container path that no resource points at is simply not a resource.
    const resource = manifest.resources.find((candidate) => candidate.uri === uri);
    if (resource === undefined) {
      throw new RpcFailure(JSON_RPC_ERROR.InvalidParams, `unknown resource: ${sanitizeModelText(uri, 200)}`);
    }
    const bytes = await capsule.reader.read(resource.path);
    return result({
      contents: [
        {
          uri: resource.uri,
          mimeType: resource.mimeType,
          ...(isTextMimeType(resource.mimeType)
            ? { text: bytes.toString("utf8") }
            : { blob: bytes.toString("base64") }),
        },
      ],
      ttlMs: CONTENT_TTL_MS,
      cacheScope: "public",
    });
  }

  /**
   * One tool call, all the way through `invokeTool` — the same path the CLI takes, so the security
   * model is not re-decided here. What *is* decided here is which failures are the peer's protocol
   * mistake and which are an outcome the model has to read: a name that is not a string and
   * arguments that are not an object are JSON-RPC errors, while a tool that does not exist, was
   * refused, threw or timed out is a `complete` result carrying `isError` — a model that receives a
   * transport error learns nothing it can act on, and MCP requires tool failures in the result.
   *
   * Every refusal names the run it did not perform: `runId` is what ties a result to the journal, so
   * it is reported for a refused call too, where the journal holds nothing under it.
   */
  async function callTool(params: unknown): Promise<Record<string, unknown>> {
    const request = asRecord(params);
    const name = request?.["name"];
    if (typeof name !== "string" || name === "") {
      throw new RpcFailure(JSON_RPC_ERROR.InvalidParams, "tools/call needs a non-empty string name");
    }
    const rawArgs = request?.["arguments"];
    const args = rawArgs === undefined ? undefined : asRecord(rawArgs);
    if (rawArgs !== undefined && args === undefined) {
      throw new RpcFailure(JSON_RPC_ERROR.InvalidParams, "tools/call arguments must be an object");
    }
    const meta = parseMeta(params);

    if (suppressed.has(name)) {
      // Deliberately not a JSON-RPC error: the client asked for a tool this server knows about and
      // will not serve, and that is an answer, not a malformed request.
      return result({ content: [textContent("tool is suppressed due to suspicious content")], isError: true });
    }

    const res = await invokeTool({
      capsule: opts.capsule,
      tool: name,
      args: args ?? {},
      grants: opts.grants,
      statePath: opts.statePath,
      journalPath: opts.journalPath,
      homeDir: opts.homeDir,
    });

    if (res.ok) {
      // The value is already sanitised and capped by the run itself, so it is serialised as it
      // stands: a string is its own text, anything else is its JSON.
      return result(
        {
          content: [textContent(typeof res.value === "string" ? res.value : JSON.stringify(res.value))],
          isError: false,
        },
        { runId: res.runId, effects: res.effects, events: res.events },
      );
    }

    const code = res.error?.code ?? "ERROR";
    const message = sanitizeModelText(res.error?.message ?? "invocation failed", MAX_MESSAGE_CHARS);
    // The tool name came off the wire, so it is cleaned before it reaches somebody's terminal.
    warn(`tools/call ${sanitizeModelText(name, 120)} failed: ${code}${attribution(meta)}`);
    return result(
      {
        // A missing grant is the one failure a human can fix, so it is phrased as the request it is
        // rather than as an error code the model is left to interpret.
        content: [textContent(code === "E_POLICY" ? `Permission denied: ${message}` : `${code}: ${message}`)],
        isError: true,
      },
      { code, runId: res.runId },
    );
  }

  const handlers = new Map<string, (params: unknown) => Record<string, unknown> | Promise<Record<string, unknown>>>([
    [
      "initialize",
      () => result({ protocolVersion: MCP_PROTOCOL_VERSION, serverInfo, capabilities: capabilities() }),
    ],
    [
      "server/discover",
      () =>
        result({
          spec: MCP_PROTOCOL_VERSION,
          supportedVersions: [MCP_PROTOCOL_VERSION],
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
    ["tools/call", callTool],
    ["resources/list", () => result({ resources, ttlMs: CONTENT_TTL_MS, cacheScope: "public" })],
    ["resources/read", readResource],
    ["ping", () => result({})],
  ]);

  const errorResponse = (id: JsonRpcId, code: number, message: string): JsonRpcErrorResponse => ({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });

  async function handleMessage(
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
  }

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
