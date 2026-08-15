import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { CapsuleError } from "../core/errors.ts";
import type { Policy } from "./policy.ts";

/** What a guest may send, and what it gets back. Strings both ways: a capsule's world is JSON. */
export type FetchInit = { method?: string; headers?: Record<string, string>; body?: string };

export type FetchResponse = { status: number; statusText: string; headers: Record<string, string>; body: string };

export type FetchPort = (url: string, init?: FetchInit) => Promise<FetchResponse>;

/**
 * The one shape of `dns.promises.lookup` this module uses. Named rather than borrowed as
 * `typeof dnsLookup`, which is a pile of overloads no test double can satisfy — the real resolver is
 * assignable to this, which is what matters.
 */
export type LookupFn = (
  hostname: string,
  options: { all: true },
) => Promise<{ address: string; family: number }[]>;

const REQUEST_BODY_MAX = 1024 * 1024;
const RESPONSE_BODY_MAX = 4 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 5000;
const MAX_HEADERS = 16;
const MAX_HEADER_BYTES = 1024;

const METHODS = new Set(["GET", "POST"]);

/**
 * Headers a guest must not be able to choose. `cookie` and `authorization` are the credentials of
 * whoever happens to be reachable, `host` and the proxy/forwarding family rewrite where the request
 * appears to be going or coming from. They are dropped silently: a capsule that asks for them is
 * asking for something it never had, not making a mistake worth failing over.
 */
const DROPPED_HEADER = /^(cookie|authorization|proxy-|host|x-forwarded-)/i;

/** The only response headers handed on. The body is the answer; the rest is the connection's business. */
const KEPT_RESPONSE_HEADERS = ["content-type", "content-length"];

/** The spellings of loopback a URL can carry — `URL.hostname` keeps the brackets on IPv6 literals. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/** Statuses that keep the method and body; everything else redirects into a plain GET. */
const METHOD_PRESERVING = new Set([307, 308]);

/**
 * Every address a capsule must not be able to reach: its own machine, its own network, the
 * link-local range that carries cloud instance metadata, and the ranges that are reserved rather
 * than routed. `net.BlockList` is asked rather than the arithmetic being written out, and it
 * understands IPv4-mapped IPv6 (`::ffff:10.0.0.1` matches the `10/8` entry) — which is the spelling
 * an SSRF check written by hand usually misses.
 */
const BLOCKED = new BlockList();
for (const [subnet, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, and cloud metadata with it
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and the broadcast address at the top of it
] as const) {
  BLOCKED.addSubnet(subnet, prefix, "ipv4");
}
for (const [subnet, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
  ["2001:db8::", 32], // documentation
] as const) {
  BLOCKED.addSubnet(subnet, prefix, "ipv6");
}

/**
 * Whether an address is one a capsule must not reach. Anything that is not an address at all — an
 * empty answer, a name, a dotted-decimal form only a resolver would accept — counts as blocked: this
 * decides whether to open a connection, so what it cannot reason about it refuses.
 */
export function isPrivateIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return true;
  return BLOCKED.check(ip, family === 4 ? "ipv4" : "ipv6");
}

function policyFail(message: string, detail: Record<string, unknown> = {}): never {
  throw new CapsuleError("E_POLICY", message, detail);
}

function usage(message: string, detail: Record<string, unknown> = {}): never {
  throw new CapsuleError("E_USAGE", message, detail);
}

/** A port is allowed if it is one of the two web ports or in the unprivileged range. */
function portAllowed(url: URL): boolean {
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  return port === 80 || port === 443 || (port >= 1024 && port <= 65535);
}

/**
 * The guest's `init`, checked rather than trusted. It arrives as whatever JSON the guest built, so
 * every field is verified before it can reach the transport — a number where a body belongs would
 * otherwise surface as a host `TypeError`.
 */
