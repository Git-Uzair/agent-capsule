import { join } from "node:path";
import { CapsuleError } from "../core/errors.ts";
import { capsuleHome } from "./signing.ts";
import { emptyDict, readStore, writeStore } from "./store.ts";

/**
 * `capsules[capsuleId][grant] === true` means the user has said yes to that grant for that capsule.
 * A grant is either `pack` or `net:<host>`; anything absent is denied, so a missing file, a missing
 * capsule and a missing key all mean the same thing.
 */
export type GrantsStore = {
  version: 1;
  capsules: Record<string, Record<string, boolean>>;
};

const GRANTS_FILE = "grants.json";

function grantsPath(homeDir: string): string {
  return join(homeDir, GRANTS_FILE);
}

/** Re-seat a dictionary a caller may have built as a plain object, keeping its own keys. */
function ownDict<T>(dict: Record<string, T>): Record<string, T> {
  if (Object.getPrototypeOf(dict) === null) return dict;
  return Object.assign(emptyDict<T>(), dict);
}

function fail(message: string, detail: Record<string, unknown> = {}): never {
  throw new CapsuleError("E_POLICY", message, detail);
}

/**
 * A malformed store is an error, never an empty store. Silently discarding grants would be safe in
 * the deny-by-default sense but would then let the next `saveGrants` overwrite the user's real
 * answers with an empty file.
 */
export function loadGrants(homeDir: string = capsuleHome()): GrantsStore {
  const file = grantsPath(homeDir);
  return {
    version: 1,
    capsules: readStore(file, {
      code: "E_POLICY",
      label: "grant store",
      entry: (value, capsuleId) => {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          fail(`grant store entry is malformed: ${capsuleId}`, { file, capsuleId });
        }
        const dict = emptyDict<boolean>();
        for (const [grant, flag] of Object.entries(value as Record<string, unknown>)) {
          if (typeof flag !== "boolean") {
            fail(`grant store entry is malformed: ${capsuleId}`, { file, capsuleId, grant });
          }
          dict[grant] = flag;
        }
        return dict;
      },
    }),
  };
}

export function saveGrants(store: GrantsStore, homeDir: string = capsuleHome()): void {
  writeStore(grantsPath(homeDir), store);
}

export function hasGrant(store: GrantsStore, capsuleId: string, grant: string): boolean {
  if (!Object.hasOwn(store.capsules, capsuleId)) return false;
  const grants = store.capsules[capsuleId];
  return grants !== undefined && Object.hasOwn(grants, grant) && grants[grant] === true;
}

export function addGrant(store: GrantsStore, capsuleId: string, grant: string): void {
  const capsules = ownDict(store.capsules);
  store.capsules = capsules;
  const grants = ownDict(Object.hasOwn(capsules, capsuleId) ? (capsules[capsuleId] ?? {}) : {});
  grants[grant] = true;
  capsules[capsuleId] = grants;
}
