import { test } from "node:test";
import assert from "node:assert/strict";
import { parseManifest } from "../src/format/manifest.ts";
import { CapsuleError } from "../src/core/errors.ts";

const manifestError =
  (message?: RegExp) =>
  (e: unknown): boolean =>
    e instanceof CapsuleError &&
    e.code === "E_MANIFEST" &&
    (message === undefined || message.test(e.message));

const MIN = {
  spec_version: "0.1.0",
  meta: { name: "hello", version: "1.0.0", title: "Hello", description: "A hello capsule." },
  runtime: { type: "quickjs-1", entry: "src/main.js" },
  tools: [{ name: "greet", title: "Greet", description: "Greets.", inputSchema: { type: "object" } }],
};
const TOOL = MIN.tools[0]!;

test("accepts a minimal manifest and applies defaults", () => {
  const m = parseManifest(MIN);
  assert.equal(m.runtime.memory_limit_mb, 64);
  assert.equal(m.runtime.timeout_ms, 5000);
  assert.equal(m.runtime.determinism, "strict");
  assert.deepEqual(m.capabilities, {
    sql: false,
    kv: false,
    pack: false,
    net: { allowed_hosts: [], allow_localhost: false },
  });
  assert.deepEqual(m.tools[0]!.effects, []);
  assert.deepEqual(m.resources, []);
  // text and object inputs agree, and the caller's object is never mutated
  assert.deepEqual(parseManifest(JSON.stringify(MIN)), m);
  assert.equal("capabilities" in MIN, false);
  assert.equal("effects" in TOOL, false);
});

test("rejects unknown top-level keys and bad names", () => {
  assert.throws(() => parseManifest("{not json"), manifestError(/invalid capsule\.json/));
  assert.throws(() => parseManifest({ ...MIN, surprise: 1 }), manifestError());
  assert.throws(
    () => parseManifest({ ...MIN, meta: { ...MIN.meta, name: "Bad Name" } }),
    manifestError(),
  );
  assert.throws(
    () => parseManifest({ ...MIN, runtime: { type: "quickjs-1", entry: "../etc/passwd" } }),
    manifestError(),
  );
  assert.throws(
    () => parseManifest({ ...MIN, runtime: { type: "quickjs-1", entry: "src/../evil.js" } }),
    manifestError(/must not contain '\.\.'/),
  );
  assert.throws(() => parseManifest({ ...MIN, spec_version: "0.2.0" }), manifestError());
});

test("rejects undeclared effects and duplicate tool names", () => {
  assert.throws(
    () => parseManifest({ ...MIN, tools: [{ ...TOOL, effects: ["fs.write"] }] }),
    manifestError(),
  );
  assert.throws(
    () => parseManifest({ ...MIN, tools: [TOOL, TOOL] }),
    manifestError(/duplicate tool name: greet/),
  );
});

test("rejects a tool that requests net.fetch with no allowed_hosts", () => {
  assert.throws(
    () => parseManifest({ ...MIN, tools: [{ ...TOOL, effects: ["net.fetch"] }] }),
    manifestError(/allowed_hosts/),
  );
  const withHosts = parseManifest({
    ...MIN,
    capabilities: { net: { allowed_hosts: ["api.example.com"] } },
    tools: [{ ...TOOL, effects: ["net.fetch"] }],
  });
  assert.deepEqual(withHosts.capabilities.net, {
    allowed_hosts: ["api.example.com"],
    allow_localhost: false,
  });
  assert.deepEqual(withHosts.tools[0]!.effects, ["net.fetch"]);
  // localhost alone is enough to justify the effect
  assert.equal(
    parseManifest({
      ...MIN,
      capabilities: { net: { allow_localhost: true } },
      tools: [{ ...TOOL, effects: ["net.fetch"] }],
    }).capabilities.net.allow_localhost,
    true,
  );
});

test("rejects effects whose capability flag is false", () => {
  for (const effect of ["sql.query", "sql.exec", "kv.get", "kv.set", "pack.write"]) {
    assert.throws(
      () => parseManifest({ ...MIN, tools: [{ ...TOOL, effects: [effect] }] }),
      manifestError(new RegExp(`requests ${effect.replace(".", "\\.")} but capabilities\\.`)),
    );
  }
  const m = parseManifest({
    ...MIN,
    capabilities: { sql: true, kv: true, pack: true },
    tools: [{ ...TOOL, effects: ["sql.query", "kv.set", "pack.write", "clock.now", "log.write"] }],
  });
  assert.equal(m.capabilities.sql, true);
  // ambient-free effects need no capability at all
  assert.deepEqual(parseManifest({ ...MIN, tools: [{ ...TOOL, effects: ["random.bytes"] }] })
    .tools[0]!.effects, ["random.bytes"]);
});

test("rejects a tool ui that does not match ui.app.resourceUri", () => {
  const ui = { app: { resourceUri: "ui://hello", path: "ui/index.html" } };
  assert.throws(
    () => parseManifest({ ...MIN, ui, tools: [{ ...TOOL, ui: "ui://other" }] }),
    manifestError(/ui:\/\/other/),
  );
  assert.throws(
    () => parseManifest({ ...MIN, tools: [{ ...TOOL, ui: "ui://hello" }] }),
    manifestError(/ui\.app/),
  );
  const ok = parseManifest({ ...MIN, ui, tools: [{ ...TOOL, ui: "ui://hello" }] });
  assert.equal(ok.ui?.app?.resourceUri, "ui://hello");
  assert.equal(ok.ui?.app?.csp, undefined);
  // a present csp block gets its four domain lists defaulted
  const withCsp = parseManifest({ ...MIN, ui: { app: { ...ui.app, csp: {} } } });
  assert.deepEqual(withCsp.ui?.app?.csp, {
    connectDomains: [],
    resourceDomains: [],
    frameDomains: [],
    baseUriDomains: [],
  });
});

test("normalises resources and rejects traversal in resource paths", () => {
  const resource = {
    uri: "capsule://data/rows",
    name: "rows",
    mimeType: "application/json",
    path: "data/rows.json",
  };
  assert.deepEqual(parseManifest({ ...MIN, resources: [resource] }).resources, [resource]);
  assert.throws(
    () => parseManifest({ ...MIN, resources: [{ ...resource, path: "data/../secret" }] }),
    manifestError(/must not contain '\.\.'/),
  );
});
