import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalize } from "../core/canonical.ts";
import { sha256Hex } from "../core/digest.ts";
import { CapsuleError } from "../core/errors.ts";

export const EVENT = {
  runStarted: "run.started",
  toolProposed: "tool.proposed",
  toolAuthorized: "tool.authorized",
  interruptRaised: "interrupt.raised",
  interruptResolved: "interrupt.resolved",
  effectRequested: "effect.requested",
  effectCompleted: "effect.completed",
  toolCompleted: "tool.completed",
  runFinished: "run.finished",
} as const;

export type EventType = (typeof EVENT)[keyof typeof EVENT];

export type JournalEvent = {
  run_id: string;
  idx: number;
  type: string;
  payload: unknown;
  prev_hash: string;
  hash: string;
};

export type RecordedEffect = {
  i: number;
  op: string;
  paramsDigest: string;
  value?: unknown;
  valueDigest?: string;
  ms?: number;
};

export type Journal = {
  beginRun(opts: {
    runId: string;
    capsuleId: string;
    tool: string;
    mode?: "record" | "replay";
    startedAt?: string;
  }): void;
  append(runId: string, type: string, payload: unknown): { idx: number; hash: string };
  finishRun(runId: string, status: "ok" | "error"): void;
  events(runId: string): JournalEvent[];
  effects(runId: string): RecordedEffect[];
  verifyChain(runId: string): void;
  latestRunId(capsuleId?: string): string | null;
  close(): void;
};

const GENESIS = `sha256:${"0".repeat(64)}`;

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS capsule_runs (
  run_id     TEXT PRIMARY KEY,
  capsule_id TEXT NOT NULL,
  tool       TEXT NOT NULL,
  mode       TEXT NOT NULL CHECK (mode IN ('record','replay')),
  status     TEXT NOT NULL CHECK (status IN ('running','ok','error')),
  started_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS capsule_events (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id    TEXT NOT NULL REFERENCES capsule_runs(run_id),
  idx       INTEGER NOT NULL,
  type      TEXT NOT NULL,
  payload   TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash      TEXT NOT NULL,
  UNIQUE (run_id, idx)
);
`;

/** Every column is `NOT NULL` in a schema this module owns, so the row shape is a cast, not a guess. */
type EventRow = { idx: number; type: string; payload: string; prev_hash: string; hash: string };

function hashEvent(runId: string, idx: number, type: string, payload: unknown, prevHash: string): string {
  return `sha256:${sha256Hex(canonicalize({ run_id: runId, idx, type, payload, prev_hash: prevHash }))}`;
}

function broken(idx: number, why: string): CapsuleError {
  return new CapsuleError("E_DIGEST", `journal chain broken at idx ${idx}`, { idx, why });
}

/**
 * A stored payload is attacker-reachable (the sidecar is a file on disk), so unparseable JSON is a
 * broken chain rather than a `SyntaxError` escaping from the verifier.
 */
function parsePayload(json: string, idx: number): unknown {
  try {
    return JSON.parse(json);
  } catch (e) {
    throw broken(idx, `payload is not valid JSON: ${(e as Error).message}`);
  }
}

export function openJournal(path: string): Journal {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);

  const insertRun = db.prepare(
    "INSERT INTO capsule_runs (run_id, capsule_id, tool, mode, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)",
  );
  const updateStatus = db.prepare("UPDATE capsule_runs SET status = ? WHERE run_id = ?");
  const selectLast = db.prepare("SELECT idx, hash FROM capsule_events WHERE run_id = ? ORDER BY idx DESC LIMIT 1");
  const insertEvent = db.prepare(
    "INSERT INTO capsule_events (run_id, idx, type, payload, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const selectEvents = db.prepare(
    "SELECT idx, type, payload, prev_hash, hash FROM capsule_events WHERE run_id = ? ORDER BY idx ASC",
  );
  // `latestRunId()` with no capsule means "any capsule", expressed as a single statement so the
  // ordering rule lives in exactly one place. Insertion order breaks ties on equal timestamps.
  const selectLatest = db.prepare(
    "SELECT run_id FROM capsule_runs WHERE (:capsuleId IS NULL OR capsule_id = :capsuleId) " +
      "ORDER BY started_at DESC, rowid DESC LIMIT 1",
  );

  const rowsOf = (runId: string): EventRow[] => selectEvents.all(runId) as EventRow[];

  const events = (runId: string): JournalEvent[] =>
    rowsOf(runId).map((row) => ({
      run_id: runId,
      idx: row.idx,
      type: row.type,
      payload: parsePayload(row.payload, row.idx),
      prev_hash: row.prev_hash,
      hash: row.hash,
    }));

  return {
    beginRun({ runId, capsuleId, tool, mode = "record", startedAt = new Date().toISOString() }) {
      insertRun.run(runId, capsuleId, tool, mode, startedAt);
    },

    append(runId, type, payload) {
      const last = selectLast.get(runId) as { idx: number; hash: string } | undefined;
      const idx = last === undefined ? 0 : last.idx + 1;
      const prevHash = last === undefined ? GENESIS : last.hash;
      // The hash covers the payload as it will be read back, not as it was handed in: canonical
      // JSON is what gets stored, so verification recomputes over exactly the same value.
      const stored = canonicalize(payload);
      const hash = hashEvent(runId, idx, type, JSON.parse(stored), prevHash);
      insertEvent.run(runId, idx, type, stored, prevHash, hash);
      return { idx, hash };
    },

    finishRun(runId, status) {
      updateStatus.run(status, runId);
    },

    events,

    effects(runId) {
      return events(runId)
        .filter((e) => e.type === EVENT.effectCompleted)
        .map((e) => e.payload as RecordedEffect);
    },

    verifyChain(runId) {
      let prevHash = GENESIS;
      let expected = 0;
      for (const row of rowsOf(runId)) {
        // A deleted or reindexed event shows up here: idx must be a dense 0..N-1 sequence.
        if (row.idx !== expected) throw broken(expected, `expected idx ${expected}, found ${row.idx}`);
        if (row.prev_hash !== prevHash) throw broken(row.idx, "prev_hash does not match the previous event");
        const hash = hashEvent(runId, row.idx, row.type, parsePayload(row.payload, row.idx), row.prev_hash);
        if (hash !== row.hash) throw broken(row.idx, "recomputed hash does not match the stored hash");
        prevHash = row.hash;
        expected += 1;
      }
    },

    latestRunId(capsuleId) {
      const row = selectLatest.get({ capsuleId: capsuleId ?? null }) as { run_id: string } | undefined;
      return row === undefined ? null : row.run_id;
    },

    close() {
      db.close();
    },
  };
}
