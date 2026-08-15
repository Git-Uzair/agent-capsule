import { CapsuleError } from "../core/errors.ts";
import { runConformance } from "../conformance/run.ts";
import type { ConformanceReport, ConformanceResult } from "../conformance/checks.ts";

export { runConformance } from "../conformance/run.ts";
export type { ConformanceOptions } from "../conformance/run.ts";
export type {
  ConformanceMeasurement,
  ConformanceReport,
  ConformanceResult,
  ConformanceSeverity,
  ConformanceStatus,
  ConformanceVector,
} from "../conformance/checks.ts";

const USAGE = "usage: capsule conformance <file> [--json] [--strict] [--perf] [--self-test]";

function usage(message: string): never {
  throw new CapsuleError("E_USAGE", `${message} (${USAGE})`);
}

/** The widest value in a column, so the table lines up without a formatting dependency. */
const widest = (values: string[]): number => values.reduce((max, value) => Math.max(max, value.length), 0);

function formatHumanReport(report: ConformanceReport): void {
  const lines: string[] = [];
  if (report.name !== "") {
    lines.push(`capsule: ${report.name}@${report.version} (${report.file})`);
    lines.push(`id:      ${report.capsuleId}`);
  } else {
    lines.push(`file:    ${report.file}`);
  }

  const column = (pick: (result: ConformanceResult) => string): number => widest(report.results.map(pick));
  const statusWidth = column((r) => r.status);
  const severityWidth = column((r) => r.severity);
  const titleWidth = column((r) => r.title);
  for (const result of report.results) {
    lines.push(
      `${result.id}  ${result.status.padEnd(statusWidth)}  ${result.severity.padEnd(severityWidth)}  ` +
        `${result.title.padEnd(titleWidth)}  ${result.detail}`,
    );
  }

  if (report.measurements.length > 0) {
    lines.push("budgets:");
    const nameWidth = widest(report.measurements.map((m) => m.name));
    for (const measurement of report.measurements) {
      lines.push(
        `  ${measurement.name.padEnd(nameWidth)}  ${measurement.ms}ms / ${measurement.budgetMs}ms  ` +
          `${measurement.ok ? "ok" : "OVER"}`,
      );
    }
    lines.push(`  rss growth  +${report.rssDeltaMiB} MiB`);
  }

  const verdict = report.ok ? "PASS" : "FAIL";
  lines.push(`${verdict} (${report.errors} error, ${report.warnings} warn)`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

/**
 * `capsule conformance <file>` — the spec suite. A non-conforming capsule is an answer, not a crash,
 * so the report goes to stdout either way and the exit status is what a script reads: 0 only when no
 * `error` vector failed, which leaves a budget overrun or an injection marker visible without making
 * either one a verdict on the capsule's conformance.
 */
export async function runConformanceCommand(argv: string[]): Promise<number> {
  let file: string | undefined;
  let json = false;
  let strict = false;
  let perf = false;
  let selfTest = false;

  for (const arg of argv) {
    if (arg === "--json") {
      json = true;
    } else if (arg === "--strict") {
      strict = true;
    } else if (arg === "--perf") {
      perf = true;
    } else if (arg === "--self-test") {
      selfTest = true;
    } else if (arg.startsWith("-")) {
      usage(`unknown option: ${arg}`);
    } else if (file === undefined) {
      file = arg;
    } else {
      usage(`unexpected argument: ${arg}`);
    }
  }
  if (file === undefined) usage("conformance needs a capsule file");

  const report = await runConformance(file, { strict, perf, selfTest });

  if (json) process.stdout.write(`${JSON.stringify(report)}\n`);
  else formatHumanReport(report);

  return report.ok ? 0 : 1;
}

export const conformanceCommand = runConformanceCommand;
