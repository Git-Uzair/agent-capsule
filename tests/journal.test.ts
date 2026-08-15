import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CapsuleError } from "../src/core/errors.ts";
import { EVENT, openJournal, type Journal } from "../src/runtime/journal.ts";

const capsuleError =
  (code: "E_DIGEST", message?: RegExp) =>
  (e: unknown): boolean =>
    e instanceof CapsuleError && e.code === code && (message === undefined || message.test(e.message));

const HASH = /^sha256:[0-9a-f]{64}$/;
const GENESIS = "sha256:" + "0".repeat(64);
const CAPSULE = "sha256:" + "1".repeat(64);
const DIGEST = "sha256:" + "2".repeat(64);

/**
 * Every test gets its own sidecar under `.tmp/`. `open()` is a factory so the reopen test can hold
 * more than one handle over the run of a test; whatever is still open is closed before the file is
 * removed, because Windows will not unlink a database SQLite still has mapped.
 */
function withJournal(fn: (ctx: { open: () => Journal; close: (j: Journal) => void; path: string }) => void): void {
  const path = join(".tmp", `journal-${randomUUID()}.sqlite`);
  const live = new Set<Journal>();
  const close = (j: Journal): void => {
    j.close();
    live.delete(j);
  };
  try {
    fn({
      open: () => {
        const j = openJournal(path);
        live.add(j);
        return j;
      },
      close,
      path,
    });
  } finally {
    for (const j of live) j.close();
    // WAL mode leaves -wal/-shm siblings next to the database file.
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  }
}

/** Tampering happens the way an attacker would do it: raw SQL against the closed sidecar. */
function tamper(path: string, fn: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(path);
  try {
    fn(db);
  } finally {
    db.close();
  }
}

test("appends a verifiable chain", () => {
  withJournal(({ open }) => {
    const journal = open();
    journal.beginRun({ runId: "run-a", capsuleId: CAPSULE, tool: "greet" });

    const first = journal.append("run-a", EVENT.runStarted, { tool: "greet" });
    const second = journal.append("run-a", EVENT.effectRequested, { i: 0, op: "clock.now", paramsDigest: DIGEST });
    const third = journal.append("run-a", EVENT.runFinished, { status: "ok" });

    assert.deepEqual([first.idx, second.idx, third.idx], [0, 1, 2]);
    for (const { hash } of [first, second, third]) assert.match(hash, HASH);
    assert.equal(new Set([first.hash, second.hash, third.hash]).size, 3);

    const events = journal.events("run-a");
    assert.equal(events.length, 3);
    assert.deepEqual(
      events.map((e) => e.type),
      [EVENT.runStarted, EVENT.effectRequested, EVENT.runFinished],
    );
    assert.deepEqual(
      events.map((e) => e.idx),
      [0, 1, 2],
    );
    assert.equal(events[0]?.run_id, "run-a");
    assert.equal(events[0]?.prev_hash, GENESIS);
    assert.equal(events[1]?.prev_hash, first.hash);
    assert.equal(events[2]?.prev_hash, second.hash);
    assert.equal(events[2]?.hash, third.hash);
    assert.deepEqual(events[1]?.payload, { i: 0, op: "clock.now", paramsDigest: DIGEST });

    journal.verifyChain("run-a");
    journal.finishRun("run-a", "ok");
    assert.equal(journal.latestRunId(CAPSULE), "run-a");
    assert.equal(journal.latestRunId("sha256:" + "9".repeat(64)), null);
  });
});

test("detects a tampered payload", () => {
  withJournal(({ open, close, path }) => {
    const journal = open();
    journal.beginRun({ runId: "run-a", capsuleId: CAPSULE, tool: "greet" });
    journal.append("run-a", EVENT.runStarted, { tool: "greet" });
    journal.append("run-a", EVENT.effectCompleted, { i: 0, op: "kv.set", paramsDigest: DIGEST, value: true });
    journal.append("run-a", EVENT.runFinished, { status: "ok" });
    close(journal);

    tamper(path, (db) => {
      db.prepare("UPDATE capsule_events SET payload = ? WHERE run_id = ? AND idx = ?").run(
        JSON.stringify({ i: 0, op: "kv.set", paramsDigest: DIGEST, value: false }),
        "run-a",
        1,
      );
    });

    const reopened = open();
    assert.throws(() => reopened.verifyChain("run-a"), capsuleError("E_DIGEST", /journal chain broken at idx 1$/));
  });
});

