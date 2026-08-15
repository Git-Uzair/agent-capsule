import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalize } from "../src/core/canonical.ts";
import { CapsuleError } from "../src/core/errors.ts";
import { openContainer, packEntries } from "../src/format/container.ts";
import { parseManifest } from "../src/format/manifest.ts";
import { buildStatement, toolCatalogDigest, verifyStatement } from "../src/format/statement.ts";
import { HOST_VERSION } from "../src/version.ts";

const digestError =
  (message?: RegExp) =>
  (e: unknown): boolean =>
    e instanceof CapsuleError && e.code === "E_DIGEST" && (message === undefined || message.test(e.message));

const enc = (s: string) => new TextEncoder().encode(s);

const MANIFEST_OBJ = {
  spec_version: "0.1.0" as const,
  meta: { name: "hello", version: "1.0.0", title: "Hello", description: "A hello capsule." },
  runtime: { type: "quickjs-1" as const, entry: "src/main.js" },
  tools: [
    {
      name: "greet",
      title: "Greet",
      description: "Greets.",
      inputSchema: { type: "object" },
      effects: ["log.write" as const, "clock.now" as const],
    },
  ],
};

const MANIFEST_JSON = JSON.stringify(MANIFEST_OBJ);
const MAIN_JS = 'globalThis.tools = { greet() { return "hello"; } };\n';

const BASE_ENTRIES = [
  { path: "capsule.json", data: enc(MANIFEST_JSON) },
  { path: "src/main.js", data: enc(MAIN_JS) },
];

