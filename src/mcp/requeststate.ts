import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { asRecord, canonicalize } from "../core/canonical.ts";
import { CapsuleError } from "../core/errors.ts";
import { capsuleHome } from "../security/signing.ts";

/**
 * What a consent question was about, carried by the client and given back on the retry. The whole
 * point of the MRTR pattern is that the server keeps no session, so this is the only thing that ties
 * an answer to the request that provoked it: which capsule, which tool, which *arguments* — approving
 * a cheap call must not execute an expensive one — which grants were asked about, and until when.
 */
export type RequestStatePayload = {
  capsuleId: string;
  tool: string;
  argsDigest: string;
  grants: string[];
  exp: number;
};

const KEY_FILE = "state-key";
const KEY_BYTES = 32;

function fail(message: string, detail: Record<string, unknown> = {}): never {
  throw new CapsuleError("E_POLICY", message, detail);
}

/**
 * The key the token is authenticated with, created on first use and owner-readable only: it is the
 * one secret that keeps a client from writing its own consent. `wx` is what makes the creation safe
 * when two servers start at once — the loser of the race reads the winner's key rather than
 * overwriting it, so a token signed a moment ago still verifies.
 */
export function loadStateKey(homeDir: string = capsuleHome()): Buffer {
  const file = join(homeDir, KEY_FILE);
  const read = (): Buffer | undefined => {
    try {
      return readFileSync(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  };

  let key = read();
  if (key === undefined) {
    mkdirSync(homeDir, { recursive: true });
    key = randomBytes(KEY_BYTES);
    try {
      writeFileSync(file, key, { mode: 0o600, flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      key = read();
    }
  }
  // A short key is a weak key, and a key file somebody else's tooling wrote is not a key we may sign
  // with: neither is fixed by silently replacing it, since that would invalidate live tokens.
  if (key === undefined || key.length !== KEY_BYTES) {
    fail(`request state key is unusable: ${file}`, { file });
  }
  return key;
}

function mac(key: Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

export function signRequestState(payload: RequestStatePayload, key: Buffer): string {
  // The canonical form, so the same payload always signs to the same token.
  const body = Buffer.from(canonicalize(payload), "utf8").toString("base64url");
  return `${body}.${mac(key, body).toString("base64url")}`;
}

/**
 * The payload of a token this server signed, or nothing at all. `requestState` reaches us through the
 * client, so it is treated as attacker-controlled input: the tag is checked before the payload is
 * parsed, in constant time, and an expired token is refused however well it verifies. The caller
 * still has to check the payload against the request in hand — that is what `capsuleId`, `tool` and
 * `argsDigest` are for.
 */
export function verifyRequestState(token: string, key: Buffer): RequestStatePayload {
  const dot = typeof token === "string" ? token.indexOf(".") : -1;
  if (dot <= 0) fail("requestState is malformed");
  const body = token.slice(0, dot);
  const provided = Buffer.from(token.slice(dot + 1), "base64url");
  const expected = mac(key, body);
  // The length is compared first: `timingSafeEqual` throws on buffers of different sizes.
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    fail("requestState failed verification");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    fail("requestState is malformed");
  }
  const payload = asRecord(parsed);
  if (
    payload === undefined ||
    typeof payload["capsuleId"] !== "string" ||
    typeof payload["tool"] !== "string" ||
    typeof payload["argsDigest"] !== "string" ||
    typeof payload["exp"] !== "number" ||
    !Array.isArray(payload["grants"]) ||
    !payload["grants"].every((grant) => typeof grant === "string")
  ) {
    fail("requestState is malformed");
  }
  // A window, not a session: an approval a user gave long ago is not an approval of what is being
  // asked now.
  if (!((payload["exp"] as number) > Date.now())) fail("requestState has expired");
  return payload as RequestStatePayload;
}
