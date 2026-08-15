import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CapsuleError } from "../core/errors.ts";
import { capsuleHome } from "./signing.ts";

export type TrustEntry = {
  keyId: string;
  publicKey: string;
  toolCatalogDigest: string;
  pinnedAt: string;
};

export type TrustStore = {
  version: 1;
  capsules: Record<string, TrustEntry>;
};

export type Observed = {
  keyId: string;
  publicKey: string;
  toolCatalogDigest: string;
};

const TRUST_FILE = "trust.json";

function trustPath(homeDir: string): string {
  return join(homeDir, TRUST_FILE);
}

function isTrustEntry(value: unknown): value is TrustEntry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e["keyId"] === "string" &&
    typeof e["publicKey"] === "string" &&
    typeof e["toolCatalogDigest"] === "string" &&
    typeof e["pinnedAt"] === "string"
  );
}

/**
 * A malformed store is an error, never an empty store: silently discarding pins would turn every
 * corrupted file into a free trust-on-first-use for whatever capsule the user runs next.
 */
export function loadTrustStore(homeDir: string = capsuleHome()): TrustStore {
  const file = trustPath(homeDir);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, capsules: {} };
    throw e;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new CapsuleError("E_TRUST", `trust store is not valid JSON: ${file}`, { cause: (e as Error).message });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CapsuleError("E_TRUST", `trust store is malformed: ${file}`);
  }

  const store = parsed as Record<string, unknown>;
  if (store["version"] !== 1) {
    throw new CapsuleError("E_TRUST", `unsupported trust store version in ${file}`, { version: store["version"] });
  }
  const capsules = store["capsules"];
  if (typeof capsules !== "object" || capsules === null || Array.isArray(capsules)) {
    throw new CapsuleError("E_TRUST", `trust store is malformed: ${file}`);
  }

  const entries: Record<string, TrustEntry> = {};
  for (const [name, entry] of Object.entries(capsules as Record<string, unknown>)) {
    if (!isTrustEntry(entry)) {
      throw new CapsuleError("E_TRUST", `trust store entry is malformed: ${name}`, { file, name });
    }
    entries[name] = {
      keyId: entry.keyId,
      publicKey: entry.publicKey,
      toolCatalogDigest: entry.toolCatalogDigest,
      pinnedAt: entry.pinnedAt,
    };
  }
  return { version: 1, capsules: entries };
}

export function saveTrustStore(store: TrustStore, homeDir: string = capsuleHome()): void {
  const file = trustPath(homeDir);
  const tmp = `${file}.tmp`;
  mkdirSync(homeDir, { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * Trust-on-first-use. `"pinned"` means there was nothing pinned yet and the caller should call
 * `pinTrust`; `"ok"` means the observed key and tool catalog both match what was pinned.
 */
export function checkTrust(
  entry: TrustEntry | undefined,
  observed: Observed & { name: string },
): "pinned" | "ok" {
  if (entry === undefined) return "pinned";

  if (entry.keyId !== observed.keyId) {
    throw new CapsuleError(
      "E_TRUST",
      `publisher key changed for ${observed.name}: expected ${entry.keyId}, got ${observed.keyId}`,
      { name: observed.name, expected: entry.keyId, actual: observed.keyId },
    );
  }
  if (entry.toolCatalogDigest !== observed.toolCatalogDigest) {
    throw new CapsuleError(
      "E_TRUST",
      `tool catalog changed for ${observed.name}: expected ${entry.toolCatalogDigest}, got ` +
        `${observed.toolCatalogDigest} (re-pin with --accept-drift if this change is expected)`,
      { name: observed.name, expected: entry.toolCatalogDigest, actual: observed.toolCatalogDigest },
    );
  }
  return "ok";
}

export function pinTrust(name: string, observed: Observed, homeDir: string = capsuleHome()): TrustEntry {
  const entry: TrustEntry = {
    keyId: observed.keyId,
    publicKey: observed.publicKey,
    toolCatalogDigest: observed.toolCatalogDigest,
    pinnedAt: new Date().toISOString(),
  };
  const store = loadTrustStore(homeDir);
  store.capsules[name] = entry;
  saveTrustStore(store, homeDir);
  return entry;
}
