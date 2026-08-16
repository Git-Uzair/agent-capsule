import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { packDirectory } from "../src/format/capsule.ts";
import { createManagerServer, ELICITATION_TIMEOUT_MS } from "../src/mcp/manager/server.ts";
import { DECISION, DECISION_PROPERTY, ELICITATION_METHOD } from "../src/mcp/mrtr.ts";
import { MCP_PROTOCOL_VERSION, SERVER_INFO_META } from "../src/mcp/server.ts";
import {
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type Transport,
  type TransportRequestOptions,
} from "../src/mcp/transport.ts";
import { hasGrant, loadGrants } from "../src/security/grants.ts";

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");
const NET_HOST = "api.example.com";
const NET_GRANT = `net:${NET_HOST}`;

async function withHome(
  fn: (home: string, downloads: string) => Promise<void>,
): Promise<void> {
  const home = join(".tmp", `home-elicitation-${randomUUID()}`);
  const downloads = join(".tmp", `downloads-elicitation-${randomUUID()}`);
  const previousHome = process.env.CAPSULE_HOME;
  process.env.CAPSULE_HOME = home;
  mkdirSync(home, { recursive: true });
  mkdirSync(downloads, { recursive: true });
  try {
    await fn(home, downloads);
  } finally {
    if (previousHome === undefined) delete process.env.CAPSULE_HOME;
    else process.env.CAPSULE_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(downloads, { recursive: true, force: true });
  }
}

async function packNetCapsule(home: string, name: string = "netapp"): Promise<string> {
  const dir = join(home, `src-${name}-${randomUUID()}`);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "main.js"),
    'globalThis.tools = { pull() { return "pulled data"; } };',
  );
  writeFileSync(
    join(dir, "capsule.json"),
    JSON.stringify({
      spec_version: "0.1.0",
      meta: { name, version: "1.0.0", title: name, description: `Net test capsule ${name}.` },
      runtime: { type: "quickjs-1", entry: "src/main.js", timeout_ms: 2000 },
      capabilities: { net: { allowed_hosts: [NET_HOST] } },
      tools: [
        {
          name: "pull",
          title: "Pull",
          description: "Fetches remote data.",
          inputSchema: { type: "object" },
          effects: ["net.fetch"],
        },
      ],
    }),
  );
  const out = join(home, `${name}-${randomUUID()}.capsule`);
  await packDirectory(dir, out, { homeDir: home });
  return out;
}

