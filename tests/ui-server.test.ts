import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { join } from "node:path";
import { loadCapsule, packDirectory, type LoadedCapsule } from "../src/format/capsule.ts";
import { allowedHosts, startUiServer, type UiServer } from "../src/ui/server.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "hello");
const PAGE = readFileSync(join(FIXTURE, "ui", "index.html"), "utf8");

/**
 * The sha256 the served page's one inline script must be allowed by, computed by slicing the file
 * rather than by asking the server: the point of the assertion is that the hash in the header is the
 * hash of *that* script, and a test that reused the server's own extractor could not tell.
 */
const INLINE_SCRIPT_SHA256 = ((): string => {
  const open = '<script type="module">';
  const start = PAGE.indexOf(open) + open.length;
  const end = PAGE.indexOf("</script>", start);
  assert.ok(start > open.length - 1 && end > start, "fixture page must carry one inline module script");
  return createHash("sha256").update(PAGE.slice(start, end), "utf8").digest("base64");
})();

type DraftTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  effects?: string[];
  ui?: string;
};

type Draft = {
  spec_version: "0.1.0";
  meta: { name: string; version: string; title: string; description: string };
  runtime: { type: "quickjs-1"; entry: string; timeout_ms?: number };
  capabilities: {
    sql?: boolean;
    kv?: boolean;
    pack?: boolean;
    net?: { allowed_hosts?: string[]; allow_localhost?: boolean };
  };
  tools: DraftTool[];
  ui?: {
    app?: { resourceUri: string; path: string; csp?: { connectDomains?: string[]; resourceDomains?: string[] } };
    local?: { path: string };
  };
};

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

async function packCapsule(home: string, edit?: (draft: Draft) => void): Promise<LoadedCapsule> {
  const dir = join(home, `src-${randomUUID()}`);
  cpSync(FIXTURE, dir, { recursive: true });

  const draft = JSON.parse(readFileSync(join(dir, "capsule.json"), "utf8")) as Draft;
  edit?.(draft);
  writeFileSync(join(dir, "capsule.json"), JSON.stringify(draft));

  const file = join(home, `hello-${randomUUID()}.capsule`);
  await packDirectory(dir, file, { homeDir: home });
  return await loadCapsule(file, { homeDir: home });
}

type Res = { status: number; headers: IncomingHttpHeaders; body: string };

/**
 * A raw `node:http` request, not `fetch`, for two reasons the tests depend on: `fetch` refuses to
 * send a `Host` header of the caller's choosing (it is a forbidden header name), and it normalises
 * `..` out of a path before the request is written — which is exactly what the traversal test needs
 * to reach the server intact.
 */
function raw(opts: {
  port: number;
  path: string;
  method?: string;
  host?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port: opts.port,
      method: opts.method ?? "GET",
      path: opts.path,
      headers: { host: opts.host ?? `127.0.0.1:${opts.port}`, connection: "close", ...opts.headers },
    });
    let answered = false;
    req.on("response", (res) => {
      answered = true;
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") });
      });
      res.on("error", reject);
    });
    // A body the server refused is answered and then the socket is closed, so a write that fails
    // after the answer arrived is the server doing its job rather than a failed request.
    req.on("error", (err) => {
      if (!answered) reject(err);
    });
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

async function withUi(
  opts: { capsule: LoadedCapsule; home: string; port?: number; idleTimeoutMs?: number },
  fn: (ui: UiServer) => Promise<void>,
): Promise<void> {
  const ui = await startUiServer({
    capsule: opts.capsule,
    homeDir: opts.home,
    ...(opts.port === undefined ? {} : { port: opts.port }),
    ...(opts.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: opts.idleTimeoutMs }),
  });
  try {
    await fn(ui);
  } finally {
    await ui.close();
  }
}

