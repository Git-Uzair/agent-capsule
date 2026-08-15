import { CapsuleError } from "../core/errors.ts";
import { loadCapsule, type LoadedCapsule } from "../format/capsule.ts";
import { replayRun, type ReplayResult } from "../runtime/replay.ts";

const USAGE = "usage: capsule replay <file> [--run <runId>] [--json] [--journal <path>] [--accept-drift]";

function usage(message: string): never {
  throw new CapsuleError("E_USAGE", `${message} (${USAGE})`);
}

export async function replayCommand(argv: string[]): Promise<number> {
  let file: string | undefined;
  let runId: string | undefined;
  let json = false;
  let journalPath: string | undefined;
  let acceptDrift = false;

  const valueOf = (arg: string, next: string | undefined): string =>
    next === undefined ? usage(`${arg} needs a value`) : next;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--run") {
      runId = valueOf(arg, argv[++i]);
    } else if (arg === "--journal") {
      journalPath = valueOf(arg, argv[++i]);
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--accept-drift") {
      acceptDrift = true;
    } else if (arg.startsWith("-")) {
      usage(`unknown option: ${arg}`);
    } else if (file === undefined) {
      file = arg;
    } else {
      usage(`unexpected argument: ${arg}`);
    }
  }
  if (file === undefined) usage("replay needs a capsule file");

  // The path came off a command line, so the file behind it may not be there, may be a directory, or
  // may be unreadable — `node:fs` failures that are not in this vocabulary and whose stack frames are
  // nobody's business but ours. `run` reports the same class of failure under the same code.
  let capsule: LoadedCapsule;
  try {
    capsule = await loadCapsule(file, { acceptDrift });
  } catch (e) {
    if (e instanceof CapsuleError) throw e;
    throw new CapsuleError("E_CONTAINER", e instanceof Error ? e.message : String(e), { file });
  }

  const result = await replayRun({
    capsule,
    ...(runId === undefined ? {} : { runId }),
    ...(journalPath === undefined ? {} : { journalPath }),
  });

  report(result, json);
  return result.ok && !result.diverged ? 0 : 1;
}

/**
 * A divergence is the tool this command exists to provide, not a crash: it goes to stdout in both
 * shapes, and the exit code is what a script reads. `1` covers both a replay that diverged and a
 * replay that could not be finished, since neither one reproduced the run.
 */
function report(result: ReplayResult, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (result.ok && !result.diverged) {
    process.stdout.write(
      `replay ok: run ${result.runId} (${result.tool}) reproduced ${result.effects} effect(s) ` +
        `and value ${result.recordedValueDigest}\n`,
    );
    return;
  }
  const what = result.diverged ? "replay diverged" : "replay failed";
  process.stdout.write(`${what}: ${result.error?.code}: ${result.error?.message}\n`);
}
