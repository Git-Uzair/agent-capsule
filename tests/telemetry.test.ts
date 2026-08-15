import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadCapsule, packDirectory, type LoadedCapsule } from "../src/format/capsule.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { invokeTool, sidecarPaths } from "../src/runtime/invoke.ts";
import { openJournal, EVENT } from "../src/runtime/journal.ts";
import { ATTR } from "../src/telemetry/semconv.ts";
import {
  exportTrace,
  startSpan,
  endSpan,
  writeTrace,
  SPAN_KIND,
  SPAN_STATUS,
  type OTelTraceExport,
  type OTelSpan,
} from "../src/telemetry/otlp.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "hello");

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

function getAllSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      files.push(...getAllSourceFiles(fullPath));
    } else if (fullPath.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

test("ATTR contains semantic convention constants and no gen_ai. literals exist elsewhere in src", () => {
  assert.equal(ATTR.GEN_AI_OPERATION_NAME, "gen_ai.operation.name");
  assert.equal(ATTR.GEN_AI_TOOL_NAME, "gen_ai.tool.name");
  assert.equal(ATTR.GEN_AI_CLIENT_OPERATION_DURATION, "gen_ai.client.operation.duration");
  assert.equal(ATTR.MCP_METHOD_NAME, "mcp.method.name");
  assert.equal(ATTR.MCP_TOOL_NAME, "mcp.tool.name");
  assert.equal(ATTR.ERROR_TYPE, "error.type");
  assert.equal(ATTR.ERROR_MESSAGE, "error.message");
  assert.equal(ATTR.SERVICE_NAME, "service.name");
  assert.equal(ATTR.SERVICE_VERSION, "service.version");
  assert.equal(ATTR.CAPSULE_ID, "capsule.id");
  assert.equal(ATTR.CAPSULE_RUN_ID, "capsule.run_id");
  assert.equal(ATTR.CAPSULE_MODE, "capsule.mode");
  assert.equal(ATTR.CAPSULE_EFFECT_OP, "capsule.effect.op");

  const srcDir = join(import.meta.dirname, "..", "src");
  const semconvPath = join(srcDir, "telemetry", "semconv.ts");
  const allSourceFiles = getAllSourceFiles(srcDir);

  for (const file of allSourceFiles) {
    if (file === semconvPath) continue;
    const content = readFileSync(file, "utf8");
    assert.ok(
      !content.includes("gen_ai."),
      `File ${file} contains literal "gen_ai." string which must only exist in semconv.ts`,
    );
  }
});

test("CAPSULE_TRACE_DIR file exporter writes valid OTLP JSON trace file on finished run", async () => {
  await withHome(async (home) => {
    const traceDir = join(home, "traces");
    const prevTraceDir = process.env.CAPSULE_TRACE_DIR;
    process.env.CAPSULE_TRACE_DIR = traceDir;

    try {
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

      const traceFilePath = join(traceDir, `${runId}.otlp.json`);
      assert.ok(existsSync(traceFilePath), `trace file should exist at ${traceFilePath}`);

      const content = readFileSync(traceFilePath, "utf8");
      const parsed = JSON.parse(content) as OTelTraceExport;

      assert.ok(Array.isArray(parsed.resourceSpans));
      assert.equal(parsed.resourceSpans.length, 1);

      const rs = parsed.resourceSpans[0]!;
      const serviceAttr = rs.resource.attributes.find((a: { key: string }) => a.key === ATTR.SERVICE_NAME);
      assert.equal(serviceAttr?.value.stringValue, "hello");

      const scopeSpan = rs.scopeSpans[0]!;
      assert.equal(scopeSpan.scope.name, "agent-capsule");

      const spans = scopeSpan.spans;
      assert.ok(spans.length >= 5);

      const rootSpan = spans[0]!;
      assert.equal(rootSpan.name, "execute_tool greet");
      assert.equal(rootSpan.kind, SPAN_KIND.INTERNAL);
      assert.equal(rootSpan.status.code, SPAN_STATUS.OK);
      assert.equal(rootSpan.status.code, 0);

      const childSpans = spans.slice(1);
      for (const child of childSpans) {
        assert.equal(child.traceId, rootSpan.traceId);
        assert.equal(child.parentSpanId, rootSpan.spanId);
        assert.equal(child.status.code, SPAN_STATUS.OK);
        assert.equal(child.kind, SPAN_KIND.INTERNAL);
      }
    } finally {
      if (prevTraceDir === undefined) delete process.env.CAPSULE_TRACE_DIR;
      else process.env.CAPSULE_TRACE_DIR = prevTraceDir;
    }
  });
});

test("an MCP tools/call run records mcp.method.name and mcp.tool.name in its exported trace", async () => {
  await withHome(async (home) => {
    const traceDir = join(home, "traces");
    const prevTraceDir = process.env.CAPSULE_TRACE_DIR;
    process.env.CAPSULE_TRACE_DIR = traceDir;

    try {
      const capsule = await packFixture(home);
      const server = createMcpServer({ capsule });

      const response = await server.handleMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "greet", arguments: { name: "ada" } },
      });
      assert.ok(response && "result" in response);

      const written = readdirSync(traceDir);
      assert.equal(written.length, 1, `expected one trace file, got ${written.join(", ")}`);

      const parsed = JSON.parse(readFileSync(join(traceDir, written[0]!), "utf8")) as OTelTraceExport;
      const rootSpan = parsed.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
      const methodAttr = rootSpan.attributes.find((a: { key: string }) => a.key === ATTR.MCP_METHOD_NAME);
      const toolAttr = rootSpan.attributes.find((a: { key: string }) => a.key === ATTR.MCP_TOOL_NAME);
      assert.equal(methodAttr?.value.stringValue, "tools/call");
      assert.equal(toolAttr?.value.stringValue, "greet");
      assert.equal(rootSpan.status.code, SPAN_STATUS.OK);
    } finally {
      if (prevTraceDir === undefined) delete process.env.CAPSULE_TRACE_DIR;
      else process.env.CAPSULE_TRACE_DIR = prevTraceDir;
    }
  });
});

