import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { digestOf } from "../src/core/digest.ts";
import { CapsuleError, type CapsuleErrorCode } from "../src/core/errors.ts";
import { parseManifest, type EffectName, type Manifest } from "../src/format/manifest.ts";
import { createEffects, type EffectsController } from "../src/runtime/effects.ts";
import { EVENT, openJournal, type Journal, type RecordedEffect } from "../src/runtime/journal.ts";
import { buildPolicy } from "../src/runtime/policy.ts";
import { openState, type CapsuleState } from "../src/runtime/state.ts";

const capsuleError =
  (code: CapsuleErrorCode, message?: RegExp) =>
  (e: unknown): boolean =>
    e instanceof CapsuleError && e.code === code && (message === undefined || message.test(e.message));

const CAPSULE = "sha256:" + "1".repeat(64);

/** The clock hands out a fixed sequence so a recorded run has a value a replay can be judged against. */
const TIMES = ["2026-01-01T00:00:00.000Z", "2026-01-01T00:00:01.000Z", "2026-01-01T00:00:02.000Z"];

const BASE = {
  spec_version: "0.1.0",
  meta: { name: "hello", version: "1.0.0", title: "Hello", description: "A hello capsule." },
  runtime: { type: "quickjs-1", entry: "src/main.js" },
};

function manifestWith(capabilities: Record<string, unknown>, effects: EffectName[]): Manifest {
  return parseManifest({
    ...BASE,
    capabilities,
    tools: [
      { name: "greet", title: "Greet", description: "Greets.", inputSchema: { type: "object" }, effects },
    ],
  });
}

const ALL_LOCAL: EffectName[] = [
  "clock.now",
  "random.bytes",
  "log.write",
  "kv.get",
  "kv.set",
  "sql.query",
  "sql.exec",
];

const LOCAL = manifestWith({ kv: true, sql: true }, ALL_LOCAL);

type Ctx = {
  journal: Journal;
  /** The journal's own file, so a test can try to reach the evidence the way a guest would. */
  journalPath: string;
  state: CapsuleState;
  /** A controller bound to a fresh run, so record and replay never share an ordinal counter. */
  effects(opts: {
    mode: "record" | "replay";
    recorded?: RecordedEffect[];
    manifest?: Manifest;
    grants?: Record<string, boolean>;
    tool?: string;
    state?: CapsuleState;
    netFetch?: (url: string, init?: unknown) => Promise<unknown>;
    packWrite?: (dir: string, out?: string) => Promise<unknown>;
  }): { runId: string; controller: EffectsController };
};

/**
 * Guest state and the journal are separate files by design, so a test gets two sidecars under
 * `.tmp/` and removes both. Handles are closed before the files are unlinked: Windows will not
 * unlink a database SQLite still has open.
 */
async function withRun(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const appPath = join(".tmp", `app-${randomUUID()}.sqlite`);
  const journalPath = join(".tmp", `journal-${randomUUID()}.sqlite`);
  const journal = openJournal(journalPath);
  const state = openState(appPath);
  try {
    await fn({
      journal,
      journalPath,
      state,
      effects(opts) {
        const manifest = opts.manifest ?? LOCAL;
        const runId = randomUUID();
        journal.beginRun({ runId, capsuleId: CAPSULE, tool: "greet", mode: opts.mode });
        let next = 0;
        const controller = createEffects({
          policy: buildPolicy({ manifest, capsuleId: CAPSULE, grants: opts.grants ?? {} }),
          journal,
          runId,
          tool: opts.tool ?? "greet",
          mode: opts.mode,
          recorded: opts.recorded,
          state: "state" in opts ? opts.state : state,
          clock: () => TIMES[next++] ?? "2026-01-01T00:00:09.000Z",
          randomBytes: (n) => "aa".repeat(n),
          netFetch: opts.netFetch,
          packWrite: opts.packWrite,
        });
        return { runId, controller };
      },
    });
  } finally {
    state.close();
    journal.close();
    for (const path of [appPath, journalPath]) {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(`${path}${suffix}`, { force: true });
    }
  }
}

