import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { parseMeta } from "../src/mcp/meta.ts";
import {
  JSON_RPC_ERROR,
  createStdioTransport,
  type JsonRpcMessage,
  type Transport,
} from "../src/mcp/transport.ts";

const VALID_TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

function collector(): { out: Writable; text: () => string; messages: () => unknown[] } {
  const chunks: string[] = [];
  const out = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  const text = () => chunks.join("");
  return {
    out,
    text,
    messages: () =>
      text()
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as unknown),
  };
}

type Harness = {
  input: PassThrough;
  transport: Transport;
  received: JsonRpcMessage[];
  out: Writable;
  text: () => string;
  messages: () => unknown[];
  settle: () => Promise<void>;
};

function harness(
  opts: { maxLineLength?: number; handler?: (msg: JsonRpcMessage) => void | Promise<void> } = {},
): Harness {
  const input = new PassThrough();
  const sink = collector();
  const transport = createStdioTransport({
    in: input,
    out: sink.out,
    maxLineLength: opts.maxLineLength,
  });
  const received: JsonRpcMessage[] = [];
  transport.onMessage((msg) => {
    received.push(msg);
    return opts.handler?.(msg);
  });
  return {
    input,
    transport,
    received,
    out: sink.out,
    text: sink.text,
    messages: sink.messages,
    settle: async () => {
      for (let i = 0; i < 4; i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
  };
}

test("parseMeta returns undefined when params or _meta is not an object", () => {
  assert.equal(parseMeta(undefined), undefined);
  assert.equal(parseMeta(null), undefined);
  assert.equal(parseMeta("string"), undefined);
  assert.equal(parseMeta(42), undefined);
  assert.equal(parseMeta([{ _meta: {} }]), undefined);
  assert.equal(parseMeta({}), undefined);
  assert.equal(parseMeta({ _meta: null }), undefined);
  assert.equal(parseMeta({ _meta: "nope" }), undefined);
  assert.equal(parseMeta({ _meta: [] }), undefined);
  assert.deepEqual(parseMeta({ _meta: {} }), {});
});

test("parseMeta accepts a string or number progressToken and drops any other type", () => {
  assert.deepEqual(parseMeta({ _meta: { progressToken: "abc" } }), { progressToken: "abc" });
  assert.deepEqual(parseMeta({ _meta: { progressToken: 7 } }), { progressToken: 7 });
  assert.deepEqual(parseMeta({ _meta: { progressToken: 0 } }), { progressToken: 0 });
  assert.deepEqual(parseMeta({ _meta: { progressToken: "" } }), { progressToken: "" });

  for (const bad of [true, null, {}, [], Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(parseMeta({ _meta: { progressToken: bad } }), {}, `progressToken ${String(bad)}`);
  }
});

test("parseMeta keeps a W3C traceparent and drops a malformed one", () => {
  assert.deepEqual(parseMeta({ _meta: { traceparent: VALID_TRACEPARENT } }), {
    traceparent: VALID_TRACEPARENT,
  });

  const malformed = [
    "01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", // unsupported version
    "00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01", // uppercase hex
    "00-4bf92f3577b34da6a3ce929d0e0e473-00f067aa0ba902b7-01", // short trace id
    "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b-01", // short span id
    "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-1", // short flags
    `${VALID_TRACEPARENT}-extra`,
    ` ${VALID_TRACEPARENT}`,
    "",
    "not-a-traceparent",
    123,
    { version: "00" },
  ];
  for (const bad of malformed) {
    assert.deepEqual(parseMeta({ _meta: { traceparent: bad } }), {}, `traceparent ${String(bad)}`);
  }
});

test("parseMeta sanitizes caller name and kind and requires a usable name", () => {
  assert.deepEqual(parseMeta({ _meta: { caller: { name: "orchestrator", kind: "agent" } } }), {
    caller: { name: "orchestrator", kind: "agent" },
  });

  // ANSI escapes, zero-width characters and C0 controls are stripped by sanitizeModelText.
  assert.deepEqual(
    parseMeta({ _meta: { caller: { name: "\u001B[31mev\u200Bil\u0000", kind: "a\u001B[0mgent\n" } } }),
    { caller: { name: "evil", kind: "agent" } },
  );

  // A name that sanitizes away entirely leaves no caller at all.
  assert.deepEqual(parseMeta({ _meta: { caller: { name: "\u200B\u0000" } } }), {});
  assert.deepEqual(parseMeta({ _meta: { caller: { name: 5 } } }), {});
  assert.deepEqual(parseMeta({ _meta: { caller: {} } }), {});
  assert.deepEqual(parseMeta({ _meta: { caller: "orchestrator" } }), {});

  // A non-string or empty kind is dropped while the name survives.
  assert.deepEqual(parseMeta({ _meta: { caller: { name: "a", kind: 9 } } }), { caller: { name: "a" } });
  assert.deepEqual(parseMeta({ _meta: { caller: { name: "a", kind: "\u200B" } } }), {
    caller: { name: "a" },
  });
});

test("parseMeta collects every valid field at once and ignores unknown keys", () => {
  assert.deepEqual(
    parseMeta({
      _meta: {
        progressToken: 3,
        traceparent: VALID_TRACEPARENT,
        caller: { name: "cli", kind: "human" },
        unknown: { deep: true },
      },
    }),
    { progressToken: 3, traceparent: VALID_TRACEPARENT, caller: { name: "cli", kind: "human" } },
  );
});

test("createStdioTransport delivers requests, notifications and responses in order", async () => {
  const h = harness();
  h.input.write('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"greet"}}\n');
  h.input.write('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}\n');
  h.input.write('{"jsonrpc":"2.0","id":"a","result":{"ok":true}}\n');
  h.input.write('{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"nope"}}\n');
  await h.settle();

  assert.deepEqual(h.received, [
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "greet" } },
    { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } },
    { jsonrpc: "2.0", id: "a", result: { ok: true } },
    { jsonrpc: "2.0", id: null, error: { code: -32700, message: "nope" } },
  ]);
  assert.equal(h.text(), "");
});

