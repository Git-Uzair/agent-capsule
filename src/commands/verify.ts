import { CapsuleError } from "../core/errors.ts";
import { loadCapsule, type LoadedCapsule } from "../format/capsule.ts";
import { scanTextTree } from "../security/text.ts";

const USAGE = "usage: capsule verify <file> [--json] [--allow-suspicious] [--accept-drift]";

export type VerifyFinding = {
  severity: "error" | "warn";
  code: string;
  message: string;
};

export type VerifyReport = {
  ok: boolean;
  file: string;
  capsuleId: string;
  keyId: string;
  name: string;
  version: string;
  trust: "pinned" | "ok" | "drift-accepted";
  capabilities: {
    sql: boolean;
    kv: boolean;
    pack: boolean;
    net: { allowed_hosts: string[]; allow_localhost: boolean };
  };
  tools: { name: string; effects: string[]; markers: string[] }[];
  findings: VerifyFinding[];
};

export async function verifyCapsule(
  file: string,
  opts?: { allowSuspicious?: boolean; acceptDrift?: boolean; homeDir?: string },
): Promise<VerifyReport> {
  let loaded: LoadedCapsule;
  try {
    loaded = await loadCapsule(file, {
      trust: true,
      acceptDrift: opts?.acceptDrift,
      homeDir: opts?.homeDir,
    });
  } catch (err) {
    const code = err instanceof CapsuleError ? err.code : "E_CONTAINER";
    const message = (err as Error).message || String(err);
    return {
      ok: false,
      file,
      capsuleId: "",
      keyId: "",
      name: "",
      version: "",
      trust: "ok",
      capabilities: {
        sql: false,
        kv: false,
        pack: false,
        net: { allowed_hosts: [], allow_localhost: false },
      },
      tools: [],
      findings: [{ severity: "error", code, message }],
    };
  }

  let ok = true;
  const findings: VerifyFinding[] = [];
  const tools: { name: string; effects: string[]; markers: string[] }[] = [];

  for (const tool of loaded.manifest.tools) {
    // The same screen `capsule mcp` applies to the tool catalog, over the same text.
    const markers = scanTextTree([tool.title, tool.description, tool.inputSchema, tool.outputSchema]);
    tools.push({
      name: tool.name,
      effects: [...tool.effects],
      markers,
    });

    if (markers.length > 0) {
      findings.push({
        severity: "warn",
        code: "suspicious_text",
        message: `suspicious text in tool '${tool.name}': ${markers.join(", ")}`,
      });
      if (!opts?.allowSuspicious) {
        ok = false;
      }
    }
  }

  return {
    ok,
    file: loaded.file,
    capsuleId: loaded.capsuleId,
    keyId: loaded.keyId,
    name: loaded.manifest.meta.name,
    version: loaded.manifest.meta.version,
    trust: loaded.trust,
    capabilities: {
      sql: loaded.manifest.capabilities.sql,
      kv: loaded.manifest.capabilities.kv,
      pack: loaded.manifest.capabilities.pack,
      net: {
        allowed_hosts: [...loaded.manifest.capabilities.net.allowed_hosts],
        allow_localhost: loaded.manifest.capabilities.net.allow_localhost,
      },
    },
    tools,
    findings,
  };
}

function formatHumanReport(report: VerifyReport): void {
  const lines: string[] = [];
  if (report.name !== "") {
    lines.push(`capsule:      ${report.name}@${report.version} (${report.file})`);
    lines.push(`id:           ${report.capsuleId}`);
    lines.push(`key:          ${report.keyId}`);
    lines.push(`trust:        ${report.trust}`);
    const caps = report.capabilities;
    const netDesc = `net=[${caps.net.allowed_hosts.join(", ")}] (localhost=${caps.net.allow_localhost})`;
    lines.push(`capabilities: sql=${caps.sql}, kv=${caps.kv}, pack=${caps.pack}, ${netDesc}`);
    if (report.tools.length > 0) {
      lines.push("tools:");
      for (const t of report.tools) {
        const effects = t.effects.length > 0 ? t.effects.join(", ") : "none";
        const markers = t.markers.length > 0 ? ` [markers: ${t.markers.join(", ")}]` : "";
        lines.push(`  - ${t.name} (${effects})${markers}`);
      }
    }
  } else {
    lines.push(`file:         ${report.file}`);
  }

  if (report.findings.length > 0) {
    lines.push("findings:");
    for (const f of report.findings) {
      lines.push(`  - [${f.severity.toUpperCase()}] ${f.code}: ${f.message}`);
    }
  }

  if (report.ok) {
    lines.push("OK");
  } else {
    const errors = report.findings.filter((f) => f.severity === "error").length;
    const warnings = report.findings.filter((f) => f.severity === "warn").length;
    lines.push(`FAILED (${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"})`);
  }

  process.stdout.write(lines.join("\n") + "\n");
}

export async function runVerify(argv: string[]): Promise<number> {
  let file: string | undefined;
  let json = false;
  let allowSuspicious = false;
  let acceptDrift = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--json") {
      json = true;
    } else if (arg === "--allow-suspicious") {
      allowSuspicious = true;
    } else if (arg === "--accept-drift") {
      acceptDrift = true;
    } else if (arg.startsWith("-")) {
      throw new CapsuleError("E_USAGE", `unknown option: ${arg} (${USAGE})`);
    } else if (file === undefined) {
      file = arg;
    } else {
      throw new CapsuleError("E_USAGE", `unexpected argument: ${arg} (${USAGE})`);
    }
  }
  if (file === undefined) {
    throw new CapsuleError("E_USAGE", `verify needs a capsule file (${USAGE})`);
  }

  const report = await verifyCapsule(file, { allowSuspicious, acceptDrift });

  if (json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    formatHumanReport(report);
  }

  return report.ok ? 0 : 1;
}

export const verifyCommand = runVerify;
