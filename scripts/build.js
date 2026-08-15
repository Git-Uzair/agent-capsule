#!/usr/bin/env node
import { mkdirSync, copyFileSync, chmodSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import * as esbuild from "esbuild";

/**
 * Agent Capsule Bundle Builder
 *
 * Engine Support Split:
 * - TypeScript source dev / testing: Node.js >= 24.0.0 (uses built-in TypeScript type-stripping).
 * - Distribution bundle (dist/cli.js) / MCPB standalone: Node.js >= 22.13.0 (the minimum version for unflagged node:sqlite).
 *
 * Root package.json declares "engines": { "node": ">=24.0.0" } to ensure contributors and
 * developers run Node >=24 for native TS execution. The packaged standalone distribution bundle
 * (dist/cli.js) and MCPB-facing package manifests support Node >=22.13.0.
 *
 * This build produces a standalone ESM bundle in dist/cli.js and places the QuickJS Wasm
 * asset beside it at dist/emscripten-module.wasm so that the packaged CLI can run offline
 * without any node_modules dependencies.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const distDir = resolve(rootDir, "dist");
const require = createRequire(import.meta.url);

mkdirSync(distDir, { recursive: true });

// Shims static imports of node:sqlite into runtime dynamic requires so that running
// dist/cli.js on Node < 22.13 does not throw an uncatchable ERR_UNKNOWN_BUILTIN_MODULE
// at module link time before the probe in src/cli.ts can print its diagnostic.
const sqliteShimPlugin = {
  name: "sqlite-shim",
  setup(build) {
    build.onResolve({ filter: /^node:sqlite$/ }, (args) => ({
      path: args.path,
      namespace: "sqlite-shim",
    }));
    build.onLoad({ filter: /.*/, namespace: "sqlite-shim" }, () => ({
      contents: `
        import { createRequire } from 'node:module';
        const __req = createRequire(import.meta.url);
        let sqlite;
        try {
          sqlite = __req('node:sqlite');
        } catch {
          sqlite = {};
        }
        export const DatabaseSync = sqlite.DatabaseSync;
        export const StatementSync = sqlite.StatementSync;
        export default sqlite;
      `,
      loader: "js",
    }));
  },
};

console.log("Building dist/cli.js...");

await esbuild.build({
  entryPoints: [resolve(rootDir, "src/cli.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: resolve(distDir, "cli.js"),
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
  },
  plugins: [sqliteShimPlugin],
  logLevel: "info",
});

// Copy QuickJS Wasm asset beside dist/cli.js
const wasmPkgJson = require.resolve("@jitl/quickjs-wasmfile-release-asyncify/package.json");
const wasmSourcePath = resolve(dirname(wasmPkgJson), "dist", "emscripten-module.wasm");
const wasmDestPath = resolve(distDir, "emscripten-module.wasm");

copyFileSync(wasmSourcePath, wasmDestPath);

try {
  chmodSync(resolve(distDir, "cli.js"), 0o755);
} catch {
  // Ignored on platforms (e.g. Windows) where chmodSync is a no-op or has different permission models
}

console.log("Build complete: dist/cli.js + dist/emscripten-module.wasm");
