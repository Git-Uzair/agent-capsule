import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { asRecord, canonicalize } from "../core/canonical.ts";
import { CapsuleError } from "../core/errors.ts";
import {
  loadOrCreateSigningKey,
  signStatement,
  verifySignature,
  type SignatureDoc,
} from "../security/signing.ts";
import { checkTrust, loadTrustStore, pinTrust } from "../security/trust.ts";
import { openContainer, packEntries, type CapsuleEntry, type CapsuleReader } from "./container.ts";
import { parseManifest, type Manifest } from "./manifest.ts";
import { buildStatement, toolCatalogDigest, verifyStatement, type Statement } from "./statement.ts";

const STATEMENT_PATH = ".capsule/statement.json";
const SIGNATURE_PATH = ".capsule/signature.json";

/**
 * What may be packed from an author's directory: the manifest plus the three author-owned trees.
 * `.capsule/` is a legal *container* path but never comes from disk — the packer writes it — so a
 * checked-in `.capsule/signature.json` can never shadow the one we are about to sign.
 */
const PACKABLE = /^(capsule\.json|(src|ui|data)\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*)$/;
/** Names worth descending into or looking at at all; everything else is skipped in silence. */
const PACKABLE_TREE = /^(capsule\.json$|(src|ui|data)(\/|$))/;

export type PackResult = {
  file: string;
  capsuleId: string;
  keyId: string;
  name: string;
  version: string;
};

export type LoadedCapsule = {
  file: string;
  bytes: Buffer;
  reader: CapsuleReader;
  manifest: Manifest;
  statement: Statement;
  signature: SignatureDoc;
  capsuleId: string;
  keyId: string;
  trust: "pinned" | "ok" | "drift-accepted";
};

/**
 * Entry paths are assembled from directory names with `/`, so walking a Windows directory still
 * yields POSIX container paths — no `\` ever reaches `assertLegalPath`, which would reject it.
 * Symlinks are refused outright: a link is a promise about a file that is not in the container, and
 * the digest of a promise is not the digest of its target.
 */
function collectFiles(dir: string): CapsuleEntry[] {
  const files: CapsuleEntry[] = [];
  const walk = (rel: string): void => {
    for (const child of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const path = rel === "" ? child.name : `${rel}/${child.name}`;
      if (!PACKABLE_TREE.test(path)) continue;
      if (child.isSymbolicLink()) {
        throw new CapsuleError("E_CONTAINER", `symlink is not packable: ${path}`, { path });
      }
      if (child.isDirectory()) walk(path);
      else if (child.isFile() && PACKABLE.test(path)) files.push({ path, data: readFileSync(join(dir, path)) });
    }
  };
  walk("");
  return files;
}

/** Every path the manifest points at has to be in the container, or the capsule is dead on arrival. */
function assertReferencedFilesExist(manifest: Manifest, present: Set<string>): void {
  const referenced = [
    manifest.runtime.entry,
    ...(manifest.ui?.app?.path === undefined ? [] : [manifest.ui.app.path]),
    ...(manifest.ui?.local?.path === undefined ? [] : [manifest.ui.local.path]),
    ...manifest.resources.map((r) => r.path),
  ];
  for (const path of referenced) {
    if (!present.has(path)) {
      throw new CapsuleError("E_MANIFEST", `entry file not found: ${path}`, { path });
    }
  }
}

export async function packDirectory(
  dir: string,
  out?: string,
  opts?: { keyPem?: string; homeDir?: string },
): Promise<PackResult> {
  const files = collectFiles(dir);
  const manifestFile = files.find((f) => f.path === "capsule.json");
  if (manifestFile === undefined) {
    throw new CapsuleError("E_MANIFEST", `capsule.json not found in ${dir}`, { dir });
  }
  const manifest = parseManifest(Buffer.from(manifestFile.data).toString("utf8"));
  assertReferencedFilesExist(manifest, new Set(files.map((f) => f.path)));

  const statement = buildStatement({ manifest, files });
  const privateKeyPem = opts?.keyPem ?? loadOrCreateSigningKey(opts?.homeDir).privateKeyPem;
  const signature = signStatement(statement, privateKeyPem);

  const bytes = await packEntries([
    ...files,
    { path: STATEMENT_PATH, data: Buffer.from(canonicalize(statement), "utf8") },
    { path: SIGNATURE_PATH, data: Buffer.from(canonicalize(signature), "utf8") },
  ]);
  const file = out ?? `${manifest.meta.name}-${manifest.meta.version}.capsule`;
  writeFileSync(file, bytes);

  return {
    file,
    capsuleId: statement.subject.payloadDigest,
    keyId: signature.keyId,
    name: manifest.meta.name,
    version: manifest.meta.version,
  };
}

/**
 * `JSON.parse` returns `any`, which would let a hand-crafted container hand `verifyStatement` a
 * `files` string and crash the host with a TypeError instead of a `CapsuleError`. These two guards
 * check exactly the fields the verifiers dereference — nothing more; the schema for the rest of the
 * capsule lives in capsule.json.
 */