test("writeTrace passes mcp options through to the written file", async () => {
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

    const traceDir = join(home, "explicit-traces");
    const journal = openJournal(paths.journal);
    try {
      const outPath = writeTrace({ journal, runId, traceDir, mcp: { method: "tools/call", tool: "greet" } });
      assert.equal(outPath, join(traceDir, `${runId}.otlp.json`));

      const parsed = JSON.parse(readFileSync(outPath!, "utf8")) as OTelTraceExport;
      const rootSpan = parsed.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
      assert.equal(
        rootSpan.attributes.find((a: { key: string }) => a.key === ATTR.MCP_TOOL_NAME)?.value.stringValue,
        "greet",
      );
    } finally {
      journal.close();
    }
  });
});

test("child span kind is SPAN_KIND_CLIENT (3) for net.fetch and SPAN_KIND_INTERNAL (1) for other effects", async () => {
  await withHome(async (home) => {
    const capsule = await packSource(
      home,
      "nettool",
      `globalThis.tools = {
        fetcher() {
          capsule.kv.set("k", "v");
          const res = capsule.fetch("https://example.com/api");
          return res;
        }
      };`,
      {
        name: "fetcher",
        title: "fetcher",
        description: "fetches",
        inputSchema: { type: "object" },
        effects: ["kv.set", "net.fetch"],
      },
      { kv: true, net: { allowed_hosts: ["example.com"] } },
    );
    const paths = sidecarPaths(capsule.file);
    const runId = randomUUID();

    const mockFetch = async () => ({ status: 200, statusText: "OK", headers: {}, body: "ok" });

    const res = await invokeTool({
      capsule,
      tool: "fetcher",
      grants: { "net:example.com": true },
      netFetch: mockFetch,
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
        capsuleName: "nettool",
      });

      const spans = trace.resourceSpans[0]!.scopeSpans[0]!.spans;
      const rootSpan = spans[0]!;
      assert.equal(rootSpan.kind, SPAN_KIND.INTERNAL);

      const kvSpan = spans.find((s: OTelSpan) => s.name === "capsule.effect kv.set");
      assert.ok(kvSpan);
      assert.equal(kvSpan.kind, SPAN_KIND.INTERNAL);

      const fetchSpan = spans.find((s: OTelSpan) => s.name === "capsule.effect net.fetch");
      assert.ok(fetchSpan);
      assert.equal(fetchSpan.kind, SPAN_KIND.CLIENT);
      assert.equal(fetchSpan.parentSpanId, rootSpan.spanId);
    } finally {
      journal.close();
    }
  });
});

