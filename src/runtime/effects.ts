import { randomBytes as cryptoRandomBytes } from "node:crypto";
import { digestOf } from "../core/digest.ts";
import { CapsuleError } from "../core/errors.ts";
import type { EffectName } from "../format/manifest.ts";
import { sanitizeModelText } from "../security/text.ts";
import { EVENT, type Journal, type RecordedEffect } from "./journal.ts";
import type { Policy } from "./policy.ts";
import type { CapsuleState } from "./state.ts";

const MAX_RANDOM_BYTES = 64;
const MAX_LOG_CHARS = 2 * 1024;

export type EffectDispatch = (tool: string, op: EffectName, params?: unknown) => Promise<unknown>;

export type EffectsController = {
  dispatch: EffectDispatch;
  readonly count: () => number;
};

export type EffectsOptions = {
  policy: Policy;
  journal: Journal;
  runId: string;
  tool: string;
  mode: "record" | "replay";
  recorded?: RecordedEffect[];
  /**
   * The highest ordinal the recording holds a *request* for, which is the only thing that says where
   * a recording that ends at a failed effect ends: `recorded` lists completions, so a trailing failure
   * leaves no trace in it at all. Absent, the last completion is taken as the end.
   */
  maxRequestedOrdinal?: number;
  state?: CapsuleState;
  clock?: () => string;
  randomBytes?: (n: number) => string;
  netFetch?: (url: string, init?: unknown) => Promise<unknown>;
  packWrite?: (dir: string, out?: string) => Promise<unknown>;
};

function usage(message: string, detail: Record<string, unknown> = {}): never {
  throw new CapsuleError("E_USAGE", message, detail);
}

/** Params arrive from a guest, so anything that is not a plain object has no fields at all. */
function fields(params: unknown): Record<string, unknown> {
  return typeof params === "object" && params !== null && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
}

function stringField(params: unknown, name: string, op: EffectName): string {
  const value = fields(params)[name];
  if (typeof value !== "string") usage(`${op} requires a string ${name}`, { op, name });
  return value;
}

function sqlParams(params: unknown, op: EffectName): unknown[] {
  const value = fields(params).params;
  if (value === undefined) return [];
  if (!Array.isArray(value)) usage(`${op} requires params to be an array`, { op });
  return value;
}

/**
 * The one hole in the sandbox. Every non-deterministic thing a capsule can do goes through
 * `dispatch`, which is why the same function both records and replays: in record mode it runs the op
 * and writes the answer into the journal, in replay mode it reads the answer back and runs only the
 * effects the recording shows failing. A replay that asks a different question in a different order
 * is a divergence, not a new recording.
 */
