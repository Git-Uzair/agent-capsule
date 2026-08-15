import { test } from "node:test";
import assert from "node:assert/strict";
import { asRecord, canonicalize } from "../src/core/canonical.ts";
import { digestBytes, digestOf, sha256Hex } from "../src/core/digest.ts";
import { CapsuleError } from "../src/core/errors.ts";

test("sorts object keys by code unit and drops whitespace", () => {
  assert.equal(canonicalize({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
  assert.equal(canonicalize({ "\u00e4": 1, z: 2 }), '{"z":2,"ä":1}');
});

test("drops undefined properties inside objects", () => {
  assert.equal(canonicalize({ x: undefined }), "{}");
  assert.equal(canonicalize({ a: { b: undefined } }), '{"a":{}}');
  assert.equal(canonicalize({ b: 1, c: undefined, a: 2 }), '{"a":2,"b":1}');
});

test("preserves array order, handles sparse arrays and serialises numbers per ES6", () => {
  assert.equal(canonicalize([3, 1, 2]), "[3,1,2]");
  assert.equal(canonicalize([, 1]), "[null,1]");
  assert.equal(canonicalize([undefined, 1]), "[null,1]");
  assert.equal(canonicalize({ n: 1.5, e: 1e21, z: -0 }), '{"e":1e+21,"n":1.5,"z":0}');
});

test("rejects values with no canonical form", () => {
  assert.throws(
    () => canonicalize(undefined),
    (e: unknown) => e instanceof CapsuleError && e.code === "E_DIGEST",
  );
  for (const bad of [NaN, Infinity, () => 1, 1n, Symbol("foo")]) {
    assert.throws(
      () => canonicalize({ x: bad } as never),
      (e: unknown) => e instanceof CapsuleError && e.code === "E_DIGEST",
    );
    assert.throws(
      () => canonicalize(bad as never),
      (e: unknown) => e instanceof CapsuleError && e.code === "E_DIGEST",
    );
  }
});

test("digests are stable and prefixed", () => {
  assert.equal(sha256Hex("abc").slice(0, 8), "ba7816bf");
  assert.equal(digestOf({ a: 1, b: 2 }), digestOf({ b: 2, a: 1 }));
  assert.match(digestOf({}), /^sha256:[0-9a-f]{64}$/);
});

test("digestBytes hashes Uint8Array", () => {
  assert.equal(digestBytes(new TextEncoder().encode("abc")), `sha256:${sha256Hex("abc")}`);
});

test("asRecord accepts plain objects and rejects everything without named fields", () => {
  const obj = { a: 1 };
  assert.equal(asRecord(obj), obj);
  const bare = Object.create(null) as Record<string, unknown>;
  assert.equal(asRecord(bare), bare);
  for (const bad of [null, undefined, [], [1], "x", 0, false, () => 1]) {
    assert.equal(asRecord(bad), undefined);
  }
});