function createMockTransport(opts: {
  onRequest?: (method: string, params: unknown, id: JsonRpcId, reqOpts?: TransportRequestOptions) => Promise<unknown> | unknown;
} = {}): {
  transport: Transport;
  sent: JsonRpcMessage[];
  deliver(msg: JsonRpcMessage): Promise<void>;
  requests: Array<{ id: JsonRpcId; method: string; params: unknown; opts?: TransportRequestOptions }>;
} {
  const sent: JsonRpcMessage[] = [];
  const requests: Array<{ id: JsonRpcId; method: string; params: unknown; opts?: TransportRequestOptions }> = [];
  let onMsg: ((msg: JsonRpcMessage) => void | Promise<void>) | undefined;
  let nextReqId = 1;
  const pendingRequests = new Map<
    JsonRpcId,
    { resolve: (val: unknown) => void; reject: (err: unknown) => void; timer?: NodeJS.Timeout }
  >();

  const transport: Transport = {
    onMessage(handler) {
      onMsg = handler;
    },
    send(msg) {
      sent.push(msg);
    },
    async request(method, params, reqOpts) {
      const id = nextReqId++;
      requests.push({ id, method, params, opts: reqOpts });
      sent.push({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
      if (opts.onRequest !== undefined) {
        return await opts.onRequest(method, params, id, reqOpts);
      }
      return new Promise((resolve, reject) => {
        let timer: NodeJS.Timeout | undefined;
        if (reqOpts?.timeoutMs !== undefined && reqOpts.timeoutMs > 0) {
          timer = setTimeout(() => {
            pendingRequests.delete(id);
            reject(new Error(`request ${method} timed out after ${reqOpts.timeoutMs}ms`));
          }, reqOpts.timeoutMs);
          timer.unref?.();
        }
        pendingRequests.set(id, { resolve, reject, timer });
      });
    },
    close() {},
  };

  return {
    transport,
    sent,
    requests,
    async deliver(msg: JsonRpcMessage) {
      if (!("method" in msg) && "id" in msg && msg.id !== null && pendingRequests.has(msg.id)) {
        const pending = pendingRequests.get(msg.id)!;
        pendingRequests.delete(msg.id);
        if (pending.timer !== undefined) {
          clearTimeout(pending.timer);
        }
        if ("error" in msg) {
          pending.reject(new Error(msg.error.message));
        } else {
          pending.resolve(msg.result);
        }
        return;
      }
      if (onMsg) await onMsg(msg);
    },
  };
}

let nextId = 0;
function rpc(method: string, params?: unknown): JsonRpcRequest {
  nextId += 1;
  return { jsonrpc: "2.0", id: nextId, method, ...(params === undefined ? {} : { params }) };
}

test("Manager elicitation: user answers 'always-allow' -> executes tool and persists grant to grants.json", async () => {
  await withHome(async (home, downloads) => {
    const capsulePath = await packNetCapsule(home, "netcap");
    let elicitationCount = 0;

    const mock = createMockTransport({
      onRequest: (method, _params) => {
        if (method === ELICITATION_METHOD) {
          elicitationCount += 1;
          return {
            action: "accept",
            content: { [DECISION_PROPERTY]: DECISION.alwaysAllow },
          };
        }
        throw new Error(`unexpected request: ${method}`);
      },
    });

    const server = createManagerServer({ homeDir: home, downloadsDir: downloads });
    server.serve(mock.transport);

    // Initialize with elicitation capability
    await mock.deliver(
      rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: { elicitation: {} },
      }),
    );
    await server.drain();

    // Install net capsule
    await mock.deliver(
      rpc("tools/call", {
        name: "capsule_install",
        arguments: { path: capsulePath },
      }),
    );
    await server.drain();

    const installMsg = mock.sent.find(
      (m) => "result" in m && (m.result as { structuredContent?: { name?: string } }).structuredContent?.name === "netcap",
    ) as { result: { structuredContent: { capsuleId: string } } };
    assert.ok(installMsg);
    const capsuleId = installMsg.result.structuredContent.capsuleId;

    // Call gateway tool netcap__pull
    await mock.deliver(
      rpc("tools/call", {
        name: "netcap__pull",
        arguments: {},
      }),
    );
    await server.drain();

    // Verify elicitation request occurred
    assert.equal(elicitationCount, 1);
    const elicitReq = mock.requests.find((r) => r.method === ELICITATION_METHOD);
    assert.ok(elicitReq);
    assert.match(
      String((elicitReq.params as { message: string }).message),
      new RegExp(NET_GRANT.replace(".", "\\.")),
    );

    // Find tool response
    const pullRes = mock.sent.filter((m) => "result" in m).at(-1) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    assert.ok(pullRes);
    assert.equal(pullRes.result.isError, false);
    assert.equal(pullRes.result.content[0]?.text, "pulled data");

    // Verify grant is persisted in grants.json
    const store = loadGrants(home);
    assert.equal(hasGrant(store, capsuleId, NET_GRANT), true);

    // Subsequent tool call runs without triggering elicitation again
    elicitationCount = 0;
    await mock.deliver(
      rpc("tools/call", {
        name: "netcap__pull",
        arguments: {},
      }),
    );
    await server.drain();

    assert.equal(elicitationCount, 0);
    const secondPullRes = mock.sent.filter((m) => "result" in m).at(-1) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    assert.ok(secondPullRes);
    assert.equal(secondPullRes.result.isError, false);
    assert.equal(secondPullRes.result.content[0]?.text, "pulled data");
  });
});

