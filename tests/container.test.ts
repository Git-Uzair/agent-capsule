import { test } from "node:test";
import assert from "node:assert/strict";
import { ZipFile } from "yazl";
import { fromBuffer, type Entry } from "yauzl";
import { openContainer, packEntries } from "../src/format/container.ts";
import { CapsuleError } from "../src/core/errors.ts";

/** Same shape as tests/manifest.test.ts: assert the machine-readable code, not the prose. */
const containerError =
  (message?: RegExp) =>
  (e: unknown): boolean =>
    e instanceof CapsuleError && e.code === "E_CONTAINER" && (message === undefined || message.test(e.message));

const enc = (s: string) => new TextEncoder().encode(s);
const ENTRIES = [
  { path: "src/main.js", data: enc("globalThis.tools = {};\n") },
  { path: "capsule.json", data: enc('{"spec_version":"0.1.0"}') },
];

/** Collect a yazl output stream, so tests can build containers this module refuses to pack. */
function collect(zip: ZipFile): Promise<Buffer> {
  zip.end();
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    zip.outputStream.on("data", (c: Buffer) => parts.push(c));
    zip.outputStream.on("end", () => resolve(Buffer.concat(parts)));
    zip.outputStream.on("error", reject);
  });
}

function centralDirectory(bytes: Buffer): Promise<Entry[]> {
  return new Promise((resolve, reject) => {
    fromBuffer(bytes, { lazyEntries: false }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error("no zipfile"));
      const entries: Entry[] = [];
      zip.on("entry", (e: Entry) => entries.push(e));
      zip.on("end", () => resolve(entries));
      zip.on("error", reject);
    });
  });
}

function replaceAllBytes(bytes: Buffer, from: string, to: string): Buffer {
  assert.equal(from.length, to.length, "replacement must preserve zip offsets");
  const out = Buffer.from(bytes);
  const needle = Buffer.from(from, "latin1");
  const patch = Buffer.from(to, "latin1");
  for (let at = out.indexOf(needle); at !== -1; at = out.indexOf(needle, at + 1)) patch.copy(out, at);
  return out;
}

test("packing is byte-reproducible and order-independent", async () => {
  const a = await packEntries(ENTRIES);
  const b = await packEntries([...ENTRIES].reverse());
  assert.deepEqual(a, b);
  assert.equal(a.subarray(0, 2).toString("latin1"), "PK");
});

test("round-trips entries with sorted listing", async () => {
  const r = await openContainer(await packEntries(ENTRIES));
  assert.deepEqual(r.list(), ["capsule.json", "src/main.js"]);
  assert.equal(new TextDecoder().decode(await r.read("capsule.json")), '{"spec_version":"0.1.0"}');
  assert.equal(r.has("capsule.json"), true);
  assert.equal(r.has("nope.txt"), false);
  await assert.rejects(() => r.read("nope.txt"), containerError(/no such entry: nope\.txt/));
});

test("rejects illegal paths at pack time", async () => {
  for (const path of ["../evil", "/abs", "src\\win.js", "other/x", "src/../../x", "a".repeat(300)]) {
    await assert.rejects(() => packEntries([{ path, data: enc("x") }]), containerError(/illegal entry path/));
  }
  await assert.rejects(
    () => packEntries([ENTRIES[0]!, { path: "src/main.js", data: enc("dup") }]),
    containerError(/duplicate entry: src\/main\.js/),
  );
});

test("rejects zip bombs at pack time", async () => {
  const big = Buffer.alloc(32 * 1024 * 1024 + 1);
  await assert.rejects(
    () => packEntries([{ path: "data/big.bin", data: big }]),
    containerError(/entry too large: data\/big\.bin/),
  );
  const half = big.subarray(1);
  await assert.rejects(
    () =>
      packEntries([
        { path: "data/a.bin", data: half },
        { path: "data/b.bin", data: half },
        { path: "data/c.bin", data: enc("x") },
      ]),
    containerError(/payload too large/),
  );
  const many = Array.from({ length: 4097 }, (_, i) => ({ path: `data/f${i}.bin`, data: enc("x") }));
  await assert.rejects(() => packEntries(many), containerError(/too many entries/));
});

test("stores entries with a fixed, timezone-independent DOS timestamp", async () => {
  const entries = await centralDirectory(await packEntries(ENTRIES));
  // 1980-01-01 00:00:00 encoded as a DOS date: day 1 | month 1 << 5 | year 1980 - 1980 << 9.
  const expectedDate = 1 | (1 << 5);
  assert.equal(entries.length, 2);
  for (const entry of entries) {
    assert.equal(entry.lastModFileDate, expectedDate);
    assert.equal(entry.lastModFileTime, 0);
    assert.equal(entry.compressionMethod, 0, "entries must be STOREd, not deflated");
    assert.equal(entry.externalFileAttributes >>> 16, 0o100644);
    assert.equal(
      entry.extraFields.some((f) => f.id === 0x5455),
      false,
      "an Info-ZIP UT extra field would leak the packer's UTC offset into the bytes",
    );
  }
});

test("reads containers produced with DEFLATE", async () => {
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(ENTRIES[1]!.data), "capsule.json", { compress: true });
  const r = await openContainer(await collect(zip));
  assert.equal(new TextDecoder().decode(await r.read("capsule.json")), '{"spec_version":"0.1.0"}');
});

test("rejects illegal and unreadable containers at open time", async () => {
  const tampered = replaceAllBytes(
    await packEntries([{ path: "data/aaaa.bin", data: enc("x") }]),
    "data/aaaa.bin",
    "evil/aaaa.bin",
  );
  await assert.rejects(
    () => openContainer(tampered),
    containerError(/illegal entry path: evil\/aaaa\.bin/),
  );
  await assert.rejects(
    () => openContainer(Buffer.from("PK not really a zip")),
    containerError(/unreadable container/),
  );

  const many = new ZipFile();
  for (let i = 0; i < 4097; i++) many.addBuffer(Buffer.from("x"), `data/f${i}.bin`, { compress: false });
  const manyBytes = await collect(many);
  await assert.rejects(() => openContainer(manyBytes), containerError(/too many entries/));
});

test("rejects a container that declares one path twice", async () => {
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from("first"), "capsule.json", { compress: false });
  zip.addBuffer(Buffer.from("second"), "capsule.json", { compress: false });
  const bytes = await collect(zip);
  assert.equal((await centralDirectory(bytes)).length, 2, "fixture must really carry two records");
  await assert.rejects(() => openContainer(bytes), containerError(/duplicate entry: capsule\.json/));
});
