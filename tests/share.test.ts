import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildSharePayload, formatHumanShare, runShare, type SharePayload } from "../src/commands/share.ts";
import { loadCapsule, packDirectory, type LoadedCapsule } from "../src/format/capsule.ts";

const ROOT = resolve(import.meta.dirname, "..");
const FIXTURE = resolve("templates", "hello");

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = resolve(".tmp", `share-home-${randomUUID()}`);
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

describe("capsule share", () => {
  it("generates complete sharing payload with deeplinks and mcpServers config", async () => {
    await withHome(async (home) => {
      const capsule = await packTestCapsule(home);
      const payload = buildSharePayload(capsule, capsule.file);

      assert.equal(payload.name, "hello");
      assert.equal(payload.version, "1.0.0");
      assert.equal(payload.title, "Hello Capsule");
      assert.equal(payload.description, "Reference capsule used by the agent-capsule test suite.");
      assert.equal(payload.capsuleId, capsule.capsuleId);
      assert.equal(payload.keyId, capsule.keyId);
      assert.deepEqual(payload.capabilities, capsule.manifest.capabilities);
      assert.equal(payload.file, resolve(capsule.file));

      // mcpb_file should be undefined when no .mcpb exists beside it
      assert.equal(payload.mcpb_file, undefined);

      // npx_command
      assert.equal(payload.npx_command, `npx -y agent-capsule mcp "${resolve(capsule.file)}" --state-home`);

      // mcp_servers_config is a client config as pasted: the mcpServers wrapper is part of it
      const serverConfig = {
        command: "npx",
        args: ["-y", "agent-capsule", "mcp", resolve(capsule.file), "--state-home"],
      };
      assert.deepEqual(payload.mcp_servers_config, { mcpServers: { hello: serverConfig } });

      // Cursor deeplink: decoded the way Cursor documents it — name in the query, config is
      // base64 of the server config JSON (https://cursor.com/docs/mcp/install-links).
      assert.ok(payload.cursor_deeplink.startsWith("cursor://anysphere.cursor-deeplink/mcp/install?"));
      const cursorUrl = new URL(payload.cursor_deeplink);
      assert.equal(cursorUrl.searchParams.get("name"), "hello");
      const cursorBase64 = cursorUrl.searchParams.get("config") ?? "";
      assert.deepEqual(JSON.parse(Buffer.from(cursorBase64, "base64").toString("utf8")), serverConfig);
      // The base64 sits in the URL percent-encoded, so `+` and `/` cannot be re-read as a space
      // or a path separator by a query parser.
      const rawCursorConfig = payload.cursor_deeplink.split("&config=")[1] ?? "";
      assert.ok(!/[+/]/.test(rawCursorConfig), `config param must be percent-encoded: ${rawCursorConfig}`);

      // VS Code deeplink: the whole query is URL-encoded JSON carrying the name inside
      // (https://code.visualstudio.com/api/extension-guides/ai/mcp#create-an-mcp-installation-url).
      assert.ok(payload.vscode_deeplink.startsWith("vscode:mcp/install?"));
      const vscodeQuery = payload.vscode_deeplink.split("?")[1] ?? "";
      assert.deepEqual(JSON.parse(decodeURIComponent(vscodeQuery)), { name: "hello", ...serverConfig });
    });
  });

  it("detects .mcpb file beside capsule when present and ignores directories", async () => {
    await withHome(async (home) => {
      const capsule = await packTestCapsule(home);
      // Directory with .mcpb extension should be ignored
      const dirMcpb = resolve(home, "hello-1.0.0.mcpb");
      mkdirSync(dirMcpb);

      const payloadWithoutFile = buildSharePayload(capsule, capsule.file);
      assert.equal(payloadWithoutFile.mcpb_file, undefined);

      rmSync(dirMcpb, { recursive: true, force: true });
      const mcpbPath = resolve(home, "hello-1.0.0.mcpb");
      writeFileSync(mcpbPath, "fake mcpb content");

      const payload = buildSharePayload(capsule, capsule.file);
      assert.equal(payload.mcpb_file, mcpbPath);

      const human = formatHumanShare(payload);
      assert.ok(human.includes(mcpbPath));
      assert.ok(human.includes("Claude Desktop (Recommended):"));
      assert.ok(human.includes("Cursor:"));
      assert.ok(human.includes("VS Code:"));
      assert.ok(human.includes("Claude Code / Terminal:"));
      assert.ok(human.includes("Generic MCP Client"));
      // The printed snippet is pasteable as-is, wrapper included
      assert.ok(human.includes(`"mcpServers"`));
    });
  });

  it("CLI outputs JSON when --json flag is passed", async () => {
    await withHome(async (home) => {
      const capsule = await packTestCapsule(home);

      const res = spawnSync(process.execPath, ["src/cli.ts", "share", capsule.file, "--json"], {
        cwd: ROOT,
        encoding: "utf8",
      });

      assert.equal(res.status, 0);
      const parsed = JSON.parse(res.stdout) as SharePayload;
      assert.equal(parsed.name, "hello");
      assert.equal(parsed.capsuleId, capsule.capsuleId);
      assert.equal(parsed.npx_command, `npx -y agent-capsule mcp "${resolve(capsule.file)}" --state-home`);
    });
  });

  it("CLI outputs human readable summary when --json is omitted", async () => {
    await withHome(async (home) => {
      const capsule = await packTestCapsule(home);

      const res = spawnSync(process.execPath, ["src/cli.ts", "share", capsule.file], {
        cwd: ROOT,
        encoding: "utf8",
      });

      assert.equal(res.status, 0);
      assert.ok(res.stdout.includes("Agent Capsule: hello@1.0.0 (Hello Capsule)"));
      assert.ok(res.stdout.includes("Capsule ID:"));
      assert.ok(res.stdout.includes("Publisher:"));
      assert.ok(res.stdout.includes("Claude Desktop (Recommended):"));
      assert.ok(res.stdout.includes("Cursor:"));
      assert.ok(res.stdout.includes("VS Code:"));
      assert.ok(res.stdout.includes("Claude Code / Terminal:"));
      assert.ok(res.stdout.includes("Generic MCP Client (mcpServers configuration):"));
    });
  });

  it("CLI rejects non-existent or tampered capsule files with E_CONTAINER / E_SIGNATURE", async () => {
    await withHome(async (home) => {
      const nonExistent = resolve(home, "does-not-exist.capsule");
      const res1 = spawnSync(process.execPath, ["src/cli.ts", "share", nonExistent], {
        cwd: ROOT,
        encoding: "utf8",
      });
      assert.notEqual(res1.status, 0);
      assert.ok(res1.stderr.includes("E_CONTAINER") || res1.stderr.includes("ENOENT"));

      const corruptFile = resolve(home, "corrupt.capsule");
      writeFileSync(corruptFile, "not a zip file");
      const res2 = spawnSync(process.execPath, ["src/cli.ts", "share", corruptFile], {
        cwd: ROOT,
        encoding: "utf8",
      });
      assert.notEqual(res2.status, 0);
      assert.ok(res2.stderr.includes("E_CONTAINER"));
    });
  });
});
