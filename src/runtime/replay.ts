import { randomUUID } from "node:crypto";
import { digestOf } from "../core/digest.ts";
import { CapsuleError } from "../core/errors.ts";
import type { LoadedCapsule } from "../format/capsule.ts";
import { createEffects, type EffectDispatch } from "./effects.ts";
import { createFetchPort, type FetchInit } from "./fetch.ts";
import { runGuest } from "./guest.ts";
import { errorOf, openSidecar, sanitizeRunValue, sidecarPaths, type InvokeError } from "./invoke.ts";
import { EVENT, openJournal, type Journal, type JournalEvent } from "./journal.ts";
import { buildPolicy } from "./policy.ts";
import { openState, type CapsuleState } from "./state.ts";

/**
 * Where a replay's own events go. A recording is evidence and a replay is a question asked about it,
 * so the file under examination is opened to be read and nothing else: a replay run written back into
 * it would change what the next audit sees and would leave `latestRunId` naming a replay, so
 * `capsule replay` with no `--run` would go on to replay the replay. The effect ports still need a
 * journal to append to — that is how they count ordinals — so they are given one that dies with the
 * process.
 */
const SCRATCH = ":memory:";

export type ReplayResult = {
  ok: boolean;
  runId: string;
  tool: string;
  diverged: boolean;
  events: number;
  effects: number;
  value?: unknown;
  error?: InvokeError;
  /**
   * The digest the recording claims for the tool's value. A journal keeps the digest and not the
   * value — a run's value is the user's data and the journal outlives the run — so this is the whole
   * of what a replayed value can be judged against.
   */
  recordedValueDigest?: string;
};

export type ReplayOptions = {
  capsule: LoadedCapsule;
  runId?: string;
  journalPath?: string;
  statePath?: string;
  homeDir?: string;
};

function usage(message: string, detail: Record<string, unknown> = {}): never {
  throw new CapsuleError("E_USAGE", message, detail);
}

