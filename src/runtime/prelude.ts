/**
 * The guest-facing ABI, evaluated before any capsule code. It is also what makes `strict`
 * determinism true: the raw host bridge is captured in a closure and deleted from the global object,
 * so the only way out of the sandbox is the frozen `capsule` object, and the two ambient sources of
 * non-determinism QuickJS provides by itself — `Math.random` and `Date` — are rewired onto the
 * clock and entropy ports, where every answer is journalled and can be replayed.
 *
 * This is guest source, not host source: it runs inside QuickJS, so it may only use what the
 * sandbox has (no host globals, no imports) and it must stay a single expression statement that
 * leaves nothing behind but `globalThis.capsule`.
 */
export const PRELUDE = `(() => {
  const raw = globalThis.__capsule;
  delete globalThis.__capsule;
  const call = (op, params) => {
    const res = JSON.parse(raw(JSON.stringify({ op, params: params ?? {} })));
    if (!res.ok) { const e = new Error(res.error.message); e.code = res.error.code; throw e; }
    return res.value;
  };
  const now = () => call("clock.now", {});
  globalThis.capsule = Object.freeze({
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
  CapsuleDate.now = () => new RealDate(now()).getTime();
  CapsuleDate.parse = RealDate.parse;
  CapsuleDate.UTC = RealDate.UTC;
  globalThis.Date = CapsuleDate;
})();
`;
