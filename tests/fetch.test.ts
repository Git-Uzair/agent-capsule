import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { CapsuleError, type CapsuleErrorCode } from "../src/core/errors.ts";
import { loadCapsule, packDirectory } from "../src/format/capsule.ts";
import { parseManifest } from "../src/format/manifest.ts";
import { createFetchPort, isPrivateIp, type FetchInit, type FetchPort, type LookupFn } from "../src/runtime/fetch.ts";
import { invokeTool } from "../src/runtime/invoke.ts";
import { buildPolicy } from "../src/runtime/policy.ts";

const capsuleError =
  (code: CapsuleErrorCode, message?: RegExp) =>
  (e: unknown): boolean =>
    e instanceof CapsuleError && e.code === code && (message === undefined || message.test(e.message));

const CAPSULE = "sha256:" + "2".repeat(64);
const REQUEST_MAX = 1024 * 1024;
const RESPONSE_MAX = 4 * 1024 * 1024;

const BASE = {
  spec_version: "0.1.0",
  meta: { name: "puller", version: "1.0.0", title: "Puller", description: "A fetching capsule." },
  runtime: { type: "quickjs-1", entry: "src/main.js" },
};

const TOOL = {
  name: "pull",
  title: "Pull",
  description: "Fetches a URL.",
  inputSchema: { type: "object" },
  effects: ["net.fetch"],
};

/**
 * A port over a manifest built in the test. Everything the gate decides comes from the policy the
 * manifest produces, so the two are built together rather than being passed around separately.
 */
function portFor(opts: {
  capabilities: Record<string, unknown>;
  grants: Record<string, boolean>;
  allowLocalhost?: boolean;
  fetchFn?: typeof fetch;
  lookupFn?: LookupFn;
}): FetchPort {
  const manifest = parseManifest({ ...BASE, capabilities: opts.capabilities, tools: [TOOL] });
  return createFetchPort({
    policy: buildPolicy({ manifest, capsuleId: CAPSULE, grants: opts.grants }),
    tool: "pull",
    allowLocalhost: opts.allowLocalhost ?? false,
    fetchFn: opts.fetchFn,
    lookupFn: opts.lookupFn,
  });
}

/** The loopback capsule: `allow_localhost` on, one grant for all three spellings of the host. */
function localPort(extra: { fetchFn?: typeof fetch; lookupFn?: LookupFn } = {}): FetchPort {
  return portFor({
    capabilities: { net: { allow_localhost: true } },
    grants: { "net:localhost": true },
    allowLocalhost: true,
    ...extra,
  });
}

/** The ordinary capsule: one allowed public host, no loopback. */
function publicPort(extra: { fetchFn?: typeof fetch; lookupFn?: LookupFn } = {}): FetchPort {
  return portFor({
    capabilities: { net: { allowed_hosts: ["api.example.com"] } },
    grants: { "net:api.example.com": true },
    ...extra,
  });
}

/** A resolver that answers every name with the same addresses and records what it was asked. */
function spyLookup(...addresses: string[]): { fn: LookupFn; hosts: string[] } {
  const hosts: string[] = [];
  return {
    hosts,
    fn: async (host) => {
      hosts.push(host);
      return addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    },
  };
}

/** A transport that never leaves the process, so a test can assert it was never reached. */
function spyFetch(body = "ok"): { fn: typeof fetch; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  return {
    calls,
    fn: async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(body, { status: 200, statusText: "OK", headers: { "content-type": "text/plain" } });
    },
  };
}

type Serving = { base: string; requests: { method: string; url: string; headers: IncomingMessage["headers"] }[] };

/**
 * The whole test file is offline: every request goes to a `node:http` server on an ephemeral
 * loopback port, and the only hostnames that appear are `127.0.0.1` and names in the reserved
 * `.test`/`example.com` space that the gate refuses before any transport is involved.
 *
 * Connections are closed explicitly: `fetch` keeps its sockets alive, so `server.close()` alone waits
 * for a keep-alive socket that nothing is going to close and the test file never finishes.
 */
