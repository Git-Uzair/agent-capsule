import { CapsuleError } from "../core/errors.ts";
import { loadCapsule, type LoadedCapsule } from "../format/capsule.ts";
import { invokeTool, type InvokeResult } from "../runtime/invoke.ts";

const USAGE =
  "usage: capsule run <file> --tool <name> [--args '<json>'] [--json] " +
  "[--state <path>] [--journal <path>] [--accept-drift]";

function usage(message: string): never {
  throw new CapsuleError("E_USAGE", `${message} (${USAGE})`);
}

/** Arguments arrive as text from a shell, so unparseable JSON is the user's mistake, not a crash. */
function parseArgs(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch (e) {
    usage(`--args is not valid JSON: ${(e as Error).message}`);
  }
}

export async function runCommand(argv: string[]): Promise<number> {
  let file: string | undefined;
  let tool: string | undefined;
  let args: unknown;
  let json = false;
  let statePath: string | undefined;
  let journalPath: string | undefined;
  let acceptDrift = false;

  const valueOf = (arg: string, next: string | undefined): string =>
    next === undefined ? usage(`${arg} needs a value`) : next;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--tool") {
      tool = valueOf(arg, argv[++i]);
    } else if (arg === "--args") {
      args = parseArgs(valueOf(arg, argv[++i]));
    } else if (arg === "--state") {
      statePath = valueOf(arg, argv[++i]);
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
  if (file === undefined) usage("run needs a capsule file");
  if (tool === undefined) usage("run needs --tool <name>");

  // The path came off a command line, so the file behind it may not be there, may be a directory, or
  // may be unreadable — `node:fs` failures that are not in this vocabulary and whose stack frames are
  // nobody's business but ours. `verify` reports the same class of failure under the same code.
  let capsule: LoadedCapsule;
  try {
    capsule = await loadCapsule(file, { acceptDrift });
  } catch (e) {
    if (e instanceof CapsuleError) throw e;
    throw new CapsuleError("E_CONTAINER", e instanceof Error ? e.message : String(e), { file });
  }

  const result = await invokeTool({
    capsule,
    tool,
    ...(args === undefined ? {} : { args }),
    ...(statePath === undefined ? {} : { statePath }),
    ...(journalPath === undefined ? {} : { journalPath }),
  });

  report(result, json);
  return result.ok ? 0 : 1;
}

/**
 * The report goes to stdout in both shapes — a failed run is a result, not a crash, and a wrapper
 * asking for `--json` gets one JSON document whether the tool worked or not. The exit code is what
 * says which happened.
 */
function report(result: InvokeResult, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (result.ok) {
    process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`);
    process.stderr.write(`run ${result.runId}: ok in ${result.ms}ms, ${result.effects} effect(s)\n`);
  } else {
    process.stdout.write(`${result.error?.code}: ${result.error?.message}\n`);
  }
}
