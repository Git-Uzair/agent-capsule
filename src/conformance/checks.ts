import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { asRecord } from "../core/canonical.ts";
import { digestOf, sha256Hex } from "../core/digest.ts";
import { CapsuleError } from "../core/errors.ts";
import { newValidator } from "../core/schema.ts";
import type { SchemaObject } from "ajv/dist/2020.js";
import {
  loadCapsule,
  packDirectory,
  SIGNATURE_PATH,
  STATEMENT_PATH,
  type LoadedCapsule,
} from "../format/capsule.ts";
import { openContainer, packEntries, type CapsuleEntry, type CapsuleReader } from "../format/container.ts";
import { type Manifest, type ManifestTool } from "../format/manifest.ts";
import { toolCatalogDigest, verifyStatement, type Statement, type StatementFile } from "../format/statement.ts";
import { schemaErrors, type InvokeOptions, type InvokeResult } from "../runtime/invoke.ts";
import type { ReplayOptions, ReplayResult } from "../runtime/replay.ts";
import { keyIdOf, verifySignature, type SignatureDoc } from "../security/signing.ts";
import { confusableSkeleton, scanTextTree } from "../security/text.ts";
import { loadTrustStore } from "../security/trust.ts";

/** The composition bounds the spec asks implementations to hold a validator to. */
const MAX_SCHEMA_DEPTH = 8;
const MAX_SUBSCHEMAS = 200;

/** C10: one cold inspect plus one tool call, and the resident growth that buys. */
const COLD_BUDGET_MS = 1500;
const RSS_BUDGET_MIB = 128;

/** C12: the per-operation ceilings the host holds itself to, measured only under `--perf`. */
export const PERF_BUDGETS_MS = { pack: 500, verify: 200, invoke: 500, replay: 200 } as const;

/**
 * Every ceiling in the suite, carried by the report whether or not this run measured against it: a
 * `--json` consumer that reads a duration needs the number it was judged by from the same document.
 */
export const CONFORMANCE_BUDGETS: Record<string, number> = {
  cold: COLD_BUDGET_MS,
  rssMiB: RSS_BUDGET_MIB,
  ...PERF_BUDGETS_MS,
};

export type ConformanceSeverity = "error" | "warn";
export type ConformanceStatus = "pass" | "fail" | "skip";

/** One measured duration and the ceiling it is judged against. Printed, not just asserted. */
export type ConformanceMeasurement = {
  name: "cold" | "pack" | "verify" | "invoke" | "replay";
  ms: number;
  budgetMs: number;
  ok: boolean;
};

export type ConformanceOutcome = { status: ConformanceStatus; detail: string };

export type ConformanceResult = ConformanceOutcome & {
  id: string;
  title: string;
  severity: ConformanceSeverity;
  ms: number;
};

export type ConformanceReport = {
  ok: boolean;
  file: string;
  capsuleId: string;
  name: string;
  version: string;
  strict: boolean;
  perf: boolean;
  selfTest: boolean;
  results: ConformanceResult[];
  measurements: ConformanceMeasurement[];
  budgets: Record<string, number>;
  rssDeltaMiB: number;
  /** The counts a caller reads first. `total` is `results.length`; `passed + failed + skipped` is it. */
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  /** Of the failures: how many were graded `error` (which decides `ok`) and how many `warn`. */
  errors: number;
  warnings: number;
};

/**
 * What every vector is handed. The container and the three documents are read once and handed over as
 * they were found — including "it did not parse", which is a finding rather than a reason to stop — so
 * a capsule that fails one vector is still examined by the other eleven.
 *
 * `invoke` and `replay` are seams for the same reason `invokeTool` takes a `clock`: the vectors that
 * measure the runtime have to be drivable without a capsule that misbehaves, and under this host a
 * capsule *cannot* misbehave deterministically — every source of change a guest can reach is
 * journalled, so a non-reproducing run can only be manufactured on the host's side of the boundary.
 */