async function withServer(fn: (serving: Serving) => Promise<void>): Promise<void> {
  const requests: Serving["requests"] = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
    // A test that abandons a response mid-stream makes the write side fail; that is the behaviour
    // under test, not a reason to take the process down with an unhandled 'error'.
    req.on("error", () => {});
    res.on("error", () => {});
    respond(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn({ base: `http://127.0.0.1:${port}`, requests });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
}

function respond(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const to = url.searchParams.get("to") ?? "/ok";
  switch (url.pathname) {
    case "/ok":
      res.writeHead(200, {
        "content-type": "text/plain",
        "content-length": "2",
        etag: "W/\"1\"",
        "set-cookie": "a=b",
      });
      res.end("ok");
      return;
    case "/echo": {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") }),
        );
      });
      return;
    }
    case "/bytes": {
      const n = Number(url.searchParams.get("n") ?? "0");
      res.writeHead(200, { "content-type": "text/plain", "content-length": String(n) });
      res.end("x".repeat(n));
      return;
    }
    // The same overflow with no length declared: the cap has to come from counting the bytes, not
    // from believing a header.
    case "/stream":
      res.writeHead(200, { "content-type": "text/plain" });
      for (let written = 0; written <= RESPONSE_MAX; written += 512 * 1024) res.write("y".repeat(512 * 1024));
      res.end();
      return;
    case "/redirect":
      res.writeHead(302, { location: to });
      res.end();
      return;
    case "/see-other":
      res.writeHead(303, { location: to });
      res.end();
      return;
    case "/loop":
      res.writeHead(302, { location: "/loop" });
      res.end();
      return;
    case "/no-location":
      res.writeHead(302, { "content-type": "text/plain" });
      res.end("moved nowhere");
      return;
    default:
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("no");
  }
}

test("blocks private, loopback and reserved addresses", () => {
  const blocked = [
    "0.0.0.0",
    "0.1.2.3",
    "10.0.0.1",
    "10.255.255.255",
    "100.64.0.1",
    "127.0.0.1",
    "127.1.2.3",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.1",
    "192.0.2.5",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1",
    "239.1.1.1",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "fe80::1%eth0",
    "ff02::1",
    "2001:db8::1",
    // IPv4-mapped forms of the same ranges: the address a resolver returns may be spelled either way.
    "::ffff:10.0.0.1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    // Not addresses at all. An answer that cannot be reasoned about is refused, not trusted.
    "",
    "not-an-ip",
    "10.0.0.1.evil",
    "0177.0.0.1",
    "2130706433",
  ];
  for (const ip of blocked) assert.equal(isPrivateIp(ip), true, `${ip} should be blocked`);

  for (const ip of ["1.1.1.1", "8.8.8.8", "11.0.0.1", "93.184.216.34", "172.32.0.1", "2606:4700:4700::1111"]) {
    assert.equal(isPrivateIp(ip), false, `${ip} should be allowed`);
  }
});

test("rejects urls that are not https, carry credentials or use an odd port", async () => {
  const lookup = spyLookup("93.184.216.34");
  const transport = spyFetch();
  const port = publicPort({ fetchFn: transport.fn, lookupFn: lookup.fn });

  await assert.rejects(
    () => port("http://api.example.com/x"),
    capsuleError("E_POLICY", /^only https: urls are allowed/),
  );
  await assert.rejects(() => port("ftp://api.example.com/x"), capsuleError("E_POLICY", /^only https: urls/));
  await assert.rejects(
    () => port("https://user:secret@api.example.com/x"),
    capsuleError("E_POLICY", /^url must not carry credentials$/),
  );
  await assert.rejects(
    () => port("https://:secret@api.example.com/x"),
    capsuleError("E_POLICY", /^url must not carry credentials$/),
  );
  await assert.rejects(() => port("api.example.com/x"), capsuleError("E_USAGE", /^invalid url: /));
  await assert.rejects(
    () => port("https://api.example.com:81/x"),
    capsuleError("E_POLICY", /^port 81 is not allowed$/),
  );

  // Nothing above got as far as a name lookup or a socket.
  assert.equal(lookup.hosts.length, 0);
  assert.equal(transport.calls.length, 0);

  // 443 and the unprivileged range are fine.
  assert.equal((await port("https://api.example.com:8443/x")).status, 200);
  assert.equal((await port("https://api.example.com/x")).status, 200);
  assert.deepEqual(lookup.hosts, ["api.example.com", "api.example.com"]);
});

