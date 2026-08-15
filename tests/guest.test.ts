import { test } from "node:test";
import assert from "node:assert/strict";
import { CapsuleError, type CapsuleErrorCode } from "../src/core/errors.ts";
import type { EffectName } from "../src/format/manifest.ts";
import type { EffectDispatch } from "../src/runtime/effects.ts";
import { runGuest } from "../src/runtime/guest.ts";

const capsuleError =
  (code: CapsuleErrorCode, message?: RegExp) =>
  (e: unknown): boolean =>
    e instanceof CapsuleError && e.code === code && (message === undefined || message.test(e.message));

/** The clock port answers with one fixed instant, so every run sees the same "now". */
const CLOCK = "2026-01-01T00:00:00.000Z";
const CLOCK_MS = 1767225600000;

const RUNTIME = { memory_limit_mb: 32, timeout_ms: 5000, determinism: "strict" };

type Call = { op: EffectName; params: unknown };

/**
 * A fake effect port: it answers the deterministic ops with fixed values and records what the guest
 * asked for, which is how a test can tell "the prelude routed this through the port" apart from "the
 * guest had its own clock or entropy".
 */
function recorder(): { calls: Call[]; dispatch: EffectDispatch } {
  const calls: Call[] = [];
  const dispatch: EffectDispatch = async (_tool, op, params) => {
    calls.push({ op, params });
    switch (op) {
      case "clock.now":
        return CLOCK;
      case "random.bytes": {
        const n = (params as { n?: number }).n ?? 16;
        return "11".repeat(n);
      }
      case "log.write":
        return true;
      case "kv.get":
        return null;
      case "kv.set":
        return true;
      default:
        throw new CapsuleError("E_POLICY", `tool did not declare effect ${op}`, { op });
    }
  };
  return { calls, dispatch };
}

function run(
  source: string,
  opts: { tool?: string; args?: unknown; dispatch?: EffectDispatch; runtime?: Partial<typeof RUNTIME> } = {},
): Promise<unknown> {
  return runGuest({
    source,
    entryPath: "src/main.js",
    runtime: { ...RUNTIME, ...opts.runtime },
    tool: opts.tool ?? "greet",
    args: opts.args ?? {},
    dispatch: opts.dispatch ?? recorder().dispatch,
  });
}

test("runs a tool and returns its JSON value", async () => {
  const port = recorder();
  const value = await run(
    `globalThis.tools = {
       greet(args) {
         capsule.log("greeting " + args.name);
         return { text: "hello " + args.name };
       },
     };`,
    { args: { name: "ada" }, dispatch: port.dispatch },
  );

  assert.deepEqual(value, { text: "hello ada" });
  assert.deepEqual(port.calls, [{ op: "log.write", params: { message: "greeting ada" } }]);
});

test("Date.now() and new Date() come from the clock port", async () => {
  const port = recorder();
  const value = await run(
    `globalThis.tools = {
       greet: () => ({ now: Date.now(), constructed: new Date().getTime(), iso: capsule.now() }),
     };`,
    { dispatch: port.dispatch },
  );

  assert.deepEqual(value, { now: CLOCK_MS, constructed: CLOCK_MS, iso: CLOCK });
  assert.deepEqual(
    port.calls.map((call) => call.op),
    ["clock.now", "clock.now", "clock.now"],
  );
});

test("Math.random() is deterministic across two runs", async () => {
  const source = `globalThis.tools = { greet: () => [Math.random(), capsule.random(4)] };`;
  const first = recorder();
  const second = recorder();

  const one = await run(source, { dispatch: first.dispatch });
  const two = await run(source, { dispatch: second.dispatch });

  assert.deepEqual(one, two);
  assert.deepEqual(first.calls, [
    { op: "random.bytes", params: { n: 7 } },
    { op: "random.bytes", params: { n: 4 } },
  ]);
  // Entropy that came from the port is a number in [0, 1), not the host's Math.random.
  const [rolled] = one as [number, string];
  assert.ok(rolled >= 0 && rolled < 1, `expected a unit interval value, got ${rolled}`);
});

test("the guest cannot see __capsule or host globals", async () => {
  const value = await run(
    `globalThis.tools = {
       greet: () => ({
         capsuleRaw: typeof __capsule,
         process: typeof process,
         require: typeof require,
         fetch: typeof fetch,
         wasm: typeof WebAssembly,
         timer: typeof setTimeout,
         abi: typeof capsule,
         frozen: Object.isFrozen(capsule),
       }),
     };`,
  );

  assert.deepEqual(value, {
    capsuleRaw: "undefined",
    process: "undefined",
    require: "undefined",
    fetch: "undefined",
    wasm: "undefined",
    timer: "undefined",
    abi: "object",
    frozen: true,
  });
});

test("an infinite loop is interrupted", async () => {
  await assert.rejects(
    () => run(`globalThis.tools = { greet: () => { while (true) {} } };`, { runtime: { timeout_ms: 200 } }),
    capsuleError("E_TIMEOUT", /^tool exceeded timeout_ms$/),
  );
});

test("a memory hog is stopped", async () => {
  const source = `globalThis.tools = {
    greet: () => {
      const held = [];
      for (;;) held.push("x".repeat(4096));
      return held.length;
    },
  };`;

  await assert.rejects(
    () => run(source, { runtime: { memory_limit_mb: 2 } }),
    (e: unknown) =>
      e instanceof CapsuleError && (e.code === "E_GUEST" || e.code === "E_TIMEOUT") && e.message.length > 0,
  );

  // The same limit still runs an ordinary tool: the hog was stopped by its appetite, not by a limit
  // too small to start the guest at all.
  assert.deepEqual(
    await run(`globalThis.tools = { greet: () => ({ ok: capsule.now() }) };`, { runtime: { memory_limit_mb: 2 } }),
    { ok: CLOCK },
  );
});

test("a guest throw becomes E_GUEST with sanitised text", async () => {
  await assert.rejects(
    () =>
      run(
        `globalThis.tools = {
           greet: () => { throw new Error("bad \\u001B[31mred\\u001B[0m \\u200Bthing"); },
         };`,
      ),
    capsuleError("E_GUEST", /^bad red thing$/),
  );
});

test("an unknown tool name fails", async () => {
  await assert.rejects(
    () => run(`globalThis.tools = { greet: () => 1 };`, { tool: "missing" }),
    capsuleError("E_GUEST", /^tool not implemented: missing$/),
  );

  // A capsule that never installed the ABI object fails the same way, rather than throwing on the
  // property read.
  await assert.rejects(() => run(`1 + 1;`), capsuleError("E_GUEST", /^tool not implemented: greet$/));
});

test("a tool result that is not JSON is rejected", async () => {
  await assert.rejects(
    () => run(`globalThis.tools = { greet: () => () => 1 };`),
    capsuleError("E_GUEST", /^tool returned a non-JSON value$/),
  );

  await assert.rejects(
    () => run(`globalThis.tools = { greet: () => ({ big: 1n }) };`),
    capsuleError("E_GUEST", /^tool returned a non-JSON value$/),
  );
});

test("an effect error reaches the guest as a catchable error", async () => {
  const value = await run(
    `globalThis.tools = {
       greet: () => {
         try {
           capsule.fetch("https://example.com");
           return { caught: false };
         } catch (e) {
           return { caught: true, code: e.code, message: e.message };
         }
       },
     };`,
  );

  assert.deepEqual(value, {
    caught: true,
    code: "E_POLICY",
    message: "tool did not declare effect net.fetch",
  });
});