test("all-zero traceId or parentSpanId in traceparent is ignored and falls back to derived traceId", async () => {
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
      // 32 zeros traceId
      const traceAllZeroTraceId = exportTrace({
        journal,
        runId,
        traceparent: "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
      });
      const root1 = traceAllZeroTraceId.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
      assert.notEqual(root1.traceId, "00000000000000000000000000000000");
      assert.equal(root1.parentSpanId, undefined);

      // 16 zeros parentSpanId
      const traceAllZeroParentId = exportTrace({
        journal,
        runId,
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
      });
      const root2 = traceAllZeroParentId.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
      assert.notEqual(root2.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
      assert.equal(root2.parentSpanId, undefined);

      // Both all zeros
      const traceBothZeros = exportTrace({
        journal,
        runId,
        traceparent: "00-00000000000000000000000000000000-0000000000000000-01",
      });
      const root3 = traceBothZeros.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
      assert.notEqual(root3.traceId, "00000000000000000000000000000000");
      assert.equal(root3.parentSpanId, undefined);
    } finally {
      journal.close();
    }
  });
});

test("journal.run(runId) queries capsule_runs table directly and exportTrace retrieves exact started_at", async () => {
  await withHome(async (home) => {
    const capsule = await packFixture(home);
    const paths = sidecarPaths(capsule.file);
    const runId = randomUUID();
    const specificStartedAt = "2026-08-15T12:34:56.789Z";

    const journal = openJournal(paths.journal);
    try {
      journal.beginRun({
        runId,
        capsuleId: capsule.capsuleId,
        tool: "greet",
        startedAt: specificStartedAt,
      });
      journal.append(runId, EVENT.runStarted, { capsuleId: capsule.capsuleId, tool: "greet" });
      journal.append(runId, EVENT.toolCompleted, { tool: "greet" });
      journal.append(runId, EVENT.runFinished, { status: "ok" });
      journal.finishRun(runId, "ok");

      const record = journal.run(runId);
      assert.ok(record);
      assert.equal(record.run_id, runId);
      assert.equal(record.capsule_id, capsule.capsuleId);
      assert.equal(record.tool, "greet");
      assert.equal(record.started_at, specificStartedAt);

      assert.equal(journal.run("non-existent-run"), null);

      // Now insert 1005 newer runs to prove exportTrace does not rely on recentRuns limit
      for (let i = 0; i < 1005; i++) {
        const otherId = `other-${i}`;
        journal.beginRun({
          runId: otherId,
          capsuleId: capsule.capsuleId,
          tool: "greet",
          startedAt: new Date(Date.now() + i * 1000).toISOString(),
        });
      }

      const trace = exportTrace({ journal, runId });
      const rootSpan = trace.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
      const expectedNano = BigInt(new Date(specificStartedAt).getTime()) * 1_000_000n;
      assert.equal(rootSpan.startTimeUnixNano, expectedNano.toString());
    } finally {
      journal.close();
    }
  });
});