test("Manager elicitation: user answers 'allow-once' -> executes tool, grants.json untouched, next call elicits again", async () => {
  await withHome(async (home, downloads) => {
    const capsulePath = await packNetCapsule(home, "netcap_once");
    let elicitationCount = 0;

    const mock = createMockTransport({
      onRequest: (method, _params) => {
        if (method === ELICITATION_METHOD) {
          elicitationCount += 1;
          return {
            action: "accept",
            content: { [DECISION_PROPERTY]: DECISION.allowOnce },
          };
        }
        throw new Error(`unexpected request: ${method}`);
      },
    });

    const server = createManagerServer({ homeDir: home, downloadsDir: downloads });
    server.serve(mock.transport);

    // Initialize with elicitation capability
    await mock.deliver(
      rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: { elicitation: {} },
      }),
    );
    await server.drain();

    // Install net capsule
    await mock.deliver(
      rpc("tools/call", {
        name: "capsule_install",
        arguments: { path: capsulePath },
      }),
    );
    await server.drain();

    const installMsg = mock.sent.find(
      (m) => "result" in m && (m.result as { structuredContent?: { name?: string } }).structuredContent?.name === "netcap_once",
    ) as { result: { structuredContent: { capsuleId: string } } };
    assert.ok(installMsg);
    const capsuleId = installMsg.result.structuredContent.capsuleId;

    // Call netcap_once__pull
    await mock.deliver(
      rpc("tools/call", {
        name: "netcap_once__pull",
        arguments: {},
      }),
    );
    await server.drain();

    assert.equal(elicitationCount, 1);
    const pullRes = mock.sent.filter((m) => "result" in m).at(-1) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    assert.ok(pullRes);
    assert.equal(pullRes.result.isError, false);
    assert.equal(pullRes.result.content[0]?.text, "pulled data");

    // Verify grant was NOT persisted to disk
    const store = loadGrants(home);
    assert.equal(hasGrant(store, capsuleId, NET_GRANT), false);

    // Second call triggers elicitation again
    await mock.deliver(
      rpc("tools/call", {
        name: "netcap_once__pull",
        arguments: {},
      }),
    );
    await server.drain();

    assert.equal(elicitationCount, 2);
  });
});

test("Manager elicitation: user answers 'deny' -> returns error result with E_POLICY and isError: true", async () => {
  await withHome(async (home, downloads) => {
    const capsulePath = await packNetCapsule(home, "netcap_deny");
    let elicitationCount = 0;

    const mock = createMockTransport({
      onRequest: (method, _params) => {
        if (method === ELICITATION_METHOD) {
          elicitationCount += 1;
          return {
            action: "accept",
            content: { [DECISION_PROPERTY]: DECISION.deny },
          };
        }
        throw new Error(`unexpected request: ${method}`);
      },
    });

    const server = createManagerServer({ homeDir: home, downloadsDir: downloads });
    server.serve(mock.transport);

    await mock.deliver(
      rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: { elicitation: {} },
      }),
    );
    await server.drain();

    await mock.deliver(
      rpc("tools/call", {
        name: "capsule_install",
        arguments: { path: capsulePath },
      }),
    );
    await server.drain();

    const installMsg = mock.sent.find(
      (m) => "result" in m && (m.result as { structuredContent?: { name?: string } }).structuredContent?.name === "netcap_deny",
    ) as { result: { structuredContent: { capsuleId: string } } };
    const capsuleId = installMsg.result.structuredContent.capsuleId;

    // Call netcap_deny__pull
    await mock.deliver(
      rpc("tools/call", {
        name: "netcap_deny__pull",
        arguments: {},
      }),
    );
    await server.drain();

    assert.equal(elicitationCount, 1);
    const pullRes = mock.sent.filter((m) => "result" in m).at(-1) as {
      result: { isError: boolean; content: Array<{ text: string }>; _meta?: { code?: string } };
    };
    assert.ok(pullRes);
    assert.equal(pullRes.result.isError, true);
    assert.equal(pullRes.result._meta?.code, "E_POLICY");
    assert.match(pullRes.result.content[0]?.text ?? "", /E_POLICY: user denied net:api\.example\.com/);

    // Grants store untouched
    assert.equal(hasGrant(loadGrants(home), capsuleId, NET_GRANT), false);
  });
});

