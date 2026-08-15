import { CapsuleError } from "../core/errors.ts";
import { digestOf, sha256Hex } from "../core/digest.ts";
import { HOST_VERSION } from "../version.ts";
import type { CapsuleEntry, CapsuleReader } from "./container.ts";
import type { Manifest } from "./manifest.ts";

export type StatementFile = {
  path: string;
  sha256: string;
  size: number;
};

export type Statement = {
  spec: "agentcapsule.org/statement/0.1";
  subject: {
    name: string;
    version: string;
    payloadDigest: string;
  };
  files: StatementFile[];
  predicate: {
    builder: {
      name: string;
      version: string;
    };
    toolCatalogDigest: string;
  };
};

export function toolCatalogDigest(manifest: Manifest): string {
  const normalized = manifest.tools
    .map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      outputSchema: t.outputSchema ?? null,
      effects: [...t.effects].sort(),
      ui: t.ui ?? null,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return digestOf(normalized);
}

export function buildStatement({
  manifest,
  files,
}: {
  manifest: Manifest;
  files: CapsuleEntry[];
}): Statement {
  const sortedFiles: StatementFile[] = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => ({
      path: f.path,
      sha256: sha256Hex(f.data),
      size: f.data.byteLength,
    }));

  const payloadDigest = digestOf(sortedFiles);
  const catalogDigest = toolCatalogDigest(manifest);

  return {
    spec: "agentcapsule.org/statement/0.1",
    subject: {
      name: manifest.meta.name,
      version: manifest.meta.version,
      payloadDigest,
    },
    files: sortedFiles,
    predicate: {
      builder: {
        name: "agent-capsule",
        version: HOST_VERSION,
      },
      toolCatalogDigest: catalogDigest,
    },
  };
}

export async function verifyStatement(statement: Statement, reader: CapsuleReader): Promise<void> {
  // 1. Hash every file listed and compare
  for (const file of statement.files) {
    if (!reader.has(file.path)) {
      throw new CapsuleError("E_DIGEST", `missing entry: ${file.path}`, { path: file.path });
    }
    const data = await reader.read(file.path);
    if (data.byteLength !== file.size || sha256Hex(data) !== file.sha256) {
      throw new CapsuleError("E_DIGEST", `digest mismatch: ${file.path}`, {
        path: file.path,
        expectedSha256: file.sha256,
        expectedSize: file.size,
        actualSize: data.byteLength,
      });
    }
  }

  // 2. Recompute payloadDigest from the listed files and compare
  const computedPayloadDigest = digestOf(statement.files);
  if (statement.subject.payloadDigest !== computedPayloadDigest) {
    throw new CapsuleError("E_DIGEST", "payload digest mismatch", {
      expected: computedPayloadDigest,
      actual: statement.subject.payloadDigest,
    });
  }

  // 3. Compare container reader's entry set minus .capsule/statement.json and .capsule/signature.json
  const statementPaths = new Set(statement.files.map((f) => f.path));
  for (const path of reader.list()) {
    if (path === ".capsule/statement.json" || path === ".capsule/signature.json") {
      continue;
    }
    if (!statementPaths.has(path)) {
      throw new CapsuleError("E_DIGEST", `unlisted entry: ${path}`, { path });
    }
  }
}
