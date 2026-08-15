import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadCapsule, packDirectory, type LoadedCapsule } from "../src/format/capsule.ts";
import { EVENT, openJournal } from "../src/runtime/journal.ts";
import { invokeTool, sidecarPaths, type InvokeResult } from "../src/runtime/invoke.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "hello");
const CLI = join(import.meta.dirname, "..", "src", "cli.ts");

/** One fixed instant, so a recorded value is a value the assertions can name. */
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

/** The signed fixture capsule, packed into the test's own home. */
async function packFixture(home: string): Promise<LoadedCapsule> {
  const file = join(home, "hello.capsule");
  await packDirectory(FIXTURE, file, { homeDir: home });
  return await loadCapsule(file, { homeDir: home });
}

/**
 * A one-tool capsule built from source in the test itself: the pipeline's failure paths are about
 * what a guest returns or throws, which a fixture on disk cannot vary.
 */
async function packSource(
  home: string,
  name: string,
  source: string,
  tool: Record<string, unknown>,
  capabilities: Record<string, unknown> = { kv: true },
): Promise<LoadedCapsule> {
  const dir = join(home, `src-${name}`);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "main.js"), source);
  writeFileSync(
    join(dir, "capsule.json"),
    JSON.stringify({
      spec_version: "0.1.0",
      meta: { name, version: "1.0.0", title: name, description: `Test capsule ${name}.` },
      runtime: { type: "quickjs-1", entry: "src/main.js", timeout_ms: 2000 },
      capabilities,
      tools: [tool],
    }),
  );
  const file = join(home, `${name}.capsule`);
  await packDirectory(dir, file, { homeDir: home });
  return await loadCapsule(file, { homeDir: home });
}

function eventTypes(journalPath: string, runId: string): string[] {
  const journal = openJournal(journalPath);
  try {
    journal.verifyChain(runId);
    return journal.events(runId).map((e) => e.type);
  } finally {
    journal.close();
  }
}

