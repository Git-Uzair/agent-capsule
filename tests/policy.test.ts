import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CapsuleError } from "../src/core/errors.ts";
import { parseManifest, type EffectName, type Manifest } from "../src/format/manifest.ts";
import { addGrant, hasGrant, loadGrants, saveGrants, type GrantsStore } from "../src/security/grants.ts";
import { buildPolicy, hostAllowed } from "../src/runtime/policy.ts";

/** Same shape as tests/signing.test.ts: assert the machine-readable code plus the exact prose. */
const policyError =
  (message: RegExp) =>
  (e: unknown): boolean =>
    e instanceof CapsuleError && e.code === "E_POLICY" && message.test(e.message);

/** Every test that touches the grant file gets its own CAPSULE_HOME under .tmp/ and removes it. */
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

const CAPSULE_ID = "sha256:" + "1".repeat(64);
const FIXTURE = join(import.meta.dirname, "fixtures", "hello");

const BASE = {
  spec_version: "0.1.0",
  meta: { name: "hello", version: "1.0.0", title: "Hello", description: "A hello capsule." },
  runtime: { type: "quickjs-1", entry: "src/main.js" },
};

function manifestWith(capabilities: Record<string, unknown>, effects: EffectName[]): Manifest {
  return parseManifest({
    ...BASE,
    capabilities,
    tools: [
      { name: "greet", title: "Greet", description: "Greets.", inputSchema: { type: "object" }, effects },
    ],
  });
}

const AMBIENT = manifestWith({}, ["clock.now", "random.bytes", "log.write"]);
const STATEFUL = manifestWith({ kv: true, sql: true }, ["kv.get", "kv.set", "sql.query", "sql.exec"]);
const NET = manifestWith({ net: { allowed_hosts: ["api.example.com"] } }, ["net.fetch"]);
const LOOPBACK = manifestWith({ net: { allow_localhost: true } }, ["net.fetch"]);
const PACK = manifestWith({ pack: true }, ["pack.write"]);

/**
 * The manifest validator already rejects an effect whose capability flag is off, so this pairing
 * cannot come out of `parseManifest`. The policy engine is the second line of defence and must deny
 * it on its own, which is why this manifest is hand-built instead of parsed.
 */
const UNVALIDATED: Manifest = {
  spec_version: "0.1.0",
  meta: { name: "sneaky", version: "1.0.0", title: "Sneaky", description: "Effects without flags." },
  runtime: {
    type: "quickjs-1",
    entry: "src/main.js",
    memory_limit_mb: 64,
    timeout_ms: 5000,
    determinism: "strict",
  },
  capabilities: { sql: false, kv: false, pack: false, net: { allowed_hosts: [], allow_localhost: false } },
  tools: [
    {
      name: "greet",
      title: "Greet",
      description: "Greets.",
      inputSchema: { type: "object" },
      effects: ["kv.get", "sql.query", "pack.write"],
    },
  ],
  resources: [],
};

const policyFor = (manifest: Manifest, grants: Record<string, boolean> = {}) =>
  buildPolicy({ manifest, capsuleId: CAPSULE_ID, grants });

test("hostAllowed matches exact hosts and rejects near misses", () => {
  assert.equal(hostAllowed("example.com", ["example.com"], false), true);
  assert.equal(hostAllowed("EXAMPLE.Com", ["example.com"], false), true);
  assert.equal(hostAllowed("example.com", ["EXAMPLE.com"], false), true);
  assert.equal(hostAllowed("api.example.com", ["example.com"], false), false);
  assert.equal(hostAllowed("evil-example.com", ["example.com"], false), false);
  assert.equal(hostAllowed("example.com.evil.com", ["example.com"], false), false);
  assert.equal(hostAllowed("example.com", [], false), false);
  assert.equal(hostAllowed("", ["example.com"], false), false);
});

test("hostAllowed wildcard matches one or more labels but never the apex", () => {
  assert.equal(hostAllowed("a.example.com", ["*.example.com"], false), true);
  assert.equal(hostAllowed("b.a.example.com", ["*.example.com"], false), true);
  assert.equal(hostAllowed("example.com", ["*.example.com"], false), false);
  assert.equal(hostAllowed(".example.com", ["*.example.com"], false), false);
  assert.equal(hostAllowed("xexample.com", ["*.example.com"], false), false);
  assert.equal(hostAllowed("evil.com", ["*.example.com"], false), false);
});

test("hostAllowed rejects non-ASCII hosts, which must already be punycode", () => {
  assert.equal(hostAllowed("bücher.example.com", ["*.example.com"], false), false);
  assert.equal(hostAllowed("xn--bcher-kva.example.com", ["*.example.com"], false), true);
  // Fullwidth digits normalise to 127.0.0.1 in some resolvers; deny before that ever happens.
  assert.equal(hostAllowed("１２７.0.0.1", [], true), false);
});