test("createStdioTransport reassembles split chunks, CRLF lines and multi-byte characters", async () => {
  const h = harness();
  const line = Buffer.from('{"jsonrpc":"2.0","id":1,"method":"m","params":{"t":"héllo ✓"}}\r\n', "utf8");
  // Split inside the two-byte é so the decoder has to hold a partial code point.
  const cut = line.indexOf(Buffer.from("é", "utf8")) + 1;
  h.input.write(line.subarray(0, cut));
  await h.settle();
  assert.deepEqual(h.received, []);
  h.input.write(line.subarray(cut));
  // Blank and whitespace-only lines are ignored, not reported as errors.
  h.input.write("\n   \r\n");
  h.input.write('{"jsonrpc":"2.0","id":2,"met');
  h.input.write('hod":"m"}\n');
  await h.settle();

  assert.deepEqual(h.received, [
    { jsonrpc: "2.0", id: 1, method: "m", params: { t: "héllo ✓" } },
    { jsonrpc: "2.0", id: 2, method: "m" },
  ]);
  assert.equal(h.text(), "");
});

test("createStdioTransport answers malformed JSON with a parse error and id null", async () => {
  const h = harness();
  h.input.write("{not json\n");
  h.input.write('{"jsonrpc":"2.0","id":1,"method":"m"}\n');
  await h.settle();

  assert.equal(h.received.length, 1);
  const replies = h.messages();
  assert.equal(replies.length, 1);
  const reply = replies[0] as { jsonrpc: string; id: unknown; error: { code: number; message: string } };
  assert.equal(reply.jsonrpc, "2.0");
  assert.equal(reply.id, null);
  assert.equal(reply.error.code, JSON_RPC_ERROR.ParseError);
  assert.equal(reply.error.code, -32700);
  assert.equal(typeof reply.error.message, "string");
});

test("createStdioTransport rejects well-formed JSON that is not a JSON-RPC 2.0 message", async () => {
  const h = harness();
  const invalid = [
    "42",
    '"string"',
    "null",
    "[]",
    '[{"jsonrpc":"2.0","id":1,"method":"m"}]',
    "{}",
    '{"jsonrpc":"1.0","id":1,"method":"m"}',
    '{"jsonrpc":2.0,"id":1,"method":"m"}',
    '{"id":1,"method":"m"}',
    '{"jsonrpc":"2.0","id":1}',
    '{"jsonrpc":"2.0","method":42}',
    '{"jsonrpc":"2.0","id":{"a":1},"method":"m"}',
    '{"jsonrpc":"2.0","id":true,"method":"m"}',
    '{"jsonrpc":"2.0","id":1,"error":{"message":"no code"}}',
  ];
  for (const line of invalid) {
    h.input.write(`${line}\n`);
  }
  await h.settle();

  assert.deepEqual(h.received, []);
  const replies = h.messages() as Array<{ id: unknown; error: { code: number } }>;
  assert.equal(replies.length, invalid.length);
  for (const reply of replies) {
    assert.equal(reply.error.code, JSON_RPC_ERROR.InvalidRequest);
    assert.equal(reply.error.code, -32600);
  }
  // The id is echoed when it is usable, and null otherwise.
  assert.equal(replies[0]?.id, null);
  assert.equal(replies[9]?.id, 1);
});

