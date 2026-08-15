import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { CapsuleError } from "../core/errors.ts";

/** Hard limits on what a guest can store or read back in one go. */
const MAX_KEY_CHARS = 256;
const MAX_VALUE_CHARS = 64 * 1024;
const MAX_KV_ROWS = 10_000;
const MAX_QUERY_ROWS = 1000;
const MAX_QUERY_BYTES = 1024 * 1024;

/** Statements the guest must never reach: they escape the sidecar or reconfigure the database. */
const DISALLOWED = new Set(["ATTACH", "DETACH", "PRAGMA", "VACUUM"]);

const SCHEMA = "CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)";

/** Comments are stripped before the keyword is read, so a commented-out prefix hides nothing. */
const COMMENTS = /--[^\n]*|\/\*[\s\S]*?\*\//g;

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
  return /^\s*([a-z_]+)/i.exec(sql.replace(COMMENTS, " "))?.[1]?.toUpperCase() ?? "";
}

function bind(params: unknown[] | undefined): SQLInputValue[] {
  return (params ?? []) as SQLInputValue[];
}

/**
 * Guest state lives in its own file, separate from the journal, so the guest can never touch the
 * evidence and protecting the journal needs no SQL parsing at all. Two handles on that one file:
 * `sql.query` gets the read-only one, so SQLite itself refuses a write dressed up as a query.
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
      if (value.length > MAX_VALUE_CHARS) {
        usage(`kv value exceeds ${MAX_VALUE_CHARS} characters`, { key, length: value.length });
      }
      // A full table may still be updated in place; only new keys are refused.
      if (kvGet(key) === null && ((countRows.get() as { n: number }).n >= MAX_KV_ROWS)) {
        usage(`kv is full: ${MAX_KV_ROWS} rows`, { key });
      }
      upsert.run(key, value);
    },

    sqlQuery(sql, params) {
      const rows = roDb.prepare(sql).all(...bind(params));
      if (rows.length > MAX_QUERY_ROWS) {
        usage(`sql.query returned more than ${MAX_QUERY_ROWS} rows`, { rows: rows.length });
      }
      const bytes = Buffer.byteLength(JSON.stringify(rows));
      if (bytes > MAX_QUERY_BYTES) usage(`sql.query result exceeds ${MAX_QUERY_BYTES} bytes`, { bytes });
      return rows;
    },

    sqlExec(sql, params) {
      const keyword = leadingKeyword(sql);
      if (DISALLOWED.has(keyword)) {
        throw new CapsuleError("E_POLICY", "sql.exec disallows ATTACH/PRAGMA/VACUUM", { keyword });
      }
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