test("hostAllowed rejects IP literals unless they are loopback and localhost is allowed", () => {
  assert.equal(hostAllowed("93.184.216.34", ["93.184.216.34"], false), false);
  assert.equal(hostAllowed("93.184.216.34", ["*.example.com"], true), false);
  assert.equal(hostAllowed("127.0.0.1", [], true), true);
  assert.equal(hostAllowed("127.0.0.1", [], false), false);
  assert.equal(hostAllowed("::1", [], true), true);
  assert.equal(hostAllowed("localhost", [], true), true);
  // allow_localhost is the only switch for loopback: allowed_hosts cannot smuggle it in.
  assert.equal(hostAllowed("localhost", ["localhost"], false), false);
  // Decimal and octal spellings of 127.0.0.1 are never loopback names.
  assert.equal(hostAllowed("2130706433", [], true), false);
  assert.equal(hostAllowed("api.example.com:8080", ["api.example.com"], false), false);
});

test("allows declared ambient effects with no grant and no capability flag", () => {
  const policy = policyFor(AMBIENT);
  for (const op of ["clock.now", "random.bytes", "log.write"] as EffectName[]) {
    assert.doesNotThrow(() => policy.check("greet", op));
  }
  assert.deepEqual(policy.requiredGrants("greet"), []);
  assert.deepEqual(policy.missingGrants("greet"), []);
});

test("denies an effect the tool did not declare, and an unknown tool", () => {
  const policy = policyFor(STATEFUL);
  assert.throws(
    () => policy.check("greet", "clock.now"),
    policyError(/^tool greet did not declare effect clock\.now$/),
  );
  // The capability flag is on; only the tool's own declaration authorises the effect.
  assert.throws(
    () => policy.check("greet", "net.fetch", "https://api.example.com/"),
    policyError(/^tool greet did not declare effect net\.fetch$/),
  );
  assert.throws(
    () => policy.check("ghost", "kv.get"),
    policyError(/^tool ghost did not declare effect kv\.get$/),
  );
});

test("allows kv and sql when the capability flag is on, without any grant", () => {
  const policy = policyFor(STATEFUL);
  for (const op of ["kv.get", "kv.set", "sql.query", "sql.exec"] as EffectName[]) {
    assert.doesNotThrow(() => policy.check("greet", op));
  }
  assert.deepEqual(policy.requiredGrants("greet"), []);
});

test("denies declared effects whose capability flag is off", () => {
  const policy = policyFor(UNVALIDATED);
  assert.throws(
    () => policy.check("greet", "kv.get"),
    policyError(/^capsule did not declare capability kv$/),
  );
  assert.throws(
    () => policy.check("greet", "sql.query"),
    policyError(/^capsule did not declare capability sql$/),
  );
  assert.throws(
    () => policy.check("greet", "pack.write"),
    policyError(/^capsule did not declare capability pack$/),
  );
});

test("denies net.fetch to a host outside allowed_hosts", () => {
  const wild = manifestWith({ net: { allowed_hosts: ["*.example.com"] } }, ["net.fetch"]);
  const policy = buildPolicy({
    manifest: wild,
    capsuleId: CAPSULE_ID,
    grants: { "net:evil.com": true, "net:example.com": true },
  });
  assert.throws(
    () => policy.check("greet", "net.fetch", "https://evil.com/steal"),
    policyError(/^host evil\.com is not in capabilities\.net\.allowed_hosts$/),
  );
  // The apex is not covered by *.example.com, and a granted host is still not an allowed host.
  assert.throws(
    () => policy.check("greet", "net.fetch", "https://example.com/"),
    policyError(/^host example\.com is not in capabilities\.net\.allowed_hosts$/),
  );
  // A missing target can never be allowed either.
  assert.throws(
    () => policy.check("greet", "net.fetch"),
    policyError(/is not in capabilities\.net\.allowed_hosts$/),
  );
});

test("denies net.fetch to an allowed host that the user has not granted", () => {
  const policy = policyFor(NET);
  assert.throws(
    () => policy.check("greet", "net.fetch", "https://api.example.com/v1"),
    policyError(/^missing user grant: net:api\.example\.com$/),
  );
  assert.deepEqual(policy.requiredGrants("greet"), ["net:api.example.com"]);
  assert.deepEqual(policy.missingGrants("greet"), ["net:api.example.com"]);
});

test("allows net.fetch when the host is allowed and granted, by URL or bare host", () => {
  const policy = policyFor(NET, { "net:api.example.com": true });
  assert.doesNotThrow(() => policy.check("greet", "net.fetch", "https://API.Example.com/v1?q=1"));
  assert.doesNotThrow(() => policy.check("greet", "net.fetch", "api.example.com"));
  assert.deepEqual(policy.missingGrants("greet"), []);
});