test("non-integer effect duration ms exports integer nano timestamps without throwing", async () => {
  await withHome(async (home) => {
    const capsule = await packFixture(home);
    const paths = sidecarPaths(capsule.file);
    const runId = randomUUID();

    const journal = openJournal(paths.journal);
    try {
      journal.beginRun({
        runId,
        capsuleId: capsule.capsuleId,
        tool: "greet",
        startedAt: "2026-08-15T12:34:56.789Z",
      });
      journal.append(runId, EVENT.runStarted, { capsuleId: capsule.capsuleId, tool: "greet" });
      journal.append(runId, EVENT.effectCompleted, {
        i: 0,
        op: "kv.set",
        paramsDigest: "sha256:aa",
        ms: 15.5,
      });
      journal.append(runId, EVENT.toolCompleted, { tool: "greet" });
      journal.append(runId, EVENT.runFinished, { status: "ok" });
      journal.finishRun(runId, "ok");

      const trace = exportTrace({ journal, runId });
      const spans = trace.resourceSpans[0]!.scopeSpans[0]!.spans;
      const childSpan = spans[1]!;

      assert.match(childSpan.startTimeUnixNano, /^\d+$/);
      assert.match(childSpan.endTimeUnixNano, /^\d+$/);
      assert.equal(
        BigInt(childSpan.endTimeUnixNano) - BigInt(childSpan.startTimeUnixNano),
        16n * 1_000_000n,
      );

      const durationAttr = childSpan.attributes.find(
        (a: { key: string }) => a.key === ATTR.CAPSULE_EFFECT_DURATION_MS,
      );
      assert.equal(durationAttr?.value.intValue, 16);
      assert.match(trace.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.endTimeUnixNano, /^\d+$/);
    } finally {
      journal.close();
    }
  });
});

test("effect.completed events sharing an ordinal still produce distinct child spanIds", async () => {
  await withHome(async (home) => {
    const capsule = await packFixture(home);
    const paths = sidecarPaths(capsule.file);
    const runId = randomUUID();

    const journal = openJournal(paths.journal);
    try {
      journal.beginRun({
        runId,
        capsuleId: capsule.capsuleId,
        tool: "greet",
        startedAt: "2026-08-15T12:34:56.789Z",
      });
      journal.append(runId, EVENT.runStarted, { capsuleId: capsule.capsuleId, tool: "greet" });
      journal.append(runId, EVENT.effectCompleted, { i: 0, op: "kv.set", paramsDigest: "sha256:aa", ms: 1 });
      journal.append(runId, EVENT.effectCompleted, { i: 0, op: "kv.get", paramsDigest: "sha256:bb", ms: 2 });
      journal.append(runId, EVENT.toolCompleted, { tool: "greet" });
      journal.append(runId, EVENT.runFinished, { status: "ok" });
      journal.finishRun(runId, "ok");

      const trace = exportTrace({ journal, runId });
      const spans = trace.resourceSpans[0]!.scopeSpans[0]!.spans;
      const childSpans = spans.slice(1);
      assert.equal(childSpans.length, 2);

      const spanIds = new Set(childSpans.map((s: OTelSpan) => s.spanId));
      assert.equal(spanIds.size, 2, "child spanIds must be unique");
      for (const child of childSpans) {
        assert.notEqual(child.spanId, spans[0]!.spanId);
      }
    } finally {
      journal.close();
    }
  });
});

test("startSpan, endSpan, and writeTrace helpers operate correctly", async () => {
  const draft = startSpan({
    name: "test_span",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    kind: SPAN_KIND.CLIENT,
  });
  assert.equal(draft.name, "test_span");
  assert.equal(draft.kind, SPAN_KIND.CLIENT);
  assert.equal(draft.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");

  const span = endSpan(draft, { status: { code: SPAN_STATUS.OK } });
  assert.equal(span.name, "test_span");
  assert.equal(span.status.code, SPAN_STATUS.OK);
  assert.equal(SPAN_STATUS.OK, 0);
  assert.equal(SPAN_STATUS.ERROR, 2);
  assert.ok(BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano));
});