test("detects a deleted event", () => {
  withJournal(({ open, close, path }) => {
    const journal = open();
    journal.beginRun({ runId: "run-a", capsuleId: CAPSULE, tool: "greet" });
    journal.append("run-a", EVENT.runStarted, { tool: "greet" });
    journal.append("run-a", EVENT.toolProposed, { tool: "greet" });
    journal.append("run-a", EVENT.runFinished, { status: "ok" });
    close(journal);

    tamper(path, (db) => {
      db.prepare("DELETE FROM capsule_events WHERE run_id = ? AND idx = ?").run("run-a", 1);
    });

    const reopened = open();
    assert.equal(reopened.events("run-a").length, 2);
    assert.throws(() => reopened.verifyChain("run-a"), capsuleError("E_DIGEST", /journal chain broken at idx 1$/));
  });
});

test("keeps runs independent", () => {
  withJournal(({ open }) => {
    const journal = open();
    journal.beginRun({ runId: "run-a", capsuleId: CAPSULE, tool: "greet", startedAt: "2026-01-01T00:00:00.000Z" });
    journal.beginRun({
      runId: "run-b",
      capsuleId: CAPSULE,
      tool: "greet",
      mode: "replay",
      startedAt: "2026-01-01T00:00:01.000Z",
    });

    const a0 = journal.append("run-a", EVENT.runStarted, { tool: "greet" });
    const b0 = journal.append("run-b", EVENT.runStarted, { tool: "greet" });
    const a1 = journal.append("run-a", EVENT.runFinished, { status: "ok" });
    const b1 = journal.append("run-b", EVENT.runFinished, { status: "ok" });

    assert.deepEqual([a0.idx, b0.idx], [0, 0]);
    assert.deepEqual([a1.idx, b1.idx], [1, 1]);
    // Same payloads, different run ids: the run id is part of every hash.
    assert.notEqual(a0.hash, b0.hash);

    assert.deepEqual(
      journal.events("run-a").map((e) => e.run_id),
      ["run-a", "run-a"],
    );
    assert.equal(journal.events("run-b")[0]?.prev_hash, GENESIS);
    journal.verifyChain("run-a");
    journal.verifyChain("run-b");

    assert.equal(journal.latestRunId(CAPSULE), "run-b");
    assert.equal(journal.latestRunId(), "run-b");
  });
});

test("survives reopen", () => {
  withJournal(({ open, close }) => {
    const journal = open();
    journal.beginRun({ runId: "run-a", capsuleId: CAPSULE, tool: "greet" });
    journal.append("run-a", EVENT.runStarted, { tool: "greet" });
    const second = journal.append("run-a", EVENT.toolProposed, { tool: "greet" });
    close(journal);

    const reopened = open();
    const third = reopened.append("run-a", EVENT.runFinished, { status: "ok" });

    assert.equal(third.idx, 2);
    assert.equal(reopened.events("run-a")[2]?.prev_hash, second.hash);
    assert.equal(reopened.events("run-a").length, 3);
    reopened.verifyChain("run-a");
    assert.equal(reopened.latestRunId(CAPSULE), "run-a");
  });
});

test("effects() returns only completed effects in order", () => {
  withJournal(({ open }) => {
    const journal = open();
    journal.beginRun({ runId: "run-a", capsuleId: CAPSULE, tool: "greet" });
    journal.append("run-a", EVENT.runStarted, { tool: "greet" });

    const completed = [
      { i: 0, op: "clock.now", paramsDigest: DIGEST, value: "2026-01-01T00:00:00.000Z", valueDigest: DIGEST, ms: 0 },
      { i: 1, op: "kv.set", paramsDigest: DIGEST, value: true, valueDigest: DIGEST, ms: 10 },
      { i: 2, op: "kv.get", paramsDigest: DIGEST, value: null, valueDigest: DIGEST },
    ];
    for (const effect of completed) {
      journal.append("run-a", EVENT.effectRequested, { i: effect.i, op: effect.op, paramsDigest: effect.paramsDigest });
      journal.append("run-a", EVENT.effectCompleted, effect);
    }
    journal.append("run-a", EVENT.runFinished, { status: "ok" });

    assert.deepEqual(journal.effects("run-a"), completed);
    assert.deepEqual(journal.effects("run-b"), []);
    journal.verifyChain("run-a");
  });
});
