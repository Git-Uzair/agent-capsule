import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalize } from "../core/canonical.ts";
import { sha256Hex } from "../core/digest.ts";
import { CapsuleError } from "../core/errors.ts";
import type { Statement } from "../format/statement.ts";

export type SignatureDoc = {
  alg: "ed25519";
  publicKey: string;
  keyId: string;
  signature: string;
};

/** Read the environment on every call: tests and `--home` style overrides change it at runtime. */
export function capsuleHome(): string {
  return process.env.CAPSULE_HOME ?? join(homedir(), ".agent-capsule");
}

export function keyIdOf(publicKeySpkiDer: Buffer | Uint8Array): string {
  return `sha256:${sha256Hex(publicKeySpkiDer)}`;
}

export type SigningKey = {
  privateKeyPem: string;
  publicKeySpkiDer: Buffer;
  publicKeyBase64: string;
  keyId: string;
};

function describe(privateKeyPem: string): SigningKey {
  let publicKeySpkiDer: Buffer;
  try {
    const privateKey = createPrivateKey(privateKeyPem);
    if (privateKey.asymmetricKeyType !== "ed25519") {
      throw new CapsuleError("E_SIGNATURE", `signing key is not ed25519: ${privateKey.asymmetricKeyType}`);
    }
    publicKeySpkiDer = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  } catch (e) {
    if (e instanceof CapsuleError) throw e;
    throw new CapsuleError("E_SIGNATURE", "signing key is not a readable PKCS#8 PEM", {
      cause: (e as Error).message,
    });
  }
  return {
    privateKeyPem,
    publicKeySpkiDer,
    publicKeyBase64: publicKeySpkiDer.toString("base64"),
    keyId: keyIdOf(publicKeySpkiDer),
  };
}

/**
 * Load `<home>/signing-key.pem`, creating it on first use. The create path uses `flag: "wx"` so a
 * concurrent creator can never be clobbered — on EEXIST we simply read whichever key won.
 */
export function loadOrCreateSigningKey(homeDir: string = capsuleHome()): SigningKey {
  const keyPath = join(homeDir, "signing-key.pem");
  const read = (): string | undefined => {
    try {
      return readFileSync(keyPath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  };

  const existing = read();
  if (existing !== undefined) return describe(existing);

  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  mkdirSync(homeDir, { recursive: true });
  try {
    writeFileSync(keyPath, pem, { mode: 0o600, flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const winner = read();
    if (winner !== undefined) return describe(winner);
  }
  return describe(pem);
}

export function signStatement(statement: Statement, privateKeyPem: string): SignatureDoc {
  const key = describe(privateKeyPem);
  const signature = sign(null, Buffer.from(canonicalize(statement), "utf8"), createPrivateKey(privateKeyPem));
  return {
    alg: "ed25519",
    publicKey: key.publicKeyBase64,
    keyId: key.keyId,
    signature: signature.toString("base64"),
  };
}

/** Reject anything base64 that does not round-trip: silent truncation must not become a valid key. */
function decodeStrictBase64(value: string, what: string): Buffer {
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength === 0 || bytes.toString("base64") !== value) {
    throw new CapsuleError("E_SIGNATURE", `malformed ${what} encoding in signature document`);
  }
  return bytes;
}

export function verifySignature(statement: Statement, signatureDoc: SignatureDoc): void {
  if (signatureDoc.alg !== "ed25519") {
    throw new CapsuleError("E_SIGNATURE", `unsupported signature algorithm: ${signatureDoc.alg}`, {
      alg: signatureDoc.alg,
    });
  }

  const der = decodeStrictBase64(signatureDoc.publicKey, "public key");
  const actualKeyId = keyIdOf(der);
  if (actualKeyId !== signatureDoc.keyId) {
    throw new CapsuleError("E_SIGNATURE", "keyId does not match publicKey in signature document", {
      expected: actualKeyId,
      actual: signatureDoc.keyId,
    });
  }

  let publicKey;
  try {
    publicKey = createPublicKey({ key: der, format: "der", type: "spki" });
  } catch (e) {
    throw new CapsuleError("E_SIGNATURE", "malformed public key in signature document", {
      cause: (e as Error).message,
    });
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new CapsuleError("E_SIGNATURE", `public key is not ed25519: ${publicKey.asymmetricKeyType}`);
  }

  const signature = decodeStrictBase64(signatureDoc.signature, "signature");
  const data = Buffer.from(canonicalize(statement), "utf8");
  let ok: boolean;
  try {
    ok = verify(null, data, publicKey, signature);
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new CapsuleError("E_SIGNATURE", "signature verification failed", { keyId: signatureDoc.keyId });
  }
}