/** `log.write` goes to stderr by design, so the test reads it there instead of shouting into it. */
async function captureStderr(fn: () => Promise<void>): Promise<string[]> {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return chunks;
}

test("records then replays an identical effect sequence", async () => {
  await withRun(async ({ journal, state, effects }) => {
    const record = effects({ mode: "record" });
    assert.equal(await record.controller.dispatch("greet", "kv.set", { key: "greeting", value: "hi" }), true);
    assert.equal(await record.controller.dispatch("greet", "kv.get", { key: "greeting" }), "hi");
    assert.equal(await record.controller.dispatch("greet", "clock.now", {}), TIMES[0]);
    assert.equal(record.controller.count(), 3);

    // Six events: one request and one completion per effect, in a chain that still verifies.
    const events = journal.events(record.runId);
    assert.deepEqual(
      events.map((e) => e.type),
      [
        EVENT.effectRequested,
        EVENT.effectCompleted,
        EVENT.effectRequested,
        EVENT.effectCompleted,
        EVENT.effectRequested,
        EVENT.effectCompleted,
      ],
    );
    assert.deepEqual(events[0]?.payload, {
      i: 0,
      op: "kv.set",
      paramsDigest: digestOf({ key: "greeting", value: "hi" }),
    });
    assert.doesNotThrow(() => journal.verifyChain(record.runId));

    const recorded = journal.effects(record.runId);
    assert.deepEqual(
      recorded.map((e) => [e.i, e.op, e.value]),
      [
        [0, "kv.set", true],
        [1, "kv.get", "hi"],
        [2, "clock.now", TIMES[0]],
      ],
    );
    for (const effect of recorded) {
      assert.equal(effect.valueDigest, digestOf(effect.value));
      // Timing is bucketed to 10 ms so it cannot make the chain unreproducible.
      assert.equal(typeof effect.ms, "number");
      assert.equal((effect.ms ?? 1) % 10, 0);
    }

    // Wipe the row the recorded run wrote: replay must not touch state to produce the same values.
    state.sqlExec("DELETE FROM kv");
    assert.equal(state.kvGet("greeting"), null);

    const replay = effects({ mode: "replay", recorded });
    assert.equal(await replay.controller.dispatch("greet", "kv.set", { key: "greeting", value: "hi" }), true);
    assert.equal(await replay.controller.dispatch("greet", "kv.get", { key: "greeting" }), "hi");
    assert.equal(await replay.controller.dispatch("greet", "clock.now", {}), TIMES[0]);
    assert.equal(state.kvGet("greeting"), null);

    // Same values and digests as the recording, minus the timings.
    const replayed = journal.effects(replay.runId);
    assert.deepEqual(
      replayed,
      recorded.map(({ ms, ...rest }) => {
        void ms;
        return rest;
      }),
    );
    assert.doesNotThrow(() => journal.verifyChain(replay.runId));
  });
});