function parseDoc(text: string, path: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new CapsuleError("E_SIGNATURE", `${path} is not valid JSON`, { path, cause: (e as Error).message });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CapsuleError("E_SIGNATURE", `${path} is malformed`, { path });
  }
  return value as Record<string, unknown>;
}

const isString = (value: unknown): boolean => typeof value === "string";

function asStatement(doc: Record<string, unknown>): Statement {
  const subject = asRecord(doc["subject"]);
  const predicate = asRecord(doc["predicate"]);
  const files = doc["files"];
  const ok =
    subject !== undefined &&
    predicate !== undefined &&
    Array.isArray(files) &&
    isString(subject["name"]) &&
    isString(subject["version"]) &&
    isString(subject["payloadDigest"]) &&
    isString(predicate["toolCatalogDigest"]) &&
    files.every((f: unknown) => {
      const entry = asRecord(f);
      return (
        entry !== undefined &&
        isString(entry["path"]) &&
        isString(entry["sha256"]) &&
        typeof entry["size"] === "number"
      );
    });
  if (!ok) throw new CapsuleError("E_SIGNATURE", `${STATEMENT_PATH} is malformed`, { path: STATEMENT_PATH });
  return doc as unknown as Statement;
}

function asSignatureDoc(doc: Record<string, unknown>): SignatureDoc {
  if (!isString(doc["alg"]) || !isString(doc["publicKey"]) || !isString(doc["keyId"]) || !isString(doc["signature"])) {
    throw new CapsuleError("E_SIGNATURE", `${SIGNATURE_PATH} is malformed`, { path: SIGNATURE_PATH });
  }
  return doc as unknown as SignatureDoc;
}

/**
 * The trust gate every entry point goes through. The order is the point: the signature is checked
 * before any digest, so we never hash a file list chosen by someone whose key we have not seen; the
 * digests are checked before the trust store, so a pin is never taken from a container whose bytes
 * do not match its statement.
 */
export async function loadCapsule(
  file: string,
  opts?: { trust?: boolean; acceptDrift?: boolean; homeDir?: string },
): Promise<LoadedCapsule> {
  const bytes = readFileSync(file);
  const reader = await openContainer(bytes);
  const manifest = parseManifest((await reader.read("capsule.json")).toString("utf8"));

  if (!reader.has(STATEMENT_PATH) || !reader.has(SIGNATURE_PATH)) {
    throw new CapsuleError("E_SIGNATURE", "capsule is unsigned", { file });
  }
  const statement = asStatement(parseDoc((await reader.read(STATEMENT_PATH)).toString("utf8"), STATEMENT_PATH));
  const signature = asSignatureDoc(parseDoc((await reader.read(SIGNATURE_PATH)).toString("utf8"), SIGNATURE_PATH));

  verifySignature(statement, signature);
  await verifyStatement(statement, reader);

  const catalogDigest = toolCatalogDigest(manifest);
  if (catalogDigest !== statement.predicate.toolCatalogDigest) {
    throw new CapsuleError("E_DIGEST", "catalog digest mismatch", {
      expected: catalogDigest,
      actual: statement.predicate.toolCatalogDigest,
    });
  }

  // Checked before the trust store is touched, so a pin is never keyed on a name the signed
  // statement does not claim (the plan orders this last; pinning first would be the wrong order).
  const name = manifest.meta.name;
  if (statement.subject.name !== name || statement.subject.version !== manifest.meta.version) {
    throw new CapsuleError("E_DIGEST", "statement subject does not match capsule.json", {
      statement: `${statement.subject.name}@${statement.subject.version}`,
      manifest: `${name}@${manifest.meta.version}`,
    });
  }

  let trust: LoadedCapsule["trust"] = "ok";
  if (opts?.trust ?? true) {
    const observed = { keyId: signature.keyId, publicKey: signature.publicKey, toolCatalogDigest: catalogDigest };
    const pinned = loadTrustStore(opts?.homeDir).capsules[name];
    // Drift is the same key publishing a different tool catalog — the rug pull. Only that case is
    // overridable; `checkTrust` stays the single gate for a changed key.
    const drifted = pinned !== undefined && pinned.keyId === observed.keyId && pinned.toolCatalogDigest !== catalogDigest;
    if (drifted && opts?.acceptDrift === true) {
      process.stderr.write(
        `warning: tool catalog changed for ${name}: ${pinned.toolCatalogDigest} -> ${catalogDigest} (re-pinned)\n`,
      );
      pinTrust(name, observed, opts?.homeDir);
      trust = "drift-accepted";
    } else {
      trust = checkTrust(pinned, { ...observed, name });
      if (trust === "pinned") pinTrust(name, observed, opts?.homeDir);
    }
  }

  return {
    file,
    bytes,
    reader,
    manifest,
    statement,
    signature,
    capsuleId: statement.subject.payloadDigest,
    keyId: signature.keyId,
    trust,
  };
}