function readInit(init: unknown): { method: string; headers: Record<string, string>; body?: string } {
  if (init === undefined) return { method: "GET", headers: {} };
  if (typeof init !== "object" || init === null || Array.isArray(init)) usage("net.fetch init must be an object");
  const { method: rawMethod, headers: rawHeaders, body } = init as Record<string, unknown>;

  if (rawMethod !== undefined && typeof rawMethod !== "string") usage("net.fetch method must be a string");
  const method = (rawMethod ?? "GET").toUpperCase();
  if (!METHODS.has(method)) usage(`net.fetch allows only GET and POST, not ${method}`, { method });

  if (body !== undefined && typeof body !== "string") usage("net.fetch body must be a string");
  if (body !== undefined && method === "GET") usage("net.fetch GET requests must not carry a body");
  // Bytes, not characters: the wire cost of a multi-byte string is what the budget is about.
  if (body !== undefined && Buffer.byteLength(body, "utf8") > REQUEST_BODY_MAX) {
    usage("request body exceeds 1 MiB", { bytes: Buffer.byteLength(body, "utf8") });
  }

  const headers: Record<string, string> = {};
  if (rawHeaders !== undefined) {
    if (typeof rawHeaders !== "object" || rawHeaders === null || Array.isArray(rawHeaders)) {
      usage("net.fetch headers must be an object of strings");
    }
    const entries = Object.entries(rawHeaders as Record<string, unknown>);
    if (entries.length > MAX_HEADERS) usage(`net.fetch allows at most ${MAX_HEADERS} request headers`);
    for (const [name, value] of entries) {
      if (typeof value !== "string") usage("net.fetch headers must be an object of strings", { header: name });
      if (Buffer.byteLength(value, "utf8") > MAX_HEADER_BYTES) {
        usage(`net.fetch request header ${name} exceeds ${MAX_HEADER_BYTES} bytes`, { header: name });
      }
      if (!DROPPED_HEADER.test(name)) headers[name] = value;
    }
  }
  return { method, headers, ...(body === undefined ? {} : { body }) };
}

/** What a transport failure means to a caller: a deadline, or the network saying no. */
function transportFailure(e: unknown): never {
  if (e instanceof CapsuleError) throw e;
  const error = e as { name?: string; message?: string; cause?: unknown };
  if (error.name === "TimeoutError" || error.name === "AbortError") {
    throw new CapsuleError("E_TIMEOUT", `net.fetch exceeded ${TIMEOUT_MS} ms`);
  }
  const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
  throw new CapsuleError("E_USAGE", `net.fetch failed: ${error.message ?? String(e)}${cause}`);
}

/**
 * The egress gate. Everything a capsule can reach on the network goes through here, and the order the
 * checks run in is the point: the URL is understood before the policy is asked, the policy is asked
 * before a name is resolved, and the addresses behind the name are inspected before a socket is
 * opened. A host the manifest never declared therefore costs an attacker not even a DNS query, and a
 * host it did declare cannot become an address on the loopback interface or the metadata service by
 * answering its own lookup — including halfway through a redirect chain, where the gate runs again
 * from the top.
 */