export type ConformanceCtx = {
  file: string;
  bytes: Buffer;
  reader: CapsuleReader;
  manifest?: Manifest;
  manifestError?: string;
  statement?: Statement;
  signature?: SignatureDoc;
  docsError?: string;
  loaded?: LoadedCapsule;
  loadError?: string;
  strict: boolean;
  perf: boolean;
  selfTest: boolean;
  homeDir?: string;
  workDir: string;
  invoke: (opts: InvokeOptions) => Promise<InvokeResult>;
  replay: (opts: ReplayOptions) => Promise<ReplayResult>;
  measure: (measurement: ConformanceMeasurement) => void;
  /** Written by C10, reported by the runner: resident growth over one cold inspect and tool call. */
  rssDeltaMiB: number;
};

export type ConformanceVector = {
  id: string;
  title: string;
  severity: ConformanceSeverity;
  /** `--strict` promotes this vector to an error. Only the injection scan is graded that way. */
  strictError?: boolean;
  run: (ctx: ConformanceCtx) => Promise<ConformanceOutcome>;
};

const pass = (detail: string): ConformanceOutcome => ({ status: "pass", detail });
const fail = (detail: string): ConformanceOutcome => ({ status: "fail", detail });
const skip = (detail: string): ConformanceOutcome => ({ status: "skip", detail });

/** Every entry the statement covers: the container minus the two documents that carry the statement. */
async function payloadEntries(reader: CapsuleReader): Promise<CapsuleEntry[]> {
  const entries: CapsuleEntry[] = [];
  for (const path of reader.list()) {
    if (path === STATEMENT_PATH || path === SIGNATURE_PATH) continue;
    entries.push({ path, data: await reader.read(path) });
  }
  return entries;
}

/** The file list a statement would claim for a container, in the order `buildStatement` sorts it. */
async function fileList(reader: CapsuleReader): Promise<StatementFile[]> {
  const files: StatementFile[] = [];
  for (const path of reader.list()) {
    const data = await reader.read(path);
    files.push({ path, sha256: sha256Hex(data), size: data.byteLength });
  }
  return files;
}

/** The example a tool publishes for itself, which is the only input the suite may invent a call from. */
function exampleArgs(tool: ManifestTool): unknown | undefined {
  const examples = tool.inputSchema["examples"];
  return Array.isArray(examples) && examples.length > 0 ? examples[0] : undefined;
}

/**
 * A tool the suite may call with arguments it can justify: the author's own `examples[0]`, or no
 * arguments at all when the schema says that is a complete call. Anything else would be the suite
 * inventing a capsule's input, which is not a conformance question.
 */
function invokableTool(manifest: Manifest): { tool: ManifestTool; args: unknown } | undefined {
  for (const tool of manifest.tools) {
    const example = exampleArgs(tool);
    if (example !== undefined) return { tool, args: example };
  }
  for (const tool of manifest.tools) {
    if (schemaErrors(tool.inputSchema, {}) === undefined) return { tool, args: {} };
  }
  return undefined;
}

/**
 * The keyword positions a subschema can occupy in JSON Schema 2020-12 (plus the two draft-07 spellings
 * a hand-written schema still arrives with): one subschema, a map of them, or an array of them. Every
 * other keyword holds data — `examples`, `default`, `const`, `enum` — and no amount of nesting inside
 * one of those is composition a validator has to walk.
 */
const SUBSCHEMA_KEYWORDS = [
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
];
const SUBSCHEMA_MAP_KEYWORDS = ["$defs", "definitions", "dependentSchemas", "patternProperties", "properties"];
const SUBSCHEMA_LIST_KEYWORDS = ["allOf", "anyOf", "oneOf", "prefixItems"];

