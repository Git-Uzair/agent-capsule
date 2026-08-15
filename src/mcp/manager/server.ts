import { asRecord } from "../../core/canonical.ts";
import { CapsuleError } from "../../core/errors.ts";
import { loadCapsule, type LoadedCapsule } from "../../format/capsule.ts";
import { homeSidecarPaths } from "../../runtime/invoke.ts";
import { HOST_VERSION } from "../../version.ts";
import { handleToolsCall, type McpServerContext } from "../call.ts";
import {
  assertNoToolNameCollision,
  buildToolList,
  type CatalogTool,
} from "../catalog.ts";
import {
  CAPSULE_SPEC,
  MCP_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  type McpServer,
} from "../server.ts";
import {
  JSON_RPC_ERROR,
  RpcFailure,
  type JsonRpcErrorResponse,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcResponse,
  type Transport,
} from "../transport.ts";
import { confusableSkeleton, sanitizeModelText } from "../../security/text.ts";
import { loadInstalledStore, type InstalledEntry } from "./registry.ts";
import {
  handleCapsuleInstall,
  handleCapsuleList,
  handleCapsuleUninstall,
  MANAGER_TOOLS,
} from "./tools.ts";

const SERVER_INFO_META = "io.modelcontextprotocol/serverInfo";
const CATALOG_TTL_MS = 3_600_000;

export type ManagerServerOptions = {
  homeDir?: string;
  downloadsDir?: string;
  allowSuspicious?: boolean;
  warn?: (line: string) => void;
};

export type ManagerMcpServer = McpServer & {
  notifyListChanged(): void;
  invalidateCache(): void;
  drain(): Promise<void>;
};

