import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CapsuleError } from "../core/errors.ts";
import { loadCapsule, type LoadedCapsule } from "../format/capsule.ts";
import { generateMcpServerConfig, type McpServerConfig } from "./inject.ts";

const USAGE = "usage: capsule share <file> [--json] [--accept-drift]";

function usage(message: string): never {
  throw new CapsuleError("E_USAGE", `${message} (${USAGE})`);
}

export type McpServerConfigItem = McpServerConfig;

export type SharePayload = {
  capsuleId: string;
  name: string;
  version: string;
  title?: string;
  description?: string;
  keyId: string;
  capabilities: Record<string, unknown>;
  file: string;
  mcpb_file?: string;
  npx_command: string;
  mcp_servers_config: Record<string, McpServerConfigItem>;
  cursor_deeplink: string;
  vscode_deeplink: string;
};

export function findMcpbFile(filePath: string, name: string, version: string): string | undefined {
  const absPath = resolve(filePath);
  const dir = dirname(absPath);
  const candidates = [
    join(dir, `${name}-${version}.mcpb`),
    join(dir, `${name}.mcpb`),
    absPath.replace(/\.capsule$/i, ".mcpb"),
    `${absPath}.mcpb`,
  ];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // candidate does not exist or stat failed
    }
  }
  return undefined;
}

export function buildSharePayload(capsule: LoadedCapsule, filePath: string): SharePayload {
  const absPath = resolve(filePath);
  const manifest = capsule.manifest;
  const name = manifest.meta.name;
  const version = manifest.meta.version;
  const mcpbFile = findMcpbFile(absPath, name, version);

  const serverConfig = generateMcpServerConfig(absPath, name, {
    npx: true,
    stateHome: true,
  });

  const encodedConfig = encodeURIComponent(JSON.stringify(serverConfig));
  const encodedName = encodeURIComponent(name);

  const payload: SharePayload = {
    capsuleId: capsule.capsuleId,
    name,
    version,
    ...(manifest.meta.title !== undefined ? { title: manifest.meta.title } : {}),
    ...(manifest.meta.description !== undefined ? { description: manifest.meta.description } : {}),
    keyId: capsule.keyId,
    capabilities: (manifest.capabilities ?? {}) as Record<string, unknown>,
    file: absPath,
    ...(mcpbFile !== undefined ? { mcpb_file: mcpbFile } : {}),
    npx_command: `npx -y agent-capsule mcp "${absPath}" --state-home`,
    mcp_servers_config: {
      [name]: serverConfig,
    },
    cursor_deeplink: `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodedName}&config=${encodedConfig}`,
    vscode_deeplink: `vscode:mcp/install?name=${encodedName}&config=${encodedConfig}`,
  };

  return payload;
}

export function formatHumanShare(payload: SharePayload): string {
  const lines: string[] = [];
  const titlePart = payload.title ? ` (${payload.title})` : "";
  lines.push(`Agent Capsule: ${payload.name}@${payload.version}${titlePart}`);
  lines.push(`Capsule ID:    ${payload.capsuleId}`);
  lines.push(`Publisher:     ${payload.keyId}`);
  lines.push("");

  lines.push("Claude Desktop (Recommended):");
  if (payload.mcpb_file) {
    lines.push(`  Double-click bundle: ${payload.mcpb_file}`);
  } else {
    lines.push(`  Export bundle: capsule export-mcpb "${payload.file}"`);
  }
  lines.push("");

  lines.push("Cursor:");
  lines.push(`  ${payload.cursor_deeplink}`);
  lines.push("");

  lines.push("VS Code:");
  lines.push(`  ${payload.vscode_deeplink}`);
  lines.push("");

  lines.push("Claude Code / Terminal:");
  lines.push(`  ${payload.npx_command}`);
  lines.push("");

  lines.push("Generic MCP Client (mcpServers configuration):");
  const configJson = JSON.stringify(payload.mcp_servers_config, null, 2);
  const indentedConfig = configJson
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
  lines.push(indentedConfig);
  lines.push("");

  return lines.join("\n");
}

export async function runShare(argv: string[]): Promise<number> {
  let file: string | undefined;
  let json = false;
  let acceptDrift = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--json") {
      json = true;
    } else if (arg === "--accept-drift") {
      acceptDrift = true;
    } else if (arg.startsWith("-")) {
      usage(`unknown option: ${arg}`);
    } else if (file === undefined) {
      file = arg;
    } else {
      usage(`unexpected argument: ${arg}`);
    }
  }

  if (file === undefined) {
    usage("share needs a capsule file");
  }

  let capsule: LoadedCapsule;
  try {
    capsule = await loadCapsule(file, { acceptDrift });
  } catch (err) {
    if (err instanceof CapsuleError) throw err;
    throw new CapsuleError("E_CONTAINER", err instanceof Error ? err.message : String(err), { file });
  }

  const payload = buildSharePayload(capsule, file);

  if (json) {
    process.stdout.write(JSON.stringify(payload) + "\n");
  } else {
    process.stdout.write(formatHumanShare(payload));
  }

  return 0;
}

export const shareCommand = runShare;
