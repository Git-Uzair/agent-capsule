import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CapsuleError } from "../core/errors.ts";
import { getDefaultIconPath, getDistRuntimePaths } from "../core/paths.ts";
import { packDeterministicZip, type ZipEntry } from "../format/container.ts";
import { HOST_VERSION } from "../version.ts";

const USAGE = "usage: capsule build-manager-mcpb [-o <out.mcpb>]";

function usage(message: string): never {
  throw new CapsuleError("E_USAGE", `${message} (${USAGE})`);
}

export const MANAGER_DESCRIPTION =
  "Agent Capsule Manager — Gateway MCP server for running, creating, and managing secure Agent Capsules.\n\n" +
  "• Install Capsules: Use capsule_install to install .capsule files from a file path ({ path: \"...\" }) " +
  "or scan the Downloads folder ({ from_downloads: true }). Once installed, all tools from the capsule are " +
  "instantly available in this server under <capsuleName>__<toolName> without restarting.\n\n" +
  "• Author Capsules: Create new capsules on the fly with capsule_create. Provide JavaScript guest source " +
  "defining globalThis.tools, input schemas, effects, and declared capabilities (KV store, SQLite, network hosts). " +
  "The manager runs automated conformance tests, signs the capsule with your local key, installs it into the gateway, " +
  "and saves a double-clickable .mcpb sharing bundle to the user's Downloads folder.\n\n" +
  "• Test & Iterate: Test capsule tools in a secure sandbox using capsule_test_tool before telling the user it is ready. " +
  "Update existing capsules with capsule_update.\n\n" +
  "• Manage: List installed capsules, publisher keys, trust state, and exposed tools with capsule_list. " +
  "Uninstall capsules with capsule_uninstall.";

export async function buildManagerMcpb(
  outPath?: string,
  opts?: { distDir?: string; iconPath?: string },
): Promise<string> {
  if (outPath !== undefined && outPath.trim() === "") {
    throw new CapsuleError("E_USAGE", "-o needs a non-empty value");
  }
  const runtimePaths = getDistRuntimePaths(opts?.distDir);
  const iconPath = getDefaultIconPath(opts?.iconPath);

  const cliJsData = readFileSync(runtimePaths.cliJs);
  const wasmData = readFileSync(runtimePaths.wasm);
  const iconData = readFileSync(iconPath);

  const manifestJson = {
    manifest_version: "0.2",
    name: "capsule-manager",
    display_name: "Capsule Manager",
    version: HOST_VERSION,
    description: MANAGER_DESCRIPTION,
    author: { name: "Agent Capsule" },
    icon: "icon.png",
    server: {
      type: "node",
      entry_point: "server/cli.js",
      mcp_config: {
        command: "node",
        args: ["${__dirname}/server/cli.js", "manager"],
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

  const entries: ZipEntry[] = [
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
      path: "package.json",
      data: Buffer.from(JSON.stringify(packageJson, null, 2) + "\n", "utf8"),
    },
    {
      path: "icon.png",
      data: iconData,
    },
  ];

  const zipBytes = await packDeterministicZip(entries, { compress: true });

  const targetOut = outPath ?? "capsule-manager.mcpb";
  mkdirSync(dirname(resolve(targetOut)), { recursive: true });
  writeFileSync(targetOut, zipBytes);

  return targetOut;
}

export async function runBuildManagerMcpb(argv: string[]): Promise<number> {
  let out: string | undefined;

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
    } else if (arg.startsWith("-")) {
      usage(`unknown option: ${arg}`);
    } else {
      usage(`unexpected argument: ${arg}`);
    }
  }

  await buildManagerMcpb(out);
  return 0;
}

export const buildManagerMcpbCommand = runBuildManagerMcpb;
