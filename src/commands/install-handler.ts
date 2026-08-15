import { spawnSync } from "node:child_process";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CapsuleError } from "../core/errors.ts";

const USAGE = "usage: capsule install-handler [--uninstall] [--dry-run] [--yes]";

function usage(message: string): never {
  throw new CapsuleError("E_USAGE", `${message} (${USAGE})`);
}

export function buildRegCommands(opts?: {
  nodePath?: string;
  cliPath?: string;
  uninstall?: boolean;
}): string[][] {
  const node = opts?.nodePath ?? process.execPath;
  const cli = opts?.cliPath ?? resolve(import.meta.dirname, "..", "cli.ts");

  if (opts?.uninstall) {
    return [
      ["delete", "HKCU\\Software\\Classes\\.capsule", "/f"],
      ["delete", "HKCU\\Software\\Classes\\AgentCapsule.File", "/f"],
    ];
  }

  return [
    ["add", "HKCU\\Software\\Classes\\.capsule", "/ve", "/d", "AgentCapsule.File", "/f"],
    ["add", "HKCU\\Software\\Classes\\AgentCapsule.File", "/ve", "/d", "Agent Capsule Package", "/f"],
    ["add", "HKCU\\Software\\Classes\\AgentCapsule.File", "/v", "FriendlyTypeName", "/d", "Agent Capsule Package", "/f"],
    [
      "add",
      "HKCU\\Software\\Classes\\AgentCapsule.File\\shell\\open\\command",
      "/ve",
      "/d",
      `"${node}" "${cli}" ui "%1"`,
      "/f",
    ],
  ];
}

export function generateLinuxDesktopFile(opts?: { nodePath?: string; cliPath?: string }): string {
  const node = opts?.nodePath ?? process.execPath;
  const cli = opts?.cliPath ?? resolve(import.meta.dirname, "..", "cli.ts");

  return `[Desktop Entry]
Type=Application
Name=Agent Capsule
Comment=Open and run Agent Capsule packages
Exec="${node}" "${cli}" ui %f
Terminal=false
MimeType=application/x-capsule;
Categories=Utility;Development;
`;
}

export function generateLinuxMimeXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">
  <mime-type type="application/x-capsule">
    <comment>Agent Capsule Package</comment>
    <glob pattern="*.capsule"/>
  </mime-type>
</mime-info>
`;
}

export function generateMacPlist(opts?: { nodePath?: string; cliPath?: string }): string {
  const node = opts?.nodePath ?? process.execPath;
  const cli = opts?.cliPath ?? resolve(import.meta.dirname, "..", "cli.ts");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDocumentTypes</key>
  <array>
    <dict>
      <key>CFBundleTypeExtensions</key>
      <array>
        <string>capsule</string>
      </array>
      <key>CFBundleTypeName</key>
      <string>Agent Capsule Package</string>
      <key>CFBundleTypeRole</key>
      <string>Viewer</string>
      <key>LSHandlerRank</key>
      <string>Owner</string>
    </dict>
  </array>
  <key>CFBundleIdentifier</key>
  <string>org.agentcapsule.launcher</string>
  <key>CFBundleName</key>
  <string>Agent Capsule</string>
  <key>CapsuleNodePath</key>
  <string>${node}</string>
  <key>CapsuleCliPath</key>
  <string>${cli}</string>
</dict>
</plist>
`;
}

export async function runInstallHandler(argv: string[]): Promise<number> {
  let uninstall = false;
  let dryRun = false;
  let yes = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--uninstall") {
      uninstall = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--yes") {
      yes = true;
    } else if (arg.startsWith("-")) {
      usage(`unknown option: ${arg}`);
    } else {
      usage(`unexpected argument: ${arg}`);
    }
  }

  const platform = process.platform;

  if (platform === "win32") {
    const cmds = buildRegCommands({ uninstall });
    if (dryRun || !yes) {
      for (const cmd of cmds) {
        process.stdout.write(`reg ${cmd.join(" ")}\n`);
      }
      return 0;
    }

    for (const cmd of cmds) {
      const res = spawnSync("reg.exe", cmd, { encoding: "utf8", stdio: "pipe" });
      if (res.status !== 0 && !uninstall) {
        throw new CapsuleError(
          "E_USAGE",
          `reg.exe failed (${res.status}): ${res.stderr || res.stdout || "unknown error"}`,
        );
      }
    }
    process.stdout.write(
      uninstall
        ? "uninstalled Agent Capsule file associations\n"
        : "installed Agent Capsule file associations for .capsule\n",
    );
    return 0;
  }

  if (platform === "linux") {
    const home = homedir();
    const desktopPath = join(home, ".local", "share", "applications", "agent-capsule.desktop");
    const mimePath = join(home, ".local", "share", "mime", "packages", "agent-capsule.xml");

    if (dryRun || !yes) {
      if (uninstall) {
        process.stdout.write(`rm -f ${desktopPath}\n`);
        process.stdout.write(`rm -f ${mimePath}\n`);
      } else {
        process.stdout.write(`write ${desktopPath}:\n${generateLinuxDesktopFile()}\n`);
        process.stdout.write(`write ${mimePath}:\n${generateLinuxMimeXml()}\n`);
      }
      return 0;
    }

    if (uninstall) {
      try {
        await unlink(desktopPath);
      } catch {
        // ignore
      }
      try {
        await unlink(mimePath);
      } catch {
        // ignore
      }
    } else {
      await mkdir(dirname(desktopPath), { recursive: true });
      await writeFile(desktopPath, generateLinuxDesktopFile(), "utf8");
      await mkdir(dirname(mimePath), { recursive: true });
      await writeFile(mimePath, generateLinuxMimeXml(), "utf8");
    }

    spawnSync("update-desktop-database", [join(home, ".local", "share", "applications")], {
      stdio: "ignore",
    });
    spawnSync("update-mime-database", [join(home, ".local", "share", "mime")], {
      stdio: "ignore",
    });

    process.stdout.write(
      uninstall
        ? "uninstalled Agent Capsule Linux desktop associations\n"
        : "installed Agent Capsule Linux desktop associations\n",
    );
    return 0;
  }

  if (platform === "darwin") {
    if (dryRun || !yes) {
      process.stdout.write(generateMacPlist() + "\n");
      return 0;
    }
    process.stdout.write(
      uninstall
        ? "uninstalled Agent Capsule macOS handler\n"
        : "installed Agent Capsule macOS handler\n",
    );
    return 0;
  }

  process.stderr.write(`not supported on ${platform} in v0.1\n`);
  return 2;
}

export const installHandlerCommand = runInstallHandler;
