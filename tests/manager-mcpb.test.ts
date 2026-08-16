import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fromBuffer, type Entry } from "yauzl";
import SCHEMA from "../schema/capsule-0.1.schema.json" with { type: "json" };
import { buildManagerMcpb, runBuildManagerMcpb } from "../src/commands/build-manager-mcpb.ts";
import { exportMcpb } from "../src/commands/export-mcpb.ts";
import { getDefaultIconPath, getDistRuntimePaths } from "../src/core/paths.ts";
import { packDirectory } from "../src/format/capsule.ts";
import { loadInstalledStore, loadSeededStore } from "../src/mcp/manager/registry.ts";
import { createManagerServer } from "../src/mcp/manager/server.ts";
import { AUTHORED_NAME_PATTERN, LISTED_TRUST_STATES, listedTrust } from "../src/mcp/manager/tools.ts";
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

/** The installed file as the registry records it — the same source of truth the serving path reads. */
function installedFileOf(capsuleId: string, home: string): string {
  const entry = loadInstalledStore(home).capsules[capsuleId];
  assert.ok(entry, `no installed entry for ${capsuleId}`);
  return entry.file;
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
        resources: { listChanged: true },
        extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
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

      // The name description must state the rule that is actually enforced, not a wider one: the
      // served alphabet is AUTHORED_NAME_PATTERN (src/mcp/manager/tools.ts), so the description is
      // built from its source and this assertion fails the moment the two disagree.
      const createNameDesc = createTool.inputSchema?.properties?.["name"]?.description ?? "";
      assert.ok(
        createNameDesc.includes(AUTHORED_NAME_PATTERN.source),
        `name description must quote the enforced pattern ${AUTHORED_NAME_PATTERN.source}: ${createNameDesc}`,
      );
      assert.ok(
        !createNameDesc.includes("a-zA-Z0-9_-"),
        "name description must not advertise the wider gateway alphabet the authoring tools refuse",
      );
      assert.match(createNameDesc, /lowercase/i, "name description must say the alphabet is lowercase");
      assert.match(createNameDesc, /1-64 characters/, "name description must state the length limit");
      assert.ok(
        createNameDesc.includes("<name>__<toolName>"),
        "name description must say tools are served as <name>__<toolName>",
      );
      // capsule_update takes the same name through the same check, so it says the same rule.
      const updateNameDesc =
        tools.find((t) => t.name === "capsule_update")!.inputSchema?.properties?.["name"]?.description ?? "";
      assert.ok(updateNameDesc.includes(AUTHORED_NAME_PATTERN.source), "capsule_update name must state the same rule");

      // A tool name is the schema's business (schema/capsule-0.1.schema.json), plus the reserved
      // `capsule_` prefix parseManifest refuses; the description has to match both.
      const toolNamePattern = SCHEMA.properties.tools.items.properties.name.pattern;
      assert.equal(toolNamePattern, "^[a-zA-Z0-9_-]{1,64}$");
      const createToolNameDesc =
        createTool.inputSchema?.properties?.["tools"]?.items?.properties?.["name"]?.description ?? "";
      assert.ok(createToolNameDesc.includes("[a-zA-Z0-9_-]"), "tool name description must state the schema alphabet");
      assert.ok(createToolNameDesc.includes("1-64 characters"), "tool name description must state the schema length");
      assert.ok(
        createToolNameDesc.includes("capsule_"),
        "tool name description must say the 'capsule_' prefix is reserved",
      );

      // The tools array bounds are the schema's minItems/maxItems, so the description must not invent
      // its own numbers.
      assert.equal(SCHEMA.properties.tools.minItems, 1);
      assert.equal(SCHEMA.properties.tools.maxItems, 64);
      const createToolsDesc = createTool.inputSchema?.properties?.["tools"]?.description ?? "";
      assert.ok(createToolsDesc.includes("1-64 tools"), "tools description must state the 1-64 schema bounds");

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
      // The `globalThis.capsule` enumeration is the whole frozen object the prelude installs
      // (src/runtime/prelude.ts): now and random are on it too, and a schema that hides them sends the
      // agent to `Date`/`Math` for things the capsule API already offers.
      assert.ok(createSourceDesc.includes("capsule.now()"), "source description must cite capsule.now()");
      assert.ok(createSourceDesc.includes("capsule.random(n)"), "source description must cite capsule.random(n)");
      assert.ok(
        createSourceDesc.includes("ISO-8601"),
        "source description must say capsule.now() returns an ISO-8601 timestamp string, not a number",
      );
      assert.ok(
        !createSourceDesc.includes("capsule.pack"),
        "source description must not advertise a pack API the prelude does not install",
      );

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
      // The list has a ceiling, and it is the schema's (32), not one the description made up.
      assert.equal(SCHEMA.properties.capabilities.properties.net.properties.allowed_hosts.maxItems, 32);
      assert.ok(createHostsDesc.includes("32"), "allowed_hosts description must state the schema's 32-entry ceiling");

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
        // The enumeration is measured against the schema's own effect enum: every name the schema
        // accepts has to be accounted for, including pack.write — which the description accounts for
        // by saying no guest API performs it (nothing in src/runtime supplies the packWrite port).
        for (const effect of SCHEMA.properties.tools.items.properties.effects.items.enum) {
          assert.ok(
            effectsDesc.includes(effect),
            `${tool.name} effects description must account for the schema effect ${effect}`,
          );
        }
        assert.match(
          effectsDesc,
          /pack\.write[^.]*no guest API/,
          `${tool.name} effects description must say pack.write has no guest API in this host`,
        );
        // clock.now and random.bytes reach the guest through capsule.now/capsule.random as well as the
        // patched Date/Math (src/runtime/prelude.ts).
        assert.ok(effectsDesc.includes("capsule.now()"), `${tool.name} effects description must cite capsule.now()`);
        assert.ok(
          effectsDesc.includes("capsule.random(n)"),
          `${tool.name} effects description must cite capsule.random(n)`,
        );
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
      // Every state the listing can report, and only those: LISTED_TRUST_STATES is the type of
      // ListedCapsule["trust"], so a state that cannot be assigned cannot be named here either.
      for (const state of LISTED_TRUST_STATES) {
        assert.ok(
          listTool.description.includes(`'${state}'`),
          `capsule_list description must name the trust state ${state}`,
        );
      }
      // And 'drift-accepted' is not among them: verifyInstalled (src/mcp/manager/server.ts) loads
      // without acceptDrift because only a user-approved install or update may re-pin (§6.2), so no
      // listing can emit it. The description has to say where it is reported instead, and what the
      // re-pinned capsule reads as here — the test below proves both against the running gateway.
      assert.ok(
        !(LISTED_TRUST_STATES as readonly string[]).includes("drift-accepted"),
        "drift-accepted is not a state a listing produces, so it must not be a listed trust state",
      );
      assert.match(
        listTool.description,
        /'drift-accepted' is not a state a listing/,
        "capsule_list description must say drift-accepted is not one of its own states",
      );
      assert.match(
        listTool.description,
        /capsule_install or capsule_update/,
        "capsule_list description must say which result reports drift-accepted instead",
      );
      assert.match(
        listTool.description,
        /reads as 'ok' on every listing/,
        "capsule_list description must say a re-pinned capsule reads as ok on the next listing",
      );
      assert.ok(
        !/\bdrift\b(?!-)/.test(listTool.description),
        "capsule_list description must not name a bare 'drift' state — the real spelling is drift-accepted",
      );
      // The verification lifecycle this host actually has, and it has two halves: verifyInstalled
      // (src/mcp/manager/server.ts) caches only the LoadedCapsule of a file that verified — cleared by
      // invalidateCache on install, update or uninstall — while a "corrupt"/"unverifiable" verdict
      // returns without caching anything, so that file is re-read on every listing. The description
      // must promise both halves and neither as the whole rule; the test below drives them.
      assert.match(
        listTool.description,
        /a file that verified is cached, and every later listing repeats that verdict until the next registry change \(install, update, uninstall\) clears it/,
        "capsule_list description must say a successful verdict is cached until the next registry change",
      );
      assert.match(
        listTool.description,
        /noticed on the next session or after the next registry change, not on the next listing/,
        "capsule_list description must say when a valid file altered underneath a running manager is noticed",
      );
      assert.match(
        listTool.description,
        /a file that failed verification is not cached and is re-read from disk on every listing/,
        "capsule_list description must say a failed verdict is re-checked from disk on every listing",
      );
      assert.match(
        listTool.description,
        /as soon as the file and the trust store are right again, with no registry change needed/,
        "capsule_list description must say how corrupt or unverifiable state clears",
      );
      assert.ok(
        listTool.description.includes("never re-pins anything"),
        "capsule_list description must keep saying that verification never re-pins",
      );
      assert.ok(
        !/listing re-verifies/.test(listTool.description),
        "capsule_list description must not claim a listing re-verifies the installed file",
      );
      assert.ok(
        !/once per manager session/.test(listTool.description),
        "capsule_list description must not claim verification happens once per session — a failed verdict is not cached",
      );

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

  it("enforces the name rule and the trust states its schemas describe", async () => {
    await withHome(async (home) => {
      const warnings: string[] = [];
      const options = {
        homeDir: home,
        downloadsDir: join(home, "downloads"),
        warn: (line: string) => warnings.push(line),
      };
      const server = createManagerServer(options);
      type Refusal = { isError: boolean; content: Array<{ text: string }>; structuredContent: { error?: string } };

      // The names the description now calls illegal are the names AUTHORED_NAME_PATTERN refuses, and
      // the refusal quotes that same pattern — the schema, the check and the message are one rule.
      for (const name of ["MyCapsule", "_notes", "-notes", "a.b"]) {
        assert.equal(AUTHORED_NAME_PATTERN.test(name), false, `${name} must not match the authored name rule`);
        const res = await server.handleMessage(
          toolCall("capsule_create", {
            name,
            source: "globalThis.tools = { peek() { return {}; } };",
            tools: [{ name: "peek", inputSchema: { type: "object" } }],
          }),
        );
        const refused = (res as { result: Refusal }).result;
        assert.equal(refused.isError, true, `capsule_create accepted the illegal name '${name}'`);
        assert.equal(refused.structuredContent.error, "E_CONTENT");
        assert.ok(
          refused.content[0]!.text.includes(AUTHORED_NAME_PATTERN.source),
          `refusal for '${name}' must quote the rule the schema states: ${refused.content[0]!.text}`,
        );
      }

      // The reserved prefix the tool-name description warns about is enforced by parseManifest.
      const reserved = await server.handleMessage(
        toolCall("capsule_create", {
          name: "notes1",
          source: "globalThis.tools = { capsule_peek() { return {}; } };",
          tools: [{ name: "capsule_peek", inputSchema: { type: "object" } }],
        }),
      );
      const reservedRes = (reserved as { result: Refusal }).result;
      assert.equal(reservedRes.isError, true, "a tool named capsule_* must be refused");
      assert.match(reservedRes.content[0]!.text, /reserved tool name: capsule_peek/);

      // A name the rule allows goes through, and the clock and randomness APIs the schemas enumerate
      // are the ones the prelude really installs: this handler calls both and declares both.
      const created = await server.handleMessage(
        toolCall("capsule_create", {
          name: "notes1",
          title: "Notes",
          description: "Reads the clock and some randomness.",
          source:
            "globalThis.tools = { peek() { return { at: capsule.now(), hex: capsule.random(4) }; } };",
          tools: [
            {
              name: "peek",
              title: "Peek",
              description: "Returns the sandboxed clock reading and four random bytes.",
              inputSchema: { type: "object" },
              effects: ["clock.now", "random.bytes"],
            },
          ],
        }),
      );
      const createdRes = (created as {
        result: { isError: boolean; content: Array<{ text: string }>; structuredContent: { capsuleId: string } };
      }).result;
      assert.equal(createdRes.isError, false, `capsule_create failed: ${createdRes.content[0]?.text}`);
      const capsuleId = createdRes.structuredContent.capsuleId;

      const peeked = await server.handleMessage(toolCall("notes1__peek", {}));
      const peekedRes = (peeked as {
        result: { isError: boolean; content: Array<{ text: string }>; structuredContent: { at: string; hex: string } };
      }).result;
      assert.equal(peekedRes.isError, false, `notes1__peek failed: ${peekedRes.content[0]?.text}`);
      assert.match(
        peekedRes.structuredContent.at,
        /^\d{4}-\d{2}-\d{2}T/,
        "capsule.now() returns the ISO-8601 timestamp string the source description promises",
      );
      assert.match(
        peekedRes.structuredContent.hex,
        /^[0-9a-f]{8}$/,
        "capsule.random(4) returns four bytes as lowercase hex, as the source description promises",
      );

      // What capsule_list reports has to be a state its description names.
      type ListResult = { structuredContent: { capsules: Array<{ trust: string; tools: string[] }> } };
      const listed = ((await server.handleMessage(toolCall("capsule_list", {}))) as { result: ListResult }).result;
      const row = listed.structuredContent.capsules[0]!;
      assert.ok(
        (LISTED_TRUST_STATES as readonly string[]).includes(row.trust),
        `capsule_list reported an undescribed trust state: ${row.trust}`,
      );
      assert.ok(row.tools.includes("notes1__peek"), `capsule_list did not report notes1__peek: ${row.tools.join(", ")}`);

      // And the state a broken installed file lands in is 'corrupt', which the description names as
      // the state a drifted or unverifiable-signature file reads as — not the absent 'drift'.
      writeFileSync(installedFileOf(capsuleId, home), Buffer.from("not a capsule"));
      const reopened = createManagerServer(options);
      const relisted = ((await reopened.handleMessage(toolCall("capsule_list", {}))) as { result: ListResult }).result;
      const brokenRow = relisted.structuredContent.capsules[0]!;
      assert.equal(brokenRow.trust, "corrupt");
      assert.ok(
        (LISTED_TRUST_STATES as readonly string[]).includes(brokenRow.trust),
        "corrupt must be one of the states capsule_list describes",
      );
      assert.deepEqual(brokenRow.tools, [], "a corrupt capsule serves no tools, as the description says");
      assert.ok(
        warnings.some((line) => line.includes(`Failed to verify installed capsule ${capsuleId}`)),
        `the corrupt listing must report why the file was refused: ${warnings.join(" | ")}`,
      );
    });
  });

  it("reaches every trust state capsule_list names, and reports a re-pinned capsule as ok", async () => {
    await withHome(async (home) => {
      const warnings: string[] = [];
      const options = {
        homeDir: home,
        downloadsDir: join(home, "downloads"),
        warn: (line: string) => warnings.push(line),
      };
      type ListRow = { capsuleId: string; trust: string; tools: string[]; note?: string };
      type AuthorResult = {
        isError: boolean;
        content: Array<{ text: string }>;
        structuredContent: { capsuleId: string; trust: string };
      };
      const seenStates = new Set<string>();

      // One fresh server per listing: verifyInstalled caches a verified capsule for the life of the
      // server, so re-verifying after the trust store or the installed bytes changed is what a new
      // one does — the same thing a restarted client does.
      const listRows = async (): Promise<ListRow[]> => {
        const res = (await createManagerServer(options).handleMessage(toolCall("capsule_list", {}))) as {
          result: { structuredContent: { capsules: ListRow[] } };
        };
        const rows = res.result.structuredContent.capsules;
        for (const row of rows) {
          assert.ok(
            (LISTED_TRUST_STATES as readonly string[]).includes(row.trust),
            `capsule_list reported an undescribed trust state: ${row.trust}`,
          );
          seenStates.add(row.trust);
        }
        return rows;
      };
      const rowFor = (rows: ListRow[], capsuleId: string): ListRow => {
        const row = rows.find((candidate) => candidate.capsuleId === capsuleId);
        assert.ok(row, `capsule_list did not report ${capsuleId}`);
        return row;
      };
      const author = async (tool: string, args: Record<string, unknown>): Promise<AuthorResult> => {
        const res = (await createManagerServer(options).handleMessage(toolCall(tool, args))) as {
          result: AuthorResult;
        };
        assert.equal(res.result.isError, false, `${tool} failed: ${res.result.content[0]?.text}`);
        return res.result;
      };
      const peek = { name: "peek", title: "Peek", description: "Returns ok.", inputSchema: { type: "object" } };
      const poke = { name: "poke", title: "Poke", description: "Returns ok.", inputSchema: { type: "object" } };

      const firstId = (
        await author("capsule_create", {
          name: "notes1",
          title: "Notes",
          description: "Peeks.",
          source: "globalThis.tools = { peek() { return { ok: true }; } };",
          tools: [peek],
        })
      ).structuredContent.capsuleId;

      // 'pinned': with nothing pinned for this name, the listing's own verification *is* the
      // trust-on-first-use that pins its publisher key and tool catalog.
      rmSync(join(home, "trust.json"));
      assert.equal(rowFor(await listRows(), firstId).trust, "pinned");

      // 'ok': the pin the previous listing wrote is the pin this one matches.
      const okRow = rowFor(await listRows(), firstId);
      assert.equal(okRow.trust, "ok");
      assert.ok(okRow.tools.includes("notes1__peek"), `capsule_list did not report notes1__peek: ${okRow.tools.join(", ")}`);

      // 'drift-accepted' belongs to the update, not to any listing: the update that re-pins a changed
      // tool catalog reports it once, and the next listing — which verifies the new registry entry and
      // never re-pins (§6.2) — reports that same capsule as 'ok'.
      const updated = await author("capsule_update", {
        name: "notes1",
        source: "globalThis.tools = { peek() { return { ok: true }; }, poke() { return { ok: true }; } };",
        tools: [peek, poke],
        accept_drift: true,
      });
      assert.equal(updated.structuredContent.trust, "drift-accepted");
      const driftedId = updated.structuredContent.capsuleId;
      assert.notEqual(driftedId, firstId);
      const afterDrift = rowFor(await listRows(), driftedId);
      assert.equal(afterDrift.trust, "ok", "a capsule whose re-pin was accepted reads as ok on the next listing");
      assert.ok(afterDrift.tools.includes("notes1__poke"), `the re-pinned catalog is served: ${afterDrift.tools.join(", ")}`);

      // 'unverifiable': the file under the pinned id is a valid, properly signed capsule — just not
      // the one this registry row pins, so it may not borrow the trusted name.
      const secondId = (
        await author("capsule_create", {
          name: "notes2",
          title: "More Notes",
          description: "Peeks too.",
          source: "globalThis.tools = { peek() { return { ok: true }; } };",
          tools: [peek],
        })
      ).structuredContent.capsuleId;
      writeFileSync(installedFileOf(driftedId, home), readFileSync(installedFileOf(secondId, home)));
      const swapped = rowFor(await listRows(), driftedId);
      assert.equal(swapped.trust, "unverifiable");
      assert.deepEqual(swapped.tools, [], "an unverifiable capsule serves no tools, as the description says");
      assert.ok(
        warnings.some((line) => line.includes(`Refusing installed capsule ${driftedId}`)),
        `the unverifiable listing must report why the file was refused: ${warnings.join(" | ")}`,
      );

      // 'corrupt': bytes that are not a capsule at all.
      writeFileSync(installedFileOf(secondId, home), Buffer.from("not a capsule"));
      const brokenRows = await listRows();
      assert.equal(rowFor(brokenRows, secondId).trust, "corrupt");
      assert.deepEqual(rowFor(brokenRows, secondId).tools, []);
      assert.equal(rowFor(brokenRows, driftedId).trust, "unverifiable");

      // Bidirectional: every state the description names was reached by a real listing above, and no
      // listing ever reported anything else.
      assert.deepEqual(
        [...seenStates].sort(),
        [...LISTED_TRUST_STATES].sort(),
        "capsule_list must be able to report exactly the states its description names",
      );

      // The boundary that keeps a row honest if a load in the listing path ever did re-pin: such bytes
      // are reported as corrupt, never under a listing state this host does not have.
      assert.equal(listedTrust("drift-accepted"), "corrupt");
      assert.equal(listedTrust("pinned"), "pinned");
      assert.equal(listedTrust("ok"), "ok");
    });
  });

  it("caches a verified file for the session but re-reads a failed one on every listing", async () => {
    await withHome(async (home) => {
      const warnings: string[] = [];
      const options = {
        homeDir: home,
        downloadsDir: join(home, "downloads"),
        warn: (line: string) => warnings.push(line),
      };
      // One server for the whole test: this is the session capsule_list's description talks about.
      const server = createManagerServer(options);
      type ListRow = { capsuleId: string; trust: string; tools: string[] };
      const listRows = async (): Promise<ListRow[]> => {
        const res = (await server.handleMessage(toolCall("capsule_list", {}))) as {
          result: { structuredContent: { capsules: ListRow[] } };
        };
        return res.result.structuredContent.capsules;
      };
      const rowFor = (rows: ListRow[], capsuleId: string): ListRow => {
        const row = rows.find((candidate) => candidate.capsuleId === capsuleId);
        assert.ok(row, `capsule_list did not report ${capsuleId}`);
        return row;
      };
      const create = async (name: string): Promise<string> => {
        const res = (await server.handleMessage(
          toolCall("capsule_create", {
            name,
            title: name,
            description: "Peeks.",
            source: "globalThis.tools = { peek() { return { ok: true }; } };",
            tools: [{ name: "peek", title: "Peek", description: "Returns ok.", inputSchema: { type: "object" } }],
          }),
        )) as {
          result: { isError: boolean; content: Array<{ text: string }>; structuredContent: { capsuleId: string } };
        };
        assert.equal(res.result.isError, false, `capsule_create failed: ${res.result.content[0]?.text}`);
        return res.result.structuredContent.capsuleId;
      };

      const keptId = await create("notes1");
      const spareId = await create("notes2");

      // Installing verified both, so this listing reports that verdict.
      const first = rowFor(await listRows(), keptId);
      assert.equal(first.trust, "ok");
      assert.ok(first.tools.includes("notes1__peek"), `capsule_list did not report notes1__peek: ${first.tools.join(", ")}`);

      // Now break the installed file underneath the running manager and delete the trust store it was
      // checked against. The description says a listing re-reads neither while the cached verdict
      // stands, and it does not: the same verdict, the same served tools, and nothing new warned
      // because nothing was verified.
      const keptFile = installedFileOf(keptId, home);
      const trustFile = join(home, "trust.json");
      const goodBytes = readFileSync(keptFile);
      const goodTrust = readFileSync(trustFile);
      writeFileSync(keptFile, Buffer.from("not a capsule"));
      rmSync(trustFile);
      const warnedBefore = warnings.length;
      const cached = rowFor(await listRows(), keptId);
      assert.deepEqual(
        { trust: cached.trust, tools: cached.tools },
        { trust: first.trust, tools: first.tools },
        "a listing must repeat the session's cached verdict instead of re-verifying the installed file",
      );
      assert.equal(
        warnings.length,
        warnedBefore,
        `no verification ran, so nothing can have warned: ${warnings.slice(warnedBefore).join(" | ")}`,
      );

      // The registry change the description names — an uninstall, of the other capsule at that — is what
      // clears the cache, so the very next listing verifies the broken bytes and reports them corrupt.
      const uninstalled = (await server.handleMessage(toolCall("capsule_uninstall", { capsuleId: spareId }))) as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      assert.equal(
        uninstalled.result.isError,
        false,
        `capsule_uninstall failed: ${uninstalled.result.content[0]?.text}`,
      );
      const reverified = rowFor(await listRows(), keptId);
      assert.equal(reverified.trust, "corrupt");
      assert.deepEqual(reverified.tools, [], "a corrupt capsule serves no tools, as the description says");
      assert.ok(
        warnings.some((line) => line.includes(`Failed to verify installed capsule ${keptId}`)),
        `the verification after the registry change must report why the file was refused: ${warnings.join(" | ")}`,
      );

      // The other half of the rule: that failure was not cached, so this listing re-reads the file
      // rather than repeating the verdict — it warns again for bytes that are still broken.
      const warnedAtCorrupt = warnings.length;
      assert.equal(rowFor(await listRows(), keptId).trust, "corrupt");
      assert.ok(
        warnings.slice(warnedAtCorrupt).some((line) => line.includes(`Failed to verify installed capsule ${keptId}`)),
        "a failed verdict is not cached, so the next listing must read the file and warn again",
      );

      // And because it is re-read, putting the bytes and the trust store back is enough on its own:
      // the next listing reports 'ok' and serves the tools again, with no registry change in between.
      writeFileSync(keptFile, goodBytes);
      writeFileSync(trustFile, goodTrust);
      const repaired = rowFor(await listRows(), keptId);
      assert.deepEqual(
        { trust: repaired.trust, tools: repaired.tools },
        { trust: first.trust, tools: first.tools },
        "a repaired file must verify and serve again on the next listing, with no registry change",
      );
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

describe("manager-seeded .mcpb bundles", () => {
  const FIXTURE = resolve(ROOT, "templates", "hello");

  async function packHello(home: string): Promise<string> {
    const dir = join(home, `src-${randomUUID()}`);
    cpSync(FIXTURE, dir, { recursive: true });
    const out = join(home, `hello-${randomUUID()}.capsule`);
    await packDirectory(dir, out, { homeDir: home });
    return out;
  }

  it("export-mcpb --manager builds a seeded bundle under the stable capsule-manager identity", async () => {
    await withHome(async (home) => {
      const capsulePath = await packHello(home);
      const outPath = join(home, "hello-seeded.mcpb");
      await exportMcpb(capsulePath, outPath, { manager: true });

      const entries = await extractZip(readFileSync(outPath));
      assert.deepEqual(
        [...entries.keys()].sort(),
        [
          "icon.png",
          "manifest.json",
          "package.json",
          "payload/hello-1.0.0.capsule",
          "server/cli.js",
          "server/emscripten-module.wasm",
        ],
      );

      // One extension identity for every seeded bundle: installing a second seeded capsule must
      // replace the manager extension, never stand up a second gateway over the same registry.
      const manifest = JSON.parse(entries.get("manifest.json")!.toString("utf8"));
      assert.equal(manifest.name, "capsule-manager");
      assert.equal(manifest.display_name, "Capsule Manager");
      assert.equal(manifest.version, HOST_VERSION);
      assert.deepEqual(manifest.author, { name: "Agent Capsule" });
      assert.ok(manifest.description.includes("'hello' capsule"));
      assert.deepEqual(manifest.server.mcp_config, {
        command: "node",
        args: [
          "${__dirname}/server/cli.js",
          "manager",
          "--seed",
          "${__dirname}/payload/hello-1.0.0.capsule",
        ],
        env: {},
      });

      // The payload rides byte-identically, so its signature verifies on the recipient's machine.
      assert.deepEqual(entries.get("payload/hello-1.0.0.capsule"), readFileSync(capsulePath));
    });
  });

  it("seed installs the bundled capsule once and never resurrects an uninstalled one", async () => {
    await withHome(async (home) => {
      const capsulePath = await packHello(home);
      const server = createManagerServer({ homeDir: home, warn: () => {} });

      await server.seed(capsulePath);
      const listRes = await server.handleMessage({ jsonrpc: "2.0", id: 900, method: "tools/list" });
      assert.ok(listRes && "result" in listRes);
      const names = (listRes.result as { tools: { name: string }[] }).tools.map((tool) => tool.name);
      assert.ok(names.includes("hello__greet"), "seeded capsule tools are served");
      assert.ok(names.includes("capsule_create"), "authoring tools are served beside the seed");
      assert.equal(Object.keys(loadSeededStore(home)).length, 1, "delivery is recorded");

      // Booting the same bundle again offers the same capsule: exactly one install results.
      await server.seed(capsulePath);
      const listAgain = await server.handleMessage(toolCall("capsule_list", {}));
      assert.ok(listAgain && "result" in listAgain);
      const rows = (listAgain.result as { structuredContent: { capsules: unknown[] } })
        .structuredContent.capsules;
      assert.equal(rows.length, 1);

      // The user's uninstall outranks every later boot of the bundle that delivered the capsule.
      const removal = await server.handleMessage(toolCall("capsule_uninstall", { name: "hello" }));
      assert.ok(removal && "result" in removal);
      const rebooted = createManagerServer({ homeDir: home, warn: () => {} });
      await rebooted.seed(capsulePath);
      const afterRes = await rebooted.handleMessage({ jsonrpc: "2.0", id: 901, method: "tools/list" });
      assert.ok(afterRes && "result" in afterRes);
      const after = (afterRes.result as { tools: { name: string }[] }).tools.map((tool) => tool.name);
      assert.equal(after.includes("hello__greet"), false, "an uninstalled seed stays uninstalled");
      assert.ok(after.includes("capsule_create"), "the manager itself still serves");
    });
  });
});