export function createFetchPort(opts: {
  policy: Policy;
  tool: string;
  fetchFn?: typeof fetch;
  lookupFn?: LookupFn;
  allowLocalhost?: boolean;
}): FetchPort {
  const { policy, tool } = opts;
  const fetchFn = opts.fetchFn ?? fetch;
  const lookupFn: LookupFn = opts.lookupFn ?? dnsLookup;
  const allowLocalhost = opts.allowLocalhost ?? false;

  /** A loopback URL the capsule is allowed to use: the one case where plain http and a reserved
   * address are the intended target rather than an escape. */
  const isLocal = (url: URL): boolean => allowLocalhost && LOOPBACK_HOSTS.has(url.hostname.toLowerCase());

  const parse = (raw: string): URL => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return usage(`invalid url: ${raw.slice(0, 200)}`);
    }
    // Credentials in a URL are a secret in a string a guest composed, and the request that carries
    // them is one the user never saw. There is no version of this the gate lets through.
    if (url.username !== "" || url.password !== "") policyFail("url must not carry credentials", { host: url.hostname });
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal(url))) {
      policyFail(`only https: urls are allowed, not ${url.protocol}`, { url: url.href });
    }
    if (!portAllowed(url)) policyFail(`port ${url.port} is not allowed`, { url: url.href });
    return url;
  };

  /**
   * Every address behind the name, not the first one: a name that answers with a public address and a
   * private one is a rebinding attack whichever address the connection ends up using.
   */
  const assertPublic = async (url: URL): Promise<void> => {
    // Brackets are the URL's syntax for an IPv6 literal, not part of the host a resolver is asked about.
    const host = url.hostname.replace(/^\[|\]$/g, "");
    let addresses: { address: string }[];
    try {
      addresses = await lookupFn(host, { all: true });
    } catch (e) {
      return usage(`dns lookup failed for ${host}: ${(e as Error).message}`, { host });
    }
    if (addresses.length === 0) usage(`${host} did not resolve to any address`, { host });
    if (addresses.some((a) => isPrivateIp(a.address))) {
      policyFail("SSRF: host resolved to reserved/private IP", { host, addresses: addresses.map((a) => a.address) });
    }
  };

  const admit = async (raw: string): Promise<URL> => {
    const url = parse(raw);
    policy.check(tool, "net.fetch", url.href);
    if (!isLocal(url)) await assertPublic(url);
    return url;
  };

  /** The response, once it is known to be small enough to hold. */
  const read = async (response: Response): Promise<FetchResponse> => {
    const headers: Record<string, string> = {};
    for (const name of KEPT_RESPONSE_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    return { status: response.status, statusText: response.statusText, headers, body: await readBody(response) };
  };

  return async (rawUrl, init) => {
    const request = readInit(init);
    let url = await admit(rawUrl);
    let { method, body } = request;
    // One deadline for the whole exchange, redirects included: a per-hop timeout is a budget an
    // attacker multiplies by the hop limit.
    const signal = AbortSignal.timeout(TIMEOUT_MS);

    for (let hop = 0; ; hop++) {
      let response: Response;
      try {
        response = await fetchFn(url, {
          method,
          headers: request.headers,
          ...(body === undefined ? {} : { body }),
          redirect: "manual",
          signal,
        });
      } catch (e) {
        return transportFailure(e);
      }

      const location = response.headers.get("location");
      if (!REDIRECT_STATUS.has(response.status) || location === null) return await read(response);

      // The chain ends here, so the response nobody will read is dropped rather than left to the
      // garbage collector to close.
      await response.body?.cancel().catch(() => {});
      if (hop >= MAX_REDIRECTS) usage("maximum redirects exceeded", { hops: hop + 1, url: url.href });

      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        return policyFail(`redirect blocked: ${location.slice(0, 200)}`, { from: url.href });
      }
      // The new target gets the same gate as the first one, and a refusal names the redirect: a
      // capsule reading its own error should be able to tell "you cannot go there" from "you cannot
      // be sent there".
      try {
        url = await admit(next.href);
      } catch (e) {
        if (e instanceof CapsuleError && e.code === "E_POLICY") {
          throw new CapsuleError("E_POLICY", `redirect blocked: ${next.hostname}: ${e.message}`, {
            ...e.detail,
            redirect: next.href,
          });
        }
        throw e;
      }
      // 303 — and by long-standing practice 301 and 302 — turn a POST into a GET; only 307 and 308
      // promise to repeat the request as it was.
      if (!METHOD_PRESERVING.has(response.status)) {
        method = "GET";
        body = undefined;
      }
    }
  };
}

/**
 * The body, counted as it arrives. A cap applied after `text()` is not a cap: by then the host has
 * already paid for however much the server chose to send, which is the denial of service the limit
 * exists to prevent. A declared length past the limit is refused without reading anything at all.
 */
async function readBody(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > RESPONSE_BODY_MAX) {
    await response.body?.cancel().catch(() => {});
    usage("response body exceeds 4 MiB", { bytes: declared });
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return "";

  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_BODY_MAX) {
        await reader.cancel().catch(() => {});
        usage("response body exceeds 4 MiB", { bytes: size });
      }
      chunks.push(value);
    }
  } catch (e) {
    return transportFailure(e);
  }
  return Buffer.concat(chunks).toString("utf8");
}