test("rejects a host outside allowed_hosts before any dns lookup", async () => {
  const lookup = spyLookup("93.184.216.34");
  const transport = spyFetch();
  const port = publicPort({ fetchFn: transport.fn, lookupFn: lookup.fn });

  await assert.rejects(
    () => port("https://evil.test/steal"),
    capsuleError("E_POLICY", /^host evil\.test is not in capabilities\.net\.allowed_hosts$/),
  );
  // A host the manifest allows but the user has not granted is refused the same way, and just as early.
  const ungranted = portFor({
    capabilities: { net: { allowed_hosts: ["api.example.com"] } },
    grants: {},
    fetchFn: transport.fn,
    lookupFn: lookup.fn,
  });
  await assert.rejects(
    () => ungranted("https://api.example.com/x"),
    capsuleError("E_POLICY", /^missing user grant: net:api\.example\.com$/),
  );

  assert.equal(lookup.hosts.length, 0);
  assert.equal(transport.calls.length, 0);
});

test("refuses a host that resolves to a reserved address", async () => {
  const transport = spyFetch();
  // A name that resolves to one public and one private address is refused: DNS rebinding needs only
  // the answer the connection happens to use.
  const mixed = spyLookup("93.184.216.34", "10.0.0.1");
  await assert.rejects(
    () => publicPort({ fetchFn: transport.fn, lookupFn: mixed.fn })("https://api.example.com/x"),
    capsuleError("E_POLICY", /^SSRF: host resolved to reserved\/private IP$/),
  );
  assert.deepEqual(mixed.hosts, ["api.example.com"]);
  assert.equal(transport.calls.length, 0);

  for (const address of ["169.254.169.254", "127.0.0.1", "::1", "::ffff:192.168.0.5"]) {
    await assert.rejects(
      () => publicPort({ fetchFn: transport.fn, lookupFn: spyLookup(address).fn })("https://api.example.com/x"),
      capsuleError("E_POLICY", /^SSRF: host resolved to reserved\/private IP$/),
    );
  }
  assert.equal(transport.calls.length, 0);

  // A name with no answer at all is a failure, not a licence to connect.
  await assert.rejects(
    () => publicPort({ fetchFn: transport.fn, lookupFn: spyLookup().fn })("https://api.example.com/x"),
    capsuleError("E_USAGE", /^api\.example\.com did not resolve to any address$/),
  );
  assert.equal(transport.calls.length, 0);

  // Public answers get through, and the transport is asked for exactly what the gate approved.
  const ok = await publicPort({ fetchFn: transport.fn, lookupFn: spyLookup("93.184.216.34").fn })(
    "https://api.example.com/x",
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.body, "ok");
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0]?.url, "https://api.example.com/x");
  assert.equal(transport.calls[0]?.init?.method, "GET");
  assert.equal(transport.calls[0]?.init?.redirect, "manual");
});

test("fetches an allowed loopback url without resolving it", async () => {
  await withServer(async ({ base, requests }) => {
    const lookup = spyLookup("127.0.0.1");
    const response = await localPort({ lookupFn: lookup.fn })(`${base}/ok`);

    assert.equal(response.status, 200);
    assert.equal(response.statusText, "OK");
    assert.equal(response.body, "ok");
    // Only the two headers a guest is given. `etag` and `set-cookie` were on the response and are not
    // handed on: the response's other metadata is not the guest's business.
    assert.deepEqual(Object.keys(response.headers).sort(), ["content-length", "content-type"]);
    assert.match(response.headers["content-type"] ?? "", /^text\/plain/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.method, "GET");

    // `127.0.0.1` is a reserved address, so a loopback fetch only works because the lookup is skipped
    // for the loopback host — which also means there is nothing to rebind.
    assert.equal(lookup.hosts.length, 0);

    // http to a non-loopback host stays refused even with allow_localhost on.
    await assert.rejects(
      () => localPort({ lookupFn: lookup.fn })("http://api.example.com/x"),
      capsuleError("E_POLICY", /^only https: urls are allowed/),
    );
  });
});

test("caps the request body at 1 MiB", async () => {
  await withServer(async ({ base }) => {
    const transport = spyFetch();
    await assert.rejects(
      () => localPort({ fetchFn: transport.fn })(`${base}/echo`, { method: "POST", body: "x".repeat(REQUEST_MAX + 1) }),
      capsuleError("E_USAGE", /^request body exceeds 1 MiB$/),
    );
    // Bytes, not UTF-16 units: 400 000 euro signs are 1.2 MiB on the wire.
    await assert.rejects(
      () => localPort({ fetchFn: transport.fn })(`${base}/echo`, { method: "POST", body: "\u20AC".repeat(400_000) }),
      capsuleError("E_USAGE", /^request body exceeds 1 MiB$/),
    );
    assert.equal(transport.calls.length, 0);

    // A body right at the limit is sent whole.
    const body = "a".repeat(REQUEST_MAX);
    const response = await localPort()(`${base}/echo`, { method: "POST", body });
    const echoed = JSON.parse(response.body) as { method: string; body: string };
    assert.equal(echoed.method, "POST");
    assert.equal(echoed.body.length, REQUEST_MAX);
  });
});

