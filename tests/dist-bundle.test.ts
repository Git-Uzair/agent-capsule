import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, cpSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { VERSION_LINE } from "../src/version.ts";

describe("Distribution bundle (dist/cli.js)", () => {
  const root = resolve(import.meta.dirname, "..");
  const distDir = join(root, "dist");
  const cliPath = join(distDir, "cli.js");
  const wasmPath = join(distDir, "emscripten-module.wasm");

  it("dist artifacts exist and have been built", () => {
    // Ensure build is present
    if (!existsSync(cliPath) || !existsSync(wasmPath)) {
      const res = spawnSync(process.execPath, [join(root, "scripts", "build.js")], {
        cwd: root,
        encoding: "utf8",
      });
      assert.equal(res.status, 0, `Build failed: ${res.stderr}`);
    }
    assert.equal(existsSync(cliPath), true, "dist/cli.js should exist");
    assert.equal(existsSync(wasmPath), true, "dist/emscripten-module.wasm should exist");
  });

  it("executes --version, pack, verify, and run in a clean directory without node_modules", () => {
    const sandbox = join(tmpdir(), `capsule-dist-test-${randomUUID()}`);
    const isolatedDist = join(sandbox, "dist");
    const isolatedHello = join(sandbox, "hello");
    const isolatedHome = join(sandbox, "home");

    mkdirSync(isolatedDist, { recursive: true });
    mkdirSync(isolatedHome, { recursive: true });
    writeFileSync(join(sandbox, "package.json"), JSON.stringify({ type: "module" }));

    copyFileSync(cliPath, join(isolatedDist, "cli.js"));
    copyFileSync(wasmPath, join(isolatedDist, "emscripten-module.wasm"));
    cpSync(join(root, "templates", "hello"), isolatedHello, { recursive: true });

    const isolatedCli = join(isolatedDist, "cli.js");
    const env = { ...process.env, CAPSULE_HOME: isolatedHome };

    try {
      // 1. --version
      const vRes = spawnSync(process.execPath, [isolatedCli, "--version"], {
        cwd: sandbox,
        encoding: "utf8",
        env,
      });
      assert.equal(vRes.status, 0, `Version command failed: ${vRes.stderr}`);
      assert.equal(vRes.stdout.trim(), VERSION_LINE);

      // 2. pack
      const pRes = spawnSync(
        process.execPath,
        [isolatedCli, "pack", isolatedHello, "-o", "test.capsule"],
        {
          cwd: sandbox,
          encoding: "utf8",
          env,
        },
      );
      assert.equal(pRes.status, 0, `Pack command failed: ${pRes.stderr}`);
      assert.equal(existsSync(join(sandbox, "test.capsule")), true);

      // 3. verify
      const verifyRes = spawnSync(
        process.execPath,
        [isolatedCli, "verify", "test.capsule"],
        {
          cwd: sandbox,
          encoding: "utf8",
          env,
        },
      );
      assert.equal(verifyRes.status, 0, `Verify command failed: ${verifyRes.stderr}`);
      assert.match(verifyRes.stdout, /OK/);

      // 4. run tool (proves QuickJS Wasm execution in complete isolation from node_modules)
      const runRes = spawnSync(
        process.execPath,
        [
          isolatedCli,
          "run",
          "test.capsule",
          "--tool",
          "greet",
          "--args",
          JSON.stringify({ name: "CleanEnv" }),
        ],
        {
          cwd: sandbox,
          encoding: "utf8",
          env,
        },
      );
      assert.equal(runRes.status, 0, `Run command failed: ${runRes.stderr}`);
      assert.match(runRes.stdout, /"text": "hello CleanEnv"/);
      assert.match(runRes.stderr, /ok in \d+ms/);

      // 5. install-handler dry-run targets dist/cli.js (not missing cli.ts)
      const ihRes = spawnSync(
        process.execPath,
        [isolatedCli, "install-handler"],
        {
          cwd: sandbox,
          encoding: "utf8",
          env,
        },
      );
      assert.equal(ihRes.status, process.platform === "win32" ? 0 : 2);
      if (process.platform === "win32") {
        assert.match(ihRes.stdout, /cli\.js/);
        assert.doesNotMatch(ihRes.stdout, /cli\.ts/);
      }
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