/**
 * How deep a schema's subschemas nest, and how many of them there are. Depth is counted in subschemas
 * rather than in JSON objects: `{properties: {a: {properties: {b: …}}}}` is two levels of composition,
 * not four, because the `properties` object is the keyword's value and not a schema in its own right.
 * The bound exists to stop a validator being handed a pathological *composition*, so counting the
 * document's object nesting instead would fail schemas an author would reasonably write — and would
 * count an `examples[0]` value, which is data, as composition.
 *
 * A `true`/`false` schema is a subschema at the position it sits in, which is why the recursion counts
 * the value it was handed before asking whether it has keywords.
 */
function shapeOf(schema: unknown, depth = 1): { depth: number; subschemas: number } {
  const shape = { depth, subschemas: 1 };
  const keywords = asRecord(schema);
  if (keywords === undefined) return shape;

  const descend = (value: unknown): void => {
    const inner = shapeOf(value, depth + 1);
    shape.depth = Math.max(shape.depth, inner.depth);
    shape.subschemas += inner.subschemas;
  };
  for (const [keyword, value] of Object.entries(keywords)) {
    if (SUBSCHEMA_MAP_KEYWORDS.includes(keyword)) {
      for (const subschema of Object.values(asRecord(value) ?? {})) descend(subschema);
    } else if (SUBSCHEMA_LIST_KEYWORDS.includes(keyword) || SUBSCHEMA_KEYWORDS.includes(keyword)) {
      // `items` is a single subschema in 2020-12 and a tuple in draft-07; both spellings are walked.
      if (Array.isArray(value)) for (const subschema of value) descend(subschema);
      else descend(value);
    }
  }
  return shape;
}

/** Runs `body` with argument journalling on, which is what a replay of the run needs. */
async function withJournalledArgs<T>(body: () => Promise<T>): Promise<T> {
  const previous = process.env.CAPSULE_JOURNAL_ARGS;
  process.env.CAPSULE_JOURNAL_ARGS = "1";
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.CAPSULE_JOURNAL_ARGS;
    else process.env.CAPSULE_JOURNAL_ARGS = previous;
  }
}

/** How a failed invocation reads in a vector's detail. */
const why = (result: { error?: { code: string; message: string } }): string =>
  result.error === undefined ? "no reason given" : `${result.error.code}: ${result.error.message}`;

/** The sidecars a vector's own runs use: never the capsule's, which is the user's evidence. */
function scratch(ctx: ConformanceCtx, tag: string): { journalPath: string; statePath: string } {
  return {
    journalPath: join(ctx.workDir, `${tag}.journal.sqlite`),
    statePath: join(ctx.workDir, `${tag}.app.sqlite`),
  };
}

const home = (ctx: ConformanceCtx): { homeDir?: string } =>
  ctx.homeDir === undefined ? {} : { homeDir: ctx.homeDir };

async function timed(body: () => Promise<unknown>): Promise<number> {
  const startedAt = performance.now();
  await body();
  return Math.round(performance.now() - startedAt);
}

/**
 * The guest of the ephemeral capsule C09 builds. Every probe is a thing the sandbox promises is not
 * reachable, asked for in the way a hostile capsule would ask: by name, through `eval`, and by
 * spending more time and more memory than it was given.
 */
const SELF_TEST_GUEST = `globalThis.tools = {
  probes() {
    let dynamicImport = "denied";
    try {
      const pending = eval('import("node:fs")');
      // No job of the guest's is ever run, so a promise here is a module that can never arrive; a
      // value would be one that already has.
      dynamicImport = pending !== null && typeof pending === "object" ? "unresolved" : "resolved";
      if (pending !== null && typeof pending === "object" && typeof pending.catch === "function") {
        pending.catch(function () {});
      }
    } catch (e) {
      dynamicImport = "denied";
    }
    return {
      process: typeof process,
      require: typeof require,
      bridge: typeof __capsule,
      wasm: typeof WebAssembly,
      fetch: typeof fetch,
      timer: typeof setTimeout,
      std: typeof std,
      os: typeof os,
      dynamicImport: dynamicImport,
    };
  },
  spin() {
    let i = 0;
    // Far more work than the manifest's timeout_ms allows: the interrupt handler is what ends it.
    while (i < 1e12) i += 1;
    return i;
  },
  hog() {
    const held = [];
    for (let i = 0; i < 1024; i++) held.push("x".repeat(1024 * 1024));
    return held.length;
  },
};
`;

