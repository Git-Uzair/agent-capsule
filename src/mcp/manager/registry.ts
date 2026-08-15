import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { CapsuleError } from "../../core/errors.ts";
import { capsuleHome } from "../../security/signing.ts";
import { emptyDict, readStore, writeStore } from "../../security/store.ts";

export type InstalledEntry = {
  name: string;
  version: string;
  file: string;
  installedAt: string;
};

export type InstalledStore = {
  version: 1;
  capsules: Record<string, InstalledEntry>;
};

const INSTALLED_FILE = "installed.json";

export function installedPath(homeDir: string = capsuleHome()): string {
  return join(homeDir, INSTALLED_FILE);
}

export function installedCapsulesDir(homeDir: string = capsuleHome()): string {
  return join(homeDir, "capsules");
}

export function installedCapsulePath(capsuleId: string, homeDir: string = capsuleHome()): string {
  const safeId = capsuleId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(installedCapsulesDir(homeDir), `${safeId}.capsule`);
}

function isInstalledEntry(value: unknown): value is InstalledEntry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e["name"] === "string" &&
    typeof e["version"] === "string" &&
    typeof e["file"] === "string" &&
    typeof e["installedAt"] === "string"
  );
}

export function loadInstalledStore(homeDir: string = capsuleHome()): InstalledStore {
  const file = installedPath(homeDir);
  return {
    version: 1,
    capsules: readStore(file, {
      code: "E_USAGE",
      label: "installed store",
      entry: (value, key) => {
        if (!isInstalledEntry(value)) {
          throw new CapsuleError("E_USAGE", `installed store entry is malformed: ${key}`, { file, key });
        }
        return {
          name: value.name,
          version: value.version,
          file: value.file,
          installedAt: value.installedAt,
        };
      },
    }),
  };
}

export function saveInstalledStore(store: InstalledStore, homeDir: string = capsuleHome()): void {
  writeStore(installedPath(homeDir), store);
}

export function addInstalledCapsule(
  capsuleId: string,
  entry: InstalledEntry,
  homeDir: string = capsuleHome(),
): void {
  const store = loadInstalledStore(homeDir);
  store.capsules[capsuleId] = entry;
  saveInstalledStore(store, homeDir);
}

export function removeInstalledCapsule(
  capsuleId: string,
  homeDir: string = capsuleHome(),
): { ok: boolean; entry?: InstalledEntry } {
  const store = loadInstalledStore(homeDir);
  if (!Object.hasOwn(store.capsules, capsuleId)) {
    return { ok: false };
  }
  const entry = store.capsules[capsuleId];
  delete store.capsules[capsuleId];
  saveInstalledStore(store, homeDir);
  if (entry?.file && existsSync(entry.file)) {
    try {
      unlinkSync(entry.file);
    } catch {
      // Best-effort cleanup
    }
  }
  return { ok: true, entry };
}

export function removeInstalledCapsulesByName(
  name: string,
  homeDir: string = capsuleHome(),
): { removed: Array<{ capsuleId: string; entry: InstalledEntry }> } {
  const store = loadInstalledStore(homeDir);
  const removed: Array<{ capsuleId: string; entry: InstalledEntry }> = [];
  for (const [capsuleId, entry] of Object.entries(store.capsules)) {
    if (entry.name === name) {
      removed.push({ capsuleId, entry });
      delete store.capsules[capsuleId];
      if (entry.file && existsSync(entry.file)) {
        try {
          unlinkSync(entry.file);
        } catch {
          // Best-effort cleanup
        }
      }
    }
  }
  if (removed.length > 0) {
    saveInstalledStore(store, homeDir);
  }
  return { removed };
}
