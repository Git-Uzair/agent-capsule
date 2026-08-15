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

test("Date reached through its prototype is still the clock port", async () => {
  // `Date` is reachable by more than its global name: every date instance's prototype names its
  // constructor, and that reference has to be the port's clock too, or the host's wall clock is one
  // property read away. The zone is part of the same answer — a host offset would make the same
  // instant format differently on two machines.
  const port = recorder();
  const value = await run(
    `globalThis.tools = {
       greet: () => ({
         constructed: new (Date.prototype.constructor)().getTime(),
         statically: Date.prototype.constructor.now(),
         offset: new Date().getTimezoneOffset(),
       }),
     };`,
    { dispatch: port.dispatch },
  );

  assert.deepEqual(value, { constructed: CLOCK_MS, statically: CLOCK_MS, offset: 0 });
  assert.deepEqual(
    port.calls.map((call) => call.op),
    ["clock.now", "clock.now", "clock.now"],
  );
});

/**
 * Runs `fn` as if the host machine were in `zone`. Node re-reads `process.env.TZ` for every date
 * operation, and the QuickJS build asks its host for the offset each time it needs local time, so
 * this is the whole simulation: no child process, and the variable is put back either way.
 */
async function withTimezone<T>(zone: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

const ZONES = ["UTC", "America/New_York", "Asia/Kolkata"];

test("the host timezone never reaches the guest", async () => {
  // A timestamp is an instant *and* a zone, and QuickJS reads the zone from the machine it runs on:
  // every local-time member of `Date` — the accessors, the setters, the formatters, the calendar
  // constructor and the parser — is a way for the guest to learn where the host is, and each one that
  // answers differently on two machines is a replay that cannot be trusted. The guest is at UTC.
  const source = `globalThis.tools = {
       greet: () => {
         const epoch = new Date(0);
         const clock = new Date();
         const moved = new Date(0);
         moved.setHours(5);
         return {
           hours: epoch.getHours(),
           date: epoch.getDate(),
           day: epoch.getDay(),
           month: epoch.getMonth(),
           year: epoch.getFullYear(),
           minutes: epoch.getMinutes(),
           seconds: epoch.getSeconds(),
           ms: epoch.getMilliseconds(),
           legacyYear: epoch.getYear(),
           offset: epoch.getTimezoneOffset(),
           text: clock.toString(),
           dateText: clock.toDateString(),
           timeText: clock.toTimeString(),
           localeText: clock.toLocaleString(),
           localeDate: clock.toLocaleDateString(),
           localeTime: clock.toLocaleTimeString(),
           invalid: new Date(NaN).toString(),
           components: new Date(2026, 0, 1).getTime(),
           parsed: Date.parse("2026-01-01T00:00:00"),
           parsedSpaced: new Date("2026-01-01 00:00:00").getTime(),
           parsedZoned: Date.parse("2026-01-01T00:00:00-05:00"),
           parsedDay: Date.parse("2026-01-01"),
           parsedCoerced: new Date({ toString: () => "2026-01-01T00:00:00" }).getTime(),
           setLocal: moved.getTime(),
         };
       },
     };`;

  const seen = [];
  for (const zone of ZONES) seen.push(await withTimezone(zone, () => run(source)));

  // Every zone answers exactly what a UTC machine answers, which is also QuickJS's own output there:
  // nothing about the reading changes when the host moves.
  assert.deepEqual(seen[0], {
    hours: 0,
    date: 1,
    day: 4,
    month: 0,
    year: 1970,
    minutes: 0,
    seconds: 0,
    ms: 0,
    legacyYear: 70,
    offset: 0,
    text: "Thu Jan 01 2026 00:00:00 GMT+0000",
    dateText: "Thu Jan 01 2026",
    timeText: "00:00:00 GMT+0000",
    localeText: "01/01/2026, 12:00:00 AM",
    localeDate: "01/01/2026",
    localeTime: "12:00:00 AM",
    invalid: "Invalid Date",
    components: CLOCK_MS,
    parsed: CLOCK_MS,
    parsedSpaced: CLOCK_MS,
    // An explicit offset is not the host's: it stays five hours west of the instant it names.
    parsedZoned: CLOCK_MS + 5 * 3600000,
    parsedDay: CLOCK_MS,
    parsedCoerced: CLOCK_MS,
    setLocal: 5 * 3600000,
  });
  for (const [index, zone] of ZONES.entries()) {
    assert.deepEqual(seen[index], seen[0], `zone ${zone} answered differently`);
  }
  assert.ok((seen[0] as { text: string }).text.includes("GMT+0000"));
});

test("a guest cannot forge or find the invoker", async () => {
  // QuickJS lets a script redefine a property of the global object however it was installed, so the
  // invoker is not there to redefine: the host names it only after this source has run. From in here
  // there is nothing to see and nothing to shadow.
  const forged = `'{"status":"ok","json":"{\\\\"ran\\\\":\\\\"hijacked\\\\"}"}'`;
  const source = `const define = Object.defineProperty;
    const names = Object.getOwnPropertyNames(globalThis);
    const evil = () => ${forged};
    for (const name of names) {
      try { define(globalThis, name, { value: evil, writable: false, configurable: false }); } catch (e) {}
    }
    define(globalThis, "__capsule_invoke", { value: evil, writable: false, configurable: false });
    // \`this\` at the top of a script is the global object itself, which is how the tool table still
    // arrives after the loop above has redefined even the \`globalThis\` property.
    this.tools = {
      greet: () => ({ ran: "greet", suspects: names.filter((n) => n.indexOf("invoke") !== -1) }),
    };`;

  assert.deepEqual(await run(source), { ran: "greet", suspects: [] });

  // The same forgery by a capsule that implements nothing is still the missing tool, never the
  // capsule's own answer standing in for the host's envelope.
  await assert.rejects(
    () => run(`Object.defineProperty(globalThis, "__capsule_invoke", { value: () => ${forged} });`),
    capsuleError("E_GUEST", /^tool not implemented: greet$/),
  );

  // The price of naming the invoker last: a capsule that seals its own global object leaves the host
  // nowhere to put it. That is a capsule that cannot be run, and it is told so in as many words.
  await assert.rejects(
    () => run(`this.tools = { greet: () => 1 }; Object.freeze(globalThis);`),
    capsuleError("E_GUEST", /^the capsule made its global object unwritable$/),
  );
});

test("a tool written as a method keeps its receiver", async () => {
  // The tool table is an object, so a tool may be a method that reaches a sibling through `this`.
  const value = await run(
    `globalThis.tools = {
       helper() { return 1; },
       greet() {
         if (this !== globalThis.tools) throw new Error("receiver was not the tool table");
         return { ok: this.helper() };
       },
     };`,
  );

  assert.deepEqual(value, { ok: 1 });
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

test("args that cannot be serialised are refused before the guest runs", async () => {
  const source = `globalThis.tools = { greet: () => 1 };`;
  const refused = capsuleError("E_USAGE", /^tool args must be JSON-serialisable$/);
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;

  // The two ways JSON.stringify fails — it throws, or it answers with no string at all — are the
  // same usage error, never a host TypeError reaching the caller.
  await assert.rejects(() => run(source, { args: cycle }), refused);
  await assert.rejects(() => run(source, { args: { big: 1n } }), refused);
  await assert.rejects(() => run(source, { args: () => 1 }), refused);
});

test("a guest that replaces JSON cannot break the call", async () => {
  // The ABI captured the real serialiser before the capsule ran, so poisoning the guest's own copy
  // changes nothing about the envelope the host reads back.
  const value = await run(
    `JSON.stringify = () => "not json at all";
     JSON.parse = () => { throw new Error("poisoned"); };
     globalThis.tools = { greet: (args) => ({ echo: args.name }) };`,
    { args: { name: "ada" } },
  );

  assert.deepEqual(value, { echo: "ada" });

  // An envelope the guest bends by other means — a `toJSON` on Object.prototype, which the real
  // serialiser does honour — is still one CapsuleError rather than a host parse throw.
  await assert.rejects(
    () =>
      run(
        `Object.prototype.toJSON = () => null;
         globalThis.tools = { greet: () => ({ ok: 1 }) };`,
      ),
    capsuleError("E_GUEST", /^tool returned a non-JSON value$/),
  );
});

test("a guest cannot hijack the call through globals", async () => {
  // Every vector the guest has over the invocation: pre-defining the host's globals so a later write
  // is silently dropped, and replacing or deleting the invoker itself.
  const source = `Object.defineProperty(globalThis, "__tool", { value: "other", writable: false, configurable: false });
    Object.defineProperty(globalThis, "__args", { value: '{"name":"evil"}', writable: false, configurable: false });
    globalThis.__capsule_invoke = () => JSON.stringify({ status: "ok", json: '{"ran":"hijacked"}' });
    delete globalThis.__capsule_invoke;
    globalThis.tools = {
      greet: (args) => ({ ran: "greet", name: args.name }),
      other: () => ({ ran: "other" }),
    };`;

  assert.deepEqual(await run(source, { tool: "greet", args: { name: "ada" } }), { ran: "greet", name: "ada" });

  // A declaration is the other half of the same trick: a global `let` shadows the property of the
  // same name for every script that runs afterwards. The call reaches the real global object anyway.
  assert.deepEqual(
    await run(
      `this.tools = { greet: () => ({ ran: "greet" }) };
       let globalThis = { tools: { greet: () => ({ ran: "shadowed" }) } };`,
    ),
    { ran: "greet" },
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
