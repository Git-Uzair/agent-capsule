import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { CapsuleError } from "../core/errors.ts";

/** Hard limits on what a guest can store or read back in one go. */
const MAX_KEY_CHARS = 256;
const MAX_VALUE_BYTES = 64 * 1024;
const MAX_KV_ROWS = 10_000;
const MAX_QUERY_ROWS = 1000;
const MAX_QUERY_BYTES = 1024 * 1024;

/** Statements the guest must never reach: they escape the sidecar or reconfigure the database. */
const DISALLOWED = new Set(["ATTACH", "DETACH", "PRAGMA", "VACUUM"]);

const SCHEMA = "CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)";

/**
 * Everything SQLite skips before the first token of the first real statement: whitespace, comments
 * in either syntax, and empty statements (`;`). Anything left unstripped here is a bypass, so the
 * class is deliberately greedy — over-stripping can only make the keyword check fire more often,
 * and a statement SQLite itself cannot tokenise fails at `prepare` anyway.
 */
const LEADING_NOISE = /^(?:\s|;|--[^\n]*|\/\*[\s\S]*?\*\/)+/;

export type CapsuleState = {
  db: DatabaseSync;
  roDb: DatabaseSync;
  kvGet(key: string): string | null;
  kvSet(key: string, value: string): void;
  sqlQuery(sql: string, params?: unknown[]): unknown[];
  sqlExec(sql: string, params?: unknown[]): { changes: number };
  close(): void;
};

function usage(message: string, detail: Record<string, unknown> = {}): never {
  throw new CapsuleError("E_USAGE", message, detail);
}

function assertKey(key: string): void {
  if (key.length > MAX_KEY_CHARS) {
    usage(`kv key exceeds ${MAX_KEY_CHARS} characters`, { length: key.length });
  }
}

function leadingKeyword(sql: string): string {
  return /^[a-z_]+/i.exec(sql.replace(LEADING_NOISE, ""))?.[0]?.toUpperCase() ?? "";
}

/**
 * Both ports share this gate. The journal being a separate file is not isolation on its own: any
 * connection can `ATTACH` it back in, and a read-only handle refuses writes, not attachments.
 */
function assertAllowed(op: "sql.query" | "sql.exec", sql: string): void {
  const keyword = leadingKeyword(sql);
  if (DISALLOWED.has(keyword)) {
    throw new CapsuleError("E_POLICY", `${op} disallows ATTACH/PRAGMA/VACUUM`, { keyword });
  }
}

function bind(params: unknown[] | undefined): SQLInputValue[] {
  return (params ?? []) as SQLInputValue[];
}

/**
 * How much of the byte budget a row costs, measured without serialising it: `JSON.stringify` on a row
 * holding a gigabyte blob allocates the very thing the budget exists to refuse, and fails with
 * `RangeError` rather than a refusal. Text is counted in UTF-8 bytes and a blob by its own length,
 * which is what the budget is actually about; scalars are counted as the JSON text they become.
 */
function rowBytes(row: unknown): number {
  let bytes = 2; // the row's own braces
  for (const [column, value] of Object.entries(row as Record<string, unknown>)) {
    bytes += column.length + 4; // the quoted column name, its colon and the separator
    bytes += typeof value === "string"
      ? Buffer.byteLength(value, "utf8")
      : value instanceof Uint8Array
        ? value.byteLength
        : String(value).length;
  }
  return bytes;
}

/**
 * Guest state lives in its own file, separate from the journal, so ordinary statements can never
 * name the evidence. That separation is defence in depth, not the whole defence: `ATTACH` would
 * link the journal into the guest's connection, so both ports also reject the statements that
 * reach outside the file or reconfigure it. Two handles on that one file: `sql.query` gets the
 * read-only one, so SQLite itself refuses a write dressed up as a query.
 */
export function openState(appDbPath: string): CapsuleState {
  mkdirSync(dirname(appDbPath), { recursive: true });
  const db = new DatabaseSync(appDbPath);
  db.exec(SCHEMA);
  // The read-only handle is opened after the schema exists: SQLite will not create a file for it.
  const roDb = new DatabaseSync(appDbPath, { readOnly: true });

  const selectValue = db.prepare("SELECT v FROM kv WHERE k = ?");
  const upsert = db.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v");
  const countRows = db.prepare("SELECT COUNT(*) AS n FROM kv");

  const kvGet = (key: string): string | null => {
    assertKey(key);
    const row = selectValue.get(key) as { v: string } | undefined;
    return row === undefined ? null : row.v;
  };

  return {
    db,
    roDb,
    kvGet,

    kvSet(key, value) {
      assertKey(key);
      // The budget is storage, so it is counted in UTF-8 bytes: `value.length` is UTF-16 units and
      // lets a multi-byte value store three times the limit.
      const bytes = Buffer.byteLength(value, "utf8");
      if (bytes > MAX_VALUE_BYTES) {
        usage(`kv value exceeds ${MAX_VALUE_BYTES} bytes`, { key, bytes });
      }
      // A full table may still be updated in place; only new keys are refused.
      if (kvGet(key) === null && ((countRows.get() as { n: number }).n >= MAX_KV_ROWS)) {
        usage(`kv is full: ${MAX_KV_ROWS} rows`, { key });
      }
      upsert.run(key, value);
    },

    sqlQuery(sql, params) {
      assertAllowed("sql.query", sql);
      // Both caps are tested while the result is still arriving. `.all()` would build the whole
      // thing first, which makes the caps assertions about a cost already paid: a 20-million-row
      // query kills the host before the row check can fire. `for...of` closes the statement for us
      // on the way out, including the way out through a refusal.
      const statement = roDb.prepare(sql);
      const rows: unknown[] = [];
      let bytes = 0;
      try {
        for (const row of statement.iterate(...bind(params))) {
          if (rows.length >= MAX_QUERY_ROWS) {
            usage(`sql.query returned more than ${MAX_QUERY_ROWS} rows`, { rows: rows.length + 1 });
          }
          bytes += rowBytes(row);
          if (bytes > MAX_QUERY_BYTES) usage(`sql.query result exceeds ${MAX_QUERY_BYTES} bytes`, { bytes });
          rows.push(row);
        }
      } catch (error) {
        if (error instanceof CapsuleError) throw error;
        // SQLite giving up part-way — a blob it cannot allocate, a write refused by the read-only
        // handle — is the guest's query being too much for this host, not a host defect.
        usage(error instanceof Error ? error.message : String(error), { sql });
      }
      return rows;
    },

    sqlExec(sql, params) {
      assertAllowed("sql.exec", sql);
      // `prepare` compiles the first statement only, so the keyword check cannot be bypassed by
      // appending a second one.
      return { changes: Number(db.prepare(sql).run(...bind(params)).changes) };
    },

    close() {
      roDb.close();
      db.close();
    },
  };
}
