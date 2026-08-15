import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadCapsule, packDirectory, type LoadedCapsule } from "../src/format/capsule.ts";
import { openJournal, EVENT } from "../src/runtime/journal.ts";
import { invokeTool, sidecarPaths } from "../src/runtime/invoke.ts";
import { exportTrace, type OTelTraceExport, type OTelSpan } from "../src/telemetry/otlp.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "hello");
const CLI = join(import.meta.dirname, "..", "src", "cli.ts");

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

async function packFixture(home: string): Promise<LoadedCapsule> {
  const file = join(home, "hello.capsule");
  await packDirectory(FIXTURE, file, { homeDir: home });
  return await loadCapsule(file, { homeDir: home });
}

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

test("exportTrace builds valid OTelTraceExport with resourceSpans, root, and effect child spans", async () => {
  await withHome(async (home) => {
    const capsule = await packFixture(home);
    const paths = sidecarPaths(capsule.file);
    const runId = randomUUID();

    const res = await invokeTool({
      capsule,
      tool: "greet",
      args: { name: "ada" },
      runId,
      journalPath: paths.journal,
      statePath: paths.app,
    });
    assert.equal(res.ok, true);

    const journal = openJournal(paths.journal);
    try {
      const trace = exportTrace({
        journal,
        runId,
        capsuleName: capsule.manifest.meta.name,
        capsuleVersion: capsule.manifest.meta.version,
      });

      assert.ok(Array.isArray(trace.resourceSpans));
      assert.equal(trace.resourceSpans.length, 1);

      const resourceSpan = trace.resourceSpans[0]!;
      assert.ok(resourceSpan.resource);
      assert.ok(Array.isArray(resourceSpan.resource.attributes));
      const serviceNameAttr = resourceSpan.resource.attributes.find((a: { key: string }) => a.key === "service.name");
      assert.equal(serviceNameAttr?.value.stringValue, "hello");

      assert.ok(resourceSpan.scopeSpans);
      assert.equal(resourceSpan.scopeSpans.length, 1);
      const scopeSpan = resourceSpan.scopeSpans[0]!;
      assert.equal(scopeSpan.scope.name, "agent-capsule");

      const spans = scopeSpan.spans;
      // greet has clock.now, kv.get, kv.set, log.write = 4 effects + 1 root span = 5 spans
      assert.ok(spans.length >= 2, `expected at least 2 spans, got ${spans.length}`);

      const rootSpan = spans[0]!;
      assert.equal(rootSpan.name, "execute_tool greet");
      assert.equal(rootSpan.kind, 1);
      assert.equal(rootSpan.parentSpanId, undefined);
      assert.equal(rootSpan.status.code, 0);
      assert.ok(/^[0-9a-f]{32}$/.test(rootSpan.traceId));
      assert.ok(/^[0-9a-f]{16}$/.test(rootSpan.spanId));
      assert.ok(BigInt(rootSpan.startTimeUnixNano) > 0n);
      assert.ok(BigInt(rootSpan.endTimeUnixNano) >= BigInt(rootSpan.startTimeUnixNano));

      const childSpans = spans.slice(1);
      for (const child of childSpans) {
        assert.equal(child.traceId, rootSpan.traceId);
        assert.equal(child.parentSpanId, rootSpan.spanId);
        assert.ok(child.name.startsWith("capsule.effect "));
        assert.ok(/^[0-9a-f]{16}$/.test(child.spanId));
        assert.notEqual(child.spanId, rootSpan.spanId);
        assert.equal(child.status.code, 0);
        assert.equal(child.kind, 1);
      }

      const effectOps = childSpans.map((s: OTelSpan) => {
        const attr = s.attributes.find((a: { key: string }) => a.key === "capsule.effect.op");
        return attr?.value.stringValue;
      });
      assert.ok(effectOps.includes("clock.now"));
      assert.ok(effectOps.includes("kv.get"));
      assert.ok(effectOps.includes("kv.set"));
      assert.ok(effectOps.includes("log.write"));
    } finally {
      journal.close();
    }
  });
});