const SELF_TEST_TOOL = (name: string, title: string, description: string): Record<string, unknown> => ({
  name,
  title,
  description,
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  effects: [],
});

const SELF_TEST_MANIFEST = {
  spec_version: "0.1.0",
  meta: {
    name: "conformance-selftest",
    version: "0.1.0",
    title: "Conformance self-test",
    description: "Ephemeral capsule whose tools probe the host sandbox.",
  },
  runtime: { type: "quickjs-1", entry: "src/main.js", memory_limit_mb: 16, timeout_ms: 500 },
  tools: [
    SELF_TEST_TOOL("probes", "Host globals", "Reports which host globals the guest can see."),
    SELF_TEST_TOOL("spin", "Busy loop", "Loops for far longer than the runtime timeout allows."),
    SELF_TEST_TOOL("hog", "Allocation", "Asks for a gibibyte of guest heap."),
  ],
};

/** The globals `probes` must not find, and the answer that means it did not find them. */
const DENIED_GLOBALS = ["process", "require", "bridge", "wasm", "fetch", "timer", "std", "os"];

/** Builds, signs, loads and probes an ephemeral capsule. Nothing it writes outlives `ctx.workDir`. */
async function runSelfTest(ctx: ConformanceCtx): Promise<ConformanceOutcome> {
  const dir = join(ctx.workDir, "selftest");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "capsule.json"), `${JSON.stringify(SELF_TEST_MANIFEST, null, 2)}\n`);
  writeFileSync(join(dir, "src", "main.js"), SELF_TEST_GUEST);
  const file = join(ctx.workDir, "selftest.capsule");
  // Signed with a key of its own inside the work directory, and loaded with the trust store left out
  // of it: an ephemeral capsule must not leave a pin behind in the user's home.
  await packDirectory(dir, file, { homeDir: ctx.workDir });
  const capsule = await loadCapsule(file, { trust: false, homeDir: ctx.workDir });
  const paths = scratch(ctx, "c09");

  const probes = await ctx.invoke({ capsule, tool: "probes", args: {}, ...paths, homeDir: ctx.workDir });
  if (!probes.ok) return fail(`the probe tool did not run: ${why(probes)}`);
  const seen = (probes.value ?? {}) as Record<string, unknown>;
  const reachable = DENIED_GLOBALS.filter((name) => seen[name] !== "undefined");
  if (reachable.length > 0) return fail(`the guest can see host globals: ${reachable.join(", ")}`);
  if (seen["dynamicImport"] === "resolved") return fail("the guest resolved import(\"node:fs\")");

  const spin = await ctx.invoke({ capsule, tool: "spin", args: {}, ...paths, homeDir: ctx.workDir });
  if (spin.ok || spin.error?.code !== "E_TIMEOUT") {
    return fail(`the busy loop was not interrupted: ${spin.ok ? "it returned a value" : why(spin)}`);
  }

  const hog = await ctx.invoke({ capsule, tool: "hog", args: {}, ...paths, homeDir: ctx.workDir });
  if (hog.ok || (hog.error?.code !== "E_GUEST" && hog.error?.code !== "E_TIMEOUT")) {
    return fail(`the 1 GiB allocation was not refused: ${hog.ok ? "it returned a value" : why(hog)}`);
  }

  return pass(
    `${DENIED_GLOBALS.length} host globals denied, import("node:fs") ${String(seen["dynamicImport"])}, ` +
      `busy loop ${spin.error.code}, 1 GiB allocation ${hog.error.code}`,
  );
}

/**
 * The twelve normative vectors, in report order. The ids are stable and referenced by `docs/SPEC.md`:
 * a vector may gain checks, but an id never changes what it is about.
 */
