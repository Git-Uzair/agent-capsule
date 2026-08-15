import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { formatSqliteVersionError, probeSqliteSupport, MIN_NODE_VERSION } from "../src/core/probe.ts";

describe("SQLite floor probe", () => {
  it("formatSqliteVersionError includes min version and provided version", () => {
    const msg = formatSqliteVersionError("v20.10.0");
    assert.equal(
      msg,
      `agent-capsule requires Node.js >=${MIN_NODE_VERSION} with node:sqlite support (current: v20.10.0)`,
    );
  });

  it("probeSqliteSupport succeeds in the current environment", () => {
    const result = probeSqliteSupport();
    assert.equal(result.ok, true);
  });

  it("probeSqliteSupport fails when node:sqlite import throws", () => {
    const throwingLoader = (): never => {
      throw new Error("Cannot find module 'node:sqlite'");
    };
    const result = probeSqliteSupport(throwingLoader, "v20.0.0");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(
        result.error,
        `agent-capsule requires Node.js >=${MIN_NODE_VERSION} with node:sqlite support (current: v20.0.0)`,
      );
    }
  });

  it("probeSqliteSupport fails when DatabaseSync is missing or not a function", () => {
    const missingDbLoader = (): unknown => ({});
    const result = probeSqliteSupport(missingDbLoader, "v22.5.0");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(
        result.error,
        `agent-capsule requires Node.js >=${MIN_NODE_VERSION} with node:sqlite support (current: v22.5.0)`,
      );
    }
  });
});