/** Fails the test rather than hanging `node --test`, which has no per-test timeout by default. */
async function within<T>(ms: number, what: string, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("serves the page only with a valid token", async () => {
  await withHome(async (home) => {
    const capsule = await packCapsule(home);
    await withUi({ capsule, home }, async (ui) => {
      assert.equal(ui.url, `http://127.0.0.1:${ui.port}/?t=${ui.token}`);
      assert.match(ui.token, /^[0-9a-f]{64}$/);

      const withToken = await raw({ port: ui.port, path: `/?t=${ui.token}` });
      assert.equal(withToken.status, 200);
      assert.equal(withToken.headers["content-type"], "text/html; charset=utf-8");
      // Byte-for-byte: the page is signed capsule content and the server is not allowed to edit it.
      assert.equal(withToken.body, PAGE);

      assert.equal((await raw({ port: ui.port, path: "/" })).status, 401);
      assert.equal((await raw({ port: ui.port, path: "/?t=" })).status, 401);
      assert.equal((await raw({ port: ui.port, path: `/?t=${"0".repeat(64)}` })).status, 401);
      assert.equal((await raw({ port: ui.port, path: `/?t=${ui.token}x` })).status, 401);

      const noToken = await raw({ port: ui.port, path: "/index.html" });
      assert.equal(noToken.status, 401);
      assert.equal(noToken.headers["www-authenticate"], "Bearer");

      // The three other ways to present it, for a page that would rather not put it in a URL.
      const bearer = await raw({
        port: ui.port,
        path: "/index.html",
        headers: { authorization: `Bearer ${ui.token}` },
      });
      assert.equal(bearer.status, 200);
      assert.equal(
        (await raw({ port: ui.port, path: "/", headers: { "x-capsule-token": ui.token } })).status,
        200,
      );
      assert.equal((await raw({ port: ui.port, path: `/?token=${ui.token}` })).status, 200);
    });
  });
});

test("rejects a foreign Host header and a cross-site fetch", async () => {
  await withHome(async (home) => {
    const capsule = await packCapsule(home);
    await withUi({ capsule, home }, async (ui) => {
      // DNS rebinding: the request carries a valid token, because the attacker's page is talking to
      // an address that resolves to this machine. The Host header is what gives it away.
      const foreign = await raw({ port: ui.port, path: `/?t=${ui.token}`, host: "evil.test:1234" });
      assert.equal(foreign.status, 403);

      assert.equal(
        (await raw({ port: ui.port, path: `/?t=${ui.token}`, host: `127.0.0.1:${ui.port + 1}` })).status,
        403,
      );
      assert.equal((await raw({ port: ui.port, path: `/?t=${ui.token}`, host: "127.0.0.1" })).status, 403);
      // Both loopback spellings of this port are the same origin.
      assert.equal(
        (await raw({ port: ui.port, path: `/?t=${ui.token}`, host: `localhost:${ui.port}` })).status,
        200,
      );

      const crossSite = await raw({
        port: ui.port,
        path: "/rpc",
        method: "POST",
        headers: {
          authorization: `Bearer ${ui.token}`,
          "content-type": "application/json",
          "sec-fetch-site": "cross-site",
        },
        body: JSON.stringify({ tool: "greet", args: { name: "ada" } }),
      });
      assert.equal(crossSite.status, 403);
    });
  });
});

test("accepts a port-less Host header on the default port 80", async () => {
  // The table is asserted directly as well as over the wire: binding port 80 needs a privilege (or a
  // free port 80) that not every machine running this suite has, and the rule this test exists for
  // must be proven either way.
  assert.deepEqual(allowedHosts(80), ["127.0.0.1:80", "localhost:80", "127.0.0.1", "localhost"]);
  assert.deepEqual(allowedHosts(8080), ["127.0.0.1:8080", "localhost:8080"]);

  await withHome(async (home) => {
    const capsule = await packCapsule(home);
    let ui: UiServer;
    try {
      ui = await startUiServer({ capsule, homeDir: home, port: 80 });
    } catch (err) {
      // EACCES (unprivileged) or EADDRINUSE (something else owns it): the wire half is not available
      // here, and a suite that failed for that would be testing the machine.
      assert.match(String(err), /EACCES|EADDRINUSE|EPERM/, `unexpected failure binding port 80: ${String(err)}`);
      return;
    }
    try {
      // What a browser actually sends for `http://127.0.0.1/`: no port, because 80 is the default.
      assert.equal((await raw({ port: 80, path: `/?t=${ui.token}`, host: "127.0.0.1" })).status, 200);
      assert.equal((await raw({ port: 80, path: `/?t=${ui.token}`, host: "localhost" })).status, 200);
      assert.equal((await raw({ port: 80, path: `/?t=${ui.token}`, host: "127.0.0.1:80" })).status, 200);
      // Another port and another name are still other origins.
      assert.equal((await raw({ port: 80, path: `/?t=${ui.token}`, host: "127.0.0.1:81" })).status, 403);
      assert.equal((await raw({ port: 80, path: `/?t=${ui.token}`, host: "evil.test" })).status, 403);
    } finally {
      await ui.close();
    }
  });
});

test("sets the full header set including manifest connectDomains", async () => {
  await withHome(async (home) => {
    const capsule = await packCapsule(home, (draft) => {
      draft.capabilities.net = { allowed_hosts: ["api.example.com"], allow_localhost: false };
      draft.ui = {
        app: {
          resourceUri: "ui://hello",
          path: "ui/index.html",
          // A resource domain is *not* covered by the allowed_hosts invariant, so it must not widen
          // img-src: an image URL is an exfiltration channel the manifest never promised.
          csp: { connectDomains: ["https://api.example.com"], resourceDomains: ["https://cdn.evil.test"] },
        },
        local: { path: "ui/index.html" },
      };
    });
    await withUi({ capsule, home }, async (ui) => {
      const res = await raw({ port: ui.port, path: `/?t=${ui.token}` });
      assert.equal(res.status, 200);
      assert.equal(
        res.headers["content-security-policy"],
        "default-src 'none'; " +
          `script-src 'self' 'sha256-${INLINE_SCRIPT_SHA256}'; ` +
          "style-src 'self' 'unsafe-inline'; " +
          "img-src 'self' data:; " +
          "connect-src 'self' https://api.example.com; " +
          "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      );
      assert.equal(res.headers["x-content-type-options"], "nosniff");
      assert.equal(res.headers["x-frame-options"], "DENY");
      assert.equal(res.headers["referrer-policy"], "no-referrer");
      assert.equal(res.headers["cache-control"], "no-store");
      assert.equal(res.headers["cross-origin-resource-policy"], "same-origin");
      // Nothing may make this server readable by another origin.
      for (const header of Object.keys(res.headers)) {
        assert.ok(!header.startsWith("access-control-allow-"), `unexpected CORS header: ${header}`);
      }

      // Every response carries them, including the refusals.
      for (const path of ["/", "/nope", "/ui/nope.html"]) {
        const other = await raw({ port: ui.port, path });
        assert.ok(other.status === 401 || other.status === 404);
        assert.equal(other.headers["x-content-type-options"], "nosniff");
        assert.equal(other.headers["cache-control"], "no-store");
        assert.ok(String(other.headers["content-security-policy"]).startsWith("default-src 'none';"));
      }
    });
  });
});

test("rpc invokes a tool and lists the tools it will invoke", async () => {
  await withHome(async (home) => {
    const capsule = await packCapsule(home);
    await withUi({ capsule, home }, async (ui) => {
      const res = await raw({
        port: ui.port,
        path: "/rpc",
        method: "POST",
        headers: { authorization: `Bearer ${ui.token}`, "content-type": "application/json" },
        body: JSON.stringify({ tool: "greet", args: { name: "ada" } }),
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers["content-type"], "application/json");
      const body = JSON.parse(res.body) as {
        status: string;
        ok: boolean;
        tool: string;
        runId: string;
        value: { text: string; count: number };
      };
      assert.equal(body.status, "complete");
      assert.equal(body.ok, true);
      assert.equal(body.tool, "greet");
      assert.equal(body.value.text, "hello ada");
      assert.match(body.runId, /^[0-9a-f-]{36}$/);

      // The brief's alias for the same handler; the hardening is the handler's, so it is shared.
      const alias = await raw({
        port: ui.port,
        path: "/api/call",
        method: "POST",
        headers: { authorization: `Bearer ${ui.token}`, "content-type": "application/json" },
        body: JSON.stringify({ tool: "greet", args: { name: "bob" } }),
      });
      assert.equal(alias.status, 200);
      assert.equal((JSON.parse(alias.body) as { value: { text: string } }).value.text, "hello bob");

      const failed = await raw({
        port: ui.port,
        path: "/rpc",
        method: "POST",
        headers: { authorization: `Bearer ${ui.token}`, "content-type": "application/json" },
        body: JSON.stringify({ tool: "greet", args: {} }),
      });
      // A tool that refused its arguments is an outcome, not a transport failure.
      assert.equal(failed.status, 200);
      const failedBody = JSON.parse(failed.body) as { status: string; ok: boolean; error: { code: string } };
      assert.equal(failedBody.status, "complete");
      assert.equal(failedBody.ok, false);
      assert.equal(failedBody.error.code, "E_USAGE");

      const unknown = await raw({
        port: ui.port,
        path: "/rpc",
        method: "POST",
        headers: { authorization: `Bearer ${ui.token}`, "content-type": "application/json" },
        body: JSON.stringify({ tool: "capsule_info" }),
      });
      // A tool the UI does not serve is not callable by name either, built-in or otherwise.
      assert.equal((JSON.parse(unknown.body) as { ok: boolean; error: { code: string } }).error.code, "E_USAGE");

      const tools = await raw({ port: ui.port, path: `/api/tools?t=${ui.token}` });
      assert.equal(tools.status, 200);
      const listed = (JSON.parse(tools.body) as { tools: { name: string; effects: string[] }[] }).tools;
      assert.deepEqual(
        listed.map((tool) => tool.name),
        ["greet"],
      );
      assert.equal((await raw({ port: ui.port, path: "/api/tools" })).status, 401);
    });
  });
});

test("rpc rejects text/plain and oversized bodies", async () => {
  await withHome(async (home) => {
    const capsule = await packCapsule(home);
    await withUi({ capsule, home }, async (ui) => {
      const post = (headers: Record<string, string>, body: string): Promise<Res> =>
        raw({
          port: ui.port,
          path: "/rpc",
          method: "POST",
          headers: { authorization: `Bearer ${ui.token}`, ...headers },
          body,
        });

      // An HTML form can only ever send these three, which is what makes the check a CSRF gate.
      const call = JSON.stringify({ tool: "greet", args: { name: "ada" } });
      assert.equal((await post({ "content-type": "text/plain" }, call)).status, 415);
      assert.equal((await post({ "content-type": "application/x-www-form-urlencoded" }, call)).status, 415);
      assert.equal((await post({ "content-type": "multipart/form-data; boundary=x" }, call)).status, 415);
      assert.equal((await post({}, call)).status, 415);
      // A charset is part of the media type, not a different one.
      assert.equal((await post({ "content-type": "application/json; charset=utf-8" }, call)).status, 200);

      const oversized = await post(
        { "content-type": "application/json" },
        JSON.stringify({ tool: "greet", args: { name: "a".repeat(70_000) } }),
      );
      assert.equal(oversized.status, 413);

      const malformed = await post({ "content-type": "application/json" }, "{not json");
      assert.equal(malformed.status, 400);
      const noTool = await post({ "content-type": "application/json" }, JSON.stringify({ args: {} }));
      assert.equal(noTool.status, 400);
    });
  });
});

test("unknown static paths and traversal attempts 404", async () => {
  await withHome(async (home) => {
    const capsule = await packCapsule(home);
    await withUi({ capsule, home }, async (ui) => {
      const get = async (path: string): Promise<number> =>
        (await raw({ port: ui.port, path, headers: { authorization: `Bearer ${ui.token}` } })).status;

      // The page is also reachable as the container entry it is.
      assert.equal(await get("/ui/index.html"), 200);

      // Every one of these names a real file in the container or on disk. None of them is under
      // `ui/`, and the lookup is an exact match against the container's own entry names, so there is
      // no path to join and nothing to normalise.
      assert.equal(await get("/assets/../capsule.json"), 404);
      assert.equal(await get("/ui/../capsule.json"), 404);
      assert.equal(await get("/ui/..%2fcapsule.json"), 404);
      assert.equal(await get("/ui/%2e%2e/capsule.json"), 404);
      assert.equal(await get("/capsule.json"), 404);
      assert.equal(await get("/src/main.js"), 404);
      assert.equal(await get("/ui/../src/main.js"), 404);
      assert.equal(await get("/.capsule/signature.json"), 404);
      // The assertions that tell a raw path from a resolved one: were `.` and `..` normalised away,
      // both of these would land on the page that `/ui/index.html` serves.
      assert.equal(await get("/ui/sub/../index.html"), 404);
      assert.equal(await get("/ui/./index.html"), 404);
      assert.equal(await get("/ui/nope.html"), 404);
      assert.equal(await get("/ui/"), 404);
      assert.equal(await get("/ui"), 404);
      assert.equal(await get("/nope"), 404);

      // The routes that exist only answer the method they are for.
      assert.equal(
        (await raw({ port: ui.port, path: "/", method: "POST", headers: { authorization: `Bearer ${ui.token}` } }))
          .status,
        404,
      );
      assert.equal(
        (await raw({ port: ui.port, path: "/rpc", headers: { authorization: `Bearer ${ui.token}` } })).status,
        404,
      );
    });
  });
});

test("rpc reports input_required for an ungranted capability", async () => {
  await withHome(async (home) => {
    const capsule = await packCapsule(home, (draft) => {
      draft.capabilities.net = { allowed_hosts: ["api.example.com"], allow_localhost: false };
      draft.tools[0]!.effects = [...(draft.tools[0]!.effects ?? []), "net.fetch"];
    });
    await withUi({ capsule, home }, async (ui) => {
      const res = await raw({
        port: ui.port,
        path: "/rpc",
        method: "POST",
        headers: { authorization: `Bearer ${ui.token}`, "content-type": "application/json" },
        body: JSON.stringify({ tool: "greet", args: { name: "ada" } }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(JSON.parse(res.body), {
        status: "input_required",
        tool: "greet",
        missingGrants: ["net:api.example.com"],
      });
      // Nothing ran, so nothing was recorded and nothing was granted.
      assert.equal(existsSync(join(home, "grants.json")), false);
    });
  });
});

test("consent completes an allow-once call without persisting the grant", async () => {
  await withHome(async (home) => {
    const capsule = await packCapsule(home, (draft) => {
      draft.capabilities.net = { allowed_hosts: ["api.example.com"], allow_localhost: false };
      draft.tools[0]!.effects = [...(draft.tools[0]!.effects ?? []), "net.fetch"];
    });
    await withUi({ capsule, home }, async (ui) => {
      const consent = (decision: string): Promise<Res> =>
        raw({
          port: ui.port,
          path: "/rpc/consent",
          method: "POST",
          headers: { authorization: `Bearer ${ui.token}`, "content-type": "application/json" },
          body: JSON.stringify({
            tool: "greet",
            args: { name: "ada" },
            decisions: { "net:api.example.com": decision },
          }),
        });

      const denied = await consent("deny");
      assert.equal(denied.status, 200);
      const deniedBody = JSON.parse(denied.body) as { status: string; ok: boolean; error: { code: string } };
      assert.equal(deniedBody.ok, false);
      assert.equal(deniedBody.error.code, "E_POLICY");

      const once = await consent("allow-once");
      assert.equal(once.status, 200);
      const onceBody = JSON.parse(once.body) as { status: string; ok: boolean; value: { text: string } };
      assert.equal(onceBody.status, "complete");
      assert.equal(onceBody.ok, true);
      assert.equal(onceBody.value.text, "hello ada");
      // Once means once: an allow-once answer must never reach the store on disk.
      assert.equal(existsSync(join(home, "grants.json")), false);

      const always = await consent("always-allow");
      assert.equal((JSON.parse(always.body) as { ok: boolean }).ok, true);
      const store = JSON.parse(readFileSync(join(home, "grants.json"), "utf8")) as {
        capsules: Record<string, Record<string, boolean>>;
      };
      assert.equal(store.capsules[capsule.capsuleId]?.["net:api.example.com"], true);

      const unknownDecision = await consent("maybe");
      assert.equal(unknownDecision.status, 400);
    });
  });
});

test("close() releases the port", async () => {
  await withHome(async (home) => {
    const capsule = await packCapsule(home);
    const first = await startUiServer({ capsule, homeDir: home });
    const port = first.port;
    assert.equal((await raw({ port, path: `/?t=${first.token}` })).status, 200);

    await first.close();
    // Idempotent: the command closes on its own signal handler and the process may exit either way.
    await first.close();
    await assert.rejects(() => raw({ port, path: "/" }));

    // The proof that the port was released rather than left in a listening socket nobody holds.
    const second = await startUiServer({ capsule, homeDir: home, port });
    try {
      assert.equal(second.port, port);
      assert.notEqual(second.token, first.token);
      assert.equal((await raw({ port, path: `/?t=${second.token}` })).status, 200);
      assert.equal((await raw({ port, path: `/?t=${first.token}` })).status, 401);
    } finally {
      await second.close();
    }
  });
});

test("an idle server shuts itself down", async () => {
  await withHome(async (home) => {
    const capsule = await packCapsule(home);
    const ui = await startUiServer({ capsule, homeDir: home, idleTimeoutMs: 150 });
    try {
      // Each request resets the clock, so a server in use is never closed under its user.
      for (let i = 0; i < 3; i++) {
        await new Promise((resolve) => setTimeout(resolve, 60));
        assert.equal((await raw({ port: ui.port, path: `/?t=${ui.token}` })).status, 200);
      }
      await within(3000, "the idle shutdown", ui.closed);
      await assert.rejects(() => raw({ port: ui.port, path: "/" }));
    } finally {
      await ui.close();
    }
  });
});

test("a capsule with no local page serves the installer discovery page", async () => {
  await withHome(async (home) => {
    const capsule = await packCapsule(home, (draft) => {
      draft.meta.name = "hello-no-ui";
      delete draft.ui;
      for (const tool of draft.tools) delete tool.ui;
    });
    const ui = await startUiServer({ capsule, homeDir: home });
    try {
      const res = await raw({ port: ui.port, path: `/?t=${ui.token}` });
      assert.equal(res.status, 200);
      assert.equal(res.headers["content-type"], "text/html; charset=utf-8");
      assert.ok(res.body.includes("hello-no-ui"));
      assert.ok(res.body.includes("Capsule Identity &amp; Trust"));
      assert.ok(res.body.includes("Client Installation &amp; Sharing"));
      assert.ok(res.body.includes("Add to Claude Desktop"));
      assert.ok(res.body.includes("Cursor"));
      assert.ok(res.body.includes("VS Code"));
      assert.ok(res.body.includes("cursor://anysphere.cursor-deeplink/mcp/install?"));
      assert.ok(res.body.includes("vscode:mcp/install?"));
      assert.ok(res.body.includes("npx -y agent-capsule mcp"));
      assert.ok(res.body.includes("Declared Capabilities"));
      assert.ok(res.body.includes("greet"));
      assert.ok(res.body.includes("copy-btn"));
      assert.ok(!res.body.includes("onclick="));
      assert.ok(!res.body.includes("Open Capsule UI"));

      // Also accessible at /installer
      const installerRes = await raw({ port: ui.port, path: `/installer?t=${ui.token}` });
      assert.equal(installerRes.status, 200);
      assert.equal(installerRes.headers["content-type"], "text/html; charset=utf-8");
      assert.equal(installerRes.body, res.body);
    } finally {
      await ui.close();
    }
  });
});

test("a capsule with local page also serves the installer page at /installer", async () => {
  await withHome(async (home) => {
    const capsule = await packCapsule(home);
    const ui = await startUiServer({ capsule, homeDir: home });
    try {
      // Root serves the guest UI
      const rootRes = await raw({ port: ui.port, path: `/?t=${ui.token}` });
      assert.equal(rootRes.status, 200);
      assert.equal(rootRes.body, PAGE);

      // /installer serves the installer page
      const installerRes = await raw({ port: ui.port, path: `/installer?t=${ui.token}` });
      assert.equal(installerRes.status, 200);
      assert.equal(installerRes.headers["content-type"], "text/html; charset=utf-8");
      assert.ok(installerRes.body.includes("Capsule Identity &amp; Trust"));
      assert.ok(installerRes.body.includes("Client Installation &amp; Sharing"));
      assert.ok(installerRes.body.includes("Add to Claude Desktop"));
      assert.ok(installerRes.body.includes("cursor://anysphere.cursor-deeplink/mcp/install?"));
      assert.ok(installerRes.body.includes("Open Capsule UI"));
      assert.ok(installerRes.body.includes(`/?t=${ui.token}`));
      assert.ok(installerRes.body.includes("copy-btn"));
      assert.ok(!installerRes.body.includes("onclick="));
    } finally {
      await ui.close();
    }
  });
});