test("Manager elicitation: client declines or cancels -> returns error result with E_POLICY", async () => {
  await withHome(async (home, downloads) => {
    const capsulePath = await packNetCapsule(home, "netcap_decline");

    const mock = createMockTransport({
      onRequest: (method, _params) => {
        if (method === ELICITATION_METHOD) {
          return { action: "decline" };
        }
        throw new Error(`unexpected request: ${method}`);
      },
    });

    const server = createManagerServer({ homeDir: home, downloadsDir: downloads });
    server.serve(mock.transport);

    await mock.deliver(
      rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: { elicitation: {} },
      }),
    );
    await server.drain();

    await mock.deliver(
      rpc("tools/call", {
        name: "capsule_install",
        arguments: { path: capsulePath },
      }),
    );
    await server.drain();

    // Call netcap_decline__pull
    await mock.deliver(
      rpc("tools/call", {
        name: "netcap_decline__pull",
        arguments: {},
      }),
    );
    await server.drain();

    const pullRes = mock.sent.filter((m) => "result" in m).at(-1) as {
      result: { isError: boolean; content: Array<{ text: string }>; _meta?: { code?: string } };
    };
    assert.ok(pullRes);
    assert.equal(pullRes.result.isError, true);
    assert.equal(pullRes.result._meta?.code, "E_POLICY");
    assert.match(pullRes.result.content[0]?.text ?? "", /E_POLICY: user denied net:api\.example\.com/);
  });
});

test("Manager elicitation fallback: client WITHOUT elicitation capability gets E_CONSENT text result", async () => {
  await withHome(async (home, downloads) => {
    const capsulePath = await packNetCapsule(home, "netcap_nocap");
    let elicitationCalled = false;

    const mock = createMockTransport({
      onRequest: () => {
        elicitationCalled = true;
        return { action: "accept", content: { [DECISION_PROPERTY]: DECISION.alwaysAllow } };
      },
    });

    const server = createManagerServer({ homeDir: home, downloadsDir: downloads });
    server.serve(mock.transport);

    // Initialize WITHOUT elicitation capability
    await mock.deliver(
      rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
      }),
    );
    await server.drain();

    await mock.deliver(
      rpc("tools/call", {
        name: "capsule_install",
        arguments: { path: capsulePath },
      }),
    );
    await server.drain();

    // Call tool
    await mock.deliver(
      rpc("tools/call", {
        name: "netcap_nocap__pull",
        arguments: {},
      }),
    );
    await server.drain();

    // No elicitation requests sent to client
    assert.equal(elicitationCalled, false);

    // Received E_CONSENT text error
    const pullRes = mock.sent.filter((m) => "result" in m).at(-1) as {
      result: { isError: boolean; content: Array<{ text: string }>; _meta?: { code?: string; grants?: string[] } };
    };
    assert.ok(pullRes);
    assert.equal(pullRes.result.isError, true);
    assert.equal(pullRes.result._meta?.code, "E_CONSENT");
    assert.deepEqual(pullRes.result._meta?.grants, [NET_GRANT]);
    assert.match(pullRes.result.content[0]?.text ?? "", /^E_CONSENT: this tool needs user consent for: net:api\.example\.com/);
  });
});

test("Manager elicitation: accept response without valid decision returns readable refusal with E_POLICY and isError: true", async () => {
  await withHome(async (home, downloads) => {
    const capsulePath = await packNetCapsule(home, "netcap_nodecision");

    const mock = createMockTransport({
      onRequest: (method, _params) => {
        if (method === ELICITATION_METHOD) {
          // Accept action, but content has no valid decision property
          return {
            action: "accept",
            content: {},
          };
        }
        throw new Error(`unexpected request: ${method}`);
      },
    });

    const server = createManagerServer({ homeDir: home, downloadsDir: downloads });
    server.serve(mock.transport);

    await mock.deliver(
      rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: { elicitation: {} },
      }),
    );
    await server.drain();

    await mock.deliver(
      rpc("tools/call", {
        name: "capsule_install",
        arguments: { path: capsulePath },
      }),
    );
    await server.drain();

    const installMsg = mock.sent.find(
      (m) => "result" in m && (m.result as { structuredContent?: { name?: string } }).structuredContent?.name === "netcap_nodecision",
    ) as { result: { structuredContent: { capsuleId: string } } };
    const capsuleId = installMsg.result.structuredContent.capsuleId;

    // Call netcap_nodecision__pull
    await mock.deliver(
      rpc("tools/call", {
        name: "netcap_nodecision__pull",
        arguments: {},
      }),
    );
    await server.drain();

    const pullRes = mock.sent.filter((m) => "result" in m).at(-1) as {
      result: {
        resultType?: string;
        isError: boolean;
        content: Array<{ text: string }>;
        _meta?: { code?: string; grants?: string[]; [key: string]: unknown };
      };
    };
    assert.ok(pullRes);
    assert.equal(pullRes.result.resultType, "complete");
    assert.equal(pullRes.result.isError, true);
    assert.equal(pullRes.result._meta?.code, "E_POLICY");
    assert.deepEqual(pullRes.result._meta?.grants, [NET_GRANT]);
    assert.match(pullRes.result.content[0]?.text ?? "", /E_POLICY: user denied net:api\.example\.com/);
    // An answer the server could not read is not a denial anybody made, and the refusal says so.
    assert.match(pullRes.result.content[0]?.text ?? "", /could not be read/);
    // The refusal is built by the shared result builder, so it carries the routed capsule's identity.
    assert.deepEqual(pullRes.result._meta?.[SERVER_INFO_META], {
      name: "capsule/netcap_nodecision",
      version: "1.0.0",
    });
    assert.equal(hasGrant(loadGrants(home), capsuleId, NET_GRANT), false);
  });
});