test("send writes exactly one newline-terminated line per message with no embedded newline", () => {
  const h = harness();
  h.transport.send({ jsonrpc: "2.0", id: 1, result: { text: "two\nlines\r\nhere" } });
  h.transport.send({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } });
  h.transport.send({
    jsonrpc: "2.0",
    id: null,
    error: { code: JSON_RPC_ERROR.MethodNotFound, message: "unknown method", data: { method: "x" } },
  });

  const raw = h.text();
  assert.ok(raw.endsWith("\n"));
  const lines = raw.split("\n");
  assert.equal(lines.at(-1), "");
  assert.equal(lines.length - 1, 3);
  assert.deepEqual(JSON.parse(lines[0] ?? ""), {
    jsonrpc: "2.0",
    id: 1,
    result: { text: "two\nlines\r\nhere" },
  });
  assert.deepEqual(JSON.parse(lines[2] ?? ""), {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32601, message: "unknown method", data: { method: "x" } },
  });
});

test("a line over maxLineLength is reported once and skipped without losing the next message", async () => {
  const h = harness({ maxLineLength: 64 });
  // Whole over-long line arriving with its newline in one chunk.
  h.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "m", params: "x".repeat(200) })}\n`);
  await h.settle();
  let replies = h.messages() as Array<{ id: unknown; error: { code: number } }>;
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.error.code, JSON_RPC_ERROR.ParseError);
  assert.equal(replies[0]?.id, null);
  assert.deepEqual(h.received, []);

  // Over-long line dribbling in without a newline: still exactly one error, and the
  // remainder of the doomed line is discarded rather than parsed as a fresh message.
  h.input.write("y".repeat(100));
  await h.settle();
  h.input.write("z".repeat(100));
  await h.settle();
  h.input.write('junk-tail\n{"jsonrpc":"2.0","id":2,"method":"m"}\n');
  await h.settle();

  replies = h.messages() as Array<{ id: unknown; error: { code: number } }>;
  assert.equal(replies.length, 2);
  assert.equal(replies[1]?.error.code, JSON_RPC_ERROR.ParseError);
  assert.deepEqual(h.received, [{ jsonrpc: "2.0", id: 2, method: "m" }]);
});

test("a line at exactly maxLineLength is accepted", async () => {
  const padded = (length: number): string => {
    const skeleton = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "m", params: "" });
    return JSON.stringify({ jsonrpc: "2.0", id: 1, method: "m", params: "p".repeat(length - skeleton.length) });
  };
  const line = padded(64);
  assert.equal(line.length, 64);
  const h = harness({ maxLineLength: 64 });
  h.input.write(`${line}\n`);
  await h.settle();

  assert.equal(h.text(), "");
  assert.equal(h.received.length, 1);
});

test("a trailing line without a newline is delivered when the input ends", async () => {
  const h = harness();
  h.input.write('{"jsonrpc":"2.0","id":9,"method":"m"}');
  await h.settle();
  assert.deepEqual(h.received, []);
  h.input.end();
  await h.settle();

  assert.deepEqual(h.received, [{ jsonrpc: "2.0", id: 9, method: "m" }]);
});

test("close stops delivery and makes send a no-op", async () => {
  const h = harness();
  h.input.write('{"jsonrpc":"2.0","id":1,"method":"m"}\n');
  await h.settle();
  assert.equal(h.received.length, 1);

  h.transport.close();
  h.transport.close(); // idempotent
  h.transport.send({ jsonrpc: "2.0", id: 1, result: {} });
  h.input.write('{"jsonrpc":"2.0","id":2,"method":"m"}\n');
  h.input.write("{not json\n");
  await h.settle();

  assert.equal(h.received.length, 1);
  assert.equal(h.text(), "");
});

test("a rejected handler answers a request with an internal error and never crashes", async () => {
  const h = harness({
    handler: (msg) => {
      if ("method" in msg && msg.method === "boom") {
        return Promise.reject(new Error("handler exploded"));
      }
      if ("method" in msg && msg.method === "throw") {
        throw new Error("handler threw synchronously");
      }
    },
  });
  h.input.write('{"jsonrpc":"2.0","id":1,"method":"boom"}\n');
  h.input.write('{"jsonrpc":"2.0","id":"two","method":"throw"}\n');
  h.input.write('{"jsonrpc":"2.0","method":"boom"}\n');
  await h.settle();

  const replies = h.messages() as Array<{ id: unknown; error: { code: number } }>;
  // A synchronous throw is answered while the line is still being processed, a
  // rejected promise one microtask later, so match on id rather than position.
  assert.equal(replies.length, 2);
  for (const id of [1, "two"]) {
    const reply = replies.find((r) => r.id === id);
    assert.ok(reply !== undefined, `no reply for id ${String(id)}`);
    assert.equal(reply.error.code, JSON_RPC_ERROR.InternalError);
    assert.equal(reply.error.code, -32603);
  }
});

test("JSON_RPC_ERROR exposes the standard JSON-RPC 2.0 codes", () => {
  assert.deepEqual({ ...JSON_RPC_ERROR }, {
    ParseError: -32700,
    InvalidRequest: -32600,
    MethodNotFound: -32601,
    InvalidParams: -32602,
    InternalError: -32603,
  });
});

test("createStdioTransport.request sends JSON-RPC request and resolves on matching response", async () => {
  const h = harness();
  const reqPromise = h.transport.request("elicitation/create", { prompt: "allow?" });

  const messages = h.messages() as Array<{ jsonrpc: string; id: number; method: string; params: { prompt: string } }>;
  assert.equal(messages.length, 1);
  const sentReq = messages[0]!;
  assert.equal(sentReq.jsonrpc, "2.0");
  assert.equal(typeof sentReq.id, "number");
  assert.equal(sentReq.method, "elicitation/create");
  assert.deepEqual(sentReq.params, { prompt: "allow?" });

  // Simulate client response
  h.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: sentReq.id, result: { action: "accept" } })}\n`);
  await h.settle();

  const res = await reqPromise;
  assert.deepEqual(res, { action: "accept" });
  // The matched response was resolved, so it was not passed to onMessage received
  assert.equal(h.received.length, 0);
});

