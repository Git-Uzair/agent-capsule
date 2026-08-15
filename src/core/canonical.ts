import { CapsuleError } from "./errors.ts";

function fail(what: string): never {
  throw new CapsuleError("E_DIGEST", `value has no canonical JSON form: ${what}`);
}

/**
 * The one guard for "is this parsed JSON value something with named fields?". Arrays and `null` are
 * objects to `typeof` but have no fields worth reading, so both answer `undefined` — a caller can
 * therefore treat `undefined` as "absent or unusable" without a second check.
 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) fail(String(value));
      return JSON.stringify(value === 0 ? 0 : value) as string;
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${Array.from(value as unknown[]).map((v) => (v === undefined ? "null" : canonicalize(v))).join(",")}]`;
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
    }
    default:
      return fail(typeof value);
  }
}
