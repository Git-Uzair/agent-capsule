/**
 * The guest-facing ABI, evaluated before any capsule code. It is also what makes `strict`
 * determinism true: the raw host bridge is captured in a closure and deleted from the global object,
 * so the only way out of the sandbox is the frozen `capsule` object, and the two ambient sources of
 * non-determinism QuickJS provides by itself — `Math.random` and `Date` — are rewired onto the
 * clock and entropy ports, where every answer is journalled and can be replayed.
 *
 * Running first is what makes the rest trustworthy. Everything the host and the ABI depend on — the
 * global object, the real `JSON`, the bridge, the tool being called and its arguments — is taken
 * into this closure before the capsule has had a chance to touch any of it, and the invoker the host
 * calls to run the tool is installed as a non-writable, non-configurable property, so a capsule can
 * neither replace it nor make the host read a value of the capsule's choosing.
 *
 * This is guest source, not host source: it runs inside QuickJS, so it may only use what the
 * sandbox has (no host globals, no imports) and it must stay a single expression statement that
 * leaves nothing behind but `globalThis.capsule` and `globalThis.__capsule_invoke`.
 */
export const PRELUDE = `(() => {
  const g = globalThis;
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const apply = Reflect.apply;
  const raw = g.__capsule;
  const tool = g.__tool;
  const argsJson = g.__args;
  delete g.__capsule;
  delete g.__tool;
  delete g.__args;
  const call = (op, params) => {
    const res = parse(raw(stringify({ op, params: params ?? {} })));
    if (!res.ok) { const e = new Error(res.error.message); e.code = res.error.code; throw e; }
    return res.value;
  };
  const now = () => call("clock.now", {});
  g.capsule = Object.freeze({
    now,
    random: (n) => call("random.bytes", { n: n ?? 16 }),
    log: (message) => call("log.write", { message: String(message) }),
    kv: Object.freeze({
      get: (key) => call("kv.get", { key }),
      set: (key, value) => call("kv.set", { key, value: String(value) }),
    }),
    sql: Object.freeze({
      query: (sql, params) => call("sql.query", { sql, params: params ?? [] }),
      exec: (sql, params) => call("sql.exec", { sql, params: params ?? [] }),
    }),
    fetch: (url, init) => call("net.fetch", { url, init: init ?? {} }),
  });
  Math.random = () => {
    const hex = call("random.bytes", { n: 7 });
    let x = 0;
    for (let i = 0; i < 7; i++) x = x * 256 + parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return x / 2 ** 56;
  };
  const RealDate = Date;
  const CapsuleDate = function (...args) {
    if (!(this instanceof CapsuleDate)) return new RealDate(now()).toString();
    return args.length ? new RealDate(...args) : new RealDate(now());
  };
  CapsuleDate.prototype = RealDate.prototype;
  // Sharing the prototype is what keeps \`new Date() instanceof Date\` true, but it also means the
  // prototype still names the real constructor — and a constructor is a clock:
  // \`new (Date.prototype.constructor)()\` and \`Date.prototype.constructor.now()\` would read the host's
  // wall clock through a property every date instance carries. Renaming it closes the last way to the
  // real \`Date\`, since the global binding is the only other one and the closure keeps its own.
  CapsuleDate.prototype.constructor = CapsuleDate;
  // The zone is the other half of a timestamp: the same instant is a different local time on two
  // machines, so under strict determinism the guest is always at UTC.
  RealDate.prototype.getTimezoneOffset = function () {
    return 0;
  };
  CapsuleDate.now = () => new RealDate(now()).getTime();
  CapsuleDate.parse = RealDate.parse;
  CapsuleDate.UTC = RealDate.UTC;
  g.Date = CapsuleDate;
  // The call itself. The tool name and the arguments come from this closure, never from a global the
  // capsule could have pre-defined and never spliced into source, and the result comes back as an
  // envelope — a status plus the already-serialised value — so the three outcomes the host must tell
  // apart (no such tool, a value that will not serialise, a value) cannot be confused with a tool
  // that legitimately returned a string. Reaching it grants the capsule nothing it does not already
  // have: its own tool, called with the arguments it was going to be given.
  Object.defineProperty(g, "__capsule_invoke", {
    value: () => {
      const tools = g.tools;
      const fn = tools && tools[tool];
      if (typeof fn !== "function") return stringify({ status: "no_tool" });
      // Called as a method of the tool table, exactly as \`tools[name](args)\` would be: a tool is
      // allowed to be a method that reaches a sibling through \`this\`. The receiver goes through the
      // captured \`Reflect.apply\` rather than \`fn.call\`, so a capsule that rewrote
      // \`Function.prototype.call\` cannot get between the host and its own tool.
      const value = apply(fn, tools, [parse(argsJson)]) ?? null;
      let json;
      try {
        json = stringify(value);
      } catch (e) {
        return stringify({ status: "not_json" });
      }
      return typeof json === "string" ? stringify({ status: "ok", json }) : stringify({ status: "not_json" });
    },
  });
})();
`;