test("exportTrace respects incoming traceparent for traceId and root parentSpanId", async () => {
  await withHome(async (home) => {
    const capsule = await packFixture(home);
    const paths = sidecarPaths(capsule.file);
    const runId = randomUUID();

    await invokeTool({
      capsule,
      tool: "greet",
      args: { name: "ada" },
      runId,
      journalPath: paths.journal,
      statePath: paths.app,
    });

    const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const journal = openJournal(paths.journal);
    try {
      const trace = exportTrace({
        journal,
        runId,
        traceparent,
      });

      const rootSpan = trace.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
      assert.equal(rootSpan.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
      assert.equal(rootSpan.parentSpanId, "00f067aa0ba902b7");

      const childSpans = trace.resourceSpans[0]!.scopeSpans[0]!.spans.slice(1);
      for (const child of childSpans) {
        assert.equal(child.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
        assert.equal(child.parentSpanId, rootSpan.spanId);
      }
    } finally {
      journal.close();
    }
  });
});

test("exportTrace attaches mcp.method.name and mcp.tool.name to the root span when given mcp options", async () => {
  await withHome(async (home) => {
    const capsule = await packFixture(home);
    const paths = sidecarPaths(capsule.file);
    const runId = randomUUID();

    await invokeTool({
      capsule,
      tool: "greet",
      args: { name: "ada" },
      runId,
      journalPath: paths.journal,
      statePath: paths.app,
    });

    const journal = openJournal(paths.journal);
    try {
      const trace = exportTrace({
        journal,
        runId,
        mcp: { method: "tools/call", tool: "greet" },
      });

      const rootSpan = trace.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
      const methodAttr = rootSpan.attributes.find((a: { key: string }) => a.key === "mcp.method.name");
      const toolAttr = rootSpan.attributes.find((a: { key: string }) => a.key === "mcp.tool.name");
      assert.equal(methodAttr?.value.stringValue, "tools/call");
      assert.equal(toolAttr?.value.stringValue, "greet");

      // A non-MCP run carries neither key: they describe the caller's protocol, not the run.
      const plain = exportTrace({ journal, runId });
      const plainRoot = plain.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
      assert.equal(
        plainRoot.attributes.find((a: { key: string }) => a.key === "mcp.method.name"),
        undefined,
      );
      assert.equal(
        plainRoot.attributes.find((a: { key: string }) => a.key === "mcp.tool.name"),
        undefined,
      );
    } finally {
      journal.close();
    }
  });
});

test("exportTrace reports status.code 2 and error attributes on failed tool execution", async () => {
  await withHome(async (home) => {
    const capsule = await packSource(
      home,
      "failer",
      'globalThis.tools = { fail() { throw new Error("intentional guest failure"); } };',
      { name: "fail", title: "fail", description: "fails", inputSchema: { type: "object" } },
    );
    const paths = sidecarPaths(capsule.file);
    const runId = randomUUID();

    const res = await invokeTool({
      capsule,
      tool: "fail",
      runId,
      journalPath: paths.journal,
      statePath: paths.app,
    });
    assert.equal(res.ok, false);

    const journal = openJournal(paths.journal);
    try {
      const trace = exportTrace({
        journal,
        runId,
        capsuleName: "failer",
      });

      const rootSpan = trace.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
      assert.equal(rootSpan.status.code, 2);
      assert.ok(rootSpan.status.message?.includes("intentional guest failure"));

      const errorTypeAttr = rootSpan.attributes.find((a: { key: string }) => a.key === "error.type");
      assert.equal(errorTypeAttr?.value.stringValue, "E_GUEST");
    } finally {
      journal.close();
    }
  });
});

test("exportTrace throws if journal verification fails", async () => {
  await withHome(async (home) => {
    const capsule = await packFixture(home);
    const paths = sidecarPaths(capsule.file);
    const runId = randomUUID();

    await invokeTool({
      capsule,
      tool: "greet",
      args: { name: "ada" },
      runId,
      journalPath: paths.journal,
      statePath: paths.app,
    });

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(paths.journal);
    db.prepare("UPDATE capsule_events SET payload = 'tampered' WHERE run_id = ? AND idx = 0").run(runId);
    db.close();

    const tamperedJournal = openJournal(paths.journal);
    try {
      assert.throws(
        () => exportTrace({ journal: tamperedJournal, runId }),
        (err: unknown) => {
          return err instanceof Error && err.message.includes("journal chain broken");
        },
      );
    } finally {
      tamperedJournal.close();
    }
  });
});

test("CLI run --trace emits valid OTel JSON to stdout with resourceSpans", async () => {
  await withHome(async (home) => {
    const capsule = await packFixture(home);

    const stdout = execFileSync(
      process.execPath,
      [CLI, "run", capsule.file, "--tool", "greet", "--args", '{"name":"ada"}', "--trace"],
      { env: { ...process.env, CAPSULE_HOME: home }, encoding: "utf8" },
    );

    const parsed = JSON.parse(stdout) as OTelTraceExport;
    assert.ok(Array.isArray(parsed.resourceSpans));
    assert.ok(parsed.resourceSpans[0]!.resource);
    assert.ok(parsed.resourceSpans[0]!.scopeSpans);
    assert.equal(parsed.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.name, "execute_tool greet");
    assert.equal(parsed.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.status.code, 0);
  });
});

test("exportTrace falls back to sha256 traceId on malformed traceparent and uses defaults when name/version omitted", async () => {
  await withHome(async (home) => {
    const capsule = await packFixture(home);
    const paths = sidecarPaths(capsule.file);
    const runId = randomUUID();

    await invokeTool({
      capsule,
      tool: "greet",
      args: { name: "ada" },
      runId,
      journalPath: paths.journal,
      statePath: paths.app,
    });

    const journal = openJournal(paths.journal);
    try {
      const trace = exportTrace({
        journal,
        runId,
        traceparent: "invalid-traceparent",
      });

      const rootSpan = trace.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
      assert.ok(/^[0-9a-f]{32}$/.test(rootSpan.traceId));
      assert.equal(rootSpan.parentSpanId, undefined);

      const serviceNameAttr = trace.resourceSpans[0]!.resource.attributes.find((a: { key: string }) => a.key === "service.name");
      assert.equal(serviceNameAttr?.value.stringValue, "agent-capsule");
      assert.equal(trace.resourceSpans[0]!.scopeSpans[0]!.scope.name, "agent-capsule");
    } finally {
      journal.close();
    }
  });
});

test("CLI run --trace --json outputs single line JSON with resourceSpans", async () => {
  await withHome(async (home) => {
    const capsule = await packFixture(home);

    const stdout = execFileSync(
      process.execPath,
      [CLI, "run", capsule.file, "--tool", "greet", "--args", '{"name":"ada"}', "--trace", "--json"],
      { env: { ...process.env, CAPSULE_HOME: home }, encoding: "utf8" },
    );

    assert.ok(!stdout.trim().includes("\n"));
    const parsed = JSON.parse(stdout) as OTelTraceExport;
    assert.ok(Array.isArray(parsed.resourceSpans));
    assert.ok(parsed.resourceSpans[0]!.resource);
    assert.ok(parsed.resourceSpans[0]!.scopeSpans);
    assert.equal(parsed.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.name, "execute_tool greet");
  });
});
