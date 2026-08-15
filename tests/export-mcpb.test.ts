import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { join, resolve } from "node:path";
import { fromBuffer, type Entry } from "yauzl";
import { exportMcpb, getDefaultIconPath, getDistRuntimePaths, packMcpb } from "../src/commands/export-mcpb.ts";
import { loadCapsule, packDirectory, type LoadedCapsule } from "../src/format/capsule.ts";
import { homeSidecarPaths } from "../src/runtime/invoke.ts";

const ROOT = resolve(import.meta.dirname, "..");
const FIXTURE = resolve("templates", "hello");
const CLI = resolve("dist", "cli.js");
const DIST_CLI = resolve("dist", "cli.js");
const DIST_WASM = resolve("dist", "emscripten-module.wasm");

function ensureBuilt(): void {
  if (!existsSync(DIST_CLI) || !existsSync(DIST_WASM)) {
    const res = spawnSync(process.execPath, [join(ROOT, "scripts", "build.js")], {
      cwd: ROOT,
      encoding: "utf8",
    });
    if (res.status !== 0) {
      throw new Error(`Build failed: ${res.stderr}`);
    }
  }
}

ensureBuilt();

function extractZip(bytes: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    fromBuffer(bytes, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error("failed to open zip"));
      const files = new Map<string, Buffer>();
      zip.on("entry", (entry: Entry) => {
        if (entry.fileName.endsWith("/")) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) return reject(streamErr ?? new Error(`failed to read entry: ${entry.fileName}`));
          const parts: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => parts.push(chunk));
          stream.on("end", () => {
            files.set(entry.fileName, Buffer.concat(parts));
            zip.readEntry();
          });
          stream.on("error", reject);
        });
      });
      zip.on("end", () => resolve(files));
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = resolve(".tmp", `mcpb-home-${randomUUID()}`);
  const previous = process.env.CAPSULE_HOME;
  process.env.CAPSULE_HOME = home;
  mkdirSync(home, { recursive: true });
  try {
    await fn(home);
  } finally {
    if (previous === undefined) delete process.env.CAPSULE_HOME;
    else process.env.CAPSULE_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

async function packTestCapsule(home: string): Promise<LoadedCapsule> {
  const dir = resolve(home, `src-${randomUUID()}`);
  cpSync(FIXTURE, dir, { recursive: true });
  const capsuleFile = resolve(home, "hello.capsule");
  await packDirectory(dir, capsuleFile, { homeDir: home });
  return await loadCapsule(capsuleFile, { homeDir: home });
}

describe("capsule export-mcpb", () => {
  it("packs an .mcpb archive with exact entries, valid manifest and runtime", async () => {
    await withHome(async (home) => {
      const capsule = await packTestCapsule(home);
      const mcpbPath = join(home, "test.mcpb");

      const out = await exportMcpb(capsule.file, mcpbPath);
      assert.equal(out, mcpbPath);
      assert.equal(existsSync(mcpbPath), true);

      const mcpbBytes = readFileSync(mcpbPath);
      const entries = await extractZip(mcpbBytes);

      // Verify exact entries in archive
      const expectedEntries = [
        "manifest.json",
        "server/cli.js",
        "server/emscripten-module.wasm",
        "payload/hello-1.0.0.capsule",
        "package.json",
        "icon.png",
      ];
      assert.deepEqual(
        [...entries.keys()].sort(),
        [...expectedEntries].sort(),
        "mcpb must contain exactly the expected entries",
      );

      // Verify manifest.json schema
      const manifestRaw = entries.get("manifest.json")?.toString("utf8");
      assert.ok(manifestRaw);
      const manifest = JSON.parse(manifestRaw);
      assert.equal(manifest.manifest_version, "0.2");
      assert.equal(manifest.name, "hello");
      assert.equal(manifest.version, "1.0.0");
      assert.ok(manifest.description);
      assert.deepEqual(manifest.author, { name: "Agent Capsule" });
      assert.equal(manifest.icon, "icon.png");
      assert.equal(manifest.server.type, "node");
      assert.equal(manifest.server.entry_point, "server/cli.js");
      assert.equal(manifest.server.mcp_config.command, "node");
      assert.deepEqual(manifest.server.mcp_config.args, [
        "${__dirname}/server/cli.js",
        "mcp",
        "${__dirname}/payload/hello-1.0.0.capsule",
        "--state-home",
      ]);
      assert.deepEqual(manifest.server.mcp_config.env, {});

      // Verify package.json engines
      const pkgRaw = entries.get("package.json")?.toString("utf8");
      assert.ok(pkgRaw);
      const pkg = JSON.parse(pkgRaw);
      assert.equal(pkg.type, "module");
      assert.equal(pkg.engines.node, ">=22.13.0");

      // Verify icon bytes match assets/icon.png
      const defaultIcon = readFileSync(getDefaultIconPath());
      assert.deepEqual(entries.get("icon.png"), defaultIcon);

      // Verify server runtime matches dist/
      const distPaths = getDistRuntimePaths();
      assert.deepEqual(entries.get("server/cli.js"), readFileSync(distPaths.cliJs));
      assert.deepEqual(entries.get("server/emscripten-module.wasm"), readFileSync(distPaths.wasm));

      // Verify embedded capsule is byte-identical and passes loadCapsule verification
      const embeddedCapsuleBytes = entries.get("payload/hello-1.0.0.capsule");
      assert.deepEqual(embeddedCapsuleBytes, capsule.bytes);

      const embeddedTemp = join(home, "extracted-verify.capsule");
      writeFileSync(embeddedTemp, embeddedCapsuleBytes!);
      const loadedEmbedded = await loadCapsule(embeddedTemp, { homeDir: home });
      assert.equal(loadedEmbedded.capsuleId, capsule.capsuleId);
      assert.equal(loadedEmbedded.manifest.meta.name, "hello");
    });
  });

  it("payload filename with template variables on disk is canonicalized to safe manifest-derived name preventing injection", async () => {
    await withHome(async (home) => {
      const capsule = await packTestCapsule(home);
      // Copy capsule to a file containing template variables in name
      const dangerousPath = join(home, "${HOME}-test.capsule");
      cpSync(capsule.file, dangerousPath);

      const mcpbPath = join(home, "dangerous.mcpb");
      await exportMcpb(dangerousPath, mcpbPath);

      const entries = await extractZip(readFileSync(mcpbPath));
      assert.equal(entries.has("payload/hello-1.0.0.capsule"), true);
      assert.equal(entries.has("payload/${HOME}-test.capsule"), false);

      const manifest = JSON.parse(entries.get("manifest.json")!.toString("utf8"));
      assert.deepEqual(manifest.server.mcp_config.args, [
        "${__dirname}/server/cli.js",
        "mcp",
        "${__dirname}/payload/hello-1.0.0.capsule",
        "--state-home",
      ]);
    });
  });

  it("packMcpb produces deterministic archive using shared deterministic zip packer", async () => {
    const entries = [
      { path: "b.txt", data: Buffer.from("world", "utf8") },
      { path: "a.txt", data: Buffer.from("hello", "utf8") },
    ];
    const zip1 = await packMcpb(entries);
    const zip2 = await packMcpb([...entries].reverse());
    assert.deepEqual(zip1, zip2, "packMcpb output must be order-independent and deterministic");
  });

  it("extracts and runs MCP server responding to 2025-06-18 handshake and tool calls with --state-home", async () => {
    await withHome(async (home) => {
      const capsule = await packTestCapsule(home);
      const mcpbPath = join(home, "test.mcpb");
      await exportMcpb(capsule.file, mcpbPath);

      // Extract .mcpb into an isolated sandbox (simulating Claude Desktop extension directory)
      const sandbox = join(home, "extension-sandbox");
      mkdirSync(sandbox, { recursive: true });

      const entries = await extractZip(readFileSync(mcpbPath));
      for (const [entryPath, data] of entries.entries()) {
        const dest = join(sandbox, entryPath);
        mkdirSync(resolve(dest, ".."), { recursive: true });
        writeFileSync(dest, data);
      }

      // Run extracted node server/cli.js mcp payload/hello-1.0.0.capsule --state-home
      const input = [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "Claude Desktop", version: "1.0.0" },
          },
        }),
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "greet", arguments: { name: "DesktopUser" } },
        }),
      ].join("\n");

      const stdout = execFileSync(
        process.execPath,
        ["server/cli.js", "mcp", "payload/hello-1.0.0.capsule", "--state-home"],
        {
          cwd: sandbox,
          input: `${input}\n`,
          encoding: "utf8",
          env: { ...process.env, CAPSULE_HOME: home },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );

      const lines = stdout.split("\n").filter((line) => line !== "");
      assert.equal(lines.length, 3, "Expected 3 response lines (initialize, tools/list, tools/call)");

      const [initRes, listRes, callRes] = lines.map(
        (l) => JSON.parse(l) as { id: number; result: Record<string, unknown> },
      );
      assert.ok(initRes);
      assert.ok(listRes);
      assert.ok(callRes);

      // 1. initialize negotiation
      assert.equal(initRes.id, 1);
      assert.equal(initRes.result.protocolVersion, "2025-06-18");
      assert.deepEqual(initRes.result.serverInfo, { name: "hello", version: "1.0.0" });

      // 2. tools/list
      assert.equal(listRes.id, 2);
      const tools = listRes.result.tools as { name: string }[];
      assert.ok(Array.isArray(tools));
      assert.ok(tools.some((t) => t.name === "greet"));

      // 3. tools/call
      assert.equal(callRes.id, 3);
      assert.equal(callRes.result.resultType, "complete");
      const content = callRes.result.content as { type: string; text: string }[];
      assert.ok(content[0]?.text);
      const parsedContent = JSON.parse(content[0].text) as { text: string };
      assert.equal(parsedContent.text, "hello DesktopUser");

      // Verify sidecars are created in CAPSULE_HOME/state/, NOT in the extension sandbox
      const sidecars = homeSidecarPaths(capsule.capsuleId, home);
      assert.equal(existsSync(sidecars.app), true, `State db should exist at ${sidecars.app}`);
      assert.equal(existsSync(sidecars.journal), true, `Journal db should exist at ${sidecars.journal}`);

      // Ensure NO sidecars were written inside sandbox/payload/
      assert.equal(existsSync(join(sandbox, "payload", "hello-1.0.0.capsule.app.sqlite")), false);
      assert.equal(existsSync(join(sandbox, "payload", "hello-1.0.0.capsule.journal.sqlite")), false);
    });
  });

  it("P1-2: refuses a tampered embedded capsule on startup, writes E-code to stderr and keeps stdout clean", async () => {
    await withHome(async (home) => {
      const capsule = await packTestCapsule(home);
      const mcpbPath = join(home, "test.mcpb");
      await exportMcpb(capsule.file, mcpbPath);

      const sandbox = join(home, "tampered-sandbox");
      mkdirSync(sandbox, { recursive: true });

      const entries = await extractZip(readFileSync(mcpbPath));
      for (const [entryPath, data] of entries.entries()) {
        const dest = join(sandbox, entryPath);
        mkdirSync(resolve(dest, ".."), { recursive: true });
        writeFileSync(dest, data);
      }

      // Tamper guest source in payload capsule
      const payloadPath = join(sandbox, "payload", "hello-1.0.0.capsule");
      const payloadBytes = readFileSync(payloadPath);
      const at = payloadBytes.indexOf("greet_count");
      assert.ok(at > 0, "payload must contain greet_count");
      payloadBytes[at] = (payloadBytes[at] ?? 0) ^ 0x01; // flip byte
      writeFileSync(payloadPath, payloadBytes);

      const res = spawnSync(
        process.execPath,
        ["server/cli.js", "mcp", "payload/hello-1.0.0.capsule", "--state-home"],
        {
          cwd: sandbox,
          input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) + "\n",
          encoding: "utf8",
          env: { ...process.env, CAPSULE_HOME: home },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );

      // Server must refuse startup
      assert.equal(res.status, 1, "Process should exit with code 1 on tampered capsule");
      assert.equal(res.stdout, "", "stdout must remain completely pure and empty");
      assert.match(res.stderr, /^(E_SIGNATURE|E_DIGEST|E_CONTAINER): /, "stderr must name the failure code");
    });
  });

  it("CLI command parses arguments and defaults output filename to <name>.mcpb", async () => {
    await withHome(async (home) => {
      const capsule = await packTestCapsule(home);

      // 1. Run via CLI with default output
      const res1 = spawnSync(process.execPath, [CLI, "export-mcpb", capsule.file], {
        cwd: home,
        encoding: "utf8",
        env: { ...process.env, CAPSULE_HOME: home },
      });
      assert.equal(res1.status, 0, `CLI export failed: ${res1.stderr}`);
      const defaultOut = join(home, "hello.mcpb");
      assert.equal(existsSync(defaultOut), true);

      // 2. Run via CLI with explicit -o
      const customOut = join(home, "custom.mcpb");
      const res2 = spawnSync(process.execPath, [CLI, "export-mcpb", capsule.file, "-o", customOut], {
        cwd: home,
        encoding: "utf8",
        env: { ...process.env, CAPSULE_HOME: home },
      });
      assert.equal(res2.status, 0, `CLI custom export failed: ${res2.stderr}`);
      assert.equal(existsSync(customOut), true);

      // 3. Error cases
      const missingRes = spawnSync(process.execPath, [CLI, "export-mcpb"], {
        cwd: home,
        encoding: "utf8",
        env: { ...process.env, CAPSULE_HOME: home },
      });
      assert.equal(missingRes.status, 1);
      assert.match(missingRes.stderr, /^E_USAGE: /);

      const notFoundRes = spawnSync(process.execPath, [CLI, "export-mcpb", "nonexistent.capsule"], {
        cwd: home,
        encoding: "utf8",
        env: { ...process.env, CAPSULE_HOME: home },
      });
      assert.equal(notFoundRes.status, 1);
      assert.match(notFoundRes.stderr, /^E_USAGE: /);
    });
  });
});

