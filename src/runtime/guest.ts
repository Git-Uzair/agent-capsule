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
 * Triggering the call the prelude prepared. `this` at the top of an evaluated script is the guest's
 * global object — a keyword, so no declaration the capsule made can shadow it — and the invoker is a
 * non-writable, non-configurable property installed before the capsule ran, so this reaches the
 * host's invoker or nothing at all. Nothing else is looked up by name: an identifier here would be a
 * binding the capsule's own top-level `let` or `const` could have taken over.
 */
const INVOKE = `this.__capsule_invoke()`;

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

/**
 * The one gate on `args`: they must survive the trip through JSON. Both ways that can fail — a value
 * `JSON.stringify` refuses to represent, and a value it throws on (a cycle, a BigInt) — are the same
 * usage error, so a caller never sees a raw host `TypeError` from inside the runtime.
 */
function serialiseArgs(args: unknown, tool: string): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(args ?? null);
  } catch {
    json = undefined;
  }
  if (typeof json !== "string") {
    throw new CapsuleError("E_USAGE", "tool args must be JSON-serialisable", { tool });
  }
  return json;
}

/** JSON the guest may have had a hand in: an unparseable answer is an answer, not a host throw. */
function reparse(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Reads the invoke envelope. The prelude builds it with the real serialiser, but a capsule can still
 * bend the result from a distance — a `toJSON` on `Object.prototype` is honoured by that serialiser —
 * so every shape the host does not recognise, parse failures included, is one guest error.
 */
function unwrap(envelope: string | undefined, tool: string): unknown {
  const outcome = reparse(envelope);
  const fields =
    typeof outcome === "object" && outcome !== null ? (outcome as { status?: unknown; json?: unknown }) : {};

  if (fields.status === "no_tool") {
    throw new CapsuleError("E_GUEST", `tool not implemented: ${tool}`, { tool });
  }
  if (fields.status !== "ok" || typeof fields.json !== "string") {
    throw new CapsuleError("E_GUEST", "tool returned a non-JSON value", { tool });
  }
  // The serialiser never writes the text `undefined`, so nothing but a parse failure lands here.
  const value = reparse(fields.json);
  if (value === undefined) {
    throw new CapsuleError("E_GUEST", "tool returned a non-JSON value", { tool });
  }
  return value;
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
  const argsJson = serialiseArgs(opts.args, opts.tool);

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

    // Everything the host hands over goes in before the prelude, which is before any capsule code:
    // the guest's global object is only the host's to write while nothing of the guest's has run, and
    // the prelude takes all three into its closure and deletes them.
    setGlobal(
      "__capsule",
      context.newAsyncifiedFunction("__capsule", async (payload) =>
        context.newString(await answer(opts, context.getString(payload))),
      ),
    );
    setGlobal("__tool", context.newString(opts.tool));
    setGlobal("__args", context.newString(argsJson));

    await evaluate(context, deadline, PRELUDE, "capsule:prelude");
    await evaluate(context, deadline, opts.source, opts.entryPath);

    return unwrap(await evaluate(context, deadline, INVOKE, "capsule:invoke"), opts.tool);
  } finally {
    context.dispose();
  }
}
