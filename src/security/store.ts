import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CapsuleError, type CapsuleErrorCode } from "../core/errors.ts";

/**
 * The two stores under `CAPSULE_HOME` — `trust.json` and `grants.json` — share one on-disk shape,
 * `{ "version": 1, "capsules": { "<key>": <entry> } }`, and one set of rules about it: write it
 * atomically so a crash cannot leave a half-file where the user's pins or answers were, and parse
 * its keys into a prototype-less dictionary.
 */
type Store<T> = {
  version: 1;
  capsules: Record<string, T>;
};

/**
 * Capsule names, capsule ids and grant names are all attacker-influenced strings. On a plain `{}`
 * dictionary a lookup of `constructor` would answer with the inherited `Object` instead of
 * `undefined`, and `dict["__proto__"] = value` would hit the inherited setter and silently drop the
 * entry. A null-prototype dictionary makes every name an ordinary key, and still round-trips through
 * `JSON.stringify`/`JSON.parse`, which define `__proto__` as an own property.
 */
export function emptyDict<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/** Write-to-temp then rename: readers see either the whole previous file or the whole new one. */
export function writeStore(file: string, store: Store<unknown>): void {
  const tmp = `${file}.tmp`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * Read the `capsules` map of a store, validating each entry with `entry` (which throws its own,
 * store-specific error). A missing file is an empty map; a malformed file is an error, never an
 * empty map — discarding entries silently would let the next write overwrite the real ones.
 */
export function readStore<T>(
  file: string,
  opts: { code: CapsuleErrorCode; label: string; entry: (value: unknown, key: string) => T },
): Record<string, T> {
  const fail = (message: string, detail: Record<string, unknown> = {}): never => {
    throw new CapsuleError(opts.code, message, detail);
  };

  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyDict<T>();
    throw e;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    fail(`${opts.label} is not valid JSON: ${file}`, { cause: (e as Error).message });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail(`${opts.label} is malformed: ${file}`);
  }

  const store = parsed as Record<string, unknown>;
  if (store["version"] !== 1) {
    fail(`unsupported ${opts.label} version in ${file}`, { version: store["version"] });
  }
  const capsules = store["capsules"];
  if (typeof capsules !== "object" || capsules === null || Array.isArray(capsules)) {
    fail(`${opts.label} is malformed: ${file}`);
  }

  const entries = emptyDict<T>();
  for (const [key, value] of Object.entries(capsules as Record<string, unknown>)) {
    entries[key] = opts.entry(value, key);
  }
  return entries;
}
