import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { CapsuleError } from "../core/errors.ts";
import { emptyDict } from "../security/store.ts";

export type McpServerConfig = {
  type: "stdio";
  command: string;
  args: string[];
};

const USAGE =
  "usage: capsule inject <file> (--client-config <path> | --stdout) [--config <path>] [--name <serverName>] [--dry-run] [--yes]";

function usage(message: string): never {
  throw new CapsuleError("E_USAGE", `${message} (${USAGE})`);
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

/**
 * Where a Microsoft Store install of Claude Desktop would actually read the given config, or
 * `undefined` when the question does not arise. MSIX AppData virtualization gives the packaged app a
 * private overlay under `%LOCALAPPDATA%\Packages\<family>\LocalCache\Roaming`; once the app has
 * written `claude_desktop_config.json` there, the copy shadows the classic `%APPDATA%\Claude` path
 * for that app forever, and an edit to the classic file is applied into a void. Only the overlay
 * *file* counts: while it does not exist, reads still fall through to the classic path.
 */
export function claudeStoreConfigPath(
  configPath: string,
  env: { appData?: string; packagesDir?: string } = {
    appData: process.env.APPDATA,
    packagesDir:
      process.env.LOCALAPPDATA === undefined ? undefined : join(process.env.LOCALAPPDATA, "Packages"),
  },
): string | undefined {
  if (env.appData === undefined || env.packagesDir === undefined) return undefined;
  const classic = resolve(env.appData, "Claude", "claude_desktop_config.json");
  // Windows paths compare caselessly; on other platforms APPDATA is unset and this never runs.
  if (resolve(configPath).toLowerCase() !== classic.toLowerCase()) return undefined;
  if (!existsSync(env.packagesDir)) return undefined;
  for (const pkg of readdirSync(env.packagesDir)) {
    if (!pkg.startsWith("Claude_")) continue;
    const overlay = join(env.packagesDir, pkg, "LocalCache", "Roaming", "Claude", "claude_desktop_config.json");
    if (existsSync(overlay)) return overlay;
  }
  return undefined;
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
  let configPath: string | undefined;
  let serverName: string | undefined;
  let stdoutMode = false;
  let dryRun = false;
  let yes = false;

  const valueOf = (arg: string, next: string | undefined): string =>
    next === undefined ? usage(`${arg} needs a value`) : next;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--config" || arg === "--client-config") {
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

  if (configPath === undefined && !stdoutMode) {
    throw new CapsuleError("E_USAGE", "inject requires --client-config <path> or --stdout");
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

  let existingJson = "{}";
  let fileExisted = false;

  if (configPath !== undefined && existsSync(configPath)) {
    fileExisted = true;
    const st = await stat(configPath);
    if (st.isDirectory()) {
      throw new CapsuleError("E_USAGE", "config path is a directory");
    }
    if (st.size > 1024 * 1024) {
      throw new CapsuleError("E_USAGE", "config file exceeds 1 MiB limit");
    }
    existingJson = await readFile(configPath, "utf8");
  }

  const output = injectConfig(existingJson, derivedName, serverConfig);

  // Said whether or not anything is written: a target that a Store-sandboxed Claude Desktop will
  // never read deserves the same warning on a dry run as on the real one.
  const warnIfShadowed = (): void => {
    if (configPath === undefined) return;
    const overlay = claudeStoreConfigPath(configPath);
    if (overlay === undefined) return;
    process.stderr.write(
      `warning: Claude Desktop is installed from the Microsoft Store here and reads its own copy of this config at\n` +
        `  ${overlay}\n` +
        `Changes to ${configPath} will not be seen; re-run with --client-config "${overlay}".\n`,
    );
  };

  if (configPath === undefined || stdoutMode || dryRun || !yes) {
    process.stdout.write(output);
    // Printing the merged config is not writing it: without this line, a run that omitted `--yes`
    // reports success in every way a user would check except the file itself.
    if (configPath !== undefined && !stdoutMode) {
      process.stderr.write(
        dryRun
          ? `dry run: nothing written to ${configPath}\n`
          : `nothing written: re-run with --yes to update ${configPath}\n`,
      );
      warnIfShadowed();
    }
    return 0;
  }

  if (fileExisted) {
    const backupPath = `${configPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await copyFile(configPath, backupPath);
  }

  await mkdir(dirname(configPath), { recursive: true });
  const tmpPath = `${configPath}.tmp.${Date.now()}`;
  await writeFile(tmpPath, output, "utf8");
  await rename(tmpPath, configPath);

  process.stderr.write(`injected "${derivedName}" into ${configPath}\n`);
  warnIfShadowed();
  return 0;
}

export const injectCommand = runInject;