/** A payload comes back out of the journal as JSON of unknown shape; nothing else has fields. */
function fields(payload: unknown): Record<string, unknown> {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

/**
 * The payload of the one event of `type` the run must contain. A run missing any of the three a
 * replay reads from is a run that never got that far — an interrupted host, a journal restored from
 * half a backup — which is the caller's file being wrong rather than a host defect.
 */
function payloadOf(events: JournalEvent[], type: string, runId: string): Record<string, unknown> {
  const event = events.find((e) => e.type === type);
  if (event === undefined) usage(`run ${runId} has no ${type} event`, { runId, type });
  return fields(event.payload);
}

/**
 * Re-runs one recorded run and says whether it came out the same. The guest is the capsule's own code
 * executed again for real; everything non-deterministic it asks for is answered out of the journal
 * instead of the world, which is what makes the comparison meaningful — the same source, the same
 * arguments and the same answers must produce the same value, and any of the three the recording
 * cannot supply is a refusal rather than a guess.
 *
 * Two things can therefore disagree, and both are `diverged`: the *questions*, when the guest asks
 * for an effect the recording does not hold at that ordinal, and the *answer*, when it asks for
 * exactly the recorded effects and still returns a different value. Neither is an error in the host,
 * which is why they are reported rather than thrown.
 *
 * A refusal — no such run, the wrong capsule, arguments that were never journalled — throws, because
 * there is nothing to report about a replay that could not be attempted.
 */
export async function replayRun(opts: ReplayOptions): Promise<ReplayResult> {
  const { capsule } = opts;
  const paths = sidecarPaths(capsule.file);
  let journal: Journal | undefined;
  let scratch: Journal | undefined;
  let state: CapsuleState | undefined;
  try {
    journal = openSidecar("journal", () => openJournal(opts.journalPath ?? paths.journal));
    const runId =
      opts.runId ??
      journal.latestRunId(capsule.capsuleId) ??
      usage(`no runs recorded for ${capsule.manifest.meta.name}`, { capsuleId: capsule.capsuleId });

    // The chain first. Everything below is read out of the journal, and a journal that has been
    // edited says whatever its editor wanted — including that a replay of it matched.
    journal.verifyChain(runId);
    const events = journal.events(runId);
    if (events.length === 0) usage(`no run ${runId} in the journal`, { runId });

    const started = payloadOf(events, EVENT.runStarted, runId);
    const tool = typeof started.tool === "string" ? started.tool : usage(`run ${runId} names no tool`, { runId });
    // A journal is a file beside a capsule, and two capsules can be handed the same file. Replaying
    // one capsule's run inside another is not a divergence to report but a question about the wrong
    // pair of things: the id covers every byte of the capsule, so a repacked guest is a different
    // capsule and its own recordings are the ones it can be judged against.
    if (started.capsuleId !== capsule.capsuleId) {
      usage(`run ${runId} was recorded by a different capsule`, {
        runId,
        recorded: started.capsuleId,
        capsule: capsule.capsuleId,
      });
    }

    // Arguments are the guest's other input, and the journal keeps only their digest unless it was
    // asked to keep them. Absent arguments are the empty object the invoker would have supplied, so
    // the digest is what decides: it proves either that the recorded arguments are these, or that a
    // tool which was called with some cannot be replayed until it is recorded again with them.
    const proposed = payloadOf(events, EVENT.toolProposed, runId);
    const args = Object.hasOwn(proposed, "args") ? proposed.args : {};
    if (digestOf(args) !== started.argsDigest) {
      usage(`run ${runId} did not journal its arguments: re-record it with CAPSULE_JOURNAL_ARGS=1`, { runId, tool });
    }

    const completed = payloadOf(events, EVENT.toolCompleted, runId);
    const recordedValueDigest = completed.valueDigest;
    // A run that ended in an error recorded no value, so there is nothing for a replay to match: its
    // verdict would be a comparison of two failures, which is a different feature from this one.
    if (typeof recordedValueDigest !== "string") {
      const failed = fields(completed.error).code;
      usage(`run ${runId} recorded no value to replay: it failed with ${String(failed ?? "no value")}`, { runId });
    }

    const recorded = journal.effects(runId);
    // Completions alone do not say how far the recording goes: a run whose *last* effect failed
    // recorded a request for it and nothing else, and an effect the recording shows failing has to be
    // re-run rather than read as a question the recording never asked. The requests are what carry
    // that ordinal, so the highest of them is the end of the recording.
    const requested = events.filter((e) => e.type === EVENT.effectRequested);
    const maxRequestedOrdinal = requested.reduce((max, e) => {
      // A journal is a file on disk, so an ordinal that is not a number is a payload to ignore rather
      // than a `NaN` to carry into the comparison — where it would make every ordinal look unknown.
      const i = fields(e.payload).i;
      return typeof i === "number" ? Math.max(max, i) : max;
    }, -1);
    // The questions, kept by ordinal. An effect that failed has a request and no completion, so this is
    // the only thing a re-run gap ordinal can be checked against; a payload missing any of the three
    // fields is left out, and an ordinal with nothing behind it is itself a divergence.
    const recordedRequests = new Map<number, { op: string; paramsDigest: string }>();
    for (const e of requested) {
      const p = fields(e.payload);
      if (typeof p.i === "number" && typeof p.op === "string" && typeof p.paramsDigest === "string") {
        recordedRequests.set(p.i, { op: p.op, paramsDigest: p.paramsDigest });
      }
    }
    // How many effects the recording holds, which is not how many it *answered*: the ordinals are
    // dense, so one past the highest request is the count, and a trailing failure is one of them. The
    // completions are still the floor, because a journal is a file and a hand-edited one can hold a
    // completion above its own last request.
    const expectedEffects = Math.max(recorded.length, maxRequestedOrdinal + 1);
    // State is opened for one reason: an effect the recording shows failing is re-run inside a
    // savepoint that is rolled back, and that needs the database it would have written to. Nothing
    // else in a replay touches it.
    state = openSidecar("state", () => openState(opts.statePath ?? paths.app));
    scratch = openJournal(SCRATCH);
    const scratchRunId = randomUUID();
    scratch.beginRun({ runId: scratchRunId, capsuleId: capsule.capsuleId, tool, mode: "replay" });

    // Built the way a run builds it, from the grants the user holds now: replaying a tool whose grant
    // has since been revoked is refused, and says so, rather than quietly reading the recorded answer
    // back out of a file the user no longer consents to.
    const policy = buildPolicy({
      manifest: capsule.manifest,
      capsuleId: capsule.capsuleId,
      ...(opts.homeDir === undefined ? {} : { homeDir: opts.homeDir }),
    });
    // The egress gate, for the same reason state is opened: an effect the recording shows failing is
    // re-run for real, and a `net.fetch` re-run in a runtime with no port fails because the port is
    // missing rather than for the reason the recording holds — which is a divergence the host
    // manufactured. Built exactly as a recorded run builds it, so the refusal is the same refusal;
    // nothing reaches a socket that the recording did not already show reaching one.
    const fetchPort = createFetchPort({
      policy,
      tool,
      allowLocalhost: capsule.manifest.capabilities.net.allow_localhost,
    });

    const effects = createEffects({
      policy,
      journal: scratch,
      runId: scratchRunId,
      tool,
      mode: "replay",
      recorded,
      maxRequestedOrdinal,
      recordedRequests,
      state,
      // The guest's `init` is whatever JSON it built, so it crosses as `unknown`; the port checks
      // every field of it before any of it can reach a socket.
      netFetch: (url, init): Promise<unknown> => fetchPort(url, init as FetchInit | undefined),
    });

    let divergence: CapsuleError | undefined;
    const dispatch: EffectDispatch = async (callerTool, op, params) => {
      try {
        return await effects.dispatch(callerTool, op, params);
      } catch (e) {
        // The verdict is kept here, on the host's side of the sandbox, because the guest is handed
        // this failure as a value it may catch: a capsule that swallows a diverged effect and returns
        // something anyway must not be able to launder the divergence into a clean replay.
        if (e instanceof CapsuleError && e.code === "E_NONDETERMINISM") divergence ??= e;
        throw e;
      }
    };

    const entry = capsule.manifest.runtime.entry;
    const source = (await capsule.reader.read(entry)).toString("utf8");
    let value: unknown;
    let failure: InvokeError | undefined;
    try {
      // Cleaned exactly as a recorded run cleans it, since the digest under comparison was taken
      // after that step and not before.
      value = sanitizeRunValue(
        await runGuest({
          source,
          entryPath: entry,
          runtime: capsule.manifest.runtime,
          tool,
          args,
          dispatch,
        }),
      );
    } catch (e) {
      failure = errorOf(e);
    }

    const result = (error?: InvokeError, diverged = false): ReplayResult => ({
      ok: error === undefined,
      runId,
      tool,
      diverged,
      events: events.length,
      effects: effects.count(),
      recordedValueDigest,
      ...(value === undefined ? {} : { value }),
      ...(error === undefined ? {} : { error }),
    });

    if (divergence !== undefined) {
      return result({ code: divergence.code, message: divergence.message }, true);
    }
    // Whatever else went wrong is the replay failing, not the recording being contradicted: a guest
    // that threw, a policy that no longer allows the effect, a timeout.
    if (failure !== undefined) return result(failure);
    // A guest can also diverge by asking *less*: stopping early leaves recorded effects unclaimed,
    // and an effect whose answer was never used is one whose absence the value would not show. The
    // count to fall short of is every effect the recording asked for, including the one it asked for
    // last and never got an answer to — a replay that stops in front of that one has not reproduced
    // the failure, it has avoided it.
    if (effects.count() < expectedEffects) {
      return result(
        {
          code: "E_NONDETERMINISM",
          message: `the replay stopped after ${effects.count()} of ${expectedEffects} recorded effects`,
        },
        true,
      );
    }
    const digest = digestOf(value);
    if (digest !== recordedValueDigest) {
      return result(
        {
          code: "E_NONDETERMINISM",
          message: `value digest differs: recorded ${recordedValueDigest}, replayed ${digest}`,
        },
        true,
      );
    }
    return result();
  } finally {
    // Every handle, whatever happened, and any of them may never have opened. An unclosed SQLite
    // handle keeps the journal locked on Windows and leaks a handle everywhere else.
    state?.close();
    scratch?.close();
    journal?.close();
  }
}