test("one net:localhost grant covers every loopback spelling", () => {
  const ungranted = policyFor(LOOPBACK);
  assert.deepEqual(ungranted.requiredGrants("greet"), ["net:localhost"]);
  assert.throws(
    () => ungranted.check("greet", "net.fetch", "http://127.0.0.1:8080/"),
    policyError(/^missing user grant: net:localhost$/),
  );

  const policy = policyFor(LOOPBACK, { "net:localhost": true });
  for (const target of ["http://localhost:8080/", "http://127.0.0.1:8080/", "http://[::1]:8080/"]) {
    assert.doesNotThrow(() => policy.check("greet", "net.fetch", target));
  }
});

test("denies pack.write without the pack grant and allows it with", () => {
  assert.throws(
    () => policyFor(PACK).check("greet", "pack.write"),
    policyError(/^missing user grant: pack$/),
  );
  const policy = policyFor(PACK, { pack: true });
  assert.doesNotThrow(() => policy.check("greet", "pack.write"));
  assert.deepEqual(policy.requiredGrants("greet"), ["pack"]);
  assert.deepEqual(policy.missingGrants("greet"), []);
});

test("requiredGrants covers every allowed host plus loopback, and the fixture needs none", () => {
  const fixture = parseManifest(readFileSync(join(FIXTURE, "capsule.json"), "utf8"));
  const policy = policyFor(fixture);
  assert.deepEqual(policy.requiredGrants("greet"), []);
  assert.deepEqual(policy.missingGrants("greet"), []);

  const both = manifestWith(
    { pack: true, net: { allowed_hosts: ["api.example.com", "*.cdn.example.com"], allow_localhost: true } },
    ["net.fetch", "pack.write"],
  );
  const wide = policyFor(both, { pack: true, "net:api.example.com": true });
  assert.deepEqual(wide.requiredGrants("greet"), [
    "pack",
    "net:api.example.com",
    "net:*.cdn.example.com",
    "net:localhost",
  ]);
  assert.deepEqual(wide.missingGrants("greet"), ["net:*.cdn.example.com", "net:localhost"]);
});

test("a wildcard host grant authorises every host that pattern covers", () => {
  const wild = manifestWith({ net: { allowed_hosts: ["*.cdn.example.com"] } }, ["net.fetch"]);

  // A consent flow can only ever offer the grants `requiredGrants` reports, and for a wildcard entry
  // that is the pattern — so the pattern is the grant `check` enforces and names when it is missing.
  const ungranted = policyFor(wild);
  assert.deepEqual(ungranted.requiredGrants("greet"), ["net:*.cdn.example.com"]);
  assert.deepEqual(ungranted.missingGrants("greet"), ["net:*.cdn.example.com"]);
  assert.throws(
    () => ungranted.check("greet", "net.fetch", "https://a.cdn.example.com"),
    policyError(/^missing user grant: net:\*\.cdn\.example\.com$/),
  );

  const policy = policyFor(wild, { "net:*.cdn.example.com": true });
  assert.doesNotThrow(() => policy.check("greet", "net.fetch", "https://a.cdn.example.com"));
  assert.doesNotThrow(() => policy.check("greet", "net.fetch", "https://b.a.cdn.example.com/x"));
  assert.deepEqual(policy.missingGrants("greet"), []);

  // The grant never widens allowed_hosts: the apex and a foreign host stay denied by the manifest.
  assert.throws(
    () => policy.check("greet", "net.fetch", "https://cdn.example.com/"),
    policyError(/^host cdn\.example\.com is not in capabilities\.net\.allowed_hosts$/),
  );
  assert.throws(
    () => policy.check("greet", "net.fetch", "https://evil.com/"),
    policyError(/^host evil\.com is not in capabilities\.net\.allowed_hosts$/),
  );

  // A concrete grant is strictly narrower than the pattern, so it is honoured for that one host.
  const concrete = policyFor(wild, { "net:a.cdn.example.com": true });
  assert.doesNotThrow(() => concrete.check("greet", "net.fetch", "https://a.cdn.example.com"));
  assert.throws(
    () => concrete.check("greet", "net.fetch", "https://b.cdn.example.com"),
    policyError(/^missing user grant: net:\*\.cdn\.example\.com$/),
  );
});

