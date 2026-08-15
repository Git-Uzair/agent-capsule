import { asRecord } from "../core/canonical.ts";
import { digestOf } from "../core/digest.ts";
import { CapsuleError } from "../core/errors.ts";
import type { LoadedCapsule } from "../format/capsule.ts";
import { invokeTool, schemaErrors } from "../runtime/invoke.ts";
import { buildPolicy } from "../runtime/policy.ts";
import { addGrant, loadGrants, saveGrants, type GrantsStore } from "../security/grants.ts";
import { sanitizeModelText } from "../security/text.ts";
import { BUILTIN_TOOLS, handleBuiltinCall } from "./builtin.ts";
import { parseMeta, type Meta } from "./meta.ts";
import { buildInputRequired, DECISION, readInputResponses } from "./mrtr.ts";
import { loadStateKey, signRequestState, verifyRequestState, type RequestStatePayload } from "./requeststate.ts";
import { JSON_RPC_ERROR, RpcFailure } from "./transport.ts";

/** How long a consent question stays answerable. Long enough to read, short enough to be a window. */
const CONSENT_TTL_MS = 300_000;

/** How much of a failure message a caller — ultimately a model's context — is given. */
const MAX_MESSAGE_CHARS = 500;

/**
 * What the tool-call handler needs from the server that owns it: the capsule, the names it agreed to
 * serve, where the user's answers and the run's two databases live, and the identity every result
 * carries. It is built once, when the server is created, so a call cannot change any of it.
 */
export type McpServerContext = {
  capsule: LoadedCapsule;
  /** The tools this server serves. A suppressed tool is absent, so it is not callable by name. */
  served: ReadonlySet<string>;
  /** The user's answers as the host supplies them; absent means the grant store in the home. */
  grants?: Record<string, boolean> | GrantsStore;
  statePath?: string;
  journalPath?: string;
  homeDir?: string;
  warn: (line: string) => void;
  /** The server identity written into every result's `_meta`. */
  resultMeta: Record<string, unknown>;
};

/** The one content shape this server produces: text, cleaned before it reaches a model. */
function textContent(value: string): Record<string, unknown> {
  return { type: "text", text: value };
}

/**
 * Who asked, as far as the caller chose to say. A host runs one capsule for many agents, so a
 * failure nobody can attribute is a failure nobody can chase; both fields are already validated by
 * `parseMeta` — the caller name is sanitised there and the traceparent matched against its pattern.
 */
function attribution(meta: Meta | undefined): string {
  const parts: string[] = [];
  if (meta?.caller !== undefined) parts.push(`caller=${meta.caller.name}`);
  if (meta?.traceparent !== undefined) parts.push(`traceparent=${meta.traceparent}`);
  return parts.length === 0 ? "" : ` (${parts.join(" ")})`;
}

/**
 * One diagnostic, one line. `sanitizeModelText` keeps newlines, because prose needs them, so every
 * record written to a terminal is flattened here instead: a `\r` or `\n` in a tool name or in a
 * caller's own name would otherwise let the caller forge a second record of its own.
 */
function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ");
}

/**
 * A grant store belonging to this call alone. `allow-once` means once: a grant the user approved for
 * one invocation must not reach the host's store or the file on disk, and persisting is
 * `always-allow`'s job and nothing else's.
 */
function callGrants(capsuleId: string, grants: readonly string[]): GrantsStore {
  const store: GrantsStore = { version: 1, capsules: {} };
  for (const grant of grants) addGrant(store, capsuleId, grant);
  return store;
}

/**
 * One tool call, all the way through `invokeTool` — the same path the CLI takes, so the security model
 * is not re-decided here. What *is* decided here is which failures are the peer's protocol mistake and
 * which are an outcome the model has to read. A name that is not a string, a tool this server does not
 * serve and arguments that do not fit the author's `inputSchema` are JSON-RPC errors: nothing ran, and
 * there is nothing for a model to act on. A tool that threw, timed out or was refused is a `complete`
 * result carrying `isError`, because MCP requires a tool's failure to be its result.
 *
 * Between those two sits consent. A capability the user has not granted is not an error at all: the
 * call answers `input_required`, asking for exactly the missing grants, and hands the client a signed
 * token describing what was asked. The retry arrives as an independent request — no session, which is
 * the whole point of the MRTR pattern — and is trusted only as far as that token verifies: same key,
 * same capsule, same tool, same arguments, not expired. So a user who approved a cheap call cannot
 * have an expensive one executed in its place.
 */
