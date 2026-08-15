import { randomUUID } from "node:crypto";
import type { SchemaObject, ValidateFunction } from "ajv/dist/2020.js";
import { digestOf } from "../core/digest.ts";
import { CapsuleError } from "../core/errors.ts";
import { newValidator } from "../core/schema.ts";
import type { LoadedCapsule } from "../format/capsule.ts";
import type { GrantsStore } from "../security/grants.ts";
import { sanitizeModelText } from "../security/text.ts";
import { createEffects, type EffectsController } from "./effects.ts";
import { createFetchPort, type FetchInit } from "./fetch.ts";
import { runGuest } from "./guest.ts";
import { EVENT, openJournal, type Journal } from "./journal.ts";
import { buildPolicy, type Policy } from "./policy.ts";
import { openState, type CapsuleState } from "./state.ts";

/** How much of any one string a caller — ultimately a model's context — is given. */
const MAX_VALUE_CHARS = 8192;
const MAX_MESSAGE_CHARS = 500;

export type InvokeError = { code: string; message: string };

export type InvokeResult = {
  ok: boolean;
  runId: string;
  tool: string;
  value?: unknown;
  error?: InvokeError;
  ms: number;
  events: number;
  effects: number;
};

export type InvokeOptions = {
  capsule: LoadedCapsule;
  tool: string;
  args?: unknown;
  mode?: "record";
  runId?: string;
  grants?: Record<string, boolean> | GrantsStore;
  statePath?: string;
  journalPath?: string;
  homeDir?: string;
  clock?: () => string;
  randomBytes?: (n: number) => string;
  netFetch?: (url: string, init?: unknown) => Promise<unknown>;
  packWrite?: (dir: string, out?: string) => Promise<unknown>;
};

/**
 * Where a capsule's two databases live: beside the capsule, named after it. The capsule's own bytes
 * are signed, so state and evidence can never be written back into them.
 */
export function sidecarPaths(file: string): { app: string; journal: string } {
  return { app: `${file}.app.sqlite`, journal: `${file}.journal.sqlite` };
}

/**
 * Validates a value against one of the manifest's schemas and reports why it failed, or nothing at
 * all. A schema comes from the capsule author, so it is not assumed to be a schema: ajv rejecting it
 * is the manifest's fault and is said so, rather than escaping as an ajv error.
 */
function schemaErrors(schema: Record<string, unknown>, value: unknown): string | undefined {
  const ajv = newValidator();
  let validate: ValidateFunction;
  try {
    validate = ajv.compile(schema as SchemaObject);
  } catch (e) {
    throw new CapsuleError("E_MANIFEST", `tool schema is not a valid JSON Schema: ${(e as Error).message}`);
  }
  return validate(value) ? undefined : ajv.errorsText(validate.errors);
}

/**
 * Every failure the caller is shown. A `CapsuleError` already carries the vocabulary and a message
 * fit to repeat; anything else came out of guest-driven work — a guest that nested its value deeper
 * than the host can walk, a port that threw — so it is reported as the guest's failure with a
 * cleaned message rather than a host stack trace.
 */
function errorOf(e: unknown): InvokeError {
  if (e instanceof CapsuleError) return { code: e.code, message: e.message };
  const message = e instanceof Error ? e.message : String(e);
  return { code: "E_GUEST", message: sanitizeModelText(message, MAX_MESSAGE_CHARS) || "the tool failed" };
}

/**
 * Cleans every string in the guest's value. The value's next stop is a model's context, so the whole
 * of it is treated as hostile text: escape sequences, zero-width characters and bidi overrides are
 * removed and the length is capped. Property names are left as they are — sanitising them could
 * collapse two distinct keys into one and silently drop a field.
 */
function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeModelText(value, MAX_VALUE_CHARS);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, sanitizeValue(v)]));
  }
  return value;
}

/**
 * Opens one of the two sidecar databases. Both paths can come from the caller — `--journal`, `--state`
 * — and a path is not a promise that the file behind it is a database: a text file, a half-written
 * download or somebody else's SQLite file all fail on open. That is the caller's input being wrong,
 * so it is `E_USAGE` in this vocabulary rather than SQLite's error reaching the user as a stack trace.
 */
