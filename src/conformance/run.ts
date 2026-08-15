import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapsuleError } from "../core/errors.ts";
import { loadCapsule, readSignedDocs } from "../format/capsule.ts";
import { openContainer } from "../format/container.ts";
import { parseManifest } from "../format/manifest.ts";
import { invokeTool, type InvokeOptions, type InvokeResult } from "../runtime/invoke.ts";
import { replayRun, type ReplayOptions, type ReplayResult } from "../runtime/replay.ts";
import {
  CONFORMANCE_VECTORS,
  type ConformanceCtx,
  type ConformanceMeasurement,
  type ConformanceReport,
  type ConformanceResult,
} from "./checks.ts";

export type ConformanceOptions = {
  strict?: boolean;
  perf?: boolean;
  selfTest?: boolean;
  homeDir?: string;
  /** Where the suite's own capsules and sidecars go. A directory of its own is made and removed. */
  workDir?: string;
  /** See `ConformanceCtx`: the runtime seams the determinism and budget vectors are driven through. */
  invoke?: (opts: InvokeOptions) => Promise<InvokeResult>;
  replay?: (opts: ReplayOptions) => Promise<ReplayResult>;
};

/** The message a failure carries into a report, in this project's vocabulary when it has one. */
function messageOf(e: unknown): string {
  if (e instanceof CapsuleError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

/**
 * Decides whether a `.capsule` file is a conforming capsule, one property at a time.
 *
 * Nothing here is all-or-nothing: the container, the manifest and the two signed documents are read
 * once and whatever came of each — the value or the reason it is missing — is handed to all twelve
 * vectors, so a capsule that fails one of them is still measured against the rest. That is the point
 * of a conformance suite as opposed to `capsule verify`, which refuses the whole file at the first
 * thing wrong with it.
 *
 * Only a file that cannot be read at all throws: there is no report to make about bytes nobody has.
 */
export async function runConformance(file: string, opts: ConformanceOptions = {}): Promise<ConformanceReport> {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (e) {
    throw new CapsuleError("E_CONTAINER", messageOf(e), { file });
  }

  const ownsWorkDir = opts.workDir === undefined;
  const workDir = opts.workDir ?? mkdtempSync(join(tmpdir(), "capsule-conformance-"));
  mkdirSync(workDir, { recursive: true });

  const measurements: ConformanceMeasurement[] = [];
  const strict = opts.strict === true;
  try {
    const reader = await openContainer(bytes);

    const ctx: ConformanceCtx = {
      file,
      bytes,
      reader,
      strict,
      perf: opts.perf === true,
      selfTest: opts.selfTest === true,
      ...(opts.homeDir === undefined ? {} : { homeDir: opts.homeDir }),
      workDir,
      invoke: opts.invoke ?? invokeTool,
      replay: opts.replay ?? replayRun,
      measure: (measurement) => measurements.push(measurement),
      rssDeltaMiB: 0,
    };

    try {
      ctx.manifest = parseManifest((await reader.read("capsule.json")).toString("utf8"));
    } catch (e) {
      ctx.manifestError = messageOf(e);
    }
    try {
      const docs = await readSignedDocs(reader, file);
      ctx.statement = docs.statement;
      ctx.signature = docs.signature;
    } catch (e) {
      ctx.docsError = messageOf(e);
    }
    // The loaded capsule the runtime vectors need. Trust is left out of it on purpose: C03 reports the
    // pin, and a suite that pinned a capsule as a side effect of examining it would change the answer
    // the user gets next time.
    try {
      ctx.loaded = await loadCapsule(file, { trust: false, ...(opts.homeDir === undefined ? {} : { homeDir: opts.homeDir }) });
    } catch (e) {
      ctx.loadError = messageOf(e);
    }

    const results: ConformanceResult[] = [];
    for (const vector of CONFORMANCE_VECTORS) {
      const severity = vector.strictError === true && strict ? "error" : vector.severity;
      const startedAt = performance.now();
      let outcome;
      try {
        outcome = await vector.run(ctx);
      } catch (e) {
        // A vector that threw has found what it was looking for: the throw *is* the finding, reported
        // against the vector that provoked it rather than as a crash of the suite.
        outcome = { status: "fail" as const, detail: messageOf(e) };
      }
      results.push({
        id: vector.id,
        title: vector.title,
        severity,
        ...outcome,
        ms: Math.round(performance.now() - startedAt),
      });
    }

    return summarise({
      file,
      capsuleId: ctx.statement?.subject.payloadDigest ?? "",
      name: ctx.manifest?.meta.name ?? ctx.statement?.subject.name ?? "",
      version: ctx.manifest?.meta.version ?? ctx.statement?.subject.version ?? "",
      strict,
      perf: ctx.perf,
      selfTest: ctx.selfTest,
      results,
      measurements,
      rssDeltaMiB: ctx.rssDeltaMiB,
    });
  } catch (e) {
    // The container itself is unreadable, so there is nothing for the other eleven vectors to read:
    // C01 is where a container failure belongs and the rest say why they were not run.
    const detail = messageOf(e);
    return summarise({
      file,
      capsuleId: "",
      name: "",
      version: "",
      strict,
      perf: opts.perf === true,
      selfTest: opts.selfTest === true,
      results: CONFORMANCE_VECTORS.map((vector) => ({
        id: vector.id,
        title: vector.title,
        severity: vector.strictError === true && strict ? ("error" as const) : vector.severity,
        status: vector.id === "C01" ? ("fail" as const) : ("skip" as const),
        detail: vector.id === "C01" ? detail : "the container could not be read",
        ms: 0,
      })),
      measurements,
      rssDeltaMiB: 0,
    });
  } finally {
    if (ownsWorkDir) rmSync(workDir, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** The three numbers a caller reads first: how many errors, how many warnings, and the verdict. */
function summarise(report: Omit<ConformanceReport, "ok" | "errors" | "warnings">): ConformanceReport {
  const failed = report.results.filter((result) => result.status === "fail");
  const errors = failed.filter((result) => result.severity === "error").length;
  return {
    ...report,
    ok: errors === 0,
    errors,
    warnings: failed.length - errors,
  };
}
