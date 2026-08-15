import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  type ClientType,
  defaultClientConfigPath,
  generateMcpServerConfig,
  injectConfig,
  runInject,
} from "../src/commands/inject.ts";
import {
  buildRegCommands,
  generateLinuxDesktopFile,
  generateLinuxMimeXml,
  generateMacPlist,
  runInstallHandler,
} from "../src/commands/install-handler.ts";
import { CapsuleError } from "../src/core/errors.ts";

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");

function withTempDir(fn: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = join(".tmp", `test-interop-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return Promise.resolve(fn(dir)).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

test("defaultClientConfigPath returns expected path for each client", () => {
  const claudePath = defaultClientConfigPath("claude");
  assert.ok(claudePath.endsWith("claude_desktop_config.json"));

  const cursorPath = defaultClientConfigPath("cursor");
  assert.ok(cursorPath.includes(".cursor"));
  assert.ok(cursorPath.endsWith("mcp.json"));

  const windsurfPath = defaultClientConfigPath("windsurf");
  assert.ok(windsurfPath.includes("windsurf"));
  assert.ok(windsurfPath.endsWith("mcp_config.json"));

  const genericPath = defaultClientConfigPath("generic");
  assert.ok(genericPath.endsWith("mcp.json"));

  assert.throws(
    () => defaultClientConfigPath("unknown" as ClientType),
    (e: unknown) => e instanceof CapsuleError && e.code === "E_USAGE",
  );
});

test("generateMcpServerConfig resolves absolute capsule path", () => {
  const relPath = "foo/bar/hello.capsule";
  const cfg = generateMcpServerConfig(relPath);
  assert.equal(cfg.command, "capsule");
  assert.deepEqual(cfg.args, ["mcp", resolve(relPath)]);
});

test("injectConfig merges into empty config", () => {
  const serverConfig = { command: "capsule", args: ["mcp", "C:\\test\\hello.capsule"] };
  const out = injectConfig("{}", "hello", serverConfig);
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed, {
    mcpServers: {
      hello: serverConfig,
    },
  });
});

test("injectConfig preserves existing unrelated servers and overwrites existing entry", () => {
  const initial = JSON.stringify(
    {
      mcpServers: {
        other_server: { command: "node", args: ["server.js"] },
        hello: { command: "old", args: [] },
      },
    },
    null,
    2,
  );
  const serverConfig = { command: "capsule", args: ["mcp", "C:\\test\\hello.capsule"] };
  const out = injectConfig(initial, "hello", serverConfig);
  const parsed = JSON.parse(out);

  assert.deepEqual(parsed.mcpServers.other_server, { command: "node", args: ["server.js"] });
  assert.deepEqual(parsed.mcpServers.hello, serverConfig);
});

test("injectConfig handles empty string as empty object", () => {
  const serverConfig = { command: "capsule", args: ["mcp", "C:\\test\\hello.capsule"] };
  const out = injectConfig("", "hello", serverConfig);
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed, {
    mcpServers: {
      hello: serverConfig,
    },
  });
});

test("injectConfig refuses config that is not a JSON object", () => {
  const serverConfig = { command: "capsule", args: ["mcp", "C:\\test\\hello.capsule"] };
  assert.throws(
    () => injectConfig("[]", "hello", serverConfig),
    (e: unknown) => e instanceof CapsuleError && e.code === "E_USAGE",
  );
  assert.throws(
    () => injectConfig('"not an object"', "hello", serverConfig),
    (e: unknown) => e instanceof CapsuleError && e.code === "E_USAGE",
  );
  assert.throws(
    () => injectConfig("123", "hello", serverConfig),
    (e: unknown) => e instanceof CapsuleError && e.code === "E_USAGE",
  );
});

test("runInject with --stdout writes merged json to stdout", async () => {
  await withTempDir(async (dir) => {
    const capsuleFile = join(dir, "my-tool.capsule");
    writeFileSync(capsuleFile, "dummy");

    const out = execFileSync(process.execPath, [CLI, "inject", capsuleFile, "--stdout"], {
      encoding: "utf8",
    });

    const parsed = JSON.parse(out);
    assert.deepEqual(parsed, {
      mcpServers: {
        "my-tool": {
          command: "capsule",
          args: ["mcp", resolve(capsuleFile)],
        },
      },
    });
  });
});

test("runInject atomic write and backup file creation", async () => {
  await withTempDir(async (dir) => {
    const capsuleFile = join(dir, "greet.capsule");
    writeFileSync(capsuleFile, "dummy");
    const configFile = join(dir, "config.json");
    const initialConfig = JSON.stringify({ mcpServers: { existing: { command: "cmd", args: [] } } });
    writeFileSync(configFile, initialConfig);

    const code = await runInject([capsuleFile, "--config", configFile, "--name", "my-greet"]);
    assert.equal(code, 0);

    const updated = JSON.parse(readFileSync(configFile, "utf8"));
    assert.deepEqual(updated.mcpServers.existing, { command: "cmd", args: [] });
    assert.deepEqual(updated.mcpServers["my-greet"], {
      command: "capsule",
      args: ["mcp", resolve(capsuleFile)],
    });

    const entries = readdirSync(dir);
    const backupFile = entries.find((f) => f.startsWith("config.json.bak-"));
    assert.ok(backupFile, "backup file should exist");
    assert.equal(readFileSync(join(dir, backupFile), "utf8"), initialConfig);
  });
});

test("runInject with --dry-run leaves file byte-identical", async () => {
  await withTempDir(async (dir) => {
    const capsuleFile = join(dir, "tool.capsule");
    writeFileSync(capsuleFile, "dummy");
    const configFile = join(dir, "config.json");
    const initialConfig = '{\n  "mcpServers": {}\n}\n';
    writeFileSync(configFile, initialConfig);

    const stdoutData = execFileSync(
      process.execPath,
      [CLI, "inject", capsuleFile, "--config", configFile, "--dry-run"],
      { encoding: "utf8" },
    );

    assert.equal(readFileSync(configFile, "utf8"), initialConfig);
    const parsedOut = JSON.parse(stdoutData);
    assert.ok(parsedOut.mcpServers.tool);
  });
});

test("runInject refuses config file over 1 MiB", async () => {
  await withTempDir(async (dir) => {
    const capsuleFile = join(dir, "tool.capsule");
    writeFileSync(capsuleFile, "dummy");
    const configFile = join(dir, "huge.json");
    const bigData = " ".repeat(1024 * 1024 + 10);
    writeFileSync(configFile, bigData);

    await assert.rejects(
      () => runInject([capsuleFile, "--config", configFile]),
      (e: unknown) => e instanceof CapsuleError && e.code === "E_USAGE",
    );
  });
});

test("buildRegCommands returns expected argv arrays for install and uninstall", () => {
  const installCmds = buildRegCommands({ nodePath: "C:\\Node\\node.exe", cliPath: "C:\\Capsule\\cli.ts" });
  assert.equal(installCmds.length, 4);
  assert.deepEqual(installCmds[0], [
    "add",
    "HKCU\\Software\\Classes\\.capsule",
    "/ve",
    "/d",
    "AgentCapsule.File",
    "/f",
  ]);
  assert.deepEqual(installCmds[1], [
    "add",
    "HKCU\\Software\\Classes\\AgentCapsule.File",
    "/ve",
    "/d",
    "Agent Capsule Package",
    "/f",
  ]);
  assert.deepEqual(installCmds[2], [
    "add",
    "HKCU\\Software\\Classes\\AgentCapsule.File",
    "/v",
    "FriendlyTypeName",
    "/d",
    "Agent Capsule Package",
    "/f",
  ]);
  assert.deepEqual(installCmds[3], [
    "add",
    "HKCU\\Software\\Classes\\AgentCapsule.File\\shell\\open\\command",
    "/ve",
    "/d",
    '"C:\\Node\\node.exe" "C:\\Capsule\\cli.ts" ui "%1"',
    "/f",
  ]);

  const uninstallCmds = buildRegCommands({ uninstall: true });
  assert.equal(uninstallCmds.length, 2);
  assert.deepEqual(uninstallCmds[0], ["delete", "HKCU\\Software\\Classes\\.capsule", "/f"]);
  assert.deepEqual(uninstallCmds[1], ["delete", "HKCU\\Software\\Classes\\AgentCapsule.File", "/f"]);
});

test("generateLinuxDesktopFile and generateLinuxMimeXml return valid configs", () => {
  const desktop = generateLinuxDesktopFile({ nodePath: "/usr/bin/node", cliPath: "/opt/capsule/cli.ts" });
  assert.ok(desktop.includes("Type=Application"));
  assert.ok(desktop.includes("Name=Agent Capsule"));
  assert.ok(desktop.includes("MimeType=application/x-capsule;"));
  assert.ok(desktop.includes('Exec="/usr/bin/node" "/opt/capsule/cli.ts" ui %f'));

  const xml = generateLinuxMimeXml();
  assert.ok(xml.includes('type="application/x-capsule"'));
  assert.ok(xml.includes('<glob pattern="*.capsule"/>'));
});

test("generateMacPlist returns valid plist xml", () => {
  const plist = generateMacPlist({ nodePath: "/usr/local/bin/node", cliPath: "/usr/local/bin/capsule" });
  assert.ok(plist.includes("<plist"));
  assert.ok(plist.includes("CFBundleDocumentTypes"));
  assert.ok(plist.includes("<string>capsule</string>"));
});

test("runInstallHandler supports --dry-run across platforms", () => {
  const stdoutData = execFileSync(process.execPath, [CLI, "install-handler", "--dry-run"], {
    encoding: "utf8",
  });
  assert.ok(stdoutData.length > 0);
});

test("cli runs inject and install-handler commands via child process", async () => {
  await withTempDir(async (dir) => {
    const capsuleFile = join(dir, "my.capsule");
    writeFileSync(capsuleFile, "dummy");

    const out = execFileSync(process.execPath, [CLI, "inject", capsuleFile, "--stdout"], {
      encoding: "utf8",
    });
    const parsed = JSON.parse(out);
    assert.ok(parsed.mcpServers.my);

    const dryHandlerOut = execFileSync(process.execPath, [CLI, "install-handler", "--dry-run"], {
      encoding: "utf8",
    });
    assert.ok(dryHandlerOut.length > 0);
  });
});
