import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fromBuffer, type Entry } from "yauzl";
import { buildManagerMcpb, runBuildManagerMcpb } from "../src/commands/build-manager-mcpb.ts";
import { getDefaultIconPath, getDistRuntimePaths } from "../src/core/paths.ts";
import { createManagerServer } from "../src/mcp/manager/server.ts";
import type { JsonRpcRequest } from "../src/mcp/transport.ts";
import { HOST_VERSION } from "../src/version.ts";

const ROOT = resolve(import.meta.dirname, "..");
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
  const home = resolve(".tmp", `manager-mcpb-test-${randomUUID()}`);
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

let nextId = 0;
function toolCall(name: string, args: Record<string, unknown>): JsonRpcRequest {
  nextId += 1;
  return { jsonrpc: "2.0", id: nextId, method: "tools/call", params: { name, arguments: args } };
}

describe("capsule build-manager-mcpb", () => {
  it("builds a deterministic .mcpb archive with exact 5 entries, valid manifest and runtime", async () => {
    await withHome(async (home) => {
      const outPath = join(home, "capsule-manager.mcpb");
      const out = await buildManagerMcpb(outPath);
      assert.equal(out, outPath);
      assert.equal(existsSync(outPath), true);

      const mcpbBytes = readFileSync(outPath);
      const entries = await extractZip(mcpbBytes);

      // Verify exact 5 entries in archive
      const expectedEntries = [
        "manifest.json",
        "server/cli.js",
        "server/emscripten-module.wasm",
        "package.json",
        "icon.png",
      ];
      assert.equal(entries.size, 5, `Expected exactly 5 entries, found ${entries.size}`);
      for (const expected of expectedEntries) {
        assert.equal(entries.has(expected), true, `Missing expected entry: ${expected}`);
      }

      // Verify manifest.json schema and metadata
      const manifest = JSON.parse(entries.get("manifest.json")!.toString("utf8"));
      assert.equal(manifest.manifest_version, "0.2");
      assert.equal(manifest.name, "capsule-manager");
      assert.equal(manifest.display_name, "Capsule Manager");
      assert.equal(manifest.version, HOST_VERSION);
      assert.ok(typeof manifest.description === "string" && manifest.description.length > 50);
      assert.ok(manifest.description.includes("capsule_install"));
      assert.ok(manifest.description.includes("capsule_create"));
      assert.deepEqual(manifest.author, { name: "Agent Capsule" });
      assert.equal(manifest.icon, "icon.png");
      assert.equal(manifest.server.type, "node");
      assert.equal(manifest.server.entry_point, "server/cli.js");
      assert.deepEqual(manifest.server.mcp_config, {
        command: "node",
        args: ["${__dirname}/server/cli.js", "manager"],
        env: {},
      });

      // Verify package.json engines floor
      const pkg = JSON.parse(entries.get("package.json")!.toString("utf8"));
      assert.equal(pkg.type, "module");
      assert.equal(pkg.engines.node, ">=22.13.0");

      // Verify bundled runtime and icon bytes
      const distPaths = getDistRuntimePaths();
      const defaultIcon = readFileSync(getDefaultIconPath());
      assert.deepEqual(entries.get("server/cli.js"), readFileSync(distPaths.cliJs));
      assert.deepEqual(entries.get("server/emscripten-module.wasm"), readFileSync(distPaths.wasm));
      assert.deepEqual(entries.get("icon.png"), defaultIcon);
    });
  });

  it("produces deterministic bytes regardless of execution", async () => {
    await withHome(async (home) => {
      const out1 = join(home, "out1.mcpb");
      const out2 = join(home, "out2.mcpb");
      await buildManagerMcpb(out1);
      await buildManagerMcpb(out2);

      const bytes1 = readFileSync(out1);
      const bytes2 = readFileSync(out2);
      assert.deepEqual(bytes1, bytes2, "buildManagerMcpb output must be strictly deterministic");
    });
  });

  it("extracts and runs manager MCP server responding to 2025-06-18 handshake and listing all 6 manager tools", async () => {
    await withHome(async (home) => {
      const outPath = join(home, "capsule-manager.mcpb");
      await buildManagerMcpb(outPath);

      // Extract .mcpb into sandbox
      const sandbox = join(home, "manager-sandbox");
      mkdirSync(sandbox, { recursive: true });

      const entries = await extractZip(readFileSync(outPath));
      for (const [entryPath, data] of entries.entries()) {
        const dest = join(sandbox, entryPath);
        mkdirSync(resolve(dest, ".."), { recursive: true });
        writeFileSync(dest, data);
      }

      // Execute extracted node server/cli.js manager
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
      ].join("\n");

      const stdout = execFileSync(
        process.execPath,
        ["server/cli.js", "manager"],
        {
          cwd: sandbox,
          input: `${input}\n`,
          encoding: "utf8",
          env: { ...process.env, CAPSULE_HOME: home },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );

      const lines = stdout.split("\n").filter((line) => line !== "");
      assert.equal(lines.length, 2, "Expected 2 response lines (initialize, tools/list)");

      const parsed = lines.map(
        (l) => JSON.parse(l) as { id: number; result: Record<string, unknown> },
      );
      const initRes = parsed[0]!;
      const listRes = parsed[1]!;

      assert.equal(initRes.id, 1);
      assert.equal(initRes.result["protocolVersion"], "2025-06-18");
      assert.deepEqual(initRes.result["capabilities"], {
        tools: { listChanged: true },
        resources: { listChanged: false },
      });

      assert.equal(listRes.id, 2);
      type SchemaNode = { description?: string; items?: SchemaNode; properties?: Record<string, SchemaNode> };
      type ToolItem = {
        name: string;
        title?: string;
        description: string;
        inputSchema?: SchemaNode;
      };
      const tools = listRes.result["tools"] as ToolItem[];
      const toolNames = tools.map((t) => t.name);

      const expectedTools = [
        "capsule_install",
        "capsule_uninstall",
        "capsule_list",
        "capsule_create",
        "capsule_update",
        "capsule_test_tool",
      ];
      assert.deepEqual(toolNames, expectedTools);

      // Verify all tools have non-empty titles and descriptions
      for (const t of tools) {
        assert.ok(typeof t.title === "string" && t.title.length > 0, `Tool ${t.name} missing title`);
        assert.ok(typeof t.description === "string" && t.description.length > 0, `Tool ${t.name} missing description`);
      }

      // Verify capsule_create description and accurate guest ABI instructions in schemas
      const createTool = tools.find((t) => t.name === "capsule_create")!;
      assert.ok(createTool.description.includes("brand-new Agent Capsule"));
      assert.ok(createTool.description.includes("conformance"));
      const createSourceDesc = createTool.inputSchema?.properties?.["source"]?.description ?? "";
      assert.ok(createSourceDesc.includes("QuickJS sandbox"), "source description must mention QuickJS sandbox");
      assert.ok(createSourceDesc.includes("globalThis.tools"), "source description must mention globalThis.tools");
      assert.ok(createSourceDesc.includes("globalThis.capsule"), "source description must mention globalThis.capsule");
      assert.ok(createSourceDesc.includes("capsule.fetch"), "source description must mention capsule.fetch");
      assert.ok(createSourceDesc.includes("capsule.kv.get(key)"), "source description must accurately cite capsule.kv.get(key)");
      assert.ok(createSourceDesc.includes("capsule.kv.set(key, val)"), "source description must accurately cite capsule.kv.set(key, val)");
      assert.ok(createSourceDesc.includes("capsule.sql.query"), "source description must cite capsule.sql.query");
      assert.ok(createSourceDesc.includes("capsule.sql.exec"), "source description must cite capsule.sql.exec");
      assert.ok(createSourceDesc.includes("capsule.log"), "source description must cite capsule.log");

      // An advertised API is only callable once the tool declares the op it performs: policy.check
      // refuses any op missing from that tool's effects list (src/runtime/policy.ts), so a schema that
      // offers capsule.log without saying so describes a capsule that installs and then fails.
      assert.match(
        createSourceDesc,
        /must .{0,40}be declared in that tool's `effects`/,
        "source description must state that every op a handler calls has to be declared in that tool's effects",
      );
      assert.ok(
        createSourceDesc.includes('"log.write"'),
        "source description must name the effect capsule.log requires",
      );

      const createKvDesc = createTool.inputSchema?.properties?.["capabilities"]?.properties?.["kv"]?.description ?? "";
      assert.ok(createKvDesc.includes("capsule.kv.get(key)"), "kv capability description must mention capsule.kv.get(key)");
      assert.ok(createKvDesc.includes("capsule.kv.set(key, val)"), "kv capability description must mention capsule.kv.set(key, val)");
      assert.ok(!createKvDesc.includes("delete"), "kv capability description must not advertise delete (not in guest ABI)");
      assert.ok(!createKvDesc.includes("list"), "kv capability description must not advertise list (not in guest ABI)");

      const createSqlDesc = createTool.inputSchema?.properties?.["capabilities"]?.properties?.["sql"]?.description ?? "";
      assert.ok(createSqlDesc.includes("capsule.sql.query"), "sql capability description must mention capsule.sql.query");
      assert.ok(createSqlDesc.includes("capsule.sql.exec"), "sql capability description must mention capsule.sql.exec");

      const createNetDesc = createTool.inputSchema?.properties?.["capabilities"]?.properties?.["net"]?.description ?? "";
      assert.ok(createNetDesc.includes("capsule.fetch"), "net capability description must mention capsule.fetch");

      // allowed_hosts must state the real matching semantics (src/runtime/policy.ts matchesPattern)
      const createHostsDesc =
        createTool.inputSchema?.properties?.["capabilities"]?.properties?.["net"]?.properties?.["allowed_hosts"]
          ?.description ?? "";
      assert.ok(
        createHostsDesc.includes("`*.example.com`"),
        "allowed_hosts description must show the '*.' wildcard form that the manifest schema allows",
      );
      assert.match(createHostsDesc, /subdomain/i, "allowed_hosts description must say a '*.' entry covers subdomains");
      assert.match(
        createHostsDesc,
        /not the apex/i,
        "allowed_hosts description must say a '*.' entry does not cover the apex domain",
      );
      assert.ok(
        !/wildcard[^.]*exact/i.test(createHostsDesc),
        "allowed_hosts description must not claim wildcards are matched as exact domain strings",
      );
      assert.match(createHostsDesc, /blocked/i, "allowed_hosts description must say unmatched hosts are blocked");
      assert.match(
        createHostsDesc,
        /IP address/i,
        "allowed_hosts description must say IP addresses are not reachable through this list",
      );
      assert.match(
        createHostsDesc,
        /only the hosts the user/i,
        "allowed_hosts description must keep the guardrail about listing only hosts the user named",
      );

      // Verify capsule_update accurate guest ABI descriptions
      const updateTool = tools.find((t) => t.name === "capsule_update")!;
      assert.ok(updateTool.description.includes("Update an existing Agent Capsule"));
      const updateSourceDesc = updateTool.inputSchema?.properties?.["source"]?.description ?? "";
      assert.ok(updateSourceDesc.includes("QuickJS sandbox"));
      assert.ok(updateSourceDesc.includes("globalThis.tools"));

      // Both authoring tools take the same effects list, so both have to explain it the same way —
      // including log.write, a real EffectName (src/format/manifest.ts) the enumeration used to omit.
      for (const tool of [createTool, updateTool]) {
        const effectsDesc = tool.inputSchema?.properties?.["tools"]?.items?.properties?.["effects"]?.description ?? "";
        assert.match(
          effectsDesc,
          /every runtime op the handler calls must/i,
          `${tool.name} effects description must state that every op the handler calls has to appear in the list`,
        );
        for (const effect of ["kv.get", "kv.set", "sql.query", "sql.exec", "net.fetch", "log.write"]) {
          assert.ok(
            effectsDesc.includes(effect),
            `${tool.name} effects description must enumerate ${effect}`,
          );
        }
      }

      // Verify capsule_install, capsule_uninstall, capsule_list, capsule_test_tool descriptions
      const installTool = tools.find((t) => t.name === "capsule_install")!;
      assert.ok(installTool.description.includes(".capsule"));
      assert.ok(installTool.description.includes("Downloads"));

      const uninstallTool = tools.find((t) => t.name === "capsule_uninstall")!;
      assert.ok(uninstallTool.description.includes("capsuleId or name"));

      const listTool = tools.find((t) => t.name === "capsule_list")!;
      assert.ok(listTool.description.includes("publisher keys"));
      assert.ok(listTool.description.includes("trust state"));

      const testTool = tools.find((t) => t.name === "capsule_test_tool")!;
      assert.ok(testTool.description.includes("sandboxed test invocation"));
      assert.ok(testTool.description.includes("journaled effect count"));
    });
  });

  it("runs an authored capsule written the way the schemas instruct: capsule.log and capsule.kv with those effects declared", async () => {
    await withHome(async (home) => {
      const server = createManagerServer({ homeDir: home, downloadsDir: join(home, "downloads") });
      const source = `globalThis.tools = {
        note({ text }) {
          capsule.log("note: " + text);
          const seen = Number(capsule.kv.get("seen") ?? "0") + 1;
          capsule.kv.set("seen", String(seen));
          return { logged: text, seen };
        }
      };`;
      const noteTool = {
        name: "note",
        title: "Log a note",
        description: "Logs a note and returns how many notes have been logged.",
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      };

      const createRes = await server.handleMessage(
        toolCall("capsule_create", {
          name: "notebook",
          title: "Notebook",
          description: "Logs notes and counts them.",
          capabilities: { kv: true },
          source,
          tools: [{ ...noteTool, effects: ["log.write", "kv.get", "kv.set"] }],
        }),
      );
      assert.ok(createRes && "result" in createRes);
      const created = createRes.result as {
        isError: boolean;
        content: Array<{ text: string }>;
        structuredContent: { ok: boolean; tools: string[] };
      };
      assert.equal(created.isError, false, `capsule_create failed: ${created.content[0]?.text}`);
      assert.ok(
        created.structuredContent.tools.includes("notebook__note"),
        `gateway did not serve notebook__note: ${created.structuredContent.tools.join(", ")}`,
      );

      // Called through the gateway: the three ops the handler performs are the three it declared, so
      // the run completes — and the kv write it made is there on the next call.
      type CallResult = {
        isError: boolean;
        content: Array<{ text: string }>;
        structuredContent: { logged: string; seen: number };
      };
      const first = await server.handleMessage(toolCall("notebook__note", { text: "first" }));
      const firstResult = (first as { result: CallResult }).result;
      assert.equal(firstResult.isError, false, `notebook__note failed: ${firstResult.content[0]?.text}`);
      assert.deepEqual(firstResult.structuredContent, { logged: "first", seen: 1 });

      const second = await server.handleMessage(toolCall("notebook__note", { text: "second" }));
      const secondResult = (second as { result: CallResult }).result;
      assert.equal(secondResult.isError, false);
      assert.deepEqual(secondResult.structuredContent, { logged: "second", seen: 2 });

      // Why the schemas have to spell the rule out: the same source with log.write left off the
      // effects list is created, conformed and installed all the same, and fails at call time.
      const undeclaredRes = await server.handleMessage(
        toolCall("capsule_create", {
          name: "scratchpad",
          title: "Scratchpad",
          description: "Logs notes without declaring the log effect.",
          capabilities: { kv: true },
          source,
          tools: [{ ...noteTool, effects: ["kv.get", "kv.set"] }],
        }),
      );
      const undeclared = (undeclaredRes as { result: { isError: boolean; content: Array<{ text: string }> } }).result;
      assert.equal(undeclared.isError, false, `capsule_create failed: ${undeclared.content[0]?.text}`);

      const denied = await server.handleMessage(toolCall("scratchpad__note", { text: "third" }));
      const deniedResult = (denied as { result: { isError: boolean; content: Array<{ text: string }> } }).result;
      assert.equal(deniedResult.isError, true);
      assert.match(deniedResult.content[0]!.text, /did not declare effect log\.write/);
    });
  });

  it("CLI command parses arguments and defaults output filename to capsule-manager.mcpb", async () => {
    await withHome(async (home) => {
      // 1. Run via CLI with default output
      const res1 = spawnSync(process.execPath, [CLI, "build-manager-mcpb"], {
        cwd: home,
        encoding: "utf8",
        env: { ...process.env, CAPSULE_HOME: home },
      });
      assert.equal(res1.status, 0, `CLI build failed: ${res1.stderr}`);
      const defaultOut = join(home, "capsule-manager.mcpb");
      assert.equal(existsSync(defaultOut), true);

      // 2. Run via CLI with explicit -o
      const customOut = join(home, "custom.mcpb");
      const res2 = spawnSync(process.execPath, [CLI, "build-manager-mcpb", "-o", customOut], {
        cwd: home,
        encoding: "utf8",
        env: { ...process.env, CAPSULE_HOME: home },
      });
      assert.equal(res2.status, 0, `CLI custom build failed: ${res2.stderr}`);
      assert.equal(existsSync(customOut), true);

      // 3. Run via CLI with explicit --out
      const customOut2 = join(home, "custom2.mcpb");
      const res3 = spawnSync(process.execPath, [CLI, "build-manager-mcpb", "--out", customOut2], {
        cwd: home,
        encoding: "utf8",
        env: { ...process.env, CAPSULE_HOME: home },
      });
      assert.equal(res3.status, 0, `CLI custom build failed: ${res3.stderr}`);
      assert.equal(existsSync(customOut2), true);

      // 4. Rejections on invalid options / unexpected arguments via CLI
      const missingValRes = spawnSync(process.execPath, [CLI, "build-manager-mcpb", "-o"], {
        cwd: home,
        encoding: "utf8",
        env: { ...process.env, CAPSULE_HOME: home },
      });
      assert.equal(missingValRes.status, 1);
      assert.match(missingValRes.stderr, /^E_USAGE: -o needs a value/);

      const emptyValRes = spawnSync(process.execPath, [CLI, "build-manager-mcpb", "-o", ""], {
        cwd: home,
        encoding: "utf8",
        env: { ...process.env, CAPSULE_HOME: home },
      });
      assert.equal(emptyValRes.status, 1);
      assert.match(emptyValRes.stderr, /^E_USAGE: -o needs a non-empty value/);

      const emptyValRes2 = spawnSync(process.execPath, [CLI, "build-manager-mcpb", "--out", "   "], {
        cwd: home,
        encoding: "utf8",
        env: { ...process.env, CAPSULE_HOME: home },
      });
      assert.equal(emptyValRes2.status, 1);
      assert.match(emptyValRes2.stderr, /^E_USAGE: --out needs a non-empty value/);

      const unknownOptRes = spawnSync(process.execPath, [CLI, "build-manager-mcpb", "--unknown"], {
        cwd: home,
        encoding: "utf8",
        env: { ...process.env, CAPSULE_HOME: home },
      });
      assert.equal(unknownOptRes.status, 1);
      assert.match(unknownOptRes.stderr, /^E_USAGE: unknown option: --unknown/);

      const unexpRes = spawnSync(process.execPath, [CLI, "build-manager-mcpb", "unexpected-arg"], {
        cwd: home,
        encoding: "utf8",
        env: { ...process.env, CAPSULE_HOME: home },
      });
      assert.equal(unexpRes.status, 1);
      assert.match(unexpRes.stderr, /^E_USAGE: unexpected argument: unexpected-arg/);

      // 5. Direct runner function and API errors
      await assert.rejects(
        async () => await runBuildManagerMcpb(["-o"]),
        (err: unknown) => {
          assert.equal((err as { code: string }).code, "E_USAGE");
          return true;
        },
      );
      await assert.rejects(
        async () => await runBuildManagerMcpb(["-o", ""]),
        (err: unknown) => {
          assert.equal((err as { code: string }).code, "E_USAGE");
          return true;
        },
      );
      await assert.rejects(
        async () => await buildManagerMcpb(""),
        (err: unknown) => {
          assert.equal((err as { code: string }).code, "E_USAGE");
          return true;
        },
      );
      await assert.rejects(
        async () => await runBuildManagerMcpb(["--unknown"]),
        (err: unknown) => {
          assert.equal((err as { code: string }).code, "E_USAGE");
          return true;
        },
      );
      await assert.rejects(
        async () => await runBuildManagerMcpb(["unexpected-arg"]),
        (err: unknown) => {
          assert.equal((err as { code: string }).code, "E_USAGE");
          return true;
        },
      );
    });
  });
});
