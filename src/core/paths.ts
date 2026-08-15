import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Locates this program's own runnable CLI entry, i.e. the directory that holds the
 * runtime bundle (dist/cli.js plus the assets copied beside it by scripts/build.js).
 * Shared by every command that has to point something else at the runtime:
 * OS file-association handlers (install-handler) and exported bundles (export-mcpb).
 */
export function getDefaultCliPath(): string {
  // If running from dist/cli.js
  const distCli = resolve(import.meta.dirname, "cli.js");
  if (existsSync(distCli)) {
    return distCli;
  }
  // If running from source (src/<dir>/)
  const fromSrcDist = resolve(import.meta.dirname, "..", "..", "dist", "cli.js");
  if (existsSync(fromSrcDist)) {
    return fromSrcDist;
  }
  const fromSrcTs = resolve(import.meta.dirname, "..", "cli.ts");
  if (existsSync(fromSrcTs)) {
    return fromSrcTs;
  }
  return resolve(import.meta.dirname, "..", "dist", "cli.js");
}