test("Manager elicitation: accept response with invalid decision value returns readable refusal with E_POLICY", async () => {
  await withHome(async (home, downloads) => {
    const capsulePath = await packNetCapsule(home, "netcap_invaliddecision");

    const mock = createMockTransport({
      onRequest: (method, _params) => {
        if (method === ELICITATION_METHOD) {
          // Accept action, but content has invalid decision value
          return {
            action: "accept",
            content: { [DECISION_PROPERTY]: "not-a-valid-choice" },
          };
        }
        throw new Error(`unexpected request: ${method}`);
      },
    });

    const server = createManagerServer({ homeDir: home, downloadsDir: downloads });
    server.serve(mock.transport);

    await mock.deliver(
      rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: { elicitation: {} },
      }),
    );
    await server.drain();

    await mock.deliver(
      rpc("tools/call", {
        name: "capsule_install",
        arguments: { path: capsulePath },
      }),
    );
    await server.drain();

    // Call netcap_invaliddecision__pull
    await mock.deliver(
      rpc("tools/call", {
        name: "netcap_invaliddecision__pull",
        arguments: {},
      }),
    );
    await server.drain();

    const pullRes = mock.sent.filter((m) => "result" in m).at(-1) as {
      result: {
        resultType?: string;
        isError: boolean;
        content: Array<{ text: string }>;
        _meta?: { code?: string };
      };
    };
    assert.ok(pullRes);
    assert.equal(pullRes.result.resultType, "complete");
    assert.equal(pullRes.result.isError, true);
    assert.equal(pullRes.result._meta?.code, "E_POLICY");
    assert.match(pullRes.result.content[0]?.text ?? "", /E_POLICY: user denied net:api\.example\.com/);
  });
});

