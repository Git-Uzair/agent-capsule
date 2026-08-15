import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";

describe("npm package publishability", () => {
  const root = resolve(import.meta.dirname, "..");
  const pkgPath = join(root, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    name?: string;
    private?: boolean;
    bin?: Record<string, string>;
    files?: string[];
    engines?: Record<string, string>;
    scripts?: Record<string, string>;
  };

  it("package.json has required publish metadata", () => {
    assert.equal(pkg.private, undefined, "package.json must not be marked private");
    assert.deepEqual(pkg.bin, {
      capsule: "dist/cli.js",
      "agent-capsule": "dist/cli.js",
    });
    assert.ok(Array.isArray(pkg.files), "package.json must declare files list");
    assert.ok(pkg.files.includes("dist"));
    assert.ok(pkg.files.includes("schema"));
    assert.ok(pkg.files.includes("README.md"));
    assert.ok(pkg.files.includes("docs/SPEC.md"));
    assert.ok(pkg.files.includes("templates"));
    // Root package.json specifies >=24.0.0 for TypeScript source dev / node --test execution.
    // The distribution bundle (dist/cli.js) and MCPB-facing package manifests support >=22.13.0 (unflagged node:sqlite).
    assert.equal(pkg.engines?.node, ">=24.0.0");
    assert.ok(pkg.scripts?.build, "scripts.build must exist");
    assert.ok(pkg.scripts?.prepack, "scripts.prepack must exist");
  });

  it("templates/hello exists with standard fixture files", () => {
    const templateDir = join(root, "templates", "hello");
    assert.equal(existsSync(join(templateDir, "capsule.json")), true);
    assert.equal(existsSync(join(templateDir, "src", "main.js")), true);
    assert.equal(existsSync(join(templateDir, "ui", "index.html")), true);
  });

  it("npm pack includes dist, schema, templates, and documentation", () => {
    const res = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: root,
      encoding: "utf8",
      shell: true,
    });
    assert.equal(res.status, 0, `npm pack failed: ${res.stderr}`);
    const [packInfo] = JSON.parse(res.stdout) as Array<{
      files: Array<{ path: string }>;
    }>;
    const paths = packInfo?.files.map((f) => f.path) ?? [];

    assert.ok(paths.some((p) => p === "dist/cli.js" || p === "dist\\cli.js"));
    assert.ok(paths.some((p) => p.includes("emscripten-module.wasm")));
    assert.ok(paths.some((p) => p.includes("capsule-0.1.schema.json")));
    assert.ok(paths.some((p) => p.includes("templates/hello/capsule.json") || p.includes("templates\\hello\\capsule.json")));
    assert.ok(paths.some((p) => p === "README.md"));
  });
});
