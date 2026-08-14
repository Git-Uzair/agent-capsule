import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");

test("cli reports its version", () => {
  const out = execFileSync(process.execPath, [CLI, "--version"], { encoding: "utf8" });
  assert.match(out.trim(), /^agent-capsule 0\.1\.0 \(spec 0\.1\.0, mcp 2026-07-28\)$/);
});

test("cli exits 2 with usage on an unknown command", () => {
  assert.throws(
    () => execFileSync(process.execPath, [CLI, "frobnicate"], { encoding: "utf8", stdio: "pipe" }),
    (e: unknown) => (e as { status: number }).status === 2,
  );
});