test("Manager elicitation: transport request passes timeoutMs and unanswered elicitation frees queue for subsequent requests", async () => {
  await withHome(async (home, downloads) => {
    const capsulePath = await packNetCapsule(home, "netcap_timeout");
    let passedTimeoutMs: number | undefined;

    const mock = createMockTransport({
      onRequest: (method, _params, _id, reqOpts) => {
        if (method === ELICITATION_METHOD) {
          passedTimeoutMs = reqOpts?.timeoutMs;
          // Simulate timeout error
          throw new Error(`request ${method} timed out after ${reqOpts?.timeoutMs}ms`);
        }
        throw new Error(`unexpected request: ${method}`);
      },
    });

    const server = createManagerServer({ homeDir: home, downloadsDir: downloads });
    server.serve(mock.transport);

    await mock.deliver(
      rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: { elicitation: {} },
      }),
    );
    await server.drain();

    await mock.deliver(
      rpc("tools/call", {
        name: "capsule_install",
        arguments: { path: capsulePath },
      }),
    );
    await server.drain();

    // Call tool that requires consent
    await mock.deliver(
      rpc("tools/call", {
        name: "netcap_timeout__pull",
        arguments: {},
      }),
    );
    await server.drain();

    // Verify explicit timeout was passed to transport.request
    assert.equal(passedTimeoutMs, ELICITATION_TIMEOUT_MS);
    assert.equal(passedTimeoutMs, 60_000);

    // Verify tool call failed gracefully with E_POLICY
    const pullRes = mock.sent.filter((m) => "result" in m).at(-1) as {
      result: {
        resultType?: string;
        isError: boolean;
        content: Array<{ text: string }>;
        _meta?: { code?: string };
      };
    };
    assert.ok(pullRes);
    assert.equal(pullRes.result.resultType, "complete");
    assert.equal(pullRes.result.isError, true);
    assert.equal(pullRes.result._meta?.code, "E_POLICY");
    assert.match(pullRes.result.content[0]?.text ?? "", /E_POLICY: user denied net:api\.example\.com/);

    // Verify subsequent request (tools/list) can run and drain settles without hanging
    await mock.deliver(rpc("tools/list"));
    await server.drain();

    const listRes = mock.sent.filter((m) => "result" in m).at(-1) as {
      result: { tools: Array<{ name: string }> };
    };
    assert.ok(listRes);
    assert.ok(Array.isArray(listRes.result.tools));
    assert.ok(listRes.result.tools.some((t) => t.name === "netcap_timeout__pull"));
  });
});

test("CLI manager: stdio roundtrip with elicitation and stdout purity", async () => {
  await withHome(async (home) => {
    const capsulePath = await packNetCapsule(home, "netcli");

    const child = spawn(process.execPath, [CLI, "manager", "--home", home], {
      env: { ...process.env, CAPSULE_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const lines: string[] = [];
    const rl = createInterface({ input: child.stdout });

    let resolveInit: (() => void) | undefined;
    let resolveInstall: (() => void) | undefined;
    let resolveElicit: (() => void) | undefined;
    let resolvePull: (() => void) | undefined;

    const initPromise = new Promise<void>((r) => { resolveInit = r; });
    const installPromise = new Promise<void>((r) => { resolveInstall = r; });
    const elicitPromise = new Promise<void>((r) => { resolveElicit = r; });
    const pullPromise = new Promise<void>((r) => { resolvePull = r; });

    let elicitRequestId: number | undefined;

    rl.on("line", (line) => {
      if (line.trim() === "") return;
      lines.push(line);
      let parsed: { id?: number; method?: string; result?: { structuredContent?: { name?: string; text?: string } } };
      try {
        parsed = JSON.parse(line);
      } catch {
        assert.fail(`Non-JSON line emitted on stdout: ${line}`);
      }

      if (parsed.id === 1 && parsed.result !== undefined) {
        resolveInit?.();
      } else if (parsed.id === 2 && parsed.result !== undefined) {
        resolveInstall?.();
      } else if (parsed.method === "elicitation/create" && typeof parsed.id === "number") {
        elicitRequestId = parsed.id;
        resolveElicit?.();
      } else if (parsed.id === 3 && parsed.result !== undefined) {
        resolvePull?.();
      }
    });

    // 1. Send initialize with elicitation capability
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: { elicitation: {} },
        },
      })}\n`,
    );
    await initPromise;

    // 2. Install capsule
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "capsule_install", arguments: { path: capsulePath } },
      })}\n`,
    );
    await installPromise;

    // 3. Call netcli__pull
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "netcli__pull", arguments: {} },
      })}\n`,
    );
    await elicitPromise;

    assert.ok(elicitRequestId !== undefined);

    // 4. Client responds to elicitation with always-allow
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: elicitRequestId,
        result: {
          action: "accept",
          content: { [DECISION_PROPERTY]: DECISION.alwaysAllow },
        },
      })}\n`,
    );
    await pullPromise;

    child.stdin.end();
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));

    // Verify all stdout lines are valid JSON
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line));
    }

    // Verify pull result
    const pullLine = lines.find((l) => {
      const parsed = JSON.parse(l);
      return parsed.id === 3;
    });
    assert.ok(pullLine);
    const pullParsed = JSON.parse(pullLine);
    assert.equal(pullParsed.result.isError, false);
    assert.equal(pullParsed.result.content[0].text, "pulled data");
  });
});
