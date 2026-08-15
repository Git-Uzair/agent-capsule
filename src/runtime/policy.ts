import { CapsuleError } from "../core/errors.ts";
import { EFFECT_CAPABILITY, type EffectName, type Manifest } from "../format/manifest.ts";
import { hasGrant, loadGrants, type GrantsStore } from "../security/grants.ts";

/** The three spellings of the loopback host. They are one grant, not three. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

const GRANT_PACK = "pack";
const GRANT_LOCALHOST = "net:localhost";

function fail(message: string, detail: Record<string, unknown>): never {
  throw new CapsuleError("E_POLICY", message, detail);
}

/** `URL.hostname` brackets IPv6 literals, and `::1` and `[::1]` are the same address. */
function normalize(host: string): string {
  const lower = host.toLowerCase();
  return lower.length > 1 && lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower;
}

/**
 * Bare addresses bypass the whole point of a host allow-list — an allowed name resolves to whatever
 * DNS says today, an address is chosen by the capsule — so every literal spelling is denied unless
 * it is loopback: dotted quads, anything with a colon (IPv6, or a host that smuggled in a port),
 * and the all-digit decimal form of an address that resolvers still accept.
 */
function isIpLiteral(host: string): boolean {
  return host.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /^\d+$/.test(host);
}

function matchesPattern(host: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    // `*.example.com` covers one or more labels below the apex, and never the apex itself.
    const suffix = pattern.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return host === pattern;
}

/**
 * The ASCII check runs on the host as given, before lowercasing: a few non-ASCII code points fold to
 * ASCII (U+212A KELVIN SIGN becomes `k`), so lowercasing first would let a non-punycode host
 * impersonate an allowed one. Manifests and URLs must present punycode already.
 */
export function hostAllowed(host: string, allowedHosts: string[], allowLocalhost: boolean): boolean {
  if (host === "" || /[^\x00-\x7f]/.test(host)) return false;
  const h = normalize(host);
  // `allow_localhost` is the only switch for loopback: allowed_hosts must not be able to smuggle in
  // access to whatever the host machine happens to be serving on its own interfaces.
  if (LOOPBACK.has(h)) return allowLocalhost;
  if (isIpLiteral(h)) return false;
  return allowedHosts.some((pattern) => matchesPattern(h, normalize(pattern)));
}

/** Targets arrive as a URL from `net.fetch`, but a bare host is accepted too. */
function hostOf(target: string): string {
  if (!target.includes("://")) return target;
  try {
    return new URL(target).hostname;
  } catch {
    return "";
  }
}

export type Policy = {
  check(tool: string, op: EffectName, target?: string): void;
  requiredGrants(tool: string): string[];
  missingGrants(tool: string): string[];
};

function isStore(grants: Record<string, boolean> | GrantsStore): grants is GrantsStore {
  const store = grants as GrantsStore;
  return store.version === 1 && typeof store.capsules === "object" && store.capsules !== null;
}

/**
 * The single authority for "may tool T perform op O on target X?". Everything is denied unless the
 * manifest declared it *and*, for the two effects that reach outside the sidecar, the user granted
 * it. Grants are resolved once, when the policy is built, so a decision cannot change mid-run.
 */
export function buildPolicy(opts: {
  manifest: Manifest;
  capsuleId: string;
  grants?: Record<string, boolean> | GrantsStore;
  homeDir?: string;
}): Policy {
  const { manifest, capsuleId } = opts;
  const net = manifest.capabilities.net;
  const source = opts.grants ?? loadGrants(opts.homeDir);
  // A Map keeps attacker-chosen tool names off a dictionary prototype.
  const effectsOf = new Map(manifest.tools.map((tool) => [tool.name, tool.effects] as const));

  const granted = (grant: string): boolean =>
    isStore(source)
      ? hasGrant(source, capsuleId, grant)
      : Object.hasOwn(source, grant) && source[grant] === true;

  const requireGrant = (grant: string, detail: Record<string, unknown>): void => {
    if (!granted(grant)) fail(`missing user grant: ${grant}`, { ...detail, grant });
  };

  const check = (tool: string, op: EffectName, target?: string): void => {
    // An unknown tool declared nothing, which is the same answer as a tool that declared something
    // else: the effect is not on its list.
    const effects = effectsOf.get(tool) ?? [];
    if (!effects.includes(op)) fail(`tool ${tool} did not declare effect ${op}`, { tool, op });

    const capability = EFFECT_CAPABILITY[op];
    if (capability !== undefined && !manifest.capabilities[capability]) {
      fail(`capsule did not declare capability ${capability}`, { tool, op, capability });
    }

    if (op === "net.fetch") {
      const raw = hostOf(target ?? "");
      const host = normalize(raw);
      if (!hostAllowed(raw, net.allowed_hosts, net.allow_localhost)) {
        fail(`host ${host} is not in capabilities.net.allowed_hosts`, { tool, op, target, host });
      }
      requireGrant(LOOPBACK.has(host) ? GRANT_LOCALHOST : `net:${host}`, { tool, op, host });
    }
    if (op === "pack.write") requireGrant(GRANT_PACK, { tool, op });
  };

  const requiredGrants = (tool: string): string[] => {
    const effects = effectsOf.get(tool) ?? [];
    const grants: string[] = [];
    if (effects.includes("pack.write")) grants.push(GRANT_PACK);
    if (effects.includes("net.fetch")) {
      for (const host of net.allowed_hosts) {
        const h = normalize(host);
        // Loopback is governed by allow_localhost alone, so it contributes at most the one grant.
        if (!LOOPBACK.has(h)) grants.push(`net:${h}`);
      }
      if (net.allow_localhost) grants.push(GRANT_LOCALHOST);
    }
    return [...new Set(grants)];
  };

  return {
    check,
    requiredGrants,
    missingGrants: (tool) => requiredGrants(tool).filter((grant) => !granted(grant)),
  };
}
