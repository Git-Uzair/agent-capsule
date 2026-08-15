import { CapsuleError } from "../core/errors.ts";
import { loadCapsule, type LoadedCapsule } from "../format/capsule.ts";
import { createMcpServer } from "../mcp/server.ts";
import { createStdioTransport } from "../mcp/transport.ts";

const USAGE =
  "usage: capsule mcp <file> [--state <path>] [--journal <path>] [--accept-drift] [--allow-suspicious]";

function usage(message: string): never {
  throw new CapsuleError("E_USAGE", `${message} (${USAGE})`);
}

export async function mcpCommand(argv: string[]): Promise<number> {
  let file: string | undefined;
  let statePath: string | undefined;
  let journalPath: string | undefined;
  let acceptDrift = false;
  let allowSuspicious = false;

  const valueOf = (arg: string, next: string | undefined): string =>
    next === undefined ? usage(`${arg} needs a value`) : next;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--state") {
      statePath = valueOf(arg, argv[++i]);
    } else if (arg === "--journal") {
      journalPath = valueOf(arg, argv[++i]);
    } else if (arg === "--accept-drift") {
      acceptDrift = true;
    } else if (arg === "--allow-suspicious") {
      allowSuspicious = true;
    } else if (arg.startsWith("-")) {
      usage(`unknown option: ${arg}`);
    } else if (file === undefined) {
      file = arg;
    } else {
      usage(`unexpected argument: ${arg}`);
    }
  }
  if (file === undefined) usage("mcp needs a capsule file");

  // Full verification first, and before the transport exists: a capsule that does not verify must be
  // refused on stderr without a single JSON-RPC line having been written. `replay` and `run` report
  // this same class of `node:fs` failure under the same code.
  let capsule: LoadedCapsule;
  try {
    capsule = await loadCapsule(file, { acceptDrift });
  } catch (e) {
    if (e instanceof CapsuleError) throw e;
    throw new CapsuleError("E_CONTAINER", e instanceof Error ? e.message : String(e), { file });
  }

  const server = createMcpServer({
    capsule,
    allowSuspicious,
    ...(statePath === undefined ? {} : { statePath }),
    ...(journalPath === undefined ? {} : { journalPath }),
  });
  server.serve(createStdioTransport({ in: process.stdin, out: process.stdout }));

  // The loop ends when the peer closes stdin, as the stdio transport requires. Work already in
  // flight keeps the event loop alive on its own pending I/O, so a response to the last line is
  // still written before the process exits.
  await new Promise<void>((resolve) => {
    process.stdin.once("end", resolve);
  });
  return 0;
}
