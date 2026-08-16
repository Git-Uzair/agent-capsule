import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CapsuleError } from "./errors.ts";

/**
 * Locates this program's own runnable CLI entry, i.e. the directory that holds the
 * runtime bundle (dist/cli.js plus the assets copied beside it by scripts/build.js).
 * Shared by every command that has to point something else at the runtime:
 * OS file-association handlers (install-handler) and exported bundles (export-mcpb, build-manager-mcpb).
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

export function getDistRuntimePaths(customDistDir?: string): { cliJs: string; wasm: string } {
  // The runtime bundle is wherever the CLI entry lives; scripts/build.js copies the
  // Wasm asset beside it, so one existing lookup locates both files.
  const distDir = customDistDir ?? dirname(getDefaultCliPath());
  const cliJs = resolve(distDir, "cli.js");
  const wasm = resolve(distDir, "emscripten-module.wasm");
  if (existsSync(cliJs) && existsSync(wasm)) {
    return { cliJs, wasm };
  }
  throw new CapsuleError(
    "E_CONTAINER",
    customDistDir
      ? `dist runtime bundle not found in ${customDistDir}`
      : "dist runtime bundle not found (run npm run build first)",
  );
}

export function getDefaultIconPath(customIconPath?: string): string {
  if (customIconPath) {
    if (existsSync(customIconPath)) return customIconPath;
    throw new CapsuleError("E_CONTAINER", `icon file not found at ${customIconPath}`);
  }

  // scripts/build.js copies assets/icon.png beside the CLI bundle; running from
  // source (no build yet) falls back to the repository asset.
  const besideCli = resolve(dirname(getDefaultCliPath()), "icon.png");
  if (existsSync(besideCli)) return besideCli;

  const repoAsset = resolve(import.meta.dirname, "..", "..", "assets", "icon.png");
  if (existsSync(repoAsset)) return repoAsset;

  throw new CapsuleError("E_CONTAINER", "default icon.png not found");
}

