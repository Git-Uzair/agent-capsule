/**
 * The guest-facing ABI, evaluated before any capsule code. It is also what makes `strict`
 * determinism true: the raw host bridge is captured in a closure and deleted from the global object,
 * so the only way out of the sandbox is the frozen `capsule` object, and the two ambient sources of
 * non-determinism QuickJS provides by itself — `Math.random` and `Date` — are rewired onto the
 * clock and entropy ports, where every answer is journalled and can be replayed.
 *
 * Running first is what makes the rest trustworthy. Everything the host and the ABI depend on — the
 * global object, the real `JSON`, the bridge, every method of the real `Date`, the tool being called
 * and its arguments — is taken into this closure before the capsule has had a chance to touch any of
 * it, and the invoker the host calls to run the tool is *returned* rather than installed anywhere:
 * QuickJS lets a script redefine a property of the global object however it was installed, so being
 * unreachable is the only defence that holds. The host keeps the returned function as a handle and
 * gives it a name only once the capsule's own source has finished running.
 *
 * This is guest source, not host source: it runs inside QuickJS, so it may only use what the
 * sandbox has (no host globals, no imports) and it must stay a single expression statement whose
 * value is the invoker and whose only lasting mark on the guest is `globalThis.capsule`.
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

  // \`Date\` is two sources of non-determinism, not one. The instant it reads by default is the host's
  // wall clock, and that is what the clock port replaces below — but a timestamp is an instant *and* a
  // zone, and every local-time member of \`Date\` asks the machine QuickJS runs on where it is. Patching
  // them one at a time is how a leak survives: the local surface is the accessors, the setters, the
  // formatters, the calendar constructor and the parser, and each one left alone answers differently
  // on two machines, which is a journal that cannot be replayed. So the whole surface is rebuilt out
  // of its UTC twin, and the guest is at UTC by construction rather than by patch.
  const RealDate = Date;
  const proto = RealDate.prototype;
  const realParse = RealDate.parse;
  const getTime = proto.getTime;
  const utcYear = proto.getUTCFullYear;
  const utcMonth = proto.getUTCMonth;
  const utcDate = proto.getUTCDate;
  const utcDay = proto.getUTCDay;
  const utcHours = proto.getUTCHours;
  const utcMinutes = proto.getUTCMinutes;
  const utcSeconds = proto.getUTCSeconds;
  const setUTCFullYear = proto.setUTCFullYear;

  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (value, width) => {
    let text = "" + value;
    while (text.length < width) text = "0" + text;
    return text;
  };
  /** The UTC components of a date, or nothing at all when it does not name an instant. */
  const parts = (date) => {
    const time = apply(getTime, date, []);
    if (time !== time) return null;
    return {
      day: DAY_NAMES[apply(utcDay, date, [])],
      month: MONTH_NAMES[apply(utcMonth, date, [])],
      monthNumber: apply(utcMonth, date, []) + 1,
      date: apply(utcDate, date, []),
      year: apply(utcYear, date, []),
      hours: apply(utcHours, date, []),
      minutes: apply(utcMinutes, date, []),
      seconds: apply(utcSeconds, date, []),
    };
  };
  // The same shapes QuickJS itself produces on a machine at UTC, so a capsule that already ran there
  // reads exactly what it read before — the zone in them is a constant, not a question about the host.
  const INVALID = "Invalid Date";
  const dateText = (p) => p.day + " " + p.month + " " + pad(p.date, 2) + " " + pad(p.year, 4);
  const timeText = (p) => pad(p.hours, 2) + ":" + pad(p.minutes, 2) + ":" + pad(p.seconds, 2);
  const localeDateText = (p) => pad(p.monthNumber, 2) + "/" + pad(p.date, 2) + "/" + pad(p.year, 4);
  const localeTimeText = (p) =>
    pad(p.hours % 12 === 0 ? 12 : p.hours % 12, 2) +
    ":" + pad(p.minutes, 2) + ":" + pad(p.seconds, 2) + (p.hours < 12 ? " AM" : " PM");
  const format = (render) =>
    function () {
      const p = parts(this);
      return p === null ? INVALID : render(p);
    };
  proto.toString = format((p) => dateText(p) + " " + timeText(p) + " GMT+0000");
  proto.toDateString = format(dateText);
  proto.toTimeString = format((p) => timeText(p) + " GMT+0000");
  proto.toLocaleString = format((p) => localeDateText(p) + ", " + localeTimeText(p));
  proto.toLocaleDateString = format(localeDateText);
  proto.toLocaleTimeString = format(localeTimeText);

  // Reading and writing a component: the UTC twin is the same method with the zone taken out of it.
  proto.getFullYear = utcYear;
  proto.getMonth = utcMonth;
  proto.getDate = utcDate;
  proto.getDay = utcDay;
  proto.getHours = utcHours;
  proto.getMinutes = utcMinutes;
  proto.getSeconds = utcSeconds;
  proto.getMilliseconds = proto.getUTCMilliseconds;
  proto.setFullYear = setUTCFullYear;
  proto.setMonth = proto.setUTCMonth;
  proto.setDate = proto.setUTCDate;
  proto.setHours = proto.setUTCHours;
  proto.setMinutes = proto.setUTCMinutes;
  proto.setSeconds = proto.setUTCSeconds;
  proto.setMilliseconds = proto.setUTCMilliseconds;
  proto.getTimezoneOffset = function () {
    return 0;
  };
  // Annex B's two-digit-year pair has no UTC twin to borrow, so it is written out of one.
  if (typeof proto.getYear === "function") {
    proto.getYear = function () {
      return apply(utcYear, this, []) - 1900;
    };
  }
  if (typeof proto.setYear === "function") {
    proto.setYear = function (year) {
      const full = Number(year);
      return apply(setUTCFullYear, this, [full >= 0 && full <= 99 ? full + 1900 : full]);
    };
  }

  /**
   * Reading a date out of text. A string that names its zone means the same instant everywhere, but a
   * zone-less one is read in the host's zone by the engine's own parser, which no patch at this level
   * can reach — so it is read again with a \`Z\` appended, which is the same text pinned to UTC. A
   * string the engine will not take that way is not a date a capsule can rely on, and NaN is the
   * honest answer: failing closed keeps determinism, where guessing at the host's offset would not.
   */
  const ZONED = /(?:Z|[+-]\\d{2}:?\\d{2}|GMT|UTC|UT)\\s*(?:\\([^)]*\\))?$/i;
  const parseUtc = (value) => {
    const text = ("" + value).trim();
    return ZONED.test(text) ? realParse(text) : realParse(text + "Z");
  };
  /** What \`new Date(value)\` coerces its one argument to: a string is parsed, anything else is a time. */
  const primitive = (value) => {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
    if (value instanceof RealDate) return apply(getTime, value, []);
    const valued = typeof value.valueOf === "function" ? apply(value.valueOf, value, []) : value;
    return valued === null || (typeof valued !== "object" && typeof valued !== "function") ? valued : String(value);
  };
  const CapsuleDate = function (...args) {
    if (!(this instanceof CapsuleDate)) return new RealDate(now()).toString();
    // No argument is the clock port. Two or more are calendar components, which the constructor reads
    // in the host's zone and \`Date.UTC\` reads the same everywhere. One is whatever it coerces to.
    if (args.length === 0) return new RealDate(now());
    if (args.length >= 2) return new RealDate(apply(RealDate.UTC, RealDate, args));
    const only = primitive(args[0]);
    return new RealDate(typeof only === "string" ? parseUtc(only) : only);
  };
  CapsuleDate.prototype = RealDate.prototype;
  // Sharing the prototype is what keeps \`new Date() instanceof Date\` true, but it also means the
  // prototype still names the real constructor — and a constructor is a clock:
  // \`new (Date.prototype.constructor)()\` and \`Date.prototype.constructor.now()\` would read the host's
  // wall clock through a property every date instance carries. Renaming it closes the last way to the
  // real \`Date\`, since the global binding is the only other one and the closure keeps its own.
  CapsuleDate.prototype.constructor = CapsuleDate;
  CapsuleDate.now = () => new RealDate(now()).getTime();
  CapsuleDate.parse = parseUtc;
  CapsuleDate.UTC = RealDate.UTC;
  g.Date = CapsuleDate;

  // The call itself. The tool name and the arguments come from this closure, never from a global the
  // capsule could have pre-defined and never spliced into source, and the result comes back as an
  // envelope — a status plus the already-serialised value — so the three outcomes the host must tell
  // apart (no such tool, a value that will not serialise, a value) cannot be confused with a tool
  // that legitimately returned a string. Reaching it grants the capsule nothing it does not already
  // have: its own tool, called with the arguments it was going to be given.
  return () => {
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
  };
})();
`;
