import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { CapsuleError } from "../core/errors.ts";
import { emptyDict } from "../security/store.ts";

export type ClientType = "claude" | "cursor" | "windsurf" | "generic";

export type McpServerConfig = {
  type: "stdio";
  command: string;
  args: string[];
};

const USAGE =
  "usage: capsule inject <file> [--client-config <path>] [--config <path>] [--client claude|cursor|windsurf|generic] [--stdout] [--name <serverName>] [--dry-run] [--yes]";

function usage(message: string): never {
  throw new CapsuleError("E_USAGE", `${message} (${USAGE})`);
}

export function defaultClientConfigPath(client: ClientType): string {
  const home = homedir();
  const platform = process.platform;

  switch (client) {
    case "claude": {
      if (platform === "win32") {
        const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
        return join(appData, "Claude", "claude_desktop_config.json");
      }
      if (platform === "darwin") {
        return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
      }
      return join(home, ".config", "Claude", "claude_desktop_config.json");
    }
    case "cursor": {
      return join(home, ".cursor", "mcp.json");
    }
    case "windsurf": {
      return join(home, ".codeium", "windsurf", "mcp_config.json");
    }
    case "generic": {
      return resolve("mcp.json");
    }
    default: {
      throw new CapsuleError("E_USAGE", `unknown client type: ${String(client)}`);
    }
  }
}

export function generateMcpServerConfig(
  capsulePath: string,
  _name?: string,
): McpServerConfig {
  return {
    type: "stdio",
    command: "agent-capsule",
    args: ["mcp", resolve(capsulePath)],
  };
}

export function injectConfig(
  configJson: string,
  serverName: string,
  serverConfig: { type?: string; command: string; args: string[] },
): string {
  const trimmed = configJson.trim();
  let parsed: Record<string, unknown>;

  if (trimmed === "") {
    parsed = emptyDict<unknown>();
  } else {
    try {
      parsed = JSON.parse(configJson);
    } catch (err) {
      throw new CapsuleError("E_USAGE", `invalid json config: ${(err as Error).message}`);
    }
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CapsuleError("E_USAGE", "client config must be a JSON object");
  }

  const servers = emptyDict<unknown>();
  if (parsed.mcpServers !== undefined) {
    if (typeof parsed.mcpServers !== "object" || parsed.mcpServers === null || Array.isArray(parsed.mcpServers)) {
      throw new CapsuleError("E_USAGE", "malformed config: mcpServers must be an object");
    }
    for (const [key, value] of Object.entries(parsed.mcpServers as Record<string, unknown>)) {
      servers[key] = value;
    }
  }

  servers[serverName] = serverConfig;

  const result = emptyDict<unknown>();
  for (const [key, value] of Object.entries(parsed)) {
    if (key !== "mcpServers") {
      result[key] = value;
    }
  }
  result.mcpServers = servers;

  return JSON.stringify(result, null, 2) + "\n";
}

export async function runInject(argv: string[]): Promise<number> {
  let file: string | undefined;
  let client: ClientType | undefined;
  let configPath: string | undefined;
  let serverName: string | undefined;
  let stdoutMode = false;
  let dryRun = false;
  let yes = false;

  const valueOf = (arg: string, next: string | undefined): string =>
    next === undefined ? usage(`${arg} needs a value`) : next;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--client") {
      const val = valueOf(arg, argv[++i]);
      if (val !== "claude" && val !== "cursor" && val !== "windsurf" && val !== "generic") {
        usage(`invalid client: ${val}`);
      }
      client = val as ClientType;
    } else if (arg === "--config" || arg === "--client-config") {
      configPath = valueOf(arg, argv[++i]);
    } else if (arg === "--name") {
      serverName = valueOf(arg, argv[++i]);
    } else if (arg === "--stdout") {
      stdoutMode = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--yes") {
      yes = true;
    } else if (arg.startsWith("-")) {
      usage(`unknown option: ${arg}`);
    } else if (file === undefined) {
      file = arg;
    } else {
      usage(`unexpected argument: ${arg}`);
    }
  }

  if (!file) {
    usage("missing capsule file");
  }

  if (!existsSync(file)) {
    throw new CapsuleError("E_USAGE", "capsule file does not exist");
  }
  const fileStat = await stat(file);
  if (fileStat.isDirectory()) {
    throw new CapsuleError("E_USAGE", "capsule path is a directory");
  }

  const derivedName = serverName || basename(file, ".capsule");
  const serverConfig = generateMcpServerConfig(file, derivedName);

  const targetConfigPath =
    configPath !== undefined
      ? configPath
      : defaultClientConfigPath(client ?? "claude");

  let existingJson = "{}";
  let fileExisted = false;

  if (existsSync(targetConfigPath)) {
    fileExisted = true;
    const st = await stat(targetConfigPath);
    if (st.isDirectory()) {
      throw new CapsuleError("E_USAGE", "config path is a directory");
    }
    if (st.size > 1024 * 1024) {
      throw new CapsuleError("E_USAGE", "config file exceeds 1 MiB limit");
    }
    existingJson = await readFile(targetConfigPath, "utf8");
  }

  const output = injectConfig(
    stdoutMode && !configPath && !client && !existsSync(targetConfigPath) ? "{}" : existingJson,
    derivedName,
    serverConfig,
  );

  if (stdoutMode || dryRun || !yes) {
    process.stdout.write(output);
    return 0;
  }

  if (fileExisted) {
    const backupPath = `${targetConfigPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await copyFile(targetConfigPath, backupPath);
  }

  await mkdir(dirname(targetConfigPath), { recursive: true });
  const tmpPath = `${targetConfigPath}.tmp.${Date.now()}`;
  await writeFile(tmpPath, output, "utf8");
  await rename(tmpPath, targetConfigPath);

  process.stderr.write(`injected "${derivedName}" into ${targetConfigPath}\n`);
  return 0;
}

export const injectCommand = runInject;
