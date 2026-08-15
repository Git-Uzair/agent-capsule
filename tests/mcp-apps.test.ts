import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "../src/core/digest.ts";
import { CapsuleError } from "../src/core/errors.ts";
import { loadCapsule, packDirectory, type LoadedCapsule } from "../src/format/capsule.ts";
import { parseManifest, type Manifest } from "../src/format/manifest.ts";
import { readUiResource, UI_MIME_TYPE, uiResourceDescriptor } from "../src/mcp/apps.ts";
import { createMcpServer, type McpServer } from "../src/mcp/server.ts";
import type { JsonRpcRequest } from "../src/mcp/transport.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "hello");

type DraftTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  effects?: string[];
  ui?: string;
};

type DraftResource = { uri: string; name: string; mimeType: string; path: string };

type Draft = {
  spec_version: "0.1.0";
  meta: { name: string; version: string; title: string; description: string };
  runtime: { type: "quickjs-1"; entry: string; timeout_ms?: number };
  capabilities: {
    sql?: boolean;
    kv?: boolean;
    pack?: boolean;
    net?: { allowed_hosts?: string[]; allow_localhost?: boolean };
  };
  tools: DraftTool[];
  resources?: DraftResource[];
  ui?: {
    app?: {
      resourceUri: string;
      path: string;
      csp?: {
        connectDomains?: string[];
        resourceDomains?: string[];
        frameDomains?: string[];
        baseUriDomains?: string[];
      };
    };
    local?: { path: string };
  };
};

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = join(".tmp", `home-${randomUUID()}`);
  const previous = process.env.CAPSULE_HOME;
  process.env.CAPSULE_HOME = home;
  mkdirSync(home, { recursive: true });
  try {
    await fn(home);
  } finally {
    if (previous === undefined) delete process.env.CAPSULE_HOME;
    else process.env.CAPSULE_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

async function packCapsule(home: string, edit?: (draft: Draft) => void): Promise<LoadedCapsule> {
  const dir = join(home, `src-${randomUUID()}`);
  cpSync(FIXTURE, dir, { recursive: true });

  const draft = JSON.parse(readFileSync(join(dir, "capsule.json"), "utf8")) as Draft;
  edit?.(draft);
  writeFileSync(join(dir, "capsule.json"), JSON.stringify(draft));

  const file = join(home, `hello-${randomUUID()}.capsule`);
  await packDirectory(dir, file, { homeDir: home });
  return await loadCapsule(file, { homeDir: home });
}

let nextId = 0;
function request(method: string, params?: unknown): JsonRpcRequest {
  nextId += 1;
  return { jsonrpc: "2.0", id: nextId, method, ...(params === undefined ? {} : { params }) };
}

async function callOk(server: McpServer, method: string, params?: unknown): Promise<Record<string, unknown>> {
  const response = await server.handleMessage(request(method, params));
  assert.ok(response !== undefined && "result" in response, `expected success for ${method}`);
  return response.result as Record<string, unknown>;
}

test("resources/list contains the ui:// entry with exact mime type text/html;profile=mcp-app", async () => {
  await withHome(async (home) => {
    const capsule = await packCapsule(home);
    const server = createMcpServer({ capsule });

    const list = await callOk(server, "resources/list");
    const resources = list["resources"] as Array<{ uri: string; name: string; mimeType: string }>;

    assert.ok(Array.isArray(resources));
    const uiRes = resources.find((r) => r.uri === "ui://hello");
    assert.ok(uiRes, "resources/list should contain ui://hello");
    assert.deepEqual(uiRes, {
      uri: "ui://hello",
      name: "App UI",
      mimeType: "text/html;profile=mcp-app",
    });

    // When ui.app is not present, resources/list does not include ui://
    const noUiCapsule = await packCapsule(home, (draft) => {
      draft.meta.name = "hello-no-ui";
      delete draft.ui;
      for (const tool of draft.tools) delete tool.ui;
    });
    const noUiServer = createMcpServer({ capsule: noUiCapsule });
    const noUiList = await callOk(noUiServer, "resources/list");
    const noUiResources = noUiList["resources"] as Array<{ uri: string; name: string; mimeType: string }>;
    assert.equal(noUiResources.find((r) => r.uri.startsWith("ui://")), undefined);
  });
});

test("resources/read returns the fixture HTML byte-for-byte with empty CSP arrays", async () => {
  await withHome(async (home) => {
    const capsule = await packCapsule(home);
    const server = createMcpServer({ capsule });

    const result = await callOk(server, "resources/read", { uri: "ui://hello" });
    assert.equal(result["resultType"], "complete");
    assert.equal(result["ttlMs"], 86_400_000);
    assert.equal(result["cacheScope"], "public");

    const contents = result["contents"] as Array<{
      uri: string;
      mimeType: string;
      text: string;
      _meta: {
        ui: {
          csp: {
            connectDomains: string[];
            resourceDomains: string[];
            frameDomains: string[];
            baseUriDomains: string[];
          };
          prefersBorder: boolean;
        };
      };
    }>;
    assert.equal(contents.length, 1);
    const item = contents[0]!;
    assert.equal(item.uri, "ui://hello");
    assert.equal(item.mimeType, "text/html;profile=mcp-app");

    // Verify byte-for-byte matching against the statement digest for ui/index.html
    const textBytes = new TextEncoder().encode(item.text);
    const textDigest = sha256Hex(textBytes);
    const statementFile = capsule.statement.files.find((f) => f.path === "ui/index.html");
    assert.ok(statementFile, "statement must include ui/index.html");
    assert.equal(textDigest, statementFile.sha256);

    // Verify empty CSP arrays as default
    assert.deepEqual(item._meta, {
      ui: {
        csp: {
          connectDomains: [],
          resourceDomains: [],
          frameDomains: [],
          baseUriDomains: [],
        },
        prefersBorder: false,
      },
    });
  });
});

test("resources/read returns custom CSP metadata when declared in manifest", async () => {
  await withHome(async (home) => {
    const capsule = await packCapsule(home, (draft) => {
      draft.capabilities.net = { allowed_hosts: ["api.example.com"], allow_localhost: false };
      draft.ui = {
        app: {
          resourceUri: "ui://hello",
          path: "ui/index.html",
          csp: {
            connectDomains: ["https://api.example.com"],
            frameDomains: ["https://frames.example.com"],
          },
        },
      };
    });
    const server = createMcpServer({ capsule });

    const result = await callOk(server, "resources/read", { uri: "ui://hello" });
    const contents = result["contents"] as Array<{
      uri: string;
      mimeType: string;
      text: string;
      _meta: {
        ui: {
          csp: {
            connectDomains: string[];
            resourceDomains: string[];
            frameDomains: string[];
            baseUriDomains: string[];
          };
          prefersBorder: boolean;
        };
      };
    }>;
    assert.equal(contents.length, 1);
    assert.deepEqual(contents[0]!._meta, {
      ui: {
        csp: {
          connectDomains: ["https://api.example.com"],
          resourceDomains: [],
          frameDomains: ["https://frames.example.com"],
          baseUriDomains: [],
        },
        prefersBorder: false,
      },
    });
  });
});

test("parseManifest enforces invariant: ui.app.csp.connectDomains must be a subset of capabilities.net.allowed_hosts", () => {
  const baseManifest = {
    spec_version: "0.1.0" as const,
    meta: { name: "hello", version: "1.0.0", title: "Hello", description: "A hello capsule." },
    runtime: { type: "quickjs-1" as const, entry: "src/main.js" },
    tools: [
      {
        name: "greet",
        title: "Greet",
        description: "Greets.",
        inputSchema: { type: "object" },
        ui: "ui://hello",
      },
    ],
    ui: {
      app: {
        resourceUri: "ui://hello",
        path: "ui/index.html",
        csp: {
          connectDomains: ["https://evil.test"],
        },
      },
    },
  };

  // Fails when connectDomains is not in allowed_hosts
  assert.throws(
    () => parseManifest(baseManifest),
    (err: unknown) =>
      err instanceof CapsuleError &&
      err.code === "E_MANIFEST" &&
      /ui\.app\.csp\.connectDomains not covered by capabilities\.net\.allowed_hosts/.test(err.message),
  );

  // Succeeds when allowed_hosts covers connectDomains
  const allowedManifest = {
    ...baseManifest,
    capabilities: {
      net: {
        allowed_hosts: ["evil.test"],
      },
    },
  };
  const parsed = parseManifest(allowedManifest);
  assert.equal(parsed.ui?.app?.csp?.connectDomains?.[0], "https://evil.test");

  // Succeeds with wildcard allowed_hosts
  const wildcardManifest = {
    ...baseManifest,
    capabilities: {
      net: {
        allowed_hosts: ["*.example.com"],
      },
    },
    ui: {
      app: {
        resourceUri: "ui://hello",
        path: "ui/index.html",
        csp: {
          connectDomains: ["https://sub.example.com"],
        },
      },
    },
  };
  assert.doesNotThrow(() => parseManifest(wildcardManifest));

  // Localhost in connectDomains requires allow_localhost: true
  const localhostManifest = {
    ...baseManifest,
    ui: {
      app: {
        resourceUri: "ui://hello",
        path: "ui/index.html",
        csp: {
          connectDomains: ["http://localhost:3000"],
        },
      },
    },
  };
  assert.throws(
    () => parseManifest(localhostManifest),
    (err: unknown) => err instanceof CapsuleError && err.code === "E_MANIFEST",
  );

  const allowedLocalhostManifest = {
    ...localhostManifest,
    capabilities: {
      net: {
        allow_localhost: true,
      },
    },
  };
  assert.doesNotThrow(() => parseManifest(allowedLocalhostManifest));
});

test("greet tool in tools/list carries _meta.ui.resourceUri === 'ui://hello'", async () => {
  await withHome(async (home) => {
    const capsule = await packCapsule(home);
    const server = createMcpServer({ capsule });

    const result = await callOk(server, "tools/list");
    const tools = result["tools"] as Array<{
      name: string;
      _meta?: { ui?: { resourceUri?: string } };
    }>;

    const greet = tools.find((t) => t.name === "greet");
    assert.ok(greet, "tools/list should include greet");
    assert.deepEqual(greet._meta, { ui: { resourceUri: "ui://hello" } });
  });
});

test("uiResourceDescriptor and readUiResource exported helpers work directly", async () => {
  await withHome(async (home) => {
    const capsule = await packCapsule(home);

    const desc = uiResourceDescriptor(capsule.manifest);
    assert.deepEqual(desc, {
      uri: "ui://hello",
      name: "App UI",
      mimeType: UI_MIME_TYPE,
    });

    const noAppManifest: Manifest = { ...capsule.manifest, ui: undefined };
    assert.equal(uiResourceDescriptor(noAppManifest), undefined);

    const resource = await readUiResource(capsule);
    assert.equal(resource.uri, "ui://hello");
    assert.equal(resource.mimeType, UI_MIME_TYPE);
    assert.ok(typeof resource.text === "string" && resource.text.length > 0);
    assert.deepEqual(resource._meta, {
      ui: {
        csp: {
          connectDomains: [],
          resourceDomains: [],
          frameDomains: [],
          baseUriDomains: [],
        },
        prefersBorder: false,
      },
    });

    await assert.rejects(
      () => readUiResource({ ...capsule, manifest: noAppManifest }),
      (err: unknown) => err instanceof CapsuleError && err.code === "E_CONTAINER",
    );
  });
});
