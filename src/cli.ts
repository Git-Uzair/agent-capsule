#!/usr/bin/env node
import { VERSION_LINE } from "./version.ts";
import { CapsuleError } from "./core/errors.ts";

type Command = (argv: string[]) => Promise<number>;
const COMMANDS = new Map<string, Command>();

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