test("createStdioTransport.request rejects with RpcFailure on error response", async () => {
  const h = harness();
  const reqPromise = h.transport.request("elicitation/create", { prompt: "allow?" });

  const sentReq = (h.messages() as Array<{ id: number }>)[0]!;
  const assertion = assert.rejects(
    reqPromise,
    (err: unknown) => {
      const e = err as { code?: number; message?: string; name?: string };
      return e.code === -32602 && e.message === "rejected" && e.name === "RpcFailure";
    },
  );
  h.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: sentReq.id, error: { code: -32602, message: "rejected" } })}\n`);
  await h.settle();
  await assertion;
});

test("createStdioTransport.request times out when response is not received", async () => {
  const h = harness();
  const reqPromise = h.transport.request("slow/method", {}, { timeoutMs: 20 });

  await assert.rejects(
    async () => await reqPromise,
    (err: unknown) => {
      const e = err as { code?: number; message?: string };
      return e.code === JSON_RPC_ERROR.InternalError && (e.message?.includes("timed out") ?? false);
    },
  );
});

test("createStdioTransport.request rejects pending requests when transport is closed", async () => {
  const h = harness();
  const reqPromise = h.transport.request("slow/method", {});
  h.transport.close();

  await assert.rejects(
    async () => await reqPromise,
    (err: unknown) => {
      const e = err as { code?: number; message?: string };
      return e.code === JSON_RPC_ERROR.InternalError && e.message === "transport closed";
    },
  );

  // Calling request after close rejects immediately
  await assert.rejects(
    async () => await h.transport.request("after/close"),
    (err: unknown) => {
      const e = err as { code?: number; message?: string };
      return e.code === JSON_RPC_ERROR.InternalError && e.message === "transport closed";
    },
  );
});