test("buildStatement produces a well-formed statement with sorted files and predicate", () => {
  const manifest = parseManifest(MANIFEST_OBJ);
  const statement = buildStatement({ manifest, files: [...BASE_ENTRIES].reverse() });

  assert.equal(statement.spec, "agentcapsule.org/statement/0.1");
  assert.equal(statement.subject.name, "hello");
  assert.equal(statement.subject.version, "1.0.0");
  assert.match(statement.subject.payloadDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(statement.predicate.builder.name, "agent-capsule");
  assert.equal(statement.predicate.builder.version, HOST_VERSION);
  assert.equal(statement.predicate.toolCatalogDigest, toolCatalogDigest(manifest));

  assert.deepEqual(
    statement.files.map((f) => f.path),
    ["capsule.json", "src/main.js"],
  );
  assert.equal(statement.files[0]!.size, enc(MANIFEST_JSON).byteLength);
  assert.match(statement.files[0]!.sha256, /^[0-9a-f]{64}$/);
  assert.equal(statement.files[1]!.size, enc(MAIN_JS).byteLength);
  assert.match(statement.files[1]!.sha256, /^[0-9a-f]{64}$/);
});

test("verifyStatement resolves for a valid container", async () => {
  const manifest = parseManifest(MANIFEST_OBJ);
  const statement = buildStatement({ manifest, files: BASE_ENTRIES });
  const containerBytes = await packEntries([
    ...BASE_ENTRIES,
    { path: ".capsule/statement.json", data: enc(canonicalize(statement)) },
    { path: ".capsule/signature.json", data: enc('{"alg":"ed25519"}') },
  ]);
  const reader = await openContainer(containerBytes);
  await assert.doesNotReject(() => verifyStatement(statement, reader));
});

test("flipping one byte of src/main.js before packing rejects with digest mismatch", async () => {
  const manifest = parseManifest(MANIFEST_OBJ);
  const statement = buildStatement({ manifest, files: BASE_ENTRIES });

  const corruptedMain = enc('globalThis.tools = { greet() { return "hallo"; } };\n');
  assert.equal(corruptedMain.byteLength, enc(MAIN_JS).byteLength, "same size but different content");

  const corruptedEntries = [
    { path: "capsule.json", data: enc(MANIFEST_JSON) },
    { path: "src/main.js", data: corruptedMain },
  ];
  const containerBytes = await packEntries([
    ...corruptedEntries,
    { path: ".capsule/statement.json", data: enc(canonicalize(statement)) },
  ]);
  const reader = await openContainer(containerBytes);
  await assert.rejects(() => verifyStatement(statement, reader), digestError(/digest mismatch: src\/main\.js/));
});

test("wrong file size in container rejects with digest mismatch", async () => {
  const manifest = parseManifest(MANIFEST_OBJ);
  const statement = buildStatement({ manifest, files: BASE_ENTRIES });

  const extendedMain = enc(MAIN_JS + "// extra comment\n");
  const corruptedEntries = [
    { path: "capsule.json", data: enc(MANIFEST_JSON) },
    { path: "src/main.js", data: extendedMain },
  ];
  const containerBytes = await packEntries([
    ...corruptedEntries,
    { path: ".capsule/statement.json", data: enc(canonicalize(statement)) },
  ]);
  const reader = await openContainer(containerBytes);
  await assert.rejects(() => verifyStatement(statement, reader), digestError(/digest mismatch: src\/main\.js/));
});

test("adding an unlisted entry rejects with unlisted entry", async () => {
  const manifest = parseManifest(MANIFEST_OBJ);
  const statement = buildStatement({ manifest, files: BASE_ENTRIES });

  const containerBytes = await packEntries([
    ...BASE_ENTRIES,
    { path: "data/extra.bin", data: enc("surprise") },
    { path: ".capsule/statement.json", data: enc(canonicalize(statement)) },
  ]);
  const reader = await openContainer(containerBytes);
  await assert.rejects(() => verifyStatement(statement, reader), digestError(/unlisted entry: data\/extra\.bin/));
});

test("missing entry from container rejects with missing entry", async () => {
  const manifest = parseManifest(MANIFEST_OBJ);
  const statement = buildStatement({ manifest, files: BASE_ENTRIES });

  const containerBytes = await packEntries([
    { path: "capsule.json", data: enc(MANIFEST_JSON) },
    { path: ".capsule/statement.json", data: enc(canonicalize(statement)) },
  ]);
  const reader = await openContainer(containerBytes);
  await assert.rejects(() => verifyStatement(statement, reader), digestError(/missing entry: src\/main\.js/));
});

test("tampered payloadDigest in statement rejects with payload digest mismatch", async () => {
  const manifest = parseManifest(MANIFEST_OBJ);
  const statement = buildStatement({ manifest, files: BASE_ENTRIES });
  const tamperedStatement = {
    ...statement,
    subject: {
      ...statement.subject,
      payloadDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    },
  };

  const containerBytes = await packEntries([
    ...BASE_ENTRIES,
    { path: ".capsule/statement.json", data: enc(canonicalize(statement)) },
  ]);
  const reader = await openContainer(containerBytes);
  await assert.rejects(() => verifyStatement(tamperedStatement, reader), digestError(/payload digest mismatch/));
});

test("two buildStatement calls on the same inputs produce identical canonical output", () => {
  const manifest = parseManifest(MANIFEST_OBJ);
  const s1 = buildStatement({ manifest, files: BASE_ENTRIES });
  const s2 = buildStatement({ manifest, files: [...BASE_ENTRIES].reverse() });

  assert.equal(canonicalize(s1), canonicalize(s2));
  assert.deepEqual(s1, s2);
});

test("toolCatalogDigest is sensitive to definitions but invariant to ordering", () => {
  const manifest1 = parseManifest({
    spec_version: "0.1.0",
    meta: { name: "test", version: "1.0.0", title: "Test", description: "Test" },
    runtime: { type: "quickjs-1", entry: "src/main.js" },
    tools: [
      {
        name: "b_tool",
        title: "B",
        description: "Does B",
        inputSchema: { type: "object" },
        effects: ["random.bytes", "clock.now"],
      },
      {
        name: "a_tool",
        title: "A",
        description: "Does A",
        inputSchema: { type: "object" },
        effects: ["log.write"],
      },
    ],
  });

  const manifest2 = parseManifest({
    spec_version: "0.1.0",
    meta: { name: "test", version: "1.0.0", title: "Test", description: "Test" },
    runtime: { type: "quickjs-1", entry: "src/main.js" },
    tools: [
      {
        name: "a_tool",
        title: "A",
        description: "Does A",
        inputSchema: { type: "object" },
        effects: ["log.write"],
      },
      {
        name: "b_tool",
        title: "B",
        description: "Does B",
        inputSchema: { type: "object" },
        effects: ["clock.now", "random.bytes"],
      },
    ],
  });

  // Reordering tools or effects within a tool produces identical toolCatalogDigest
  assert.equal(toolCatalogDigest(manifest1), toolCatalogDigest(manifest2));

  // Modifying description changes toolCatalogDigest
  const manifest3 = parseManifest({
    spec_version: "0.1.0",
    meta: { name: "test", version: "1.0.0", title: "Test", description: "Test" },
    runtime: { type: "quickjs-1", entry: "src/main.js" },
    tools: [
      {
        name: "a_tool",
        title: "A",
        description: "Changed description",
        inputSchema: { type: "object" },
        effects: ["log.write"],
      },
      {
        name: "b_tool",
        title: "B",
        description: "Does B",
        inputSchema: { type: "object" },
        effects: ["clock.now", "random.bytes"],
      },
    ],
  });
  assert.notEqual(toolCatalogDigest(manifest1), toolCatalogDigest(manifest3));

  // Including outputSchema or ui changes toolCatalogDigest
  const manifestWithUi = parseManifest({
    spec_version: "0.1.0",
    meta: { name: "test", version: "1.0.0", title: "Test", description: "Test" },
    runtime: { type: "quickjs-1", entry: "src/main.js" },
    ui: { app: { resourceUri: "ui://test", path: "ui/app.html" } },
    tools: [
      {
        name: "a_tool",
        title: "A",
        description: "Does A",
        inputSchema: { type: "object" },
        outputSchema: { type: "string" },
        effects: ["log.write"],
        ui: "ui://test",
      },
      {
        name: "b_tool",
        title: "B",
        description: "Does B",
        inputSchema: { type: "object" },
        effects: ["clock.now", "random.bytes"],
      },
    ],
  });
  assert.notEqual(toolCatalogDigest(manifest1), toolCatalogDigest(manifestWithUi));
});
