import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CapsuleError } from "../core/errors.ts";
import { getDefaultIconPath, getDistRuntimePaths } from "../core/paths.ts";
import { loadCapsule } from "../format/capsule.ts";
import { packDeterministicZip, type ZipEntry } from "../format/container.ts";
import { sanitizeModelText } from "../security/text.ts";
import { HOST_VERSION } from "../version.ts";
import { MANAGER_DESCRIPTION } from "./build-manager-mcpb.ts";

export { getDefaultIconPath, getDistRuntimePaths };

const USAGE = "usage: capsule export-mcpb <file> [-o <out.mcpb>] [--manager]";

function usage(message: string): never {
  throw new CapsuleError("E_USAGE", `${message} (${USAGE})`);
}

export type McpbEntry = ZipEntry;

export async function packMcpb(entries: McpbEntry[]): Promise<Buffer> {
  return packDeterministicZip(entries, { compress: true });
}

export async function exportMcpb(
  capsulePath: string,
  outPath?: string,
  opts?: { distDir?: string; iconPath?: string; manager?: boolean },
): Promise<string> {
  if (outPath !== undefined && outPath.trim() === "") {
    throw new CapsuleError("E_USAGE", "-o needs a non-empty value");
  }
  if (!existsSync(capsulePath)) {
    throw new CapsuleError("E_USAGE", "capsule file does not exist", { path: capsulePath });
  }
  if (statSync(capsulePath).isDirectory()) {
    throw new CapsuleError("E_USAGE", "capsule path is a directory", { path: capsulePath });
  }

  // Load and cryptographically verify the capsule container, digests, and signature (trust=false avoids TOFU writes during packaging)
  const loaded = await loadCapsule(capsulePath, { trust: false });
  const manifest = loaded.manifest;

  const payloadFileName = `${manifest.meta.name}-${manifest.meta.version}.capsule`;

  const runtimePaths = getDistRuntimePaths(opts?.distDir);
  const iconPath = getDefaultIconPath(opts?.iconPath);

  const cliJsData = readFileSync(runtimePaths.cliJs);
  const wasmData = readFileSync(runtimePaths.wasm);
  const iconData = readFileSync(iconPath);
  const capsuleData = loaded.bytes;

  // Two bundle shapes from one payload. Standalone runs `mcp` — a dedicated server for exactly this
  // capsule, nothing else installed or installable. Manager mode runs `manager --seed` — the full
  // gateway with the capsule delivered into the recipient's library on first boot, so whoever
  // receives the app also receives the ability to author and share capsules of their own. A seeded
  // bundle deliberately keeps ONE extension identity (`capsule-manager`): clients derive the
  // extension id from `name`, so every seeded bundle replaces the same manager extension instead of
  // standing up a second gateway over the same registry — the platform is fungible, the library
  // accumulates, and the capsule's own identity lives in the payload and the description.
  const manifestJson = opts?.manager === true
    ? {
        manifest_version: "0.2",
        name: "capsule-manager",
        display_name: "Capsule Manager",
        version: HOST_VERSION,
        description:
          `${MANAGER_DESCRIPTION}\n\nThis bundle also delivers the '${sanitizeModelText(manifest.meta.name)}' capsule ` +
          `(v${manifest.meta.version}) into your library on first run.`,
        author: { name: "Agent Capsule" },
        icon: "icon.png",
        server: {
          type: "node",
          entry_point: "server/cli.js",
          mcp_config: {
            command: "node",
            args: [
              "${__dirname}/server/cli.js",
              "manager",
              "--seed",
              `\${__dirname}/payload/${payloadFileName}`,
            ],
            env: {},
          },
        },
      }
    : {
        manifest_version: "0.2",
        name: sanitizeModelText(manifest.meta.name),
        version: manifest.meta.version,
        description: sanitizeModelText(manifest.meta.description || manifest.meta.title || manifest.meta.name),
        author: manifest.meta.author?.name
          ? { name: sanitizeModelText(manifest.meta.author.name) }
          : { name: "Agent Capsule" },
        icon: "icon.png",
        server: {
          type: "node",
          entry_point: "server/cli.js",
          mcp_config: {
            command: "node",
            args: [
              "${__dirname}/server/cli.js",
              "mcp",
              `\${__dirname}/payload/${payloadFileName}`,
              "--state-home",
            ],
            env: {},
          },
        },
      };

  const packageJson = {
    type: "module",
    engines: {
      node: ">=22.13.0",
    },
  };

  const entries: McpbEntry[] = [
    {
      path: "manifest.json",
      data: Buffer.from(JSON.stringify(manifestJson, null, 2) + "\n", "utf8"),
    },
    {
      path: "server/cli.js",
      data: cliJsData,
    },
    {
      path: "server/emscripten-module.wasm",
      data: wasmData,
    },
    {
      path: `payload/${payloadFileName}`,
      data: capsuleData,
    },
    {
      path: "package.json",
      data: Buffer.from(JSON.stringify(packageJson, null, 2) + "\n", "utf8"),
    },
    {
      path: "icon.png",
      data: iconData,
    },
  ];

  const zipBytes = await packMcpb(entries);

  let targetOut = outPath;
  if (!targetOut) {
    targetOut = capsulePath.endsWith(".capsule")
      ? capsulePath.slice(0, -".capsule".length) + ".mcpb"
      : `${capsulePath}.mcpb`;
  }

  mkdirSync(dirname(resolve(targetOut)), { recursive: true });
  writeFileSync(targetOut, zipBytes);

  return targetOut;
}

export async function runExportMcpb(argv: string[]): Promise<number> {
  let file: string | undefined;
  let out: string | undefined;
  let manager = false;

  const valueOf = (arg: string, next: string | undefined): string => {
    if (next === undefined) {
      usage(`${arg} needs a value`);
    }
    if (next.trim() === "") {
      usage(`${arg} needs a non-empty value`);
    }
    return next;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "-o" || arg === "--out") {
      out = valueOf(arg, argv[++i]);
    } else if (arg === "--manager") {
      manager = true;
    } else if (arg.startsWith("-")) {
      usage(`unknown option: ${arg}`);
    } else if (file === undefined) {
      file = arg;
    } else {
      usage(`unexpected argument: ${arg}`);
    }
  }

  if (file === undefined) {
    usage("missing capsule file");
  }

  await exportMcpb(file, out, { manager });
  return 0;
}

export const exportMcpbCommand = runExportMcpb;
