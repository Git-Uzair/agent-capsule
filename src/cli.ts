#!/usr/bin/env node
import { VERSION_LINE } from "./version.ts";
import { CapsuleError } from "./core/errors.ts";
import { conformanceCommand } from "./commands/conformance.ts";
import { mcpCommand } from "./commands/mcp.ts";
import { packCommand } from "./commands/pack.ts";
import { replayCommand } from "./commands/replay.ts";
import { runCommand } from "./commands/run.ts";
import { uiCommand } from "./commands/ui.ts";
import { verifyCommand } from "./commands/verify.ts";

type Command = (argv: string[]) => Promise<number>;
// Registered here rather than by later `set` calls: USAGE is built from this map at module load.
const COMMANDS = new Map<string, Command>([
  ["pack", packCommand],
  ["verify", verifyCommand],
  ["run", runCommand],
  ["replay", replayCommand],
  ["mcp", mcpCommand],
  ["ui", uiCommand],
  ["conformance", conformanceCommand],
]);

const USAGE = `usage: capsule <command> [options]

commands:
  --version                 print version
${[...COMMANDS.keys()].map((k) => `  ${k}`).join("\n")}
`;

export async function runCli(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "--version" || cmd === "-v") {
    process.stdout.write(VERSION_LINE + "\n");
    return 0;
  }
  const handler = cmd === undefined ? undefined : COMMANDS.get(cmd);
  if (!handler) {
    process.stderr.write(USAGE);
    return 2;
  }
  try {
    return await handler(rest);
  } catch (err) {
    if (err instanceof CapsuleError) {
      process.stderr.write(`${err.code}: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

process.exitCode = await runCli(process.argv.slice(2));