export async function handleToolsCall(
  params: unknown,
  ctx: McpServerContext,
): Promise<Record<string, unknown>> {
  const request = asRecord(params);
  const name = request?.["name"];
  if (typeof name !== "string" || name === "") {
    throw new RpcFailure(JSON_RPC_ERROR.InvalidParams, "tools/call needs a non-empty string name");
  }
  const rawArgs = request?.["arguments"];
  const args = rawArgs === undefined ? {} : asRecord(rawArgs);
  if (args === undefined) {
    throw new RpcFailure(JSON_RPC_ERROR.InvalidParams, "tools/call arguments must be an object");
  }

  const builtinTool = BUILTIN_TOOLS.find((candidate) => candidate.name === name);
  if (builtinTool !== undefined) {
    if (!ctx.served.has(name)) {
      const clean = sanitizeModelText(name, 120);
      throw new RpcFailure(JSON_RPC_ERROR.InvalidParams, `tool is not served: ${clean}`);
    }
    const invalid = schemaErrors(builtinTool.inputSchema, args);
    if (invalid !== undefined) {
      throw new RpcFailure(JSON_RPC_ERROR.InvalidParams, `invalid tool arguments: ${invalid}`);
    }
    const res = await handleBuiltinCall(name, args, ctx);
    return {
      resultType: "complete",
      content: [textContent(JSON.stringify(res))],
      structuredContent: res,
      isError: false,
      _meta: { ...ctx.resultMeta },
    };
  }

  const tool = ctx.capsule.manifest.tools.find((candidate) => candidate.name === name);
  // Suppression is a decision about a tool, not about the list it would have appeared in: a tool the
  // catalog refused to serve must not be reachable by name either.
  if (tool === undefined || !ctx.served.has(name)) {
    const clean = sanitizeModelText(name, 120);
    throw new RpcFailure(
      JSON_RPC_ERROR.InvalidParams,
      tool === undefined ? `unknown tool: ${clean}` : `tool is not served: ${clean}`,
    );
  }
  const invalid = schemaErrors(tool.inputSchema, args);
  if (invalid !== undefined) {
    throw new RpcFailure(JSON_RPC_ERROR.InvalidParams, `invalid tool arguments: ${invalid}`);
  }

  const meta = parseMeta(params);
  const capsuleId = ctx.capsule.capsuleId;
  const argsDigest = digestOf(args);
  const policy = buildPolicy({
    manifest: ctx.capsule.manifest,
    capsuleId,
    grants: ctx.grants ?? loadGrants(ctx.homeDir),
  });

  // What the user has just approved, for this call only until `always-allow` says otherwise.
  const approved = new Set<string>();
  const token = request?.["requestState"];
  if (token !== undefined) {
    if (typeof token !== "string") {
      throw new RpcFailure(JSON_RPC_ERROR.InvalidParams, "tools/call requestState must be a string");
    }
    let payload: RequestStatePayload;
    try {
      payload = verifyRequestState(token, loadStateKey(ctx.homeDir));
    } catch (e) {
      // A token that does not verify is the client's problem, not an outcome of a tool: nothing ran.
      throw new RpcFailure(
        JSON_RPC_ERROR.InvalidParams,
        e instanceof CapsuleError ? e.message : "requestState is not usable",
      );
    }
    if (payload.capsuleId !== capsuleId || payload.tool !== name || payload.argsDigest !== argsDigest) {
      throw new RpcFailure(JSON_RPC_ERROR.InvalidParams, "requestState does not match this request");
    }

    const decisions = readInputResponses(params) ?? {};
    for (const grant of payload.grants) {
      const decision = decisions[grant];
      if (decision === DECISION.deny) {
        // The user's answer, not a protocol failure — and the same result shape as any other refusal
        // a model has to read.
        return {
          resultType: "complete",
          content: [textContent(`E_POLICY: user denied ${grant}`)],
          isError: true,
          _meta: { code: "E_POLICY" },
        };
      }
      if (decision === DECISION.alwaysAllow) {
        // Read, add, write: the store on disk is the user's, and another capsule's answers in it are
        // none of this call's business.
        const store = loadGrants(ctx.homeDir);
        addGrant(store, capsuleId, grant);
        saveGrants(store, ctx.homeDir);
        approved.add(grant);
      } else if (decision === DECISION.allowOnce) {
        approved.add(grant);
      }
      // Anything else leaves the grant missing, so it is asked for again below.
    }
  }

  const missing = policy.missingGrants(name).filter((grant) => !approved.has(grant));
  if (missing.length > 0) {
    const requestState = signRequestState(
      { capsuleId, tool: name, argsDigest, grants: missing, exp: Date.now() + CONSENT_TTL_MS },
      loadStateKey(ctx.homeDir),
    );
    return buildInputRequired(missing, requestState);
  }

  const res = await invokeTool({
    capsule: ctx.capsule,
    tool: name,
    args,
    // Nothing this tool needs is missing now, so the run may be given exactly what it needs and
    // nothing else — which is how an `allow-once` grant reaches the policy without being stored.
    grants: approved.size === 0 ? ctx.grants : callGrants(capsuleId, policy.requiredGrants(name)),
    statePath: ctx.statePath,
    journalPath: ctx.journalPath,
    homeDir: ctx.homeDir,
  });

  if (res.ok) {
    // The value is already sanitised and capped by the run itself, so it is served as it stands: the
    // structured value for a client that can read it, and its serialisation for one that cannot.
    return {
      resultType: "complete",
      content: [textContent(typeof res.value === "string" ? res.value : JSON.stringify(res.value))],
      structuredContent: res.value,
      isError: false,
      // The server's own metadata is written last, so a run can never displace the identity of the
      // server that produced it.
      _meta: { runId: res.runId, effects: res.effects, events: res.events, ...ctx.resultMeta },
    };
  }

  const code = res.error?.code ?? "ERROR";
  const message = sanitizeModelText(res.error?.message ?? "invocation failed", MAX_MESSAGE_CHARS);
  ctx.warn(oneLine(`tools/call ${sanitizeModelText(name, 120)} failed: ${code}${attribution(meta)}`));
  return {
    resultType: "complete",
    content: [textContent(`${code}: ${message}`)],
    isError: true,
    _meta: { code, runId: res.runId },
  };
}