export const CONFORMANCE_VECTORS: readonly ConformanceVector[] = [
  {
    id: "C01",
    title: "container legal and repack-reproducible",
    severity: "error",
    async run(ctx) {
      const statement = ctx.statement;
      if (statement === undefined) return skip(ctx.docsError ?? "the capsule carries no statement");
      const payload = await payloadEntries(ctx.reader);
      // Packed again from its own entries: a container whose bytes are not a pure function of what is
      // in it has no stable identity, whatever its statement says.
      const repacked = await openContainer(await packEntries(payload));
      const digest = digestOf(await fileList(repacked));
      if (digest !== statement.subject.payloadDigest) {
        return fail(`repacked payload digest ${digest} does not match ${statement.subject.payloadDigest}`);
      }
      const whole = await packEntries([
        ...payload,
        { path: STATEMENT_PATH, data: await ctx.reader.read(STATEMENT_PATH) },
        { path: SIGNATURE_PATH, data: await ctx.reader.read(SIGNATURE_PATH) },
      ]);
      const bytes = whole.equals(ctx.bytes) ? "byte-identical" : "not byte-identical";
      return pass(`${payload.length} payload entries, ${ctx.bytes.byteLength} bytes, repack ${bytes}`);
    },
  },
  {
    id: "C02",
    title: "every statement digest matches, nothing missing or unlisted",
    severity: "error",
    async run(ctx) {
      const statement = ctx.statement;
      if (statement === undefined) return skip(ctx.docsError ?? "the capsule carries no statement");
      await verifyStatement(statement, ctx.reader);
      return pass(`${statement.files.length} listed entries match the container`);
    },
  },
  {
    id: "C03",
    title: "ed25519 signature valid, keyId derived from publicKey, trust state reported",
    severity: "error",
    async run(ctx) {
      const { statement, signature } = ctx;
      if (statement === undefined || signature === undefined) {
        // Not a skip. Whether the container is signed at all is precisely what this vector asks, so an
        // unsigned capsule is a failed answer to it; skipping here would let a container nobody signed
        // conform with zero errors, which is the one verdict this suite must never reach.
        if (!ctx.reader.has(STATEMENT_PATH) || !ctx.reader.has(SIGNATURE_PATH)) {
          return fail("capsule is unsigned (missing statement or signature)");
        }
        // Both documents are there but one of them did not read as what it claims to be.
        return fail(ctx.docsError ?? "the signature could not be read");
      }
      const derived = keyIdOf(Buffer.from(signature.publicKey, "base64"));
      if (derived !== signature.keyId) {
        return fail(`keyId ${signature.keyId} is not derived from publicKey (${derived})`);
      }
      verifySignature(statement, signature);

      const name = ctx.manifest?.meta.name ?? statement.subject.name;
      const pinned = loadTrustStore(ctx.homeDir).capsules[name];
      if (pinned !== undefined && pinned.keyId !== signature.keyId) {
        return fail(`publisher key changed: ${name} is pinned to ${pinned.keyId}, not ${signature.keyId}`);
      }
      const drifted =
        pinned !== undefined &&
        ctx.manifest !== undefined &&
        pinned.toolCatalogDigest !== toolCatalogDigest(ctx.manifest);
      const trust = pinned === undefined ? "unpinned (trust on first use)" : drifted ? "pinned, catalog drifted" : "pinned";
      return pass(`signature valid for ${signature.keyId}; trust: ${trust}`);
    },
  },
  {
    id: "C04",
    title: "manifest valid, no reserved tool names, no confusable collisions",
    severity: "error",
    async run(ctx) {
      const manifest = ctx.manifest;
      if (manifest === undefined) return fail(ctx.manifestError ?? "capsule.json is not a valid manifest");
      // A manifest that parsed has already been held to the schema, to the reserved `capsule_*` prefix
      // and to unique names by `parseManifest`, so re-checking those here would be a second copy of
      // rules that can only drift from the enforced ones. Confusables are this vector's own work: two
      // names a model cannot tell apart are one name as far as a caller is concerned.
      const bySkeleton = new Map<string, string>();
      for (const tool of manifest.tools) {
        const skeleton = confusableSkeleton(tool.name);
        const clash = bySkeleton.get(skeleton);
        if (clash !== undefined) {
          return fail(`tool names are confusable: ${clash} and ${tool.name}`);
        }
        bySkeleton.set(skeleton, tool.name);
      }
      return pass(`${manifest.tools.length} tools, no reserved or confusable names`);
    },
  },
  {
    id: "C05",
    title: "every schema compiles as JSON Schema 2020-12 within the composition bounds",
    severity: "error",
    async run(ctx) {
      const manifest = ctx.manifest;
      if (manifest === undefined) return skip(ctx.manifestError ?? "capsule.json is not a valid manifest");
      const ajv = newValidator();
      let deepest = 0;
      let widest = 0;
      for (const tool of manifest.tools) {
        for (const [which, schema] of [
          ["inputSchema", tool.inputSchema],
          ["outputSchema", tool.outputSchema],
        ] as const) {
          if (schema === undefined) continue;
          const shape = shapeOf(schema);
          if (shape.depth > MAX_SCHEMA_DEPTH) {
            return fail(`${tool.name}.${which} nests ${shape.depth} levels deep (limit ${MAX_SCHEMA_DEPTH})`);
          }
          if (shape.subschemas > MAX_SUBSCHEMAS) {
            return fail(`${tool.name}.${which} holds ${shape.subschemas} subschemas (limit ${MAX_SUBSCHEMAS})`);
          }
          deepest = Math.max(deepest, shape.depth);
          widest = Math.max(widest, shape.subschemas);
          try {
            ajv.compile(schema as SchemaObject);
          } catch (e) {
            return fail(`${tool.name}.${which} is not a valid JSON Schema: ${(e as Error).message}`);
          }
        }
      }
      return pass(`all schemas compile; deepest ${deepest}/${MAX_SCHEMA_DEPTH}, widest ${widest}/${MAX_SUBSCHEMAS}`);
    },
  },
  {
    id: "C06",
    title: "declared effects and CSP domains stay inside declared capabilities",
    severity: "error",
    async run(ctx) {
      const manifest = ctx.manifest;
      if (manifest === undefined) return skip(ctx.manifestError ?? "capsule.json is not a valid manifest");
      // Containment is enforced in one place — `parseManifest`'s `assertSemantics`: every effect against
      // its capability flag, `net.fetch` against an allowed host, and `ui.app.csp.connectDomains`
      // against `capabilities.net`. A manifest that reaches this vector has passed all three (a
      // manifest that failed one of them has no `ctx.manifest` at all, and C04 reports why), so what is
      // left to do is state what held rather than keep a second copy of the rules that could drift.
      const caps = manifest.capabilities;
      const effects = new Set(manifest.tools.flatMap((tool) => tool.effects));
      const domains = manifest.ui?.app?.csp?.connectDomains?.length ?? 0;
      const hosts = caps.net.allowed_hosts.length + (caps.net.allow_localhost ? 1 : 0);
      return pass(
        `${effects.size} declared effect(s) covered by capabilities, ` +
          `${domains} connect domain(s) inside ${hosts} allowed host(s)`,
      );
    },
  },
  {
    id: "C07",
    title: "no injection markers in prose or schema string leaves",
    severity: "warn",
    strictError: true,
    async run(ctx) {
      const manifest = ctx.manifest;
      if (manifest === undefined) return skip(ctx.manifestError ?? "capsule.json is not a valid manifest");
      // The same screen `capsule verify` and the MCP catalog apply, over the same text: a capsule this
      // suite calls clean has to be the capsule those two serve.
      const markers = scanTextTree([
        manifest.meta.title,
        manifest.meta.description,
        ...manifest.tools.map((tool) => [tool.title, tool.description, tool.inputSchema, tool.outputSchema]),
      ]);
      if (markers.length > 0) return fail(`injection markers: ${markers.join(", ")}`);
      return pass(`${manifest.tools.length + 1} text trees clean`);
    },
  },
  {
    id: "C08",
    title: "determinism: each tool's own example records and replays identically",
    severity: "error",
    async run(ctx) {
      const capsule = ctx.loaded;
      if (capsule === undefined) return skip(ctx.loadError ?? "the capsule did not load");
      const examples = capsule.manifest.tools
        .map((tool) => ({ tool, args: exampleArgs(tool) }))
        .filter((candidate): candidate is { tool: ManifestTool; args: unknown } => candidate.args !== undefined);
      if (examples.length === 0) return skip("no tool supplies inputSchema.examples[0]");

      const agreed: string[] = [];
      const skipped: string[] = [];
      for (const { tool, args } of examples) {
        const paths = scratch(ctx, `c08-${tool.name}`);
        const recorded = await withJournalledArgs(() =>
          ctx.invoke({ capsule, tool: tool.name, args, ...paths, ...home(ctx) }),
        );
        // A tool the user has not granted is not a determinism question: it is a consent question,
        // and answering it here would mean granting it on the user's behalf.
        if (!recorded.ok && recorded.error?.code === "E_POLICY") {
          skipped.push(`${tool.name} (${recorded.error.message})`);
          continue;
        }
        if (!recorded.ok) return fail(`${tool.name} did not record: ${why(recorded)}`);
        const replayed = await ctx.replay({ capsule, runId: recorded.runId, ...paths, ...home(ctx) });
        if (replayed.diverged || !replayed.ok) {
          return fail(`${tool.name} did not replay: ${why(replayed)}`);
        }
        const recordedDigest = digestOf(recorded.value);
        if (replayed.recordedValueDigest !== recordedDigest || digestOf(replayed.value) !== recordedDigest) {
          return fail(`${tool.name} replayed a different value than it recorded (${recordedDigest})`);
        }
        agreed.push(`${tool.name}=${recordedDigest}`);
      }
      if (agreed.length === 0) return skip(`every example needs a grant this run does not hold: ${skipped.join(", ")}`);
      const withheld = skipped.length === 0 ? "" : `; skipped ${skipped.join(", ")}`;
      return pass(`record and replay agree: ${agreed.join(", ")}${withheld}`);
    },
  },
  {
    id: "C09",
    title: "host self-test: the sandbox denies or interrupts every probe",
    severity: "error",
    async run(ctx) {
      if (!ctx.selfTest) return skip("--self-test not requested");
      return await runSelfTest(ctx);
    },
  },
  {
    id: "C10",
    title: "budget: a cold inspect plus one tool call",
    severity: "warn",
    async run(ctx) {
      const rssBefore = process.memoryUsage().rss;
      const startedAt = performance.now();
      // Cold: the file is read, verified and its catalog built from scratch, exactly as an agent host
      // does on the first `capsule_info` of a session.
      const capsule = await loadCapsule(ctx.file, { trust: false, ...home(ctx) });
      const candidate = invokableTool(capsule.manifest);
      let called = "no invokable tool: inspect only";
      if (candidate !== undefined) {
        const result = await ctx.invoke({
          capsule,
          tool: candidate.tool.name,
          args: candidate.args,
          ...scratch(ctx, "c10"),
          ...home(ctx),
        });
        called = result.ok ? `${candidate.tool.name} in ${result.ms}ms` : `${candidate.tool.name}: ${why(result)}`;
      }
      const ms = Math.round(performance.now() - startedAt);
      const rssDeltaMiB = Math.max(0, Math.round((process.memoryUsage().rss - rssBefore) / (1024 * 1024)));
      ctx.rssDeltaMiB = rssDeltaMiB;
      const withinTime = ms <= COLD_BUDGET_MS;
      ctx.measure({ name: "cold", ms, budgetMs: COLD_BUDGET_MS, ok: withinTime });
      const numbers = `${ms}ms/${COLD_BUDGET_MS}ms, rss +${rssDeltaMiB} MiB/${RSS_BUDGET_MIB} MiB (${called})`;
      if (!withinTime || rssDeltaMiB > RSS_BUDGET_MIB) return fail(`over budget: ${numbers}`);
      return pass(numbers);
    },
  },
  {
    id: "C11",
    title: "the statement binds the tool catalog and the subject to capsule.json",
    severity: "error",
    async run(ctx) {
      const { manifest, statement } = ctx;
      if (manifest === undefined || statement === undefined) {
        return skip(ctx.manifestError ?? ctx.docsError ?? "nothing to bind");
      }
      const digest = toolCatalogDigest(manifest);
      if (digest !== statement.predicate.toolCatalogDigest) {
        return fail(`tool catalog digest ${digest} is not the signed ${statement.predicate.toolCatalogDigest}`);
      }
      const subject = `${statement.subject.name}@${statement.subject.version}`;
      const claimed = `${manifest.meta.name}@${manifest.meta.version}`;
      if (subject !== claimed) return fail(`the statement signs ${subject}, capsule.json says ${claimed}`);
      return pass(`${claimed} bound to catalog ${digest}`);
    },
  },
  {
    id: "C12",
    title: "performance budgets for pack, verify, cold invoke and replay",
    severity: "warn",
    async run(ctx) {
      if (!ctx.perf) return skip("--perf not requested");
      const capsule = ctx.loaded;
      if (capsule === undefined) return skip(ctx.loadError ?? "the capsule did not load");

      const payload = await payloadEntries(ctx.reader);
      const measured: ConformanceMeasurement[] = [
        { name: "pack", ms: await timed(() => packEntries(payload)), budgetMs: PERF_BUDGETS_MS.pack, ok: true },
        {
          name: "verify",
          ms: await timed(() => loadCapsule(ctx.file, { trust: false, ...home(ctx) })),
          budgetMs: PERF_BUDGETS_MS.verify,
          ok: true,
        },
      ];

      const candidate = invokableTool(capsule.manifest);
      if (candidate === undefined) {
        for (const measurement of measured) {
          measurement.ok = measurement.ms <= measurement.budgetMs;
          ctx.measure(measurement);
        }
        return budgetOutcome(measured, "no invokable tool: pack and verify only");
      }

      const paths = scratch(ctx, "c12");
      let runId = "";
      const invokeMs = await timed(async () => {
        const result = await withJournalledArgs(() =>
          ctx.invoke({ capsule, tool: candidate.tool.name, args: candidate.args, ...paths, ...home(ctx) }),
        );
        runId = result.runId;
        if (!result.ok) throw new CapsuleError("E_USAGE", `${candidate.tool.name} did not run: ${why(result)}`);
      });
      measured.push({ name: "invoke", ms: invokeMs, budgetMs: PERF_BUDGETS_MS.invoke, ok: true });
      measured.push({
        name: "replay",
        ms: await timed(() => ctx.replay({ capsule, runId, ...paths, ...home(ctx) })),
        budgetMs: PERF_BUDGETS_MS.replay,
        ok: true,
      });

      for (const measurement of measured) {
        measurement.ok = measurement.ms <= measurement.budgetMs;
        ctx.measure(measurement);
      }
      return budgetOutcome(measured, `${candidate.tool.name} recorded and replayed`);
    },
  },
];

/** The numbers C12 measured, printed whichever way they came out. */
function budgetOutcome(measured: ConformanceMeasurement[], note: string): ConformanceOutcome {
  const numbers = measured.map((m) => `${m.name} ${m.ms}ms/${m.budgetMs}ms`).join(", ");
  const over = measured.filter((m) => !m.ok).map((m) => m.name);
  if (over.length > 0) return fail(`over budget: ${numbers} (${note})`);
  return pass(`${numbers} (${note})`);
}
