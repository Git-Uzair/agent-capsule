import { createRequire } from "node:module";

export const MIN_NODE_VERSION = "22.13.0";

/** Formats the diagnostic line shown when node:sqlite is missing or on an unsupported Node version. */
export function formatSqliteVersionError(currentVersion: string = process.version): string {
  return `agent-capsule requires Node.js >=${MIN_NODE_VERSION} with node:sqlite support (current: ${currentVersion})`;
}

export type ProbeResult = { ok: true } | { ok: false; error: string };

/**
 * Checks whether the host environment provides working node:sqlite DatabaseSync support.
 * Accepts an optional loader to allow deterministic testing of missing/broken module states.
 */
export function probeSqliteSupport(
  loader?: () => unknown,
  nodeVersion: string = process.version,
): ProbeResult {
  try {
    const req = createRequire(import.meta.url);
    const sqlite = loader
      ? (loader() as { DatabaseSync?: unknown })
      : (req("node:sqlite") as { DatabaseSync?: unknown });
    if (typeof sqlite?.DatabaseSync !== "function") {
      return { ok: false, error: formatSqliteVersionError(nodeVersion) };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: formatSqliteVersionError(nodeVersion) };
  }
}
