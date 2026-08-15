import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalize } from "../src/core/canonical.ts";
import { CapsuleError } from "../src/core/errors.ts";
import { packEntries } from "../src/format/container.ts";
import type { Statement } from "../src/format/statement.ts";
import { signStatement } from "../src/security/signing.ts";
import { loadCapsule, packDirectory } from "../src/format/capsule.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "hello");
const CLI = join(import.meta.dirname, "..", "src", "cli.ts");

const capsuleError =
  (code: "E_MANIFEST" | "E_DIGEST" | "E_TRUST" | "E_SIGNATURE", message?: RegExp) =>
  (e: unknown): boolean =>
    e instanceof CapsuleError && e.code === code && (message === undefined || message.test(e.message));

/**
 * Every test gets its own CAPSULE_HOME under `.tmp/` and writes its capsules there too, so one
 * `rmSync` leaves nothing behind and no test can see another's pinned trust or signing key.
 */
async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = join(".tmp", `home-${randomUUID()}`);
  const previous = process.env.CAPSULE_HOME;
  process.env.CAPSULE_HOME = home;
  mkdirSync(home, { recursive: true });
  try {
    await fn(home);
  } finally {
    if (previous === undefined) delete process.env.CAPSULE_HOME;
    else process.env.CAPSULE_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

/** A key that never touches the keystore: the marketplace-mirror that re-signs someone else's work. */
function freshKeyPem(): string {
  return generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }) as string;
}

test("packs the fixture into a loadable, verifiable capsule", async () => {
  await withHome(async (home) => {
    const out = join(home, "hello.capsule");
    const packed = await packDirectory(FIXTURE, out);

    assert.equal(packed.file, out);
    assert.equal(packed.name, "hello");
    assert.equal(packed.version, "1.0.0");
    assert.match(packed.capsuleId, /^sha256:[0-9a-f]{64}$/);
    assert.match(packed.keyId, /^sha256:[0-9a-f]{64}$/);

    const loaded = await loadCapsule(out);
    assert.equal(loaded.manifest.meta.name, "hello");
    assert.equal(loaded.manifest.runtime.entry, "src/main.js");
    assert.equal(loaded.capsuleId, packed.capsuleId);
    assert.equal(loaded.keyId, packed.keyId);
    assert.equal(loaded.trust, "pinned");
    assert.equal(loaded.signature.alg, "ed25519");
    assert.equal(loaded.statement.subject.version, "1.0.0");
    // Entry paths are POSIX even though the packer walked a Windows directory.
    assert.deepEqual(loaded.reader.list(), [
      ".capsule/signature.json",
      ".capsule/statement.json",
      "capsule.json",
      "src/main.js",
      "ui/index.html",
    ]);
    assert.match((await loaded.reader.read("src/main.js")).toString("utf8"), /greet_count/);

    // The first load pinned the publisher; the second one matches what was pinned.
    assert.equal((await loadCapsule(out)).trust, "ok");
  });
});

test("pack is reproducible", async () => {
  await withHome(async (home) => {
    const first = await packDirectory(FIXTURE, join(home, "a.capsule"), { homeDir: home });
    const second = await packDirectory(FIXTURE, join(home, "b.capsule"), { homeDir: home });

    assert.equal(second.capsuleId, first.capsuleId);
    assert.equal(second.keyId, first.keyId);
    assert.ok(readFileSync(first.file).equals(readFileSync(second.file)), "capsule bytes must be identical");
  });
});

test("loading a capsule with a flipped payload byte fails", async () => {
  await withHome(async (home) => {
    const out = join(home, "hello.capsule");
    await packDirectory(FIXTURE, out);

    // Entries are stored uncompressed, so the guest source is patchable in place.
    const bytes = readFileSync(out);
    const at = bytes.indexOf("greet_count");
    assert.ok(at > 0, "expected the stored guest source to be findable");
    bytes[at] = bytes[at]! ^ 0x01;
    writeFileSync(out, bytes);

    await assert.rejects(() => loadCapsule(out), capsuleError("E_DIGEST", /digest mismatch: src\/main\.js/));
  });
});

test("loading a capsule whose signature was replaced fails", async () => {
  await withHome(async (home) => {
    const original = join(home, "hello.capsule");
    await packDirectory(FIXTURE, original);
    assert.equal((await loadCapsule(original)).trust, "pinned");

    // Same payload, same statement, signed by a key the user never trusted.
    const mirrored = join(home, "mirror.capsule");
    await packDirectory(FIXTURE, mirrored, { keyPem: freshKeyPem() });

    await assert.rejects(
      () => loadCapsule(mirrored),
      capsuleError("E_TRUST", /publisher key changed for hello/),
    );
  });
});

test("pack rejects a directory whose entry file is missing", async () => {
  await withHome(async (home) => {
    const broken = join(home, "broken");
    mkdirSync(broken, { recursive: true });
    copyFileSync(join(FIXTURE, "capsule.json"), join(broken, "capsule.json"));

    await assert.rejects(
      () => packDirectory(broken, join(home, "broken.capsule")),
      capsuleError("E_MANIFEST", /entry file not found: src\/main\.js/),
    );
  });
});

test("loading an unsigned or malformed capsule fails", async () => {
  await withHome(async (home) => {
    const payload = [
      { path: "capsule.json", data: readFileSync(join(FIXTURE, "capsule.json")) },
      { path: "src/main.js", data: readFileSync(join(FIXTURE, "src", "main.js")) },
      { path: "ui/index.html", data: readFileSync(join(FIXTURE, "ui", "index.html")) },
    ];
    const write = async (name: string, extra: { path: string; data: Buffer }[]): Promise<string> => {
      const file = join(home, name);
      writeFileSync(file, await packEntries([...payload, ...extra]));
      return file;
    };
    const utf8 = (path: string, text: string) => ({ path, data: Buffer.from(text, "utf8") });
    const pem = freshKeyPem();

    const unsigned = await write("unsigned.capsule", []);
    await assert.rejects(() => loadCapsule(unsigned), capsuleError("E_SIGNATURE", /capsule is unsigned/));

    const garbage = await write("garbage.capsule", [
      utf8(".capsule/statement.json", "{not json"),
      utf8(".capsule/signature.json", "{}"),
    ]);
    await assert.rejects(() => loadCapsule(garbage), capsuleError("E_SIGNATURE", /is not valid JSON/));

    // Malformed but genuinely signed: the shape guard must fire before any verifier dereferences it.
    const bogus = { subject: { name: "hello", version: "1.0.0" }, files: "nope" } as unknown as Statement;
    const shaped = await write("shaped.capsule", [
      utf8(".capsule/statement.json", canonicalize(bogus)),
      utf8(".capsule/signature.json", canonicalize(signStatement(bogus, pem))),
    ]);
    await assert.rejects(() => loadCapsule(shaped), capsuleError("E_SIGNATURE", /statement\.json is malformed/));
  });
});

test("cli pack prints a summary with a capsuleId", async () => {
  await withHome(async (home) => {
    const out = join(home, "cli.capsule");
    const stdout = execFileSync(process.execPath, [CLI, "pack", FIXTURE, "-o", out], {
      encoding: "utf8",
      env: { ...process.env, CAPSULE_HOME: home },
    });

    const summary = JSON.parse(stdout) as { file: string; capsuleId: string; name: string };
    assert.equal(summary.file, out);
    assert.equal(summary.name, "hello");
    assert.match(summary.capsuleId, /^sha256:[0-9a-f]{64}$/);
    assert.equal((await loadCapsule(out)).capsuleId, summary.capsuleId);
  });
});