function runCli(args: string[], home: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [CLI, "run", ...args], {
      encoding: "utf8",
      env: { ...process.env, CAPSULE_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

test("invokes the fixture tool and journals a verifiable run", async () => {
  await withHome(async (home) => {
    const capsule = await packFixture(home);
    const result = await invokeTool({ capsule, tool: "greet", args: { name: "ada" }, clock: () => AT });

    assert.equal(result.ok, true);
    assert.equal(result.tool, "greet");
    assert.equal(result.error, undefined);
    assert.deepEqual(result.value, { text: "hello ada", at: AT, count: 1 });
    assert.equal(result.effects, 4);
    assert.ok(result.ms >= 0);

    // The chain verifies and the run reads as one story: started, proposed, authorized, four
    // effects as a request/completion pair each, then the tool's value and the run's end.
    const types = eventTypes(sidecarPaths(capsule.file).journal, result.runId);
    assert.deepEqual(types, [
      EVENT.runStarted,
      EVENT.toolProposed,
      EVENT.toolAuthorized,
      EVENT.effectRequested,
      EVENT.effectCompleted,
      EVENT.effectRequested,
      EVENT.effectCompleted,
      EVENT.effectRequested,
      EVENT.effectCompleted,
      EVENT.effectRequested,
      EVENT.effectCompleted,
      EVENT.toolCompleted,
      EVENT.runFinished,
    ]);
    assert.equal(result.events, types.length);
  });
});

test("kv state persists across two invocations", async () => {
  await withHome(async (home) => {
    const capsule = await packFixture(home);
    const first = await invokeTool({ capsule, tool: "greet", args: { name: "ada" }, clock: () => AT });
    const second = await invokeTool({ capsule, tool: "greet", args: { name: "ada" }, clock: () => AT });

    assert.equal((first.value as { count: number }).count, 1);
    assert.equal((second.value as { count: number }).count, 2);
    assert.notEqual(first.runId, second.runId);
  });
});

test("rejects arguments that violate inputSchema without starting a run", async () => {
  await withHome(async (home) => {
    const capsule = await packFixture(home);
    const journalPath = join(home, "j.sqlite");
    const result = await invokeTool({ capsule, tool: "greet", args: {}, journalPath });

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "E_USAGE");
    assert.match(result.error?.message ?? "", /invalid tool arguments/);
    assert.equal(result.events, 0);
    assert.equal(result.effects, 0);

    const journal = openJournal(journalPath);
    assert.equal(journal.latestRunId(), null);
    journal.close();
  });
});

test("rejects an unknown tool name", async () => {
  await withHome(async (home) => {
    const capsule = await packFixture(home);
    const result = await invokeTool({ capsule, tool: "nope", args: {} });

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "E_USAGE");
    assert.match(result.error?.message ?? "", /unknown tool: nope/);
    assert.equal(result.events, 0);
  });
});

test("refuses an ungranted net tool up front and journals nothing", async () => {
  await withHome(async (home) => {
    const capsule = await packSource(
      home,
      "netcap",
      'globalThis.tools = { pull() { return capsule.fetch("https://api.example.com/x"); } };',
      {
        name: "pull",
        title: "Pull",
        description: "Fetches a URL.",
        inputSchema: { type: "object" },
        effects: ["net.fetch"],
      },
      { net: { allowed_hosts: ["api.example.com"] } },
    );
    const journalPath = join(home, "net.sqlite");
    let fetched = false;
    const result = await invokeTool({
      capsule,
      tool: "pull",
      journalPath,
      netFetch: async () => {
        fetched = true;
        return { status: 200 };
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "E_POLICY");
    assert.match(result.error?.message ?? "", /missing user grants: net:api\.example\.com/);
    assert.equal(result.events, 0);
    assert.equal(fetched, false);

    const journal = openJournal(journalPath);
    assert.equal(journal.latestRunId(), null);
    journal.close();
  });
});

test("a granted net tool reaches the injected fetch port", async () => {
  await withHome(async (home) => {
    const capsule = await packSource(
      home,
      "netcap2",
      'globalThis.tools = { pull() { return capsule.fetch("https://api.example.com/x"); } };',
      {
        name: "pull",
        title: "Pull",
        description: "Fetches a URL.",
        inputSchema: { type: "object" },
        effects: ["net.fetch"],
      },
      { net: { allowed_hosts: ["api.example.com"] } },
    );
    const seen: string[] = [];
    const result = await invokeTool({
      capsule,
      tool: "pull",
      grants: { "net:api.example.com": true },
      netFetch: async (url) => {
        seen.push(url);
        return { status: 200, body: "ok" };
      },
    });

    assert.equal(result.error, undefined);
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, { status: 200, body: "ok" });
    assert.deepEqual(seen, ["https://api.example.com/x"]);
    assert.equal(result.effects, 1);
  });
});

test("rejects a value that does not match outputSchema", async () => {
  await withHome(async (home) => {
    const capsule = await packSource(
      home,
      "outschema",
      'globalThis.tools = { count() { return { text: "not a number" }; } };',
      {
        name: "count",
        title: "Count",
        description: "Returns a number.",
        inputSchema: { type: "object" },
        outputSchema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
        effects: [],
      },
      {},
    );
    const result = await invokeTool({ capsule, tool: "count" });

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "E_GUEST");
    assert.match(result.error?.message ?? "", /outputSchema/);
  });
});

test("sanitises hostile guest output", async () => {
  await withHome(async (home) => {
    const capsule = await packSource(
      home,
      "hostile",
      'globalThis.tools = { say() { return { text: "\\u001B[31mx\\u200B", nested: ["\\u0007y"] }; } };',
      {
        name: "say",
        title: "Say",
        description: "Returns text.",
        inputSchema: { type: "object" },
        effects: [],
      },
      {},
    );
    const result = await invokeTool({ capsule, tool: "say" });

    assert.equal(result.ok, true);
    assert.deepEqual(result.value, { text: "x", nested: ["y"] });
  });
});

test("a guest throw is reported as E_GUEST and the run is journalled as an error", async () => {
  await withHome(async (home) => {
    const capsule = await packSource(
      home,
      "thrower",
      'globalThis.tools = { boom() { throw new Error("kaboom"); } };',
      {
        name: "boom",
        title: "Boom",
        description: "Throws.",
        inputSchema: { type: "object" },
        effects: [],
      },
      {},
    );
    const journalPath = join(home, "boom.sqlite");
    const result = await invokeTool({ capsule, tool: "boom", journalPath });

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "E_GUEST");
    assert.match(result.error?.message ?? "", /kaboom/);
    assert.equal(result.value, undefined);

    const journal = openJournal(journalPath);
    try {
      journal.verifyChain(result.runId);
      const events = journal.events(result.runId);
      assert.deepEqual(events.map((e) => e.type), [
        EVENT.runStarted,
        EVENT.toolProposed,
        EVENT.toolAuthorized,
        EVENT.toolCompleted,
        EVENT.runFinished,
      ]);
      const finished = events.at(-1)?.payload as { status: string; code: string };
      assert.equal(finished.status, "error");
      assert.equal(finished.code, "E_GUEST");
    } finally {
      journal.close();
    }
  });
});

test("cli run exits 0 with a value and 1 on a failure", async () => {
  await withHome(async (home) => {
    const file = join(home, "hello.capsule");
    await packDirectory(FIXTURE, file, { homeDir: home });

    const ok = runCli([file, "--tool", "greet", "--args", '{"name":"ada"}', "--json"], home);
    assert.equal(ok.status, 0);
    const report = JSON.parse(ok.stdout) as InvokeResult;
    assert.equal(report.ok, true);
    assert.equal((report.value as { text: string }).text, "hello ada");
    assert.equal(report.effects, 4);

    const human = runCli([file, "--tool", "greet", "--args", '{"name":"bob"}'], home);
    assert.equal(human.status, 0);
    assert.match(human.stdout, /hello bob/);

    const bad = runCli([file, "--tool", "nope", "--json"], home);
    assert.equal(bad.status, 1);
    assert.equal((JSON.parse(bad.stdout) as InvokeResult).error?.code, "E_USAGE");
  });
});
