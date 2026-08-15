import { existsSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CapsuleError } from "../core/errors.ts";
import { loadCapsule } from "../format/capsule.ts";
import type { Manifest } from "../format/manifest.ts";

const USAGE = "usage: capsule export-plugin <file> -o <dir>";

/** Canonical Agent Plugins 1.0.0 manifest schema identifier (spec §5.2). */
export const PLUGIN_SCHEMA_URL = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
/** Canonical Agent Plugins 1.0.0 MCP configuration schema identifier (spec §7.2.1). */
export const MCP_SCHEMA_URL = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

function usage(message: string): never {
  throw new CapsuleError("E_USAGE", `${message} (${USAGE})`);
}

/** Plain YAML scalar when unambiguous, otherwise a double-quoted (JSON) scalar. */
function yamlScalar(value: string): string {
  return /^[A-Za-z0-9][^\n:#]*$/.test(value) ? value : JSON.stringify(value);
}

export function generateSkillMarkdown(manifest: Manifest): string {
  const meta = manifest.meta;
  const caps = manifest.capabilities;

  let netDesc = "none";
  if (caps.net.allowed_hosts.length > 0) {
    netDesc = `allowed hosts: ${caps.net.allowed_hosts.join(", ")}`;
    if (caps.net.allow_localhost) {
      netDesc += " (plus localhost)";
    }
  } else if (caps.net.allow_localhost) {
    netDesc = "localhost only";
  }

  const toolRows = manifest.tools.map((tool) => {
    const props = tool.inputSchema?.properties as Record<string, Record<string, unknown>> | undefined;
    const required = Array.isArray(tool.inputSchema?.required) ? (tool.inputSchema.required as string[]) : [];
    let argsSummary = "none";
    if (props && Object.keys(props).length > 0) {
      argsSummary = Object.entries(props)
        .map(([key, schema]) => {
          const type = schema.type ? String(schema.type) : "any";
          const isReq = required.includes(key) ? "required" : "optional";
          const desc = schema.description ? `: ${schema.description}` : "";
          return `\`${key}\` (${type}, ${isReq}${desc})`;
        })
        .join("<br/>");
    }
    return `| \`${tool.name}\` | ${tool.description} | ${argsSummary} |`;
  });

  const toolTable =
    toolRows.length > 0
      ? `| Tool | Description | Arguments |\n| --- | --- | --- |\n${toolRows.join("\n")}`
      : "No tools declared.";

  return `---
name: ${meta.name}
description: ${yamlScalar(meta.description)}
---

# ${meta.title || meta.name}

${meta.description}

## Sandboxing & Capabilities

This capsule is sandboxed; its declared capabilities are:
- **Network**: ${netDesc}
- **SQLite**: ${caps.sql ? "enabled" : "disabled"}
- **Key-Value Store**: ${caps.kv ? "enabled" : "disabled"}
- **Pack**: ${caps.pack ? "enabled" : "disabled"}

## Tools

${toolTable}
`;
}

export async function exportPlugin(capsulePath: string, outDir: string): Promise<void> {
  if (!existsSync(capsulePath)) {
    throw new CapsuleError("E_USAGE", "capsule file does not exist");
  }
  if (statSync(capsulePath).isDirectory()) {
    throw new CapsuleError("E_USAGE", "capsule path is a directory");
  }

  const loaded = await loadCapsule(capsulePath, { trust: false });
  const manifest = loaded.manifest;
  const name = manifest.meta.name;
  const absCapsulePath = resolve(capsulePath);

  const pluginJson = {
    $schema: PLUGIN_SCHEMA_URL,
    name: manifest.meta.name,
    description: manifest.meta.description,
    version: manifest.meta.version,
  };

  const mcpJson = {
    $schema: MCP_SCHEMA_URL,
    mcpServers: {
      [name]: {
        type: "stdio",
        command: "agent-capsule",
        args: ["mcp", absCapsulePath],
      },
    },
  };

  const skillMd = generateSkillMarkdown(manifest);

  const skillDir = join(outDir, "skills", name);
  await mkdir(skillDir, { recursive: true });

  await writeFile(join(outDir, "plugin.json"), JSON.stringify(pluginJson, null, 2) + "\n", "utf8");
  await writeFile(join(outDir, "mcp.json"), JSON.stringify(mcpJson, null, 2) + "\n", "utf8");
  await writeFile(join(skillDir, "SKILL.md"), skillMd, "utf8");
}

export async function runExportPlugin(argv: string[]): Promise<number> {
  let file: string | undefined;
  let outDir: string | undefined;

  const valueOf = (arg: string, next: string | undefined): string =>
    next === undefined ? usage(`${arg} needs a value`) : next;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "-o" || arg === "--out") {
      outDir = valueOf(arg, argv[++i]);
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
  if (!outDir) {
    usage("missing output directory (-o <dir>)");
  }

  await exportPlugin(file, outDir);
  return 0;
}

export const exportPluginCommand = runExportPlugin;