test("a host listed exactly is refused by its own name even when a pattern also covers it", () => {
  const both = manifestWith(
    { net: { allowed_hosts: ["a.cdn.example.com", "*.cdn.example.com"] } },
    ["net.fetch"],
  );
  assert.throws(
    () => policyFor(both).check("greet", "net.fetch", "https://a.cdn.example.com"),
    policyError(/^missing user grant: net:a\.cdn\.example\.com$/),
  );
  // Both names are on the list `requiredGrants` reports, so either one opens the host.
  for (const grant of ["net:a.cdn.example.com", "net:*.cdn.example.com"]) {
    const policy = policyFor(both, { [grant]: true });
    assert.doesNotThrow(() => policy.check("greet", "net.fetch", "https://a.cdn.example.com"));
  }
});

test("grants round-trip through CAPSULE_HOME and start empty", () => {
  withHome((home) => {
    const empty = loadGrants();
    assert.equal(empty.version, 1);
    assert.deepEqual(Object.keys(empty.capsules), []);
    // Deliberately prototype-less; assert.deepEqual against `{}` would fail on exactly that.
    assert.equal(Object.getPrototypeOf(empty.capsules), null);
    assert.equal(hasGrant(empty, CAPSULE_ID, "pack"), false);

    addGrant(empty, CAPSULE_ID, "pack");
    addGrant(empty, CAPSULE_ID, "net:api.example.com");
    saveGrants(empty);

    const reloaded = loadGrants();
    assert.equal(hasGrant(reloaded, CAPSULE_ID, "pack"), true);
    assert.equal(hasGrant(reloaded, CAPSULE_ID, "net:api.example.com"), true);
    assert.equal(hasGrant(reloaded, CAPSULE_ID, "net:evil.com"), false);
    assert.equal(hasGrant(reloaded, "sha256:other", "pack"), false);

    const file = readFileSync(join(home, "grants.json"), "utf8");
    assert.equal(file.endsWith("\n"), true);
    assert.equal(JSON.parse(file).version, 1);
    // The atomic write leaves no temp file behind.
    assert.throws(() => readFileSync(join(home, "grants.json.tmp"), "utf8"));
  });
});

test("a malformed grants file is an error, not an empty store", () => {
  withHome((home) => {
    mkdirSync(home, { recursive: true });
    const file = join(home, "grants.json");
    writeFileSync(file, "{not json");
    assert.throws(() => loadGrants(), policyError(/not valid JSON/));
    writeFileSync(file, JSON.stringify({ version: 2, capsules: {} }));
    assert.throws(() => loadGrants(), policyError(/unsupported grant store version/));
    writeFileSync(file, JSON.stringify({ version: 1, capsules: [] }));
    assert.throws(() => loadGrants(), policyError(/malformed/));
    writeFileSync(file, JSON.stringify({ version: 1, capsules: { hello: { pack: "yes" } } }));
    assert.throws(() => loadGrants(), policyError(/malformed/));
  });
});

test("hostile capsule ids and grant names cannot reach Object.prototype", () => {
  withHome(() => {
    const store = loadGrants();
    addGrant(store, "__proto__", "constructor");
    addGrant(store, "constructor", "__proto__");
    saveGrants(store);

    const reloaded = loadGrants();
    assert.equal(hasGrant(reloaded, "__proto__", "constructor"), true);
    assert.equal(hasGrant(reloaded, "constructor", "__proto__"), true);
    assert.equal(hasGrant(reloaded, "hello", "constructor"), false);
    assert.equal(hasGrant(reloaded, "__proto__", "toString"), false);
    assert.equal(({} as Record<string, unknown>)["constructor"], Object);

    // A hand-built store (prototype intact) must behave the same way.
    const plain: GrantsStore = { version: 1, capsules: {} };
    addGrant(plain, "__proto__", "pack");
    assert.equal(hasGrant(plain, "__proto__", "pack"), true);
    assert.equal(hasGrant(plain, "constructor", "pack"), false);
  });
});

test("buildPolicy falls back to the grant store on disk", () => {
  withHome((home) => {
    const store = loadGrants();
    addGrant(store, CAPSULE_ID, "net:api.example.com");
    saveGrants(store);

    // No `grants` option: read CAPSULE_HOME.
    const fromEnv = buildPolicy({ manifest: NET, capsuleId: CAPSULE_ID });
    assert.doesNotThrow(() => fromEnv.check("greet", "net.fetch", "https://api.example.com/"));
    assert.deepEqual(fromEnv.missingGrants("greet"), []);

    // An explicit homeDir wins over the environment, and a whole store can be passed in directly.
    const fromStore = buildPolicy({ manifest: NET, capsuleId: CAPSULE_ID, grants: store });
    assert.doesNotThrow(() => fromStore.check("greet", "net.fetch", "https://api.example.com/"));
    const other = buildPolicy({ manifest: NET, capsuleId: "sha256:other", homeDir: home });
    assert.deepEqual(other.missingGrants("greet"), ["net:api.example.com"]);
  });
});
