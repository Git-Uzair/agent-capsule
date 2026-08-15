import { join } from "node:path";
import { CapsuleError } from "../core/errors.ts";
import { capsuleHome } from "./signing.ts";
import { readStore, writeStore } from "./store.ts";

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
  return {
    version: 1,
    capsules: readStore(file, {
      code: "E_TRUST",
      label: "trust store",
      entry: (value, name) => {
        if (!isTrustEntry(value)) {
          throw new CapsuleError("E_TRUST", `trust store entry is malformed: ${name}`, { file, name });
        }
        return {
          keyId: value.keyId,
          publicKey: value.publicKey,
          toolCatalogDigest: value.toolCatalogDigest,
          pinnedAt: value.pinnedAt,
        };
      },
    }),
  };
}

export function saveTrustStore(store: TrustStore, homeDir: string = capsuleHome()): void {
  writeStore(trustPath(homeDir), store);
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
