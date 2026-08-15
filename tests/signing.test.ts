import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CapsuleError } from "../src/core/errors.ts";
import type { Statement } from "../src/format/statement.ts";
import {
  capsuleHome,
  keyIdOf,
  loadOrCreateSigningKey,
  signStatement,
  verifySignature,
  type SignatureDoc,
} from "../src/security/signing.ts";
import {
  checkTrust,
  loadTrustStore,
  pinTrust,
  saveTrustStore,
  type TrustEntry,
  type TrustStore,
} from "../src/security/trust.ts";

/** Same shape as tests/statement.test.ts: assert the machine-readable code, not the prose. */
const capsuleError =
  (code: "E_SIGNATURE" | "E_TRUST", message?: RegExp) =>
  (e: unknown): boolean =>
    e instanceof CapsuleError && e.code === code && (message === undefined || message.test(e.message));

/** Every test gets its own CAPSULE_HOME under .tmp/ and removes it afterwards. */
function withHome(fn: (home: string) => void): void {
  const home = join(".tmp", `home-${randomUUID()}`);
  const previous = process.env.CAPSULE_HOME;
  process.env.CAPSULE_HOME = home;
  try {
    fn(home);
  } finally {
    if (previous === undefined) delete process.env.CAPSULE_HOME;
    else process.env.CAPSULE_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

const STATEMENT: Statement = {
  spec: "agentcapsule.org/statement/0.1",
  subject: {
    name: "hello",
    version: "1.0.0",
    payloadDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000001",
  },
  files: [{ path: "capsule.json", sha256: "a".repeat(64), size: 12 }],
  predicate: {
    builder: { name: "agent-capsule", version: "0.1.0" },
    toolCatalogDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000002",
  },
};

/** A second key that never touches the keystore, for the "signed by someone else" cases. */
function foreignKey(): { publicKeyBase64: string; keyId: string } {
  const { publicKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" });
  return { publicKeyBase64: der.toString("base64"), keyId: keyIdOf(der) };
}

const observedOf = (key: { publicKeyBase64: string; keyId: string }, catalog: string, name = "hello") => ({
  keyId: key.keyId,
  publicKey: key.publicKeyBase64,
  toolCatalogDigest: catalog,
  name,
});

const CATALOG_A = "sha256:" + "1".repeat(64);
const CATALOG_B = "sha256:" + "2".repeat(64);

/** `capsules` is a null-prototype dictionary, so an empty store is not deep-equal to `{}`. */
function assertEmptyStore(store: TrustStore): void {
  assert.equal(store.version, 1);
  assert.deepEqual(Object.keys(store.capsules), []);
}

test("capsuleHome honours CAPSULE_HOME", () => {
  withHome((home) => {
    assert.equal(capsuleHome(), home);
  });
});

test("signs and verifies a statement", () => {
  withHome(() => {
    const key = loadOrCreateSigningKey();
    assert.match(key.keyId, /^sha256:[0-9a-f]{64}$/);
    assert.equal(key.keyId, keyIdOf(key.publicKeySpkiDer));
    assert.equal(key.publicKeyBase64, key.publicKeySpkiDer.toString("base64"));

    const doc = signStatement(STATEMENT, key.privateKeyPem);
    assert.equal(doc.alg, "ed25519");
    assert.equal(doc.keyId, key.keyId);
    assert.equal(doc.publicKey, key.publicKeyBase64);
    assert.equal(Buffer.from(doc.signature, "base64").byteLength, 64);

    verifySignature(STATEMENT, doc);
  });
});

test("rejects a tampered statement", () => {
  withHome(() => {
    const key = loadOrCreateSigningKey();
    const doc = signStatement(STATEMENT, key.privateKeyPem);
    const tampered: Statement = { ...STATEMENT, subject: { ...STATEMENT.subject, version: "1.0.1" } };

    assert.throws(() => verifySignature(tampered, doc), capsuleError("E_SIGNATURE", /^signature verification failed$/));
  });
});

test("rejects a signature from another key", () => {
  withHome(() => {
    const key = loadOrCreateSigningKey();
    const doc = signStatement(STATEMENT, key.privateKeyPem);
    const other = foreignKey();
    // A consistent (publicKey, keyId) pair that simply did not produce this signature.
    const swapped: SignatureDoc = { ...doc, publicKey: other.publicKeyBase64, keyId: other.keyId };

    assert.throws(
      () => verifySignature(STATEMENT, swapped),
      capsuleError("E_SIGNATURE", /^signature verification failed$/),
    );
  });
});

test("rejects a signature doc whose keyId does not match its publicKey", () => {
  withHome(() => {
    const key = loadOrCreateSigningKey();
    const doc = signStatement(STATEMENT, key.privateKeyPem);
    const mislabelled: SignatureDoc = { ...doc, keyId: foreignKey().keyId };

    assert.throws(
      () => verifySignature(STATEMENT, mislabelled),
      capsuleError("E_SIGNATURE", /^keyId does not match publicKey/),
    );
  });
});

test("rejects a signature doc with an unsupported algorithm or corrupt public key", () => {
  withHome(() => {
    const key = loadOrCreateSigningKey();
    const doc = signStatement(STATEMENT, key.privateKeyPem);

    assert.throws(
      () => verifySignature(STATEMENT, { ...doc, alg: "rsa" } as unknown as SignatureDoc),
      capsuleError("E_SIGNATURE", /algorithm/),
    );
    assert.throws(
      () => verifySignature(STATEMENT, { ...doc, publicKey: "not base64 at all!!" }),
      capsuleError("E_SIGNATURE", /public key/),
    );
  });
});

test("reuses the same signing key across calls", () => {
  withHome((home) => {
    const first = loadOrCreateSigningKey();
    const second = loadOrCreateSigningKey();

    assert.equal(second.keyId, first.keyId);
    assert.equal(second.privateKeyPem, first.privateKeyPem);
    assert.equal(readFileSync(join(home, "signing-key.pem"), "utf8"), first.privateKeyPem);
    // A statement signed with the reloaded key still verifies against the first key's id.
    const doc = signStatement(STATEMENT, second.privateKeyPem);
    assert.equal(doc.keyId, first.keyId);
    verifySignature(STATEMENT, doc);
  });
});

test("first use pins, second use matches", () => {
  withHome(() => {
    const key = loadOrCreateSigningKey();
    const observed = observedOf(key, CATALOG_A);

    assertEmptyStore(loadTrustStore());
    assert.equal(checkTrust(undefined, observed), "pinned");

    const entry = pinTrust("hello", observed);
    assert.equal(entry.keyId, key.keyId);
    assert.equal(entry.toolCatalogDigest, CATALOG_A);
    assert.match(entry.pinnedAt, /^\d{4}-\d{2}-\d{2}T/);

    const reloaded = loadTrustStore();
    assert.deepEqual(reloaded.capsules["hello"], entry);
    assert.equal(checkTrust(reloaded.capsules["hello"], observed), "ok");
  });
});

test("detects key rotation", () => {
  withHome(() => {
    const key = loadOrCreateSigningKey();
    pinTrust("hello", observedOf(key, CATALOG_A));
    const entry = loadTrustStore().capsules["hello"];

    assert.throws(
      () => checkTrust(entry, observedOf(foreignKey(), CATALOG_A)),
      capsuleError("E_TRUST", /publisher key changed for hello/),
    );
  });
});

test("detects tool catalog drift", () => {
  withHome(() => {
    const key = loadOrCreateSigningKey();
    pinTrust("hello", observedOf(key, CATALOG_A));
    const entry = loadTrustStore().capsules["hello"];

    assert.throws(
      () => checkTrust(entry, observedOf(key, CATALOG_B)),
      capsuleError("E_TRUST", /tool catalog changed for hello/),
    );
    // Re-pinning after accepted drift makes the new catalog the trusted one.
    pinTrust("hello", observedOf(key, CATALOG_B));
    assert.equal(checkTrust(loadTrustStore().capsules["hello"], observedOf(key, CATALOG_B)), "ok");
  });
});

/**
 * `Object.prototype` member names are ordinary capsule names: `constructor` satisfies the manifest
 * name pattern, and a hand-edited trust.json can hold literally any key. None of them may resolve
 * to an inherited value, swap the dictionary's prototype, or vanish on save.
 */
const PROTOTYPE_NAMES = ["constructor", "__proto__", "toString", "valueOf"];

test("pins capsules named after Object.prototype members", () => {
  withHome(() => {
    const key = loadOrCreateSigningKey();

    for (const name of PROTOTYPE_NAMES) {
      const before = loadTrustStore();
      assert.equal(before.capsules[name], undefined, `unpinned ${name} must not resolve to anything`);
      assert.equal(checkTrust(before.capsules[name], observedOf(key, CATALOG_A, name)), "pinned");

      const entry = pinTrust(name, observedOf(key, CATALOG_A, name));
      const reloaded = loadTrustStore();
      assert.deepEqual(reloaded.capsules[name], entry, `${name} must survive a save/load round trip`);
      assert.equal(checkTrust(reloaded.capsules[name], observedOf(key, CATALOG_A, name)), "ok");
      assert.throws(
        () => checkTrust(reloaded.capsules[name], observedOf(foreignKey(), CATALOG_A, name)),
        capsuleError("E_TRUST", new RegExp(`publisher key changed for ${name}`)),
      );
    }

    assert.deepEqual(Object.keys(loadTrustStore().capsules).sort(), [...PROTOTYPE_NAMES].sort());
  });
});

test("loads a stored entry named __proto__ without polluting Object.prototype", () => {
  withHome((home) => {
    const entryFor = (digit: string): TrustEntry => ({
      keyId: "sha256:" + digit.repeat(64),
      publicKey: "AAAA",
      toolCatalogDigest: CATALOG_A,
      pinnedAt: "2026-01-01T00:00:00.000Z",
    });
    const [proto, ctor] = [entryFor("4"), entryFor("5")];
    mkdirSync(home, { recursive: true });
    // Written as raw JSON: an object literal would treat `__proto__` as a prototype assignment.
    writeFileSync(
      join(home, "trust.json"),
      `{"version":1,"capsules":{"__proto__":${JSON.stringify(proto)},"constructor":${JSON.stringify(ctor)}}}`,
    );

    const store = loadTrustStore();
    assert.deepEqual(Object.keys(store.capsules).sort(), ["__proto__", "constructor"]);
    assert.deepEqual(store.capsules["__proto__"], proto);
    assert.deepEqual(store.capsules["constructor"], ctor);
    assert.equal(Object.getPrototypeOf({}), Object.prototype);
    assert.equal(({} as Record<string, unknown>)["keyId"], undefined);
  });
});

test("rejects a corrupt trust store instead of silently discarding pins", () => {
  withHome((home) => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "trust.json"), "{not json");
    assert.throws(() => loadTrustStore(), capsuleError("E_TRUST", /trust store/));

    writeFileSync(join(home, "trust.json"), JSON.stringify({ version: 2, capsules: {} }));
    assert.throws(() => loadTrustStore(), capsuleError("E_TRUST", /trust store/));

    writeFileSync(join(home, "trust.json"), JSON.stringify({ version: 1, capsules: { hello: { keyId: 1 } } }));
    assert.throws(() => loadTrustStore(), capsuleError("E_TRUST", /trust store/));
  });
});

test("saveTrustStore writes atomically and leaves no temp file behind", () => {
  withHome((home) => {
    const entry: TrustEntry = {
      keyId: "sha256:" + "3".repeat(64),
      publicKey: "AAAA",
      toolCatalogDigest: CATALOG_A,
      pinnedAt: "2026-01-01T00:00:00.000Z",
    };
    saveTrustStore({ version: 1, capsules: { hello: entry } });
    assert.deepEqual(loadTrustStore().capsules["hello"], entry);

    // Overwriting an existing store works and does not leave trust.json.tmp around.
    saveTrustStore({ version: 1, capsules: {} });
    assertEmptyStore(loadTrustStore());
    assert.throws(() => readFileSync(join(home, "trust.json.tmp")), /ENOENT/);
  });
});
