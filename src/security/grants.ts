import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CapsuleError } from "../core/errors.ts";
import { capsuleHome } from "./signing.ts";

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

/**
 * Capsule ids and grant names are attacker-influenced strings, so both dictionary levels are
 * prototype-less: on a plain `{}` a lookup of `constructor` would answer with the inherited
 * `Object` instead of `undefined`, and `dict["__proto__"] = true` would hit the inherited setter
 * and silently drop the grant. Null-prototype objects still round-trip through
 * `JSON.stringify`/`JSON.parse`, which defines `__proto__` as an own property.
 */
function emptyDict<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
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
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, capsules: emptyDict() };
    throw e;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    fail(`grant store is not valid JSON: ${file}`, { cause: (e as Error).message });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail(`grant store is malformed: ${file}`);
  }

  const store = parsed as Record<string, unknown>;
  if (store["version"] !== 1) {
    fail(`unsupported grants version in ${file}`, { version: store["version"] });
  }
  const capsules = store["capsules"];
  if (typeof capsules !== "object" || capsules === null || Array.isArray(capsules)) {
    fail(`grant store is malformed: ${file}`);
  }

  const entries = emptyDict<Record<string, boolean>>();
  for (const [capsuleId, grants] of Object.entries(capsules as Record<string, unknown>)) {
    if (typeof grants !== "object" || grants === null || Array.isArray(grants)) {
      fail(`grant store entry is malformed: ${capsuleId}`, { file, capsuleId });
    }
    const dict = emptyDict<boolean>();
    for (const [grant, value] of Object.entries(grants as Record<string, unknown>)) {
      if (typeof value !== "boolean") {
        fail(`grant store entry is malformed: ${capsuleId}`, { file, capsuleId, grant });
      }
      dict[grant] = value;
    }
    entries[capsuleId] = dict;
  }
  return { version: 1, capsules: entries };
}

export function saveGrants(store: GrantsStore, homeDir: string = capsuleHome()): void {
  const file = grantsPath(homeDir);
  const tmp = `${file}.tmp`;
  mkdirSync(homeDir, { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
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