test("replay diverges when the op order changes", async () => {
  await withRun(async ({ journal, effects }) => {
    const record = effects({ mode: "record" });
    await record.controller.dispatch("greet", "kv.set", { key: "a", value: "1" });
    await record.controller.dispatch("greet", "clock.now", {});
    const recorded = journal.effects(record.runId);

    const replay = effects({ mode: "replay", recorded });
    await assert.rejects(
      () => replay.controller.dispatch("greet", "clock.now", {}),
      capsuleError("E_NONDETERMINISM", /^effect #0 diverged: expected kv\.set\/sha256:[0-9a-f]{64}, got clock\.now\/sha256:[0-9a-f]{64}$/),
    );

    // An effect that runs past the end of the recording diverges the same way.
    const short = effects({ mode: "replay", recorded: [] });
    await assert.rejects(
      () => short.controller.dispatch("greet", "clock.now", {}),
      capsuleError("E_NONDETERMINISM", /^effect #0 diverged: expected undefined\/undefined, got clock\.now\//),
    );
  });
});

test("replay diverges when params change", async () => {
  await withRun(async ({ journal, effects }) => {
    const record = effects({ mode: "record" });
    await record.controller.dispatch("greet", "kv.get", { key: "a" });
    const recorded = journal.effects(record.runId);

    const replay = effects({ mode: "replay", recorded });
    await assert.rejects(
      () => replay.controller.dispatch("greet", "kv.get", { key: "b" }),
      capsuleError("E_NONDETERMINISM", /diverged/),
    );
  });
});

test("enforces per-op limits", async () => {
  await withRun(async ({ effects }) => {
    const { controller } = effects({ mode: "record" });
    assert.equal(await controller.dispatch("greet", "random.bytes", { n: 1 }), "aa");
    assert.equal(((await controller.dispatch("greet", "random.bytes", { n: 64 })) as string).length, 128);
    for (const n of [0, 65, 1.5, -1]) {
      await assert.rejects(
        () => controller.dispatch("greet", "random.bytes", { n }),
        capsuleError("E_USAGE", /random\.bytes requires 1 <= n <= 64/),
      );
    }

    await assert.rejects(
      () => controller.dispatch("greet", "kv.set", { key: "k", value: "x".repeat(65 * 1024) }),
      capsuleError("E_USAGE", /kv value exceeds 65536 bytes/),
    );
    await assert.rejects(
      () => controller.dispatch("greet", "kv.get", { key: "k".repeat(257) }),
      capsuleError("E_USAGE", /kv key exceeds 256 characters/),
    );
    // A limit violation still leaves the journal chain intact: the request was journalled, the
    // completion was not, and the ordinal was consumed.
    assert.equal(controller.count(), 8);

    await assert.rejects(
      () => controller.dispatch("greet", "log.write", { message: 42 }),
      capsuleError("E_USAGE", /log\.write requires a string message/),
    );
    // An oversized log message is truncated rather than refused, so a chatty capsule still runs,
    // and what reaches the terminal is sanitised: no escape sequences, on stderr, one line.
    const written = await captureStderr(async () => {
      assert.equal(await controller.dispatch("greet", "log.write", { message: "y".repeat(4096) }), true);
      assert.equal(await controller.dispatch("greet", "log.write", { message: "\u001B[31mred\u001B[0m" }), true);
    });
    assert.equal(written.length, 2);
    assert.equal(written[0]?.length, 2049);
    assert.equal(written[0]?.endsWith(" …[truncated]\n"), true);
    assert.equal(written[1], "red\n");

    await assert.rejects(
      () => controller.dispatch("greet", "sql.query", { sql: "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < 2000) SELECT n FROM c" }),
      capsuleError("E_USAGE", /sql\.query returned more than 1000 rows/),
    );
  });
});

test("blocks ATTACH and PRAGMA in sql.exec", async () => {
  await withRun(async ({ effects, state }) => {
    const { controller } = effects({ mode: "record" });
    const blocked = capsuleError("E_POLICY", /^sql\.exec disallows ATTACH\/PRAGMA\/VACUUM$/);
    for (const sql of [
      "ATTACH DATABASE 'evil.sqlite' AS evil",
      "attach database 'evil.sqlite' as evil",
      "PRAGMA journal_mode=DELETE",
      "VACUUM",
      "  /* sneaky */ ATTACH DATABASE 'evil.sqlite' AS evil",
      "-- comment\nPRAGMA foreign_keys=OFF",
    ]) {
      await assert.rejects(() => controller.dispatch("greet", "sql.exec", { sql }), blocked);
    }
    // `PRAGMA` is refused through the ports as well, so the probe uses the host's own handle.
    assert.equal(state.roDb.prepare("PRAGMA database_list").all().length, 1);

    // Ordinary statements still work, and the read-only handle refuses to write.
    assert.deepEqual(await controller.dispatch("greet", "sql.exec", { sql: "CREATE TABLE t (a TEXT)" }), {
      changes: 0,
    });
    assert.deepEqual(
      await controller.dispatch("greet", "sql.exec", { sql: "INSERT INTO t (a) VALUES (?)", params: ["x"] }),
      { changes: 1 },
    );
    // node:sqlite hands back null-prototype rows, which is exactly what a guest-supplied column name
    // should land in; spread them into plain objects to compare.
    const rows = (await controller.dispatch("greet", "sql.query", { sql: "SELECT a FROM t" })) as object[];
    assert.deepEqual(rows.map((row) => ({ ...row })), [{ a: "x" }]);
    await assert.rejects(() => controller.dispatch("greet", "sql.query", { sql: "DELETE FROM t" }), /readonly/);
  });
});

/**
 * A leading `;` is an empty statement SQLite skips, so a keyword check that only tolerates comments
 * is no check at all: both sql ports must find the first real token whatever precedes it.
 */
test("blocks disallowed statements hidden behind semicolons and comments", async () => {
  await withRun(async ({ effects, journalPath, state }) => {
    const { controller } = effects({ mode: "record" });
    const hidden = [
      ";ATTACH DATABASE 'evil.sqlite' AS evil",
      "\n;VACUUM",
      ";PRAGMA user_version=42",
      ";; -- x\n/* y */ ;attach database 'evil.sqlite' as evil",
      // The journal is a plain file on disk, so the read-only handle must refuse to link it in.
      `;ATTACH DATABASE '${journalPath}' AS j`,
      `/* j */ATTACH DATABASE '${journalPath}' AS j`,
    ];
    for (const sql of hidden) {
      await assert.rejects(
        () => controller.dispatch("greet", "sql.exec", { sql }),
        capsuleError("E_POLICY", /^sql\.exec disallows ATTACH\/PRAGMA\/VACUUM$/),
      );
      await assert.rejects(
        () => controller.dispatch("greet", "sql.query", { sql }),
        capsuleError("E_POLICY", /^sql\.query disallows ATTACH\/PRAGMA\/VACUUM$/),
      );
    }
    // Nothing got attached and nothing got reconfigured, on either handle.
    for (const handle of [state.db, state.roDb]) {
      assert.equal(handle.prepare("PRAGMA database_list").all().length, 1);
      assert.deepEqual({ ...(handle.prepare("PRAGMA user_version").get() as object) }, { user_version: 0 });
    }
  });
});

/**
 * The row and byte caps exist to stop a query the host cannot afford, so they have to hold while the
 * result is still arriving. A cap tested after the result is in memory is not a cap: the query has
 * already been paid for by then, and the payment is what kills the process.
 */
test("sql.query caps a result while it streams, not after", async () => {
  await withRun(async ({ effects }) => {
    const { controller } = effects({ mode: "record" });
    // Twenty million rows: materialising this before counting it is a heap OOM, not an E_USAGE.
    await assert.rejects(
      () =>
        controller.dispatch("greet", "sql.query", {
          sql: "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < 20000000) SELECT n FROM c",
        }),
      capsuleError("E_USAGE", /^sql\.query returned more than 1000 rows$/),
    );

    // Inside the row cap, past the byte budget: 100 rows of 40 000 hex characters is about 4 MiB.
    await assert.rejects(
      () =>
        controller.dispatch("greet", "sql.query", {
          sql: "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < 100)"
            + " SELECT hex(randomblob(20000)) AS b FROM c",
        }),
      capsuleError("E_USAGE", /^sql\.query result exceeds 1048576 bytes$/),
    );

    // One row is enough to bust the budget on its own. A gigabyte blob is measured by its own byte
    // length — serialising it to count it is what produced `RangeError` instead of a refusal — and
    // if SQLite cannot allocate it at all, that failure is the guest's query being too big too.
    await assert.rejects(
      () => controller.dispatch("greet", "sql.query", { sql: "SELECT randomblob(1000000000) AS b" }),
      capsuleError("E_USAGE", /exceeds 1048576 bytes|out of memory|too big|array length/i),
    );

    // A result inside both caps still comes back whole, right up to the last allowed row.
    const rows = (await controller.dispatch("greet", "sql.query", {
      sql: "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < 1000) SELECT n FROM c",
    })) as { n: number }[];
    assert.equal(rows.length, 1000);
    assert.equal(rows[999]?.n, 1000);
  });
});

test("kv value limit is measured in bytes, not UTF-16 units", async () => {
  await withRun(async ({ effects, state }) => {
    const { controller } = effects({ mode: "record" });
    // 30 000 euro signs are 30 000 UTF-16 units but 90 000 bytes: the budget is bytes.
    await assert.rejects(
      () => controller.dispatch("greet", "kv.set", { key: "euro", value: "\u20AC".repeat(30_000) }),
      capsuleError("E_USAGE", /^kv value exceeds 65536 bytes$/),
    );
    assert.equal(state.kvGet("euro"), null);
    // A multi-byte value that fits the byte budget is still accepted (21 845 × 3 = 65 535 bytes).
    const fits = "\u20AC".repeat(21_845);
    assert.equal(await controller.dispatch("greet", "kv.set", { key: "euro", value: fits }), true);
    assert.equal(state.kvGet("euro"), fits);
  });
});

/**
 * A failed effect consumes an ordinal but writes no completion, so the recording has a gap and
 * `recorded[i]` is not effect `i`. Replay is keyed on the ordinal: recorded ordinals are returned
 * verbatim, and a gap is executed so it fails exactly as it did in the recording.
 */
test("replays a run in which an effect failed", async () => {
  await withRun(async ({ journal, state, effects }) => {
    const oversized = { key: "big", value: "\u20AC".repeat(30_000) };
    const record = effects({ mode: "record" });
    assert.equal(await record.controller.dispatch("greet", "kv.set", { key: "a", value: "1" }), true);
    await assert.rejects(
      () => record.controller.dispatch("greet", "kv.set", oversized),
      capsuleError("E_USAGE", /^kv value exceeds 65536 bytes$/),
    );
    assert.equal(await record.controller.dispatch("greet", "kv.get", { key: "a" }), "1");
    assert.equal(record.controller.count(), 3);

    const recorded = journal.effects(record.runId);
    assert.deepEqual(
      recorded.map((e) => [e.i, e.op, e.value]),
      [
        [0, "kv.set", true],
        [2, "kv.get", "1"],
      ],
    );

    // With the row gone, an executed `kv.get` would answer `null`: "1" can only come from the
    // recording, which is how the test tells replayed values from re-executed ones.
    state.sqlExec("DELETE FROM kv");
    const replay = effects({ mode: "replay", recorded });
    assert.equal(await replay.controller.dispatch("greet", "kv.set", { key: "a", value: "1" }), true);
    await assert.rejects(
      () => replay.controller.dispatch("greet", "kv.set", oversized),
      capsuleError("E_USAGE", /^kv value exceeds 65536 bytes$/),
    );
    assert.equal(await replay.controller.dispatch("greet", "kv.get", { key: "a" }), "1");
    assert.equal(state.kvGet("a"), null);

    // Same ordinals, same values, same gap as the recording, minus the timings.
    assert.deepEqual(
      journal.effects(replay.runId),
      recorded.map(({ ms, ...rest }) => {
        void ms;
        return rest;
      }),
    );
    assert.doesNotThrow(() => journal.verifyChain(replay.runId));
  });
});

/**
 * A gap is not an unknown: the recording holds a request for that ordinal and no completion, which
 * proves the op failed. Running it is how the same failure is reproduced — so if it succeeds this
 * time, the recording and this run disagree about the world. That is a divergence, and it must not
 * be journalled as a completion or be allowed to leave the guest's state changed.
 */
test("replay diverges when a failed effect succeeds instead", async () => {
  await withRun(async ({ journal, state, effects }) => {
    const oversized = { key: "big", value: "\u20AC".repeat(30_000) };
    const record = effects({ mode: "record" });
    await record.controller.dispatch("greet", "kv.set", { key: "a", value: "1" });
    await assert.rejects(
      () => record.controller.dispatch("greet", "kv.set", oversized),
      capsuleError("E_USAGE", /^kv value exceeds 65536 bytes$/),
    );
    await record.controller.dispatch("greet", "kv.get", { key: "a" });
    const recorded = journal.effects(record.runId);
    assert.deepEqual(recorded.map((e) => e.i), [0, 2]);

    const replay = effects({ mode: "replay", recorded });
    assert.equal(await replay.controller.dispatch("greet", "kv.set", { key: "a", value: "1" }), true);
    await assert.rejects(
      // Same ordinal, a value that now fits: the op the recording says failed would succeed.
      () => replay.controller.dispatch("greet", "kv.set", { key: "big", value: "small" }),
      capsuleError("E_NONDETERMINISM", /^effect #1 diverged: expected failure, got completion$/),
    );

    // No completion for the diverging ordinal, and no write behind it either.
    assert.deepEqual(journal.effects(replay.runId).map((e) => e.i), [0]);
    assert.deepEqual(
      journal.events(replay.runId).map((e) => e.type),
      [EVENT.effectRequested, EVENT.effectCompleted, EVENT.effectRequested],
    );
    assert.equal(state.kvGet("big"), null);
    assert.doesNotThrow(() => journal.verifyChain(replay.runId));
  });
});

test("policy denial happens before journalling", async () => {
  await withRun(async ({ journal, effects }) => {
    const { runId, controller } = effects({
      mode: "record",
      manifest: manifestWith({}, ["clock.now"]),
    });
    await assert.rejects(
      () => controller.dispatch("greet", "kv.get", { key: "a" }),
      capsuleError("E_POLICY", /^tool greet did not declare effect kv\.get$/),
    );
    assert.equal(journal.events(runId).length, 0);
    assert.equal(controller.count(), 0);
  });
});

test("effects are bound to the run's tool", async () => {
  await withRun(async ({ journal, effects }) => {
    const { runId, controller } = effects({ mode: "record", tool: "greet" });
    await assert.rejects(
      () => controller.dispatch("other", "clock.now", {}),
      capsuleError("E_POLICY", /^effects are bound to tool greet, not other$/),
    );
    assert.equal(journal.events(runId).length, 0);
  });
});

test("delegates net.fetch and pack.write to the injected ports", async () => {
  await withRun(async ({ effects }) => {
    const calls: unknown[] = [];
    const manifest = manifestWith({ pack: true, net: { allowed_hosts: ["api.example.com"] } }, [
      "net.fetch",
      "pack.write",
    ]);
    const grants = { pack: true, "net:api.example.com": true };
    const { controller } = effects({
      mode: "record",
      manifest,
      grants,
      netFetch: async (url, init) => {
        calls.push([url, init]);
        return { status: 200, headers: {}, body: "ok" };
      },
      packWrite: async (dir, out) => {
        calls.push([dir, out]);
        return { path: out ?? "capsule.capsule" };
      },
    });
    assert.deepEqual(await controller.dispatch("greet", "net.fetch", { url: "https://api.example.com/v1" }), {
      status: 200,
      headers: {},
      body: "ok",
    });
    assert.deepEqual(await controller.dispatch("greet", "pack.write", { dir: "src", out: "out.capsule" }), {
      path: "out.capsule",
    });
    assert.deepEqual(calls, [["https://api.example.com/v1", undefined], ["src", "out.capsule"]]);

    // The host, not the whole URL, is what the policy is asked about.
    await assert.rejects(
      () => controller.dispatch("greet", "net.fetch", { url: "https://evil.com/steal" }),
      capsuleError("E_POLICY", /^host evil\.com is not in capabilities\.net\.allowed_hosts$/),
    );

    // A port that was never wired is a usage error, not a silent success.
    const bare = effects({ mode: "record", manifest, grants });
    await assert.rejects(
      () => bare.controller.dispatch("greet", "net.fetch", { url: "https://api.example.com/v1" }),
      capsuleError("E_USAGE", /^net\.fetch is not available in this runtime$/),
    );
  });
});

test("kv and sql refuse to run without capsule state", async () => {
  await withRun(async ({ effects }) => {
    const { controller } = effects({ mode: "record", state: undefined });
    await assert.rejects(
      () => controller.dispatch("greet", "kv.get", { key: "a" }),
      capsuleError("E_USAGE", /^kv\.get requires capsule state$/),
    );
  });
});
