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
  allowSuspicious?: boolean;
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

/**
 * Where an installed capsule's bytes live: `capsules/<name>-<version>.capsule`, a name a human can
 * read in a file listing and send onward — not the capsuleId, which is content-addressed noise to
 * anyone but the registry. The registry KEY stays the capsuleId, and so does every trust decision:
 * `verifyInstalled` re-derives the id from the bytes and compares it to that key, so what the file
 * is called proves nothing. Uniqueness holds because `addInstalledCapsule` keeps at most one entry
 * per capsule name — the replacement that installs `<name>-<new>.capsule` is the same step that
 * unlinks `<name>-<old>.capsule`. The one same-name-same-version edge (a rebuild with different
 * bytes under a pinned version) maps both ids to one path, and replacement handles that too: the
 * new bytes are written first, and the unlink is skipped exactly when old and new paths are equal.
 */
export function installedCapsulePath(
  name: string,
  version: string,
  homeDir: string = capsuleHome(),
): string {
  const safe = (part: string): string => part.replace(/[^a-zA-Z0-9._+-]/g, "_");
  return join(installedCapsulesDir(homeDir), `${safe(name)}-${safe(version)}.capsule`);
}

function isInstalledEntry(value: unknown): value is InstalledEntry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e["name"] === "string" &&
    typeof e["version"] === "string" &&
    typeof e["file"] === "string" &&
    typeof e["installedAt"] === "string" &&
    (e["allowSuspicious"] === undefined || typeof e["allowSuspicious"] === "boolean")
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
          ...(value.allowSuspicious === true ? { allowSuspicious: true } : {}),
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
  // If an existing capsule with the same name exists, clean it up so the updated version is actively served
  for (const [existingId, existingEntry] of Object.entries(store.capsules)) {
    if (existingEntry.name === entry.name && existingId !== capsuleId) {
      delete store.capsules[existingId];
      if (existingEntry.file && existingEntry.file !== entry.file && existsSync(existingEntry.file)) {
        try {
          unlinkSync(existingEntry.file);
        } catch {
          // Best-effort cleanup
        }
      }
    }
  }
  store.capsules[capsuleId] = entry;
  saveInstalledStore(store, homeDir);
}

const SEEDED_FILE = "seeded.json";

export function seededPath(homeDir: string = capsuleHome()): string {
  return join(homeDir, SEEDED_FILE);
}

/**
 * Capsule ids a seeded bundle has already delivered, capsuleId → ISO time of that first delivery.
 * A seeded manager bundle re-offers its payload on every boot, and "already delivered once" is the
 * only fact that separates a first run (install it) from a capsule the user deliberately
 * uninstalled (leave it gone) — the installed store cannot make that distinction, because absence
 * there is exactly what both cases look like.
 */
export function loadSeededStore(homeDir: string = capsuleHome()): Record<string, string> {
  const file = seededPath(homeDir);
  return readStore(file, {
    code: "E_USAGE",
    label: "seeded store",
    entry: (value, key) => {
      if (typeof value !== "string") {
        throw new CapsuleError("E_USAGE", `seeded store entry is malformed: ${key}`, { file, key });
      }
      return value;
    },
  });
}

export function markSeeded(capsuleId: string, homeDir: string = capsuleHome()): void {
  const seeded = loadSeededStore(homeDir);
  seeded[capsuleId] = new Date().toISOString();
  writeStore(seededPath(homeDir), { version: 1, capsules: seeded });
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
