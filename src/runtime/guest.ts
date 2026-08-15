import { newQuickJSAsyncWASMModule, shouldInterruptAfterDeadline } from "quickjs-emscripten";
import type { QuickJSAsyncContext, QuickJSHandle } from "quickjs-emscripten";
import { CapsuleError } from "../core/errors.ts";
import type { EffectName } from "../format/manifest.ts";
import { sanitizeModelText } from "../security/text.ts";
import type { EffectDispatch } from "./effects.ts";
import { PRELUDE } from "./prelude.ts";

const STACK_SIZE_BYTES = 1024 * 1024;
const MAX_MESSAGE_CHARS = 500;

export type RunGuestOptions = {
  source: string;
  entryPath: string;
  runtime: { memory_limit_mb: number; timeout_ms: number; determinism?: string };
  tool: string;
  args: unknown;
  dispatch: EffectDispatch;
};

/**
 * The call itself. `__tool` and `__args` are read from globals the host set, never spliced into this
 * source: a tool name or an argument that happened to be JavaScript could otherwise rewrite the
 * call. The result comes back as an envelope — a status plus the already-serialised value — so the
 * three outcomes the host must tell apart (no such tool, a value that will not serialise, a value)
 * cannot be confused with a tool that legitimately returned a string.
 */
const INVOKE = `(() => {
  const fn = globalThis.tools && globalThis.tools[__tool];
  if (typeof fn !== "function") return JSON.stringify({ status: "no_tool" });
  const value = fn(JSON.parse(__args)) ?? null;
  let json;
  try {
    json = JSON.stringify(value);
  } catch (e) {
    return JSON.stringify({ status: "not_json" });
  }
  return typeof json === "string" ? JSON.stringify({ status: "ok", json }) : JSON.stringify({ status: "not_json" });
})()`;

/**
 * The host side of the guest ABI. It must never reject: a rejected promise inside an asyncified call
 * leaves the guest suspended for ever — the interpreter is unwound, so not even the interrupt
 * handler can end it — so every failure is encoded as a value instead, and the guest sees a code and
 * a cleaned message rather than a host stack trace.
 */
async function answer(opts: RunGuestOptions, payload: string): Promise<string> {
  try {
    const request = JSON.parse(payload) as { op?: unknown; params?: unknown };
    if (typeof request.op !== "string") {
      throw new CapsuleError("E_USAGE", "effect request needs an op");
    }
    // An op the guest invented is not trusted here: `dispatch` runs it past the policy, which denies
    // everything the manifest did not declare, before any handler sees it.
    const value = await opts.dispatch(opts.tool, request.op as EffectName, request.params);
    return JSON.stringify({ ok: true, value: value ?? null });
  } catch (e) {
    const code = e instanceof CapsuleError ? e.code : "E_GUEST";
    const message = e instanceof CapsuleError ? sanitizeModelText(e.message, MAX_MESSAGE_CHARS) : "the effect failed";
    return JSON.stringify({ ok: false, error: { code, message } });
  }
}

/**
 * Every guest failure, whichever of the three evaluations produced it. QuickJS reports an interrupt
 * as `InternalError: interrupted`; requiring the deadline to have passed as well means a guest that
 * throws a look-alike error cannot have its own bug reported as the host's timeout.
 */
function failure(deadline: number, dumped: unknown): CapsuleError {
  const thrown = typeof dumped === "object" && dumped !== null ? (dumped as { name?: unknown; message?: unknown }) : {};
  const message =
    typeof thrown.message === "string"
      ? thrown.message
      : typeof dumped === "string"
        ? dumped
        : "the guest threw a non-Error value";

  if (thrown.name === "InternalError" && message === "interrupted" && Date.now() >= deadline) {
    return new CapsuleError("E_TIMEOUT", "tool exceeded timeout_ms");
  }
  return new CapsuleError("E_GUEST", sanitizeModelText(message, MAX_MESSAGE_CHARS) || "the guest failed");
}

/** Evaluates one piece of guest code and returns its value when that value is a string. */
async function evaluate(
  context: QuickJSAsyncContext,
  deadline: number,
  code: string,
  filename: string,
): Promise<string | undefined> {
  let result;
  try {
    result = await context.evalCodeAsync(code, filename);
  } catch (e) {
    // A host-side throw here is still the guest's doing — recursion deep enough to exhaust the
    // host's own JavaScript stack surfaces as a `RangeError` on this side of the boundary — so it is
    // reported as a guest failure instead of escaping to the caller as an internal error.
    throw failure(deadline, e instanceof Error ? { name: e.name, message: e.message } : e);
  }

  if (result.error) {
    throw failure(deadline, result.error.consume(context.dump));
  }
  return result.value.consume((handle) =>
    context.typeof(handle) === "string" ? context.getString(handle) : undefined,
  );
}

function unwrap(envelope: string | undefined, tool: string): unknown {
  const outcome =
    envelope === undefined ? { status: "no_result" } : (JSON.parse(envelope) as { status: string; json?: string });

  if (outcome.status === "no_tool") {
    throw new CapsuleError("E_GUEST", `tool not implemented: ${tool}`, { tool });
  }
  if (outcome.status !== "ok" || typeof outcome.json !== "string") {
    throw new CapsuleError("E_GUEST", "tool returned a non-JSON value", { tool });
  }
  return JSON.parse(outcome.json);
}

/**
 * Runs one tool of one capsule with no ambient authority: no host globals, no clock, no entropy, a
 * bounded heap and a bounded deadline, and exactly one way out — the `__capsule` bridge, which is
 * `dispatch` and nothing else.
 *
 * Each call gets its own WASM module. An asyncified module can only suspend one call at a time, so a
 * fresh one per invocation buys full isolation with no mutex and no state carried between runs; the
 * context owns its runtime, which means a single `dispose()` tears everything down in the one order
 * the library supports — disposing the runtime separately frees host function references after the
 * runtime's callbacks are gone, which aborts the process.
 */
export async function runGuest(opts: RunGuestOptions): Promise<unknown> {
  const argsJson = JSON.stringify(opts.args ?? null);
  if (typeof argsJson !== "string") {
    throw new CapsuleError("E_USAGE", "tool args must be JSON-serialisable", { tool: opts.tool });
  }

  const deadline = Date.now() + opts.runtime.timeout_ms;
  const module = await newQuickJSAsyncWASMModule();
  const context = module.newContext();
  try {
    context.runtime.setMemoryLimit(opts.runtime.memory_limit_mb * 1024 * 1024);
    context.runtime.setMaxStackSize(STACK_SIZE_BYTES);
    context.runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));

    // Installing a global consumes the handle: nothing the host creates inside the guest outlives
    // the statement that put it there.
    const setGlobal = (name: string, handle: QuickJSHandle): void => {
      context.setProp(context.global, name, handle);
      handle.dispose();
    };

    setGlobal(
      "__capsule",
      context.newAsyncifiedFunction("__capsule", async (payload) =>
        context.newString(await answer(opts, context.getString(payload))),
      ),
    );

    await evaluate(context, deadline, PRELUDE, "capsule:prelude");
    await evaluate(context, deadline, opts.source, opts.entryPath);

    setGlobal("__tool", context.newString(opts.tool));
    setGlobal("__args", context.newString(argsJson));

    return unwrap(await evaluate(context, deadline, INVOKE, "capsule:invoke"), opts.tool);
  } finally {
    context.dispose();
  }
}