function openSidecar<T>(which: "journal" | "state", open: () => T): T {
  try {
    return open();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new CapsuleError("E_USAGE", `unusable ${which} database: ${message}`, { which });
  }
}

/**
 * The one path from "call this tool" to "here is what it returned". Every entry point — the CLI, MCP,
 * the UI bridge — goes through it, so the order below is the product's security model in one place:
 * the tool has to exist, the arguments have to fit the schema the author published, and the user has
 * to have granted every capability the tool needs, all three settled before a run is opened. A
 * refusal at that stage journals nothing and executes nothing; there is no half-run to explain.
 *
 * Past that point the run is a matter of record: it is opened in the journal, every effect the guest
 * asks for is appended as it happens, and the outcome — value or error — closes the chain. Opening it
 * is itself a refusal point: a run id already in the journal is the caller's mistake, and the run
 * holding that id is left exactly as it was. So is opening the databases at all, which is why they are
 * opened inside the same `try` as everything else. Nothing throws out of here. A caller gets an
 * `InvokeResult` either way, because "the tool failed" is an answer a model and a CLI both have to be
 * able to read.
 */
export async function invokeTool(opts: InvokeOptions): Promise<InvokeResult> {
  const startedAt = performance.now();
  const { capsule } = opts;
  const runId = opts.runId ?? randomUUID();
  const mode = opts.mode ?? "record";
  const elapsed = (): number => Math.round(performance.now() - startedAt);
  const refused = (error: InvokeError): InvokeResult => ({
    ok: false,
    runId,
    tool: opts.tool,
    error,
    ms: elapsed(),
    events: 0,
    effects: 0,
  });

  const tool = capsule.manifest.tools.find((t) => t.name === opts.tool);
  if (tool === undefined) return refused({ code: "E_USAGE", message: `unknown tool: ${opts.tool}` });

  // Absent arguments are an empty object, so a tool whose schema requires a property is told what is
  // missing instead of being told its arguments are not an object.
  const args = opts.args ?? {};
  let policy: Policy;
  let missing: string[];
  try {
    policy = buildPolicy({
      manifest: capsule.manifest,
      capsuleId: capsule.capsuleId,
      ...(opts.grants === undefined ? {} : { grants: opts.grants }),
      ...(opts.homeDir === undefined ? {} : { homeDir: opts.homeDir }),
    });
    const invalid = schemaErrors(tool.inputSchema, args);
    if (invalid !== undefined) {
      return refused({ code: "E_USAGE", message: `invalid tool arguments: ${invalid}` });
    }
    missing = policy.missingGrants(tool.name);
  } catch (e) {
    return refused(errorOf(e));
  }
  if (missing.length > 0) {
    return refused({ code: "E_POLICY", message: `missing user grants: ${missing.join(", ")}` });
  }

  const paths = sidecarPaths(capsule.file);
  let journal: Journal | undefined;
  let state: CapsuleState | undefined;
  let effects: EffectsController | undefined;
  // Whether this call owns a run in the journal. A run id it did not open is a run it must not write
  // to, close, or count — the id may already name someone else's finished run.
  let started = false;

  /**
   * The journal is the run's evidence, so it is the last thing consulted: a chain that does not
   * verify makes the value untrustworthy however well the guest behaved, and says so in place of the
   * outcome. The event count it reports is therefore a count of events that verified.
   */
  const settle = (ok: boolean, value: unknown, error?: InvokeError): InvokeResult => {
    let events = 0;
    let broken: InvokeError | undefined;
    try {
      journal?.verifyChain(runId);
      events = journal?.events(runId).length ?? 0;
    } catch (e) {
      broken = errorOf(e);
    }
    const failure = broken ?? error;
    return {
      ok: ok && failure === undefined,
      runId,
      tool: opts.tool,
      ...(failure === undefined ? { value } : { error: failure }),
      ms: elapsed(),
      events,
      effects: effects?.count() ?? 0,
    };
  };

  try {
    journal = openSidecar("journal", () => openJournal(opts.journalPath ?? paths.journal));
    state = openSidecar("state", () => openState(opts.statePath ?? paths.app));
    const argsDigest = digestOf(args);
    // The run id is the journal's primary key, so the insert is the existence check: a caller that
    // reuses an id is refused here, before anything is written or executed, and told so in its own
    // vocabulary rather than SQLite's.
    try {
      journal.beginRun({ runId, capsuleId: capsule.capsuleId, tool: tool.name, mode });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes("UNIQUE constraint failed: capsule_runs.run_id")) {
        throw new CapsuleError("E_USAGE", `runId already exists: ${runId}`, { runId });
      }
      throw e;
    }
    started = true;
    journal.append(runId, EVENT.runStarted, { capsuleId: capsule.capsuleId, tool: tool.name, mode, argsDigest });
    // The digest, not the arguments: a journal is a file on disk that outlives the run, and a tool's
    // arguments are the user's data. Recording them is opt-in, for the replays that need them.
    journal.append(runId, EVENT.toolProposed, {
      tool: tool.name,
      argsDigest,
      ...(process.env.CAPSULE_JOURNAL_ARGS === "1" ? { args } : {}),
    });
    journal.append(runId, EVENT.toolAuthorized, { tool: tool.name, grants: policy.requiredGrants(tool.name) });

    // The egress gate, built here because it needs this capsule's own `allow_localhost` and this
    // tool's name — the policy answers "may *this* tool reach *that* host". A caller may inject its
    // own port (tests, replay), and a caller that does not gets the real one: net.fetch is never
    // silently unavailable to a capsule whose manifest declared it.
    const fetchPort = createFetchPort({
      policy,
      tool: tool.name,
      allowLocalhost: capsule.manifest.capabilities.net.allow_localhost,
    });

    effects = createEffects({
      policy,
      journal,
      runId,
      tool: tool.name,
      mode,
      state,
      ...(opts.clock === undefined ? {} : { clock: opts.clock }),
      ...(opts.randomBytes === undefined ? {} : { randomBytes: opts.randomBytes }),
      // The guest's `init` is whatever JSON it built, so it crosses as `unknown`; the port checks
      // every field of it before any of it can reach a socket.
      netFetch: opts.netFetch ?? ((url, init): Promise<unknown> => fetchPort(url, init as FetchInit | undefined)),
      ...(opts.packWrite === undefined ? {} : { packWrite: opts.packWrite }),
    });

    const entry = capsule.manifest.runtime.entry;
    const source = (await capsule.reader.read(entry)).toString("utf8");
    const returned = await runGuest({
      source,
      entryPath: entry,
      runtime: capsule.manifest.runtime,
      tool: tool.name,
      args,
      dispatch: effects.dispatch,
    });

    // Sanitised before it is checked, so the value the schema passed is the value the caller gets:
    // checking the raw text and returning a cleaned one would let a tool advertise a shape it does
    // not in fact deliver.
    const value = sanitizeValue(returned);
    if (tool.outputSchema !== undefined) {
      const invalid = schemaErrors(tool.outputSchema, value);
      if (invalid !== undefined) {
        throw new CapsuleError("E_GUEST", `tool output does not match outputSchema: ${invalid}`, { tool: tool.name });
      }
    }

    journal.append(runId, EVENT.toolCompleted, { tool: tool.name, valueDigest: digestOf(value) });
    journal.append(runId, EVENT.runFinished, { status: "ok" });
    journal.finishRun(runId, "ok");
    return settle(true, value);
  } catch (e) {
    const error = errorOf(e);
    // A run that failed is still a run that happened, so the failure is journalled too — but only if
    // this call is the one that opened it. Before that point there is no run to end: writing an
    // ending anyway would append to whatever run already holds the id and mark it failed. And the
    // journal is not allowed to replace the error: if writing the ending fails, the caller still
    // hears why the tool did.
    // `started` is only ever set once this call has a journal and a run of its own, so the optional
    // calls below are for the type checker's benefit rather than a case that happens.
    if (!started) return refused(error);
    try {
      journal?.append(runId, EVENT.toolCompleted, { tool: tool.name, error });
      journal?.append(runId, EVENT.runFinished, { status: "error", code: error.code });
      journal?.finishRun(runId, "error");
    } catch {
      /* the chain check in settle() is what reports a journal that could not be closed properly */
    }
    return settle(false, undefined, error);
  } finally {
    // Both databases, whatever happened — and either may never have opened, since opening them is one
    // of the things that can fail. An unclosed SQLite handle keeps a file locked on Windows and leaks
    // a handle everywhere else.
    state?.close();
    journal?.close();
  }
}