export function createEffects(opts: EffectsOptions): EffectsController {
  const { policy, journal, runId, tool, mode, recorded = [], state } = opts;
  const clock = opts.clock ?? ((): string => new Date().toISOString());
  const randomHex = opts.randomBytes ?? ((n: number): string => cryptoRandomBytes(n).toString("hex"));
  let next = 0;

  // A recorded effect is found by its ordinal, never by its position: `journal.effects()` lists
  // completed effects only, so an effect that failed leaves a gap and the two stop agreeing after
  // the first failure. `lastOrdinal` is where the recording ends, which is what tells a gap (an
  // effect that ran and threw) apart from a replay that has run past the end of the recording. The
  // last completion is not that end when the recording's final effect is one of the failures — hence
  // `maxRequestedOrdinal`, which counts the requests and so sees a failure with nothing behind it.
  const byOrdinal = new Map(recorded.map((r) => [r.i, r]));
  const lastOrdinal = recorded.reduce((max, r) => Math.max(max, r.i), opts.maxRequestedOrdinal ?? -1);

  const needState = (op: EffectName): CapsuleState => state ?? usage(`${op} requires capsule state`, { op });

  const handlers: Record<EffectName, (params: unknown) => unknown | Promise<unknown>> = {
    "clock.now": () => clock(),

    "random.bytes": (params) => {
      const n = fields(params).n;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_RANDOM_BYTES) {
        usage(`random.bytes requires 1 <= n <= ${MAX_RANDOM_BYTES}`, { n });
      }
      return randomHex(n);
    },

    "kv.get": (params) => needState("kv.get").kvGet(stringField(params, "key", "kv.get")),

    "kv.set": (params) => {
      const store = needState("kv.set");
      store.kvSet(stringField(params, "key", "kv.set"), stringField(params, "value", "kv.set"));
      return true;
    },

    "sql.query": (params) =>
      needState("sql.query").sqlQuery(stringField(params, "sql", "sql.query"), sqlParams(params, "sql.query")),

    "sql.exec": (params) =>
      needState("sql.exec").sqlExec(stringField(params, "sql", "sql.exec"), sqlParams(params, "sql.exec")),

    // Guest logs are hostile text on someone's terminal, and stdout belongs to the JSON-RPC
    // transport: sanitise, cap the length, and write to stderr. Over-long is truncated rather than
    // refused — a chatty capsule should not fail, it should be quieter.
    "log.write": (params) => {
      const message = fields(params).message;
      if (typeof message !== "string") usage("log.write requires a string message");
      process.stderr.write(sanitizeModelText(message, MAX_LOG_CHARS) + "\n");
      return true;
    },

    "net.fetch": async (params) => {
      const url = stringField(params, "url", "net.fetch");
      const port = opts.netFetch ?? usage("net.fetch is not available in this runtime");
      return await port(url, fields(params).init);
    },

    "pack.write": async (params) => {
      const dir = stringField(params, "dir", "pack.write");
      const out = fields(params).out;
      if (out !== undefined && typeof out !== "string") usage("pack.write requires a string out", { out });
      const port = opts.packWrite ?? usage("pack.write is not available in this runtime");
      return await port(dir, out);
    },
  };

  const dispatch: EffectDispatch = async (callerTool, op, params) => {
    // A controller belongs to one tool's invocation; borrowing another tool's effect list would
    // widen the policy silently.
    if (callerTool !== tool) {
      throw new CapsuleError("E_POLICY", `effects are bound to tool ${tool}, not ${callerTool}`, {
        tool,
        callerTool,
        op,
      });
    }
    // Denial happens before anything is written, so a refused effect leaves no trace and does not
    // consume an ordinal: record and replay stay aligned.
    const target = op === "net.fetch" ? String(fields(params).url ?? "") : undefined;
    policy.check(callerTool, op, target);

    const i = next++;
    const paramsDigest = digestOf(params ?? {});
    journal.append(runId, EVENT.effectRequested, { i, op, paramsDigest });

    let value: unknown;
    let ms: number | undefined;
    const previous = byOrdinal.get(i);
    if (mode === "record") {
      const started = performance.now();
      value = await handlers[op](params);
      // Bucketed to 10 ms: a real duration in the payload would make the hash chain unreproducible.
      ms = Math.round((performance.now() - started) / 10) * 10;
    } else if (previous === undefined && i <= lastOrdinal) {
      // A gap within the recording is not an unknown: the recording holds a request for this ordinal
      // and no completion, which proves the op ran and threw. Running it is how the same failure is
      // reproduced — and if it returns instead, the recording and this run disagree about the world,
      // which is a divergence rather than a result. So it runs inside a savepoint that is rolled back
      // either way: a replay must not leave guest state changed by an effect the recording says never
      // landed, and the completion is never journalled.
      state?.db.exec("SAVEPOINT capsule_gap");
      try {
        await handlers[op](params);
      } finally {
        state?.db.exec("ROLLBACK TO capsule_gap");
        state?.db.exec("RELEASE capsule_gap");
      }
      throw new CapsuleError("E_NONDETERMINISM", `effect #${i} diverged: expected failure, got completion`, {
        i,
        op,
        paramsDigest,
      });
    } else {
      if (previous === undefined || previous.op !== op || previous.paramsDigest !== paramsDigest) {
        throw new CapsuleError(
          "E_NONDETERMINISM",
          `effect #${i} diverged: expected ${previous?.op}/${previous?.paramsDigest}, got ${op}/${paramsDigest}`,
          { i, op, paramsDigest, expectedOp: previous?.op, expectedParamsDigest: previous?.paramsDigest },
        );
      }
      value = previous.value;
    }

    journal.append(runId, EVENT.effectCompleted, {
      i,
      op,
      paramsDigest,
      value,
      valueDigest: digestOf(value),
      ...(ms === undefined ? {} : { ms }),
    });
    return value;
  };

  return { dispatch, count: () => next };
}
