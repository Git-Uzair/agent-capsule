import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { digestOf } from "../src/core/digest.ts";
import { loadCapsule, packDirectory, type LoadedCapsule } from "../src/format/capsule.ts";
import { invokeTool, sidecarPaths, type InvokeResult } from "../src/runtime/invoke.ts";
import { EVENT, openJournal } from "../src/runtime/journal.ts";
import { replayRun, type ReplayResult } from "../src/runtime/replay.ts";
import { openState } from "../src/runtime/state.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "hello");
const CLI = join(import.meta.dirname, "..", "src", "cli.ts");

/** The instant the recording was made at; a faithful replay hands it back rather than reading a clock. */
const AT = "2026-01-01T00:00:00.000Z";

/**
 * Every test gets its own `CAPSULE_HOME`: the trust store pins a capsule by name and the grant store
 * keys off its id, so a shared home would let one test's pin decide another test's outcome. The
 * capsules and their sidecars live in that home too, which is what makes cleanup one `rmSync`.
 */
async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = join(".tmp", `home-${randomUUID()}`);
  const previous = process.env.CAPSULE_HOME;
  process.env.CAPSULE_HOME = home;
  mkdirSync(home, { recursive: true });
  try {
    await fn(home);
  } finally {
    if (previous === undefined) delete process.env.CAPSULE_HOME;
    else process.env.CAPSULE_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

/**
 * The signed fixture capsule, packed into the test's own home. `greet` is the tool under replay.
 * A `source` argument repacks the fixture with a different guest: the manifest is copied verbatim, so
 * the tool catalog — and the trust pin keyed on it — is unchanged while the capsule id is not.
 */
async function packFixture(home: string, source?: string): Promise<LoadedCapsule> {
  const file = join(home, `hello-${randomUUID()}.capsule`);
  let dir = FIXTURE;
  if (source !== undefined) {
    dir = join(home, `src-${randomUUID()}`);
    cpSync(FIXTURE, dir, { recursive: true });
    writeFileSync(join(dir, "src", "main.js"), source);
  }
  await packDirectory(dir, file, { homeDir: home });
  return await loadCapsule(file, { homeDir: home });
}

/**
 * One recorded run, with its arguments journalled: a replay re-runs the guest, so it needs the
 * arguments the guest was called with, and the journal only keeps them when it is asked to.
 */
async function record(capsule: LoadedCapsule, name: string, journalPath?: string): Promise<InvokeResult> {
  process.env.CAPSULE_JOURNAL_ARGS = "1";
  try {
    return await invokeTool({
      capsule,
      tool: "greet",
      args: { name },
      clock: () => AT,
      ...(journalPath === undefined ? {} : { journalPath }),
    });
  } finally {
    delete process.env.CAPSULE_JOURNAL_ARGS;
  }
}

type Recorded = { type: string; payload: unknown };

function eventsOf(journalPath: string, runId: string): Recorded[] {
  const journal = openJournal(journalPath);
  try {
    journal.verifyChain(runId);
    return journal.events(runId).map((e) => ({ type: e.type, payload: e.payload }));
  } finally {
    journal.close();
  }
}

/**
 * A second run in the same journal, appended through the journal's own API so its hash chain
 * verifies. This is how a recording made by an older build of a capsule is simulated: the events say
 * one thing, the guest that runs now does another, and only a properly chained journal proves the
 * divergence was detected by replay rather than by the chain check in front of it.
 */
function forgeRun(journalPath: string, capsuleId: string, events: Recorded[]): string {
  const journal = openJournal(journalPath);
  const runId = `forged-${randomUUID()}`;
  try {
    journal.beginRun({ runId, capsuleId, tool: "greet", startedAt: "2025-01-01T00:00:00.000Z" });
    for (const event of events) journal.append(runId, event.type, event.payload);
    journal.finishRun(runId, "ok");
  } finally {
    journal.close();
  }
  return runId;
}

/** The ordinal an effect event carries, which is what replay matches a recorded effect on. */
function ordinalOf(event: Recorded): number {
  return (event.payload as { i: number }).i;
}

function kvValue(appPath: string, key: string): string | null {
  const state = openState(appPath);
  try {
    return state.kvGet(key);
  } finally {
    state.close();
  }
}

function runCount(journalPath: string): number {
  const db = new DatabaseSync(journalPath);
  try {
    return Number((db.prepare("SELECT COUNT(*) AS n FROM capsule_runs").get() as { n: number }).n);
  } finally {
    db.close();
  }
}

function runCli(args: string[], home: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      env: { ...process.env, CAPSULE_HOME: home, CAPSULE_JOURNAL_ARGS: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

test("replays a recorded run to the recorded value digest without touching guest state", async () => {
  await withHome(async (home) => {
    const capsule = await packFixture(home);
    const paths = sidecarPaths(capsule.file);
    const recorded = await record(capsule, "ada");
    assert.equal(recorded.ok, true);
    assert.equal(kvValue(paths.app, "greet_count"), "1");

    const replay = await replayRun({ capsule, runId: recorded.runId, homeDir: home });

    assert.equal(replay.error, undefined);
    assert.equal(replay.ok, true);
    assert.equal(replay.diverged, false);
    assert.equal(replay.runId, recorded.runId);
    assert.equal(replay.tool, "greet");
    assert.equal(replay.effects, 4);
    assert.equal(replay.events, recorded.events);
    assert.deepEqual(replay.value, recorded.value);
    assert.equal(replay.recordedValueDigest, digestOf(recorded.value));

    // The effects came out of the journal, not out of the world: the counter the recorded run
    // incremented is exactly where it was left, and the journal gained neither a run nor an event.
    assert.equal(kvValue(paths.app, "greet_count"), "1");
    assert.equal(runCount(paths.journal), 1);
    assert.equal(eventsOf(paths.journal, recorded.runId).length, recorded.events);
  });
});

test("replays the capsule's latest run by default, at the recorded instant", async () => {
  await withHome(async (home) => {
    const capsule = await packFixture(home);
    await record(capsule, "ada");
    const second = await record(capsule, "bob");

    // No runId and no clock: the instant in the value can only have come from the journal.
    const replay = await replayRun({ capsule, homeDir: home });

    assert.equal(replay.ok, true);
    assert.equal(replay.runId, second.runId);
    assert.deepEqual(replay.value, { text: "hello bob", at: AT, count: 2 });
  });
});

test("refuses a run recorded by a different capsule", async () => {
  await withHome(async (home) => {
    const capsule = await packFixture(home);
    const recorded = await record(capsule, "ada");
    const changed = await packFixture(
      home,
      'globalThis.tools = {\n  greet(args) {\n    const seen = Number(capsule.kv.get("greet_count") ?? "0") + 1;\n' +
        '    capsule.kv.set("greet_count", String(seen));\n    capsule.log("greeted " + args.name);\n' +
        '    return { text: "HELLO " + args.name, at: capsule.now(), count: seen };\n  },\n};\n',
    );
    assert.notEqual(changed.capsuleId, capsule.capsuleId);

    await assert.rejects(
      () => replayRun({ capsule: changed, runId: recorded.runId, journalPath: sidecarPaths(capsule.file).journal }),
      (e: Error & { code?: string }) => {
        assert.equal(e.code, "E_USAGE");
        assert.match(e.message, /was recorded by a different capsule/);
        return true;
      },
    );
  });
});

test("reports a divergence when the recording asks for a different effect", async () => {
  await withHome(async (home) => {
    const capsule = await packFixture(home);
    const paths = sidecarPaths(capsule.file);
    const recorded = await record(capsule, "ada");
    // The recording says the guest read a different key first. The guest that runs now reads
    // `greet_count`, which is a divergence at effect #0.
    const forged = forgeRun(
      paths.journal,
      capsule.capsuleId,
      eventsOf(paths.journal, recorded.runId).map((event) =>
        event.type === EVENT.effectCompleted && ordinalOf(event) === 0
          ? { type: event.type, payload: { ...(event.payload as object), paramsDigest: digestOf({ key: "other" }) } }
          : event,
      ),
    );

    const replay = await replayRun({ capsule, runId: forged, journalPath: paths.journal, homeDir: home });

    assert.equal(replay.ok, false);
    assert.equal(replay.diverged, true);
    assert.equal(replay.error?.code, "E_NONDETERMINISM");
    assert.match(replay.error?.message ?? "", /effect #0 diverged/);
    assert.equal(replay.value, undefined);
  });
});

test("reports a divergence when the recording ends before the guest does", async () => {
  await withHome(async (home) => {
    const capsule = await packFixture(home);
    const paths = sidecarPaths(capsule.file);
    const recorded = await record(capsule, "ada");
    // Two of the four effects survive, so the chain is dense and verifies: the truncation is only
    // discovered when the guest asks for effect #2 and the recording has nothing to say about it.
    const forged = forgeRun(
      paths.journal,
      capsule.capsuleId,
      eventsOf(paths.journal, recorded.runId).filter(
        (event) =>
          (event.type !== EVENT.effectRequested && event.type !== EVENT.effectCompleted) || ordinalOf(event) < 2,
      ),
    );

    const replay = await replayRun({ capsule, runId: forged, journalPath: paths.journal, homeDir: home });

    assert.equal(replay.ok, false);
    assert.equal(replay.diverged, true);
    assert.equal(replay.error?.code, "E_NONDETERMINISM");
    assert.match(replay.error?.message ?? "", /effect #2 diverged/);
  });
});

test("reports a divergence when the replayed value differs from the recorded one", async () => {
  await withHome(async (home) => {
    const capsule = await packFixture(home);
    const paths = sidecarPaths(capsule.file);
    const recorded = await record(capsule, "ada");
    // Every effect is reproduced faithfully; only the value the recording claims is different, which
    // is what a changed guest looks like once its effects are unchanged.
    const forged = forgeRun(
      paths.journal,
      capsule.capsuleId,
      eventsOf(paths.journal, recorded.runId).map((event) =>
        event.type === EVENT.toolCompleted
          ? { type: event.type, payload: { tool: "greet", valueDigest: digestOf({ text: "something else" }) } }
          : event,
      ),
    );

    const replay = await replayRun({ capsule, runId: forged, journalPath: paths.journal, homeDir: home });

    assert.equal(replay.ok, false);
    assert.equal(replay.diverged, true);
    assert.equal(replay.error?.code, "E_NONDETERMINISM");
    assert.match(replay.error?.message ?? "", /value digest/);
    assert.equal(replay.effects, 4);
    assert.deepEqual(replay.value, { text: "hello ada", at: AT, count: 1 });
  });
});

test("reports a divergence when the recording holds an effect the guest never asks for", async () => {
  await withHome(async (home) => {
    const capsule = await packFixture(home);
    const paths = sidecarPaths(capsule.file);
    const recorded = await record(capsule, "ada");
    // A fifth effect the guest that runs now does not ask for. Every ordinal it does ask for matches
    // and the recorded value is untouched, so nothing but the count of effects gives this away.
    const spare = { i: 4, op: "clock.now", paramsDigest: digestOf({}) };
    const forged = forgeRun(
      paths.journal,
      capsule.capsuleId,
      eventsOf(paths.journal, recorded.runId).flatMap((event) =>
        event.type === EVENT.toolCompleted
          ? [
              { type: EVENT.effectRequested, payload: spare },
              { type: EVENT.effectCompleted, payload: { ...spare, value: AT, valueDigest: digestOf(AT) } },
              event,
            ]
          : [event],
      ),
    );

    const replay = await replayRun({ capsule, runId: forged, journalPath: paths.journal, homeDir: home });

    assert.equal(replay.ok, false);
    assert.equal(replay.diverged, true);
    assert.equal(replay.error?.code, "E_NONDETERMINISM");
    assert.match(replay.error?.message ?? "", /stopped after 4 of 5 recorded effects/);
  });
});

test("a guest that swallows a diverged effect still reports the divergence", async () => {
  await withHome(async (home) => {
    // This guest catches what `kv.get` throws and carries on with the same answer it would have
    // computed anyway, so the effects after the first one, and the value itself, are word for word
    // what the recording holds. Nothing on the guest's side of the sandbox is left to give the
    // divergence away: the verdict has to have been kept by the host.
    const capsule = await packFixture(
      home,
      "globalThis.tools = {\n" +
        "  greet(args) {\n" +
        "    let seen;\n" +
        '    try {\n      seen = Number(capsule.kv.get("greet_count") ?? "0") + 1;\n' +
        "    } catch (e) {\n      seen = 1;\n    }\n" +
        '    capsule.kv.set("greet_count", String(seen));\n' +
        '    capsule.log("greeted " + args.name);\n' +
        '    return { text: "hello " + args.name, at: capsule.now(), count: seen };\n' +
        "  },\n};\n",
    );
    const paths = sidecarPaths(capsule.file);
    const recorded = await record(capsule, "ada");
    assert.deepEqual(recorded.value, { text: "hello ada", at: AT, count: 1 });

    const forged = forgeRun(
      paths.journal,
      capsule.capsuleId,
      eventsOf(paths.journal, recorded.runId).map((event) =>
        event.type === EVENT.effectCompleted && ordinalOf(event) === 0
          ? { type: event.type, payload: { ...(event.payload as object), paramsDigest: digestOf({ key: "other" }) } }
          : event,
      ),
    );

    const replay = await replayRun({ capsule, runId: forged, journalPath: paths.journal, homeDir: home });

    // The value matches the recording exactly, and the replay is still not faithful.
    assert.deepEqual(replay.value, recorded.value);
    assert.equal(replay.recordedValueDigest, digestOf(recorded.value));
    assert.equal(replay.diverged, true);
    assert.equal(replay.ok, false);
    assert.equal(replay.error?.code, "E_NONDETERMINISM");
    assert.match(replay.error?.message ?? "", /effect #0 diverged/);
  });
});

test("replays a recording whose last effect failed", async () => {
  await withHome(async (home) => {
    // This guest's last effect is a `kv.get` with a key that is not a string, which the port refuses,
    // and it catches the refusal and returns anyway. So the recording ends *at* a failure: the highest
    // ordinal it holds a request for has no completion behind it. A faithful replay re-runs that effect
    // and is refused again — the recording does not stop one ordinal earlier than it looks.
    const capsule = await packFixture(
      home,
      "globalThis.tools = {\n" +
        "  greet(args) {\n" +
        '    const seen = Number(capsule.kv.get("greet_count") ?? "0") + 1;\n' +
        '    capsule.kv.set("greet_count", String(seen));\n' +
        '    capsule.log("greeted " + args.name);\n' +
        "    const at = capsule.now();\n" +
        '    let extra = "read";\n' +
        "    try {\n      capsule.kv.get(7);\n    } catch (e) {\n      extra = e.code;\n    }\n" +
        '    return { text: "hello " + args.name, at, count: seen, extra };\n' +
        "  },\n};\n",
    );
    const paths = sidecarPaths(capsule.file);
    const recorded = await record(capsule, "ada");
    assert.deepEqual(recorded.value, { text: "hello ada", at: AT, count: 1, extra: "E_USAGE" });

    // Five effects were asked for and four answered: the trailing request is the whole point.
    const events = eventsOf(paths.journal, recorded.runId);
    assert.deepEqual(
      events.filter((e) => e.type === EVENT.effectRequested).map(ordinalOf),
      [0, 1, 2, 3, 4],
    );
    assert.deepEqual(
      events.filter((e) => e.type === EVENT.effectCompleted).map(ordinalOf),
      [0, 1, 2, 3],
    );

    const replay = await replayRun({ capsule, runId: recorded.runId, homeDir: home });

    assert.equal(replay.error, undefined);
    assert.equal(replay.ok, true);
    assert.equal(replay.diverged, false);
    assert.equal(replay.effects, 5);
    assert.deepEqual(replay.value, recorded.value);
    assert.equal(replay.recordedValueDigest, digestOf(recorded.value));
  });
});

test("refuses a run whose arguments were not journalled", async () => {
  await withHome(async (home) => {
    const capsule = await packFixture(home);
    const recorded = await invokeTool({ capsule, tool: "greet", args: { name: "ada" }, clock: () => AT });
    assert.equal(recorded.ok, true);

    await assert.rejects(
      () => replayRun({ capsule, runId: recorded.runId, homeDir: home }),
      (e: Error & { code?: string }) => {
        assert.equal(e.code, "E_USAGE");
        assert.match(e.message, /did not journal its arguments/);
        return true;
      },
    );
  });
});

test("refuses a capsule with no recorded runs", async () => {
  await withHome(async (home) => {
    const capsule = await packFixture(home);

    await assert.rejects(
      () => replayRun({ capsule, journalPath: join(home, "empty.sqlite"), homeDir: home }),
      (e: Error & { code?: string }) => {
        assert.equal(e.code, "E_USAGE");
        assert.match(e.message, /no runs recorded for hello/);
        return true;
      },
    );
  });
});

test("cli replay exits 0 on a faithful replay and 1 on a divergence", async () => {
  await withHome(async (home) => {
    const file = join(home, "hello.capsule");
    await packDirectory(FIXTURE, file, { homeDir: home });
    const paths = sidecarPaths(file);

    const run = runCli(["run", file, "--tool", "greet", "--args", '{"name":"ada"}', "--json"], home);
    assert.equal(run.status, 0);
    const runId = (JSON.parse(run.stdout) as InvokeResult).runId;

    const ok = runCli(["replay", file, "--run", runId, "--json"], home);
    assert.equal(ok.status, 0);
    const report = JSON.parse(ok.stdout) as ReplayResult;
    assert.equal(report.ok, true);
    assert.equal(report.diverged, false);
    assert.equal(report.runId, runId);
    assert.equal(report.effects, 4);

    const human = runCli(["replay", file], home);
    assert.equal(human.status, 0);
    assert.match(human.stdout + human.stderr, /replay ok/);

    const capsule = await loadCapsule(file, { homeDir: home });
    const forged = forgeRun(
      paths.journal,
      capsule.capsuleId,
      eventsOf(paths.journal, runId).map((event) =>
        event.type === EVENT.toolCompleted
          ? { type: event.type, payload: { tool: "greet", valueDigest: digestOf({ text: "no" }) } }
          : event,
      ),
    );

    const diverged = runCli(["replay", file, "--run", forged, "--json"], home);
    assert.equal(diverged.status, 1);
    const divergedReport = JSON.parse(diverged.stdout) as ReplayResult;
    assert.equal(divergedReport.ok, false);
    assert.equal(divergedReport.diverged, true);
    assert.equal(divergedReport.error?.code, "E_NONDETERMINISM");

    // A run that is not there is the user's mistake, reported with a code and no host stack frames.
    const missing = runCli(["replay", file, "--run", "nope"], home);
    assert.equal(missing.status, 1);
    const output = missing.stdout + missing.stderr;
    assert.match(output, /E_USAGE: /);
    assert.doesNotMatch(output, /^\s+at /m);
  });
});
