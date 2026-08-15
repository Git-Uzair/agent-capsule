import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { generateMcpServerConfig, injectConfig, runInject } from "../src/commands/inject.ts";
import {
  buildRegCommands,
  generateLinuxDesktopFile,
  generateLinuxMimeXml,
  generateMacPlist,
  runInstallHandler,
} from "../src/commands/install-handler.ts";
import {
  MCP_SCHEMA_URL,
  PLUGIN_SCHEMA_URL,
  exportPlugin,
  runExportPlugin,
} from "../src/commands/export-plugin.ts";
import { packDirectory } from "../src/format/capsule.ts";
import { CapsuleError } from "../src/core/errors.ts";

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");
const FIXTURE = join(import.meta.dirname, "fixtures", "hello");

function withTempDir(fn: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = join(".tmp", `test-interop-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return Promise.resolve(fn(dir)).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

test("export-plugin creates plugin.json, mcp.json, and skills/<name>/SKILL.md with capability disclosure and tool table", async () => {
  await withTempDir(async (dir) => {
    const capsulePath = join(dir, "hello-1.0.0.capsule");
    await packDirectory(FIXTURE, capsulePath, { homeDir: dir });

    const pluginDir = join(dir, "exported-plugin");
    const code = await runExportPlugin([capsulePath, "-o", pluginDir]);
    assert.equal(code, 0);

    const pluginJsonPath = join(pluginDir, "plugin.json");
    assert.ok(existsSync(pluginJsonPath));
    assert.equal(PLUGIN_SCHEMA_URL, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
    const pluginJson = JSON.parse(readFileSync(pluginJsonPath, "utf8"));
    assert.deepEqual(pluginJson, {
      $schema: PLUGIN_SCHEMA_URL,
      name: "hello",
      description: "Reference capsule used by the agent-capsule test suite.",
      version: "1.0.0",
    });

    const mcpJsonPath = join(pluginDir, "mcp.json");
    assert.ok(existsSync(mcpJsonPath));
    assert.equal(MCP_SCHEMA_URL, "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
    const mcpJson = JSON.parse(readFileSync(mcpJsonPath, "utf8"));
    assert.deepEqual(mcpJson, {
      $schema: MCP_SCHEMA_URL,
      mcpServers: {
        hello: {
          type: "stdio",
          command: "agent-capsule",
          args: ["mcp", resolve(capsulePath)],
        },
      },
    });

    const skillPath = join(pluginDir, "skills", "hello", "SKILL.md");
    assert.ok(existsSync(skillPath));
    const skillContent = readFileSync(skillPath, "utf8");

    assert.ok(
      skillContent.startsWith(
        "---\nname: hello\ndescription: Reference capsule used by the agent-capsule test suite.\n---\n",
      ),
      `SKILL.md must start with YAML frontmatter, got: ${skillContent.slice(0, 120)}`,
    );
    assert.ok(skillContent.includes("Hello Capsule"));
    assert.ok(skillContent.includes("Reference capsule used by the agent-capsule test suite."));
    assert.ok(skillContent.includes("This capsule is sandboxed; its declared capabilities are"));
    assert.ok(skillContent.includes("greet"));
    assert.ok(skillContent.includes("name"));
  });
});

test("export-plugin throws E_USAGE on missing capsule file", async () => {
  await withTempDir(async (dir) => {
    const missingCapsule = join(dir, "missing.capsule");
    const pluginDir = join(dir, "exported-plugin");

    await assert.rejects(
      () => runExportPlugin([missingCapsule, "-o", pluginDir]),
      (e: unknown) => e instanceof CapsuleError && e.code === "E_USAGE",
    );
  });
});

test("runInject requires --client-config or --stdout and never infers a host path", async () => {
  await withTempDir(async (dir) => {
    const capsuleFile = join(dir, "tool.capsule");
    writeFileSync(capsuleFile, "dummy");

    await assert.rejects(
      () => runInject([capsuleFile]),
      (e: unknown) =>
        e instanceof CapsuleError &&
        e.code === "E_USAGE" &&
        e.message === "inject requires --client-config <path> or --stdout",
    );
  });
});

test("generateMcpServerConfig resolves absolute capsule path", () => {
  const relPath = "foo/bar/hello.capsule";
  const cfg = generateMcpServerConfig(relPath);
  assert.equal(cfg.type, "stdio");
  assert.equal(cfg.command, "agent-capsule");
  assert.deepEqual(cfg.args, ["mcp", resolve(relPath)]);
});

test("injectConfig merges into empty config", () => {
  const serverConfig = { type: "stdio", command: "agent-capsule", args: ["mcp", "C:\\test\\hello.capsule"] };
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
  const serverConfig = { type: "stdio", command: "agent-capsule", args: ["mcp", "C:\\test\\hello.capsule"] };
  const out = injectConfig(initial, "hello", serverConfig);
  const parsed = JSON.parse(out);

  assert.deepEqual(parsed.mcpServers.other_server, { command: "node", args: ["server.js"] });
  assert.deepEqual(parsed.mcpServers.hello, serverConfig);
});

test("injectConfig handles empty string as empty object", () => {
  const serverConfig = { type: "stdio", command: "agent-capsule", args: ["mcp", "C:\\test\\hello.capsule"] };
  const out = injectConfig("", "hello", serverConfig);
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed, {
    mcpServers: {
      hello: serverConfig,
    },
  });
});

test("injectConfig refuses config that is not a JSON object", () => {
  const serverConfig = { type: "stdio", command: "agent-capsule", args: ["mcp", "C:\\test\\hello.capsule"] };
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

test("injectConfig refuses non-object mcpServers", () => {
  const serverConfig = { type: "stdio", command: "agent-capsule", args: ["mcp", "C:\\test\\hello.capsule"] };
  assert.throws(
    () => injectConfig('{"mcpServers": "invalid"}', "hello", serverConfig),
    (e: unknown) => e instanceof CapsuleError && e.code === "E_USAGE",
  );
  assert.throws(
    () => injectConfig('{"mcpServers": [1, 2, 3]}', "hello", serverConfig),
    (e: unknown) => e instanceof CapsuleError && e.code === "E_USAGE",
  );
  assert.throws(
    () => injectConfig('{"mcpServers": null}', "hello", serverConfig),
    (e: unknown) => e instanceof CapsuleError && e.code === "E_USAGE",
  );
});

test("injectConfig handles __proto__ property without polluting Object.prototype", () => {
  const serverConfig = { type: "stdio", command: "agent-capsule", args: ["mcp", "C:\\test\\hello.capsule"] };
  const out = injectConfig('{"mcpServers":{"__proto__":{"command":"foo"}}}', "hello", serverConfig);
  const parsed = JSON.parse(out);
  assert.equal(parsed.mcpServers.hello.command, "agent-capsule");
  assert.equal(({} as Record<string, unknown>)["command"], undefined);
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
          type: "stdio",
          command: "agent-capsule",
          args: ["mcp", resolve(capsuleFile)],
        },
      },
    });
  });
});

test("runInject atomic write and backup file creation with --yes", async () => {
  await withTempDir(async (dir) => {
    const capsuleFile = join(dir, "greet.capsule");
    writeFileSync(capsuleFile, "dummy");
    const configFile = join(dir, "config.json");
    const initialConfig = JSON.stringify({ mcpServers: { existing: { command: "cmd", args: [] } } });
    writeFileSync(configFile, initialConfig);

    const code = await runInject([capsuleFile, "--client-config", configFile, "--name", "my-greet", "--yes"]);
    assert.equal(code, 0);

    const updated = JSON.parse(readFileSync(configFile, "utf8"));
    assert.deepEqual(updated.mcpServers.existing, { command: "cmd", args: [] });
    assert.deepEqual(updated.mcpServers["my-greet"], {
      type: "stdio",
      command: "agent-capsule",
      args: ["mcp", resolve(capsuleFile)],
    });

    const entries = readdirSync(dir);
    const backupFile = entries.find((f) => f.startsWith("config.json.bak-"));
    assert.ok(backupFile, "backup file should exist");
    assert.equal(readFileSync(join(dir, backupFile), "utf8"), initialConfig);
  });
});

test("runInject without --yes leaves file byte-identical", async () => {
  await withTempDir(async (dir) => {
    const capsuleFile = join(dir, "tool.capsule");
    writeFileSync(capsuleFile, "dummy");
    const configFile = join(dir, "config.json");
    const initialConfig = '{\n  "mcpServers": {}\n}\n';
    writeFileSync(configFile, initialConfig);

    const stdoutData = execFileSync(
      process.execPath,
      [CLI, "inject", capsuleFile, "--client-config", configFile],
      { encoding: "utf8" },
    );

    assert.equal(readFileSync(configFile, "utf8"), initialConfig);
    const parsedOut = JSON.parse(stdoutData);
    assert.ok(parsedOut.mcpServers.tool);
  });
});

test("runInject with missing capsule file throws E_USAGE", async () => {
  await withTempDir(async (dir) => {
    const missingCapsule = join(dir, "missing.capsule");
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, "{}");

    await assert.rejects(
      () => runInject([missingCapsule, "--client-config", configFile, "--yes"]),
      (e: unknown) => e instanceof CapsuleError && e.code === "E_USAGE",
    );
  });
});

test("runInject with directory config path throws E_USAGE", async () => {
  await withTempDir(async (dir) => {
    const capsuleFile = join(dir, "tool.capsule");
    writeFileSync(capsuleFile, "dummy");

    await assert.rejects(
      () => runInject([capsuleFile, "--client-config", dir, "--yes"]),
      (e: unknown) => e instanceof CapsuleError && e.code === "E_USAGE",
    );
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
      () => runInject([capsuleFile, "--config", configFile, "--yes"]),
      (e: unknown) => e instanceof CapsuleError && e.code === "E_USAGE",
    );
  });
});

test("buildRegCommands returns expected argv arrays for install and uninstall", () => {
  const installCmds = buildRegCommands({ nodePath: "C:\\Node\\node.exe", cliPath: "C:\\Capsule\\cli.ts" });
  assert.equal(installCmds.length, 3);
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
    "/v",
    "FriendlyTypeName",
    "/d",
    "Agent Capsule",
    "/f",
  ]);
  assert.deepEqual(installCmds[2], [
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

test("runInstallHandler without --yes leaves registry untouched and prints commands", async () => {
  const code = await runInstallHandler([]);
  assert.equal(code, process.platform === "win32" ? 0 : 2);
});

test("cli runs export-plugin, inject, and install-handler commands via child process", async () => {
  await withTempDir(async (dir) => {
    const capsulePath = join(dir, "my.capsule");
    await packDirectory(FIXTURE, capsulePath, { homeDir: dir });

    const pluginDir = join(dir, "plug");
    const exportOut = execFileSync(process.execPath, [CLI, "export-plugin", capsulePath, "-o", pluginDir], {
      encoding: "utf8",
    });
    assert.ok(existsSync(join(pluginDir, "plugin.json")));

    const out = execFileSync(process.execPath, [CLI, "inject", capsulePath, "--stdout"], {
      encoding: "utf8",
    });
    const parsed = JSON.parse(out);
    assert.ok(parsed.mcpServers.my);

    const dryHandlerOut = execFileSync(process.execPath, [CLI, "install-handler"], {
      encoding: "utf8",
    });
    assert.ok(dryHandlerOut.length > 0 || process.platform !== "win32");
  });
});
