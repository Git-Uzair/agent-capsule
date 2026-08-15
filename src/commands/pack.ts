import { CapsuleError } from "../core/errors.ts";
import { packDirectory } from "../format/capsule.ts";

const USAGE = "usage: capsule pack <dir> [-o out.capsule]";

export async function packCommand(argv: string[]): Promise<number> {
  let dir: string | undefined;
  let out: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "-o" || arg === "--out") {
      out = argv[++i];
      if (out === undefined) throw new CapsuleError("E_USAGE", `${arg} needs a file name (${USAGE})`);
    } else if (arg.startsWith("-")) {
      throw new CapsuleError("E_USAGE", `unknown option: ${arg} (${USAGE})`);
    } else if (dir === undefined) {
      dir = arg;
    } else {
      throw new CapsuleError("E_USAGE", `unexpected argument: ${arg} (${USAGE})`);
    }
  }
  if (dir === undefined) throw new CapsuleError("E_USAGE", `pack needs a directory (${USAGE})`);

  const result = await packDirectory(dir, out);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}