export function createManagerServer(opts: ManagerServerOptions = {}): ManagerMcpServer {
  const warn =
    opts.warn ??
    ((line: string): void => {
      process.stderr.write(`${line}\n`);
    });

  // Ensure manager built-in tools do not collide among themselves
  assertNoToolNameCollision(MANAGER_TOOLS.map((t) => t.name));

  let negotiatedVersion: string = MCP_PROTOCOL_VERSION;
  const activeTransports = new Set<Transport>();
  const loadedCapsuleCache = new Map<string, LoadedCapsule>();
  let messageQueue = Promise.resolve();

  const serverInfo = { name: "Capsule Manager", version: HOST_VERSION };
  const resultMeta = {
    [SERVER_INFO_META]: { name: "capsule-manager", version: HOST_VERSION },
  };

  const result = (body: Record<string, unknown>, meta?: Record<string, unknown>): Record<string, unknown> => ({
    resultType: "complete",
    ...body,
    _meta: { ...meta, ...resultMeta },
  });

  const instructions = (): string =>
    "Capsule Manager is a gateway for sandboxed Agent Capsules. " +
    "Use capsule_install to install a capsule, capsule_list to see installed capsules, and capsule_uninstall to remove a capsule. " +
    "Installed capsules expose their tools under <capsuleName>__<toolName>.";

  function invalidateCache(): void {
    loadedCapsuleCache.clear();
  }

  function notifyListChanged(): void {
    for (const transport of activeTransports) {
      try {
        transport.send({
          jsonrpc: "2.0",
          method: "notifications/tools/list_changed",
        });
      } catch (e) {
        warn(`Failed to send tools/list_changed notification: ${String(e)}`);
      }
    }
  }

  async function getLoadedCapsule(capsuleId: string, file: string): Promise<LoadedCapsule | undefined> {
    const cached = loadedCapsuleCache.get(capsuleId);
    if (cached !== undefined) {
      return cached;
    }
    try {
      // Re-load without trust re-pinning since trust was verified at install time
      const loaded = await loadCapsule(file, {
        trust: false,
        acceptDrift: true,
        homeDir: opts.homeDir,
      });
      loadedCapsuleCache.set(capsuleId, loaded);
      return loaded;
    } catch (err) {
      warn(`Failed to load installed capsule ${capsuleId} from ${file}: ${String(err)}`);
      return undefined;
    }
  }

  async function getMergedToolList(): Promise<CatalogTool[]> {
    const merged: CatalogTool[] = [...MANAGER_TOOLS];
    const seenSkeletons = new Map<string, string>();

    for (const tool of MANAGER_TOOLS) {
      seenSkeletons.set(confusableSkeleton(tool.name), tool.name);
    }

    const store = loadInstalledStore(opts.homeDir);
    // Sort installed capsules by installedAt ascending for deterministic precedence
    const sortedEntries = Object.entries(store.capsules).sort((a, b) =>
      a[1].installedAt.localeCompare(b[1].installedAt),
    );

    for (const [capsuleId, entry] of sortedEntries) {
      const loaded = await getLoadedCapsule(capsuleId, entry.file);
      if (!loaded) continue;

      const capsuleTools = buildToolList(loaded.manifest, {
        allowSuspicious: opts.allowSuspicious === true,
        warn,
      });

      let hasCollision = false;
      const candidateTools: CatalogTool[] = [];

      for (const tool of capsuleTools) {
        const prefixedName = `${loaded.manifest.meta.name}__${tool.name}`;
        const skeleton = confusableSkeleton(prefixedName);
        const first = seenSkeletons.get(skeleton);
        if (first !== undefined) {
          warn(
            `Collision detected: tool '${prefixedName}' in capsule '${loaded.manifest.meta.name}' ` +
              `collides with already registered tool '${first}'. Suppressing newer capsule.`,
          );
          hasCollision = true;
          break;
        }
        candidateTools.push({
          ...tool,
          name: prefixedName,
          title: `${loaded.manifest.meta.name}: ${tool.title}`,
        });
      }

      if (!hasCollision) {
        for (const candidate of candidateTools) {
          seenSkeletons.set(confusableSkeleton(candidate.name), candidate.name);
          merged.push(candidate);
        }
      }
    }

    return merged;
  }

  async function handleToolsCallGateway(params: unknown): Promise<Record<string, unknown>> {
    const request = asRecord(params);
    const fullName = request?.["name"];
    if (typeof fullName !== "string" || fullName === "") {
      throw new RpcFailure(JSON_RPC_ERROR.InvalidParams, "tools/call needs a non-empty string name");
    }

    // Direct manager tools
    if (fullName.startsWith("capsule_") && !fullName.includes("__")) {
      const managerTool = MANAGER_TOOLS.find((t) => t.name === fullName);
      if (!managerTool) {
        throw new RpcFailure(JSON_RPC_ERROR.InvalidParams, `unknown manager tool: ${fullName}`);
      }

      const rawArgs = request?.["arguments"];

      if (fullName === "capsule_install") {
        const res = await handleCapsuleInstall(rawArgs, {
          homeDir: opts.homeDir,
          downloadsDir: opts.downloadsDir,
          warn,
          notifyListChanged,
          invalidateCache,
        });
        return {
          resultType: "complete",
          content: [{ type: "text", text: res.text }],
          structuredContent: res.structured,
          isError: res.isError,
          _meta: { ...resultMeta },
        };
      }

      if (fullName === "capsule_uninstall") {
        const res = handleCapsuleUninstall(rawArgs, {
          homeDir: opts.homeDir,
          notifyListChanged,
          invalidateCache,
        });
        return {
          resultType: "complete",
          content: [{ type: "text", text: res.text }],
          structuredContent: res.structured,
          isError: res.isError,
          _meta: { ...resultMeta },
        };
      }

      if (fullName === "capsule_list") {
        const res = await handleCapsuleList({
          homeDir: opts.homeDir,
          getCapsule: getLoadedCapsule,
        });
        return {
          resultType: "complete",
          content: [{ type: "text", text: res.text }],
          structuredContent: res.structured,
          isError: res.isError,
          _meta: { ...resultMeta },
        };
      }

      // Future stubs (P2-4)
      return {
        resultType: "complete",
        content: [{ type: "text", text: `${fullName} is supported in Phase P2-4.` }],
        isError: false,
        _meta: { ...resultMeta },
      };
    }

    // Gateway dispatched tools: <capsuleName>__<toolName>
    if (fullName.includes("__")) {
      const idx = fullName.indexOf("__");
      const capsuleName = fullName.slice(0, idx);
      const innerToolName = fullName.slice(idx + 2);

      const store = loadInstalledStore(opts.homeDir);
      let targetEntry: InstalledEntry | undefined;
      let targetCapsuleId: string | undefined;

      for (const [cid, entry] of Object.entries(store.capsules)) {
        if (entry.name === capsuleName) {
          targetEntry = entry;
          targetCapsuleId = cid;
          break;
        }
      }

      if (!targetEntry || !targetCapsuleId) {
        throw new RpcFailure(
          JSON_RPC_ERROR.InvalidParams,
          `unknown tool: capsule '${capsuleName}' is not installed`,
        );
      }

      const loaded = await getLoadedCapsule(targetCapsuleId, targetEntry.file);
      if (!loaded) {
        throw new RpcFailure(
          JSON_RPC_ERROR.InvalidParams,
          `failed to load capsule '${capsuleName}'`,
        );
      }

      const servedTools = buildToolList(loaded.manifest, {
        allowSuspicious: opts.allowSuspicious === true,
        warn,
      });

      const toolServed = servedTools.some((t) => t.name === innerToolName);
      if (!toolServed) {
        throw new RpcFailure(
          JSON_RPC_ERROR.InvalidParams,
          `tool '${innerToolName}' is not served by capsule '${capsuleName}'`,
        );
      }

      const sidecars = homeSidecarPaths(loaded.capsuleId, opts.homeDir);
      const ctx: McpServerContext = {
        capsule: loaded,
        served: new Set(servedTools.map((t) => t.name)),
        statePath: sidecars.app,
        journalPath: sidecars.journal,
        homeDir: opts.homeDir,
        warn,
        resultMeta: {
          [SERVER_INFO_META]: {
            name: `capsule/${loaded.manifest.meta.name}`,
            version: loaded.manifest.meta.version,
          },
        },
        legacySession: () => negotiatedVersion !== MCP_PROTOCOL_VERSION,
      };

      const rewrittenParams = {
        ...(asRecord(params) ?? {}),
        name: innerToolName,
      };

      return await handleToolsCall(rewrittenParams, ctx);
    }

    throw new RpcFailure(JSON_RPC_ERROR.InvalidParams, `unknown tool: ${sanitizeModelText(fullName, 120)}`);
  }

  const handlers = new Map<
    string,
    (params: unknown) => Record<string, unknown> | Promise<Record<string, unknown>>
  >([
    [
      "initialize",
      (params) => {
        const requested = asRecord(params)?.["protocolVersion"];
        negotiatedVersion =
          typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : MCP_PROTOCOL_VERSION;
        return result({
          protocolVersion: negotiatedVersion,
          serverInfo,
          capabilities: {
            tools: { listChanged: true },
            resources: { listChanged: false },
          },
          instructions: instructions(),
        });
      },
    ],
    [
      "server/discover",
      () =>
        result({
          spec: MCP_PROTOCOL_VERSION,
          supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
          server: serverInfo,
          capabilities: {
            tools: { listChanged: true },
            resources: { listChanged: false },
          },
          instructions: instructions(),
          ttlMs: CATALOG_TTL_MS,
          cacheScope: "public",
        }),
    ],
    ["tools/list", async () => result({ tools: await getMergedToolList(), ttlMs: CATALOG_TTL_MS, cacheScope: "public" })],
    ["tools/call", handleToolsCallGateway],
    ["resources/list", () => result({ resources: [], ttlMs: CATALOG_TTL_MS, cacheScope: "public" })],
    [
      "resources/read",
      () => {
        throw new RpcFailure(JSON_RPC_ERROR.InvalidParams, "no resources declared by manager");
      },
    ],
    ["ping", () => result({})],
  ]);

  const errorResponse = (id: JsonRpcId, code: number, message: string): JsonRpcErrorResponse => ({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });

  async function handleMessage(
    msg: JsonRpcMessage,
  ): Promise<JsonRpcResponse | JsonRpcErrorResponse | void> {
    if (!("method" in msg) || !("id" in msg)) {
      return;
    }
    const handler = handlers.get(msg.method);
    if (handler === undefined) {
      return errorResponse(
        msg.id,
        JSON_RPC_ERROR.MethodNotFound,
        `method not found: ${sanitizeModelText(msg.method, 120)}`,
      );
    }
    try {
      return { jsonrpc: "2.0", id: msg.id, result: await handler(msg.params) };
    } catch (err) {
      if (err instanceof RpcFailure) {
        return errorResponse(msg.id, err.code, err.message);
      }
      const detail = err instanceof CapsuleError ? `${err.code}: ${err.message}` : String(err);
      warn(`${msg.method} failed: ${detail}`);
      return errorResponse(msg.id, JSON_RPC_ERROR.InternalError, "internal error");
    }
  }

  return {
    handleMessage,
    notifyListChanged,
    invalidateCache,
    drain(): Promise<void> {
      return messageQueue;
    },
    serve(transport: Transport): void {
      activeTransports.add(transport);
      transport.onMessage((msg) => {
        messageQueue = messageQueue
          .then(async () => {
            const response = await handleMessage(msg);
            if (response !== undefined) {
              transport.send(response);
            }
          })
          .catch((err) => {
            warn(`Transport message processing error: ${String(err)}`);
          });
      });
    },
  };
}