test("caps the response body at 4 MiB, counted as it arrives", async () => {
  await withServer(async ({ base }) => {
    const port = localPort();
    const fits = await port(`${base}/bytes?n=${RESPONSE_MAX}`);
    assert.equal(fits.body.length, RESPONSE_MAX);

    await assert.rejects(
      () => port(`${base}/bytes?n=${RESPONSE_MAX + 1}`),
      capsuleError("E_USAGE", /^response body exceeds 4 MiB$/),
    );
    // No content-length to check, so the refusal can only come from counting the bytes.
    await assert.rejects(() => port(`${base}/stream`), capsuleError("E_USAGE", /^response body exceeds 4 MiB$/));
  });
});

test("follows redirects up to five hops and no further", async () => {
  await withServer(async ({ base, requests }) => {
    const port = localPort();
    assert.equal((await port(`${base}/redirect?to=/ok`)).body, "ok");

    // Five hops are allowed: the fifth redirect lands on the answer.
    let target = "/ok";
    for (let i = 0; i < 5; i++) target = `/redirect?to=${encodeURIComponent(target)}`;
    assert.equal((await port(`${base}${target}`)).body, "ok");

    await assert.rejects(() => port(`${base}/loop`), capsuleError("E_USAGE", /^maximum redirects exceeded$/));
    // Six requests, then a refusal: the sixth redirect is where the chain stops.
    assert.equal(requests.filter((r) => r.url === "/loop").length, 6);

    // A 3xx with nothing to follow is an answer, not a redirect.
    const stuck = await port(`${base}/no-location`);
    assert.equal(stuck.status, 302);
    assert.equal(stuck.body, "moved nowhere");

    // 303 turns the follow-up into a GET with no body; 307 would keep both.
    const seeOther = await port(`${base}/see-other?to=/echo`, { method: "POST", body: "sent" });
    const echoed = JSON.parse(seeOther.body) as { method: string; body: string };
    assert.equal(echoed.method, "GET");
    assert.equal(echoed.body, "");
  });
});

test("blocks a redirect to a host outside the allowlist", async () => {
  await withServer(async ({ base }) => {
    const lookup = spyLookup("93.184.216.34");
    const port = localPort({ lookupFn: lookup.fn });

    await assert.rejects(
      () => port(`${base}/redirect?to=${encodeURIComponent("http://evil.test/steal")}`),
      capsuleError("E_POLICY", /^redirect blocked: evil\.test: /),
    );
    // The redirect target is refused by the allowlist, so it is never looked up either.
    assert.equal(lookup.hosts.length, 0);

    // A redirect that leaves loopback for a private address is blocked as an SSRF, not followed.
    const rebind = localPort({ lookupFn: spyLookup("10.0.0.1").fn });
    await assert.rejects(
      () => rebind(`${base}/redirect?to=${encodeURIComponent("https://api.example.com/x")}`),
      capsuleError("E_POLICY", /^redirect blocked: api\.example\.com: /),
    );
  });
});

test("strips credential and hop headers and limits what a guest may send", async () => {
  await withServer(async ({ base }) => {
    const response = await localPort()(`${base}/echo`, {
      method: "post",
      headers: {
        cookie: "session=secret",
        Authorization: "Bearer secret",
        "proxy-authorization": "Basic secret",
        host: "evil.test",
        "x-forwarded-for": "10.0.0.1",
        "x-ok": "keep",
      },
      body: "hello",
    });
    const echoed = JSON.parse(response.body) as { method: string; headers: Record<string, string>; body: string };

    assert.equal(echoed.method, "POST");
    assert.equal(echoed.body, "hello");
    assert.equal(echoed.headers["x-ok"], "keep");
    for (const name of ["cookie", "authorization", "proxy-authorization", "x-forwarded-for"]) {
      assert.equal(echoed.headers[name], undefined, `${name} should not have been sent`);
    }
    // `host` is the connection's, not the one the guest asked for.
    assert.equal(echoed.headers.host, base.slice("http://".length));

    const port = localPort({ fetchFn: spyFetch().fn });
    await assert.rejects(
      () => port(`${base}/echo`, { method: "PUT", body: "x" }),
      capsuleError("E_USAGE", /^net\.fetch allows only GET and POST, not PUT$/),
    );
    await assert.rejects(
      () => port(`${base}/echo`, { body: "x" }),
      capsuleError("E_USAGE", /^net\.fetch GET requests must not carry a body$/),
    );
    await assert.rejects(
      () => port(`${base}/echo`, { headers: Object.fromEntries([...Array(17).keys()].map((i) => [`x-${i}`, "v"])) }),
      capsuleError("E_USAGE", /^net\.fetch allows at most 16 request headers$/),
    );
    await assert.rejects(
      () => port(`${base}/echo`, { headers: { "x-big": "v".repeat(1025) } }),
      capsuleError("E_USAGE", /^net\.fetch request header x-big exceeds 1024 bytes$/),
    );
  });
});

