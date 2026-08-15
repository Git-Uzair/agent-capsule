import { CapsuleError } from "../core/errors.ts";
import { createManagerServer } from "../mcp/manager/server.ts";
import { createStdioTransport } from "../mcp/transport.ts";

const USAGE = "usage: capsule manager [--home <dir>] [--downloads <dir>] [--allow-suspicious]";

function usage(message: string): never {
  throw new CapsuleError("E_USAGE", `${message} (${USAGE})`);
}

export async function managerCommand(argv: string[]): Promise<number> {
  let homeDir: string | undefined;
  let downloadsDir: string | undefined;
  let allowSuspicious = false;

  const valueOf = (arg: string, next: string | undefined): string =>
    next === undefined ? usage(`${arg} needs a value`) : next;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--home") {
      homeDir = valueOf(arg, argv[++i]);
    } else if (arg === "--downloads") {
      downloadsDir = valueOf(arg, argv[++i]);
    } else if (arg === "--allow-suspicious") {
      allowSuspicious = true;
    } else if (arg.startsWith("-")) {
      usage(`unknown option: ${arg}`);
    } else {
      usage(`unexpected argument: ${arg}`);
    }
  }

  const server = createManagerServer({
    homeDir,
    downloadsDir,
    allowSuspicious,
  });

  server.serve(createStdioTransport({ in: process.stdin, out: process.stdout }));

  await new Promise<void>((resolve) => {
    process.stdin.once("end", resolve);
  });
  await server.drain();
  return 0;
}