test("refuses an init a guest made up", async () => {
  await withServer(async ({ base }) => {
    const port = localPort({ fetchFn: spyFetch().fn });
    const bad = (init: unknown): Promise<unknown> => port(`${base}/ok`, init as FetchInit);

    await assert.rejects(() => bad("GET"), capsuleError("E_USAGE", /^net\.fetch init must be an object$/));
    await assert.rejects(() => bad({ method: 5 }), capsuleError("E_USAGE", /^net\.fetch method must be a string$/));
    await assert.rejects(() => bad({ body: {} }), capsuleError("E_USAGE", /^net\.fetch body must be a string$/));
    await assert.rejects(
      () => bad({ headers: "x: y" }),
      capsuleError("E_USAGE", /^net\.fetch headers must be an object of strings$/),
    );
    await assert.rejects(
      () => bad({ headers: { "x-n": 5 } }),
      capsuleError("E_USAGE", /^net\.fetch headers must be an object of strings$/),
    );
    // An absent init and an empty one are the same thing: a plain GET.
    assert.equal((await port(`${base}/ok`)).status, 200);
    assert.equal((await port(`${base}/ok`, {})).status, 200);
  });
});

/**
 * The port is only a defence if it is the one the pipeline actually uses. This is the whole path — a
 * signed capsule, a guest calling `capsule.fetch`, no port injected — so nothing but the wiring in
 * `invokeTool` can be producing the answer.
 */
test("invokeTool wires the real fetch port when none is injected", async () => {
  await withServer(async ({ base, requests }) => {
    const home = join(".tmp", `home-${randomUUID()}`);
    const previous = process.env.CAPSULE_HOME;
    process.env.CAPSULE_HOME = home;
    const dir = join(home, "src-net");
    mkdirSync(join(dir, "src"), { recursive: true });
    try {
      writeFileSync(
        join(dir, "src", "main.js"),
        "globalThis.tools = { pull(args) { return capsule.fetch(args.url); } };",
      );
      writeFileSync(
        join(dir, "capsule.json"),
        JSON.stringify({
          ...BASE,
          runtime: { ...BASE.runtime, timeout_ms: 5000 },
          capabilities: { net: { allow_localhost: true } },
          tools: [{ ...TOOL, inputSchema: { type: "object", properties: { url: { type: "string" } } } }],
        }),
      );
      const file = join(home, "net.capsule");
      await packDirectory(dir, file, { homeDir: home });
      const capsule = await loadCapsule(file, { homeDir: home });

      const result = await invokeTool({
        capsule,
        tool: "pull",
        args: { url: `${base}/ok` },
        grants: { "net:localhost": true },
      });
      assert.equal(result.error, undefined);
      assert.equal(result.ok, true);
      assert.deepEqual(result.value, {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/plain", "content-length": "2" },
        body: "ok",
      });
      assert.equal(requests.length, 1);

      // The same capsule cannot reach anywhere else: the gate is the policy, not the guest's choice.
      // The refusal is handed to the guest, which let it propagate rather than catching it, so the
      // caller is told the tool failed and is shown why — the code is the guest's, the reason is the
      // policy's.
      const denied = await invokeTool({
        capsule,
        tool: "pull",
        args: { url: "https://evil.test/steal" },
        grants: { "net:localhost": true },
      });
      assert.equal(denied.ok, false);
      assert.equal(denied.error?.code, "E_GUEST");
      assert.match(denied.error?.message ?? "", /host evil\.test is not in capabilities\.net\.allowed_hosts/);
      assert.equal(requests.length, 1);
    } finally {
      if (previous === undefined) delete process.env.CAPSULE_HOME;
      else process.env.CAPSULE_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
