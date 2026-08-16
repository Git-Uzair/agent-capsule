import { asRecord } from "../../core/canonical.ts";
import { CapsuleError } from "../../core/errors.ts";
import { loadCapsule, type LoadedCapsule } from "../../format/capsule.ts";
import { homeSidecarPaths } from "../../runtime/invoke.ts";
import { HOST_VERSION } from "../../version.ts";
import { BUILTIN_TOOLS } from "../builtin.ts";
import { handleToolsCall, policyRefusal, type McpServerContext } from "../call.ts";
import {
  assertNoToolNameCollision,
  buildToolList,
  type CatalogTool,
} from "../catalog.ts";
import { INPUT_REQUIRED } from "../mrtr.ts";
import {
  capsuleResultMeta,
  CATALOG_TTL_MS,
  createResultBuilder,
  createRpcDispatcher,
  declaredCapabilities,
  MCP_PROTOCOL_VERSION,
  SERVER_INFO_META,
  SUPPORTED_PROTOCOL_VERSIONS,
  type McpServer,
  type RpcHandler,
} from "../server.ts";
import {
  JSON_RPC_ERROR,
  RpcFailure,
  type Transport,
} from "../transport.ts";
import { confusableSkeleton, sanitizeModelText } from "../../security/text.ts";
import {
  handleCapsuleCreate,
  handleCapsuleUpdate,
} from "./authoring.ts";
import { loadInstalledStore, type InstalledEntry } from "./registry.ts";
import {
  GATEWAY_NAME_PATTERN,
  handleCapsuleInstall,
  handleCapsuleList,
  handleCapsuleUninstall,
  MANAGER_TOOLS,
  type ListedCapsule,
  type ToolExecutionResult,
} from "./tools.ts";

/**
 * Why a registry entry is not being served. `"corrupt"` is a file that no longer verifies at all;
 * `"unverifiable"` is a file that verifies but is no longer the capsule the registry pinned.
 */
type VerifyFailure = "corrupt" | "unverifiable";

/** How long to wait for a client to answer an elicitation before treating it as declined (60s). */
export const ELICITATION_TIMEOUT_MS = 60_000;

/** Where one advertised gateway name goes, and what that capsule is allowed to run. */
type GatewayRoute = {
  loaded: LoadedCapsule;
  innerName: string;
  served: ReadonlySet<string>;
};

/**
 * One snapshot of the installed set: the tools the merged catalog advertises, the routes a
 * `tools/call` may reach, and the rows `capsule_list` reports. They are built together on purpose —
 * three separate derivations of "what does this capsule serve" is exactly how an advertised tool
 * became callable while `capsule_list` denied it existed.
 */
type Gateway = {
  tools: CatalogTool[];
  routes: Map<string, GatewayRoute>;
  capsules: ListedCapsule[];
};

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
  let clientElicitation = false;
  let currentTransport: Transport | undefined;
  const activeTransports = new Set<Transport>();
  const loadedCapsuleCache = new Map<string, LoadedCapsule>();
  let messageQueue = Promise.resolve();

  const serverInfo = { name: "Capsule Manager", version: HOST_VERSION };
  const resultMeta = {
    [SERVER_INFO_META]: { name: "capsule-manager", version: HOST_VERSION },
  };

  const result = createResultBuilder(resultMeta);

  const instructions = (): string =>
    "Capsule Manager is a gateway for sandboxed Agent Capsules. " +
    "Use capsule_create and capsule_update to author capsules in conversation, capsule_test_tool to test tools, " +
    "capsule_install to install a capsule, capsule_list to see installed capsules, and capsule_uninstall to remove a capsule. " +
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

  /**
   * The single place a registry entry turns into bytes this server is willing to run. Two gates, both
   * of them the point: the file is verified with the trust store live (drift is never auto-accepted
   * here — only `capsule_install` may re-pin, and only when the user said `accept_drift`), and its
   * payload digest must still be the registry key, so swapping `capsules/<id>.capsule` for another
   * validly signed capsule cannot borrow the trusted name. Caching after that is safe because the key
   * *is* the content address; `invalidateCache` runs on every registry change.
   */
  async function verifyInstalled(
    capsuleId: string,
    entry: InstalledEntry,
  ): Promise<LoadedCapsule | VerifyFailure> {
    const cached = loadedCapsuleCache.get(capsuleId);
    if (cached !== undefined) {
      return cached;
    }
    let loaded: LoadedCapsule;
    try {
      loaded = await loadCapsule(entry.file, { trust: true, homeDir: opts.homeDir });
    } catch (err) {
      const detail = err instanceof CapsuleError ? `${err.code}: ${err.message}` : String(err);
      warn(`Failed to verify installed capsule ${capsuleId} from ${entry.file}: ${detail}`);
      return "corrupt";
    }
    if (loaded.capsuleId !== capsuleId) {
      warn(
        `Refusing installed capsule ${capsuleId}: ${entry.file} now holds ${loaded.capsuleId} ` +
          `('${loaded.manifest.meta.name}'), so the registry pin no longer describes these bytes.`,
      );
      return "unverifiable";
    }
    loadedCapsuleCache.set(capsuleId, loaded);
    return loaded;
  }

  async function buildGateway(): Promise<Gateway> {
    const tools: CatalogTool[] = [...MANAGER_TOOLS];
    const routes = new Map<string, GatewayRoute>();
    const capsules: ListedCapsule[] = [];
    // The manager's own names are part of the merged namespace, so a capsule can never shadow them.
    const seen = new Map<string, string>(
      MANAGER_TOOLS.map((tool) => [confusableSkeleton(tool.name), tool.name]),
    );

    const store = loadInstalledStore(opts.homeDir);
    // Oldest install wins a collision, so which capsule gets suppressed never depends on key order;
    // capsuleId breaks a tie between two installs that landed in the same millisecond.
    const sorted = Object.entries(store.capsules).sort(
      (a, b) => a[1].installedAt.localeCompare(b[1].installedAt) || a[0].localeCompare(b[0]),
    );

    for (const [capsuleId, entry] of sorted) {
      const verified = await verifyInstalled(capsuleId, entry);
      const row: ListedCapsule = {
        capsuleId,
        name: entry.name,
        version: entry.version,
        file: entry.file,
        installedAt: entry.installedAt,
        publisherKey: "unknown",
        trust: typeof verified === "string" ? verified : verified.trust,
        capabilities: "unknown",
        tools: [],
      };
      capsules.push(row);
      if (typeof verified === "string") {
        row.note =
          verified === "unverifiable"
            ? "installed file no longer matches the pinned capsuleId — not served"
            : "installed file failed verification — not served";
        continue;
      }

      const loaded = verified;
      // The verified manifest outranks the registry row: the pin binds these bytes, not the JSON.
      row.name = loaded.manifest.meta.name;
      row.version = loaded.manifest.meta.version;
      row.publisherKey = loaded.keyId;
      row.capabilities = declaredCapabilities(loaded.manifest);

      // `capsule_install` refuses this name, but the registry outlives any one build of the manager:
      // a row written by an older manager, or by hand, must be inert rather than advertised under a
      // prefix that is not a legal gateway name.
      if (!GATEWAY_NAME_PATTERN.test(row.name)) {
        warn(
          `Refusing installed capsule ${capsuleId}: '${row.name}' is not a legal gateway namespace ` +
            `([a-zA-Z0-9_-], 1-64 characters), so '${row.name}__<tool>' cannot name it unambiguously.`,
        );
        row.note = `suppressed: capsule name '${row.name}' is not a legal gateway namespace`;
        continue;
      }

      // The refusal the direct server makes before it ever opens a transport, applied per capsule:
      // two names one human reads as one are a phishing vector inside that capsule's own list, and a
      // shared `<name>__` prefix carries the pair into the merged namespace unchanged — so a
      // cross-capsule check alone never sees it. Built-ins are included because the reserved-prefix
      // rule is case-sensitive: `Capsule_info` is a legal manifest name.
      try {
        assertNoToolNameCollision([
          ...loaded.manifest.tools.map((tool) => tool.name),
          ...BUILTIN_TOOLS.map((tool) => tool.name),
        ]);
      } catch (err) {
        const detail = err instanceof CapsuleError ? err.message : String(err);
        warn(`Collision detected inside capsule '${row.name}': ${detail}. Suppressing capsule.`);
        row.note = `suppressed: ${detail}`;
        continue;
      }

      const allowSuspicious = opts.allowSuspicious === true || entry.allowSuspicious === true;
      const served = buildToolList(loaded.manifest, { allowSuspicious, warn });
      const prefix = `${row.name}__`;
      const clash = served
        .map((tool) => seen.get(confusableSkeleton(`${prefix}${tool.name}`)))
        .find((first) => first !== undefined);
      if (clash !== undefined) {
        warn(
          `Collision detected: capsule '${row.name}' exposes a tool that collides with already ` +
            `registered tool '${clash}'. Suppressing newer capsule.`,
        );
        row.note = `suppressed: tool name collides with '${clash}'`;
        continue;
      }

      const servedNames: ReadonlySet<string> = new Set(served.map((tool) => tool.name));
      for (const tool of served) {
        const name = `${prefix}${tool.name}`;
        seen.set(confusableSkeleton(name), name);
        tools.push({ ...tool, name, title: `${row.name}: ${tool.title}` });
        routes.set(name, { loaded, innerName: tool.name, served: servedNames });
        row.tools.push(name);
      }
    }

    return { tools, routes, capsules };
  }

  /** What the gateway actually serves for one capsuleId — the summary `capsule_install` reads back. */
  const servedTools = async (capsuleId: string): Promise<string[]> =>
    (await buildGateway()).capsules.find((row) => row.capsuleId === capsuleId)?.tools ?? [];

  const managerTools = new Map<
    string,
    (args: unknown) => ToolExecutionResult | Promise<ToolExecutionResult>
  >([
    [
      "capsule_install",
      (args) =>
        handleCapsuleInstall(args, {
          homeDir: opts.homeDir,
          downloadsDir: opts.downloadsDir,
          warn,
          notifyListChanged,
          invalidateCache,
          servedTools,
        }),
    ],
    [
      "capsule_uninstall",
      (args) =>
        handleCapsuleUninstall(args, {
          homeDir: opts.homeDir,
          notifyListChanged,
          invalidateCache,
        }),
    ],
    ["capsule_list", async () => handleCapsuleList((await buildGateway()).capsules)],
    [
      "capsule_create",
      (args) =>
        handleCapsuleCreate(args, {
          homeDir: opts.homeDir,
          warn,
          notifyListChanged,
          invalidateCache,
          servedTools,
        }),
    ],
    [
      "capsule_update",
      (args) =>
        handleCapsuleUpdate(args, {
          homeDir: opts.homeDir,
          warn,
          notifyListChanged,
          invalidateCache,
          servedTools,
        }),
    ],
  ]);

  /**
   * One routed call, from the route the merged catalog was built from all the way to the envelope the
   * client reads. Both addressing schemes end here — the gateway name a client calls and the
   * capsule/tool pair `capsule_test_tool` names — so an authored tool answers an author exactly as it
   * will answer everyone else: same `_meta`, same consent flow, same `isError`.
   */
  async function callCapsuleTool(
    route: GatewayRoute,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const loaded = route.loaded;
    const sidecars = homeSidecarPaths(loaded.capsuleId, opts.homeDir);
    const ctx: McpServerContext = {
      capsule: loaded,
      served: route.served,
      statePath: sidecars.app,
      journalPath: sidecars.journal,
      homeDir: opts.homeDir,
      warn,
      resultMeta: capsuleResultMeta(loaded.manifest),
      // Legacy means only one thing here: a session that can carry the consent question neither way.
      // A pre-2026 revision has no MRTR, and a client that offers no `elicitation` leaves nothing to
      // ask with, so the missing grants become the readable `E_CONSENT` result and the sentence about
      // this revision is true. A client that offers elicitation is asked below whatever revision it
      // negotiated; a `2026-07-28` client that does not gets the MRTR `input_required` it can render
      // and retry itself, which is what this server would answer without the gateway in the way.
      legacySession: () => negotiatedVersion !== MCP_PROTOCOL_VERSION && !clientElicitation,
    };

    const callParams = { ...params, name: route.innerName };
    const initialRes = await handleToolsCall(callParams, ctx);
    if (initialRes["resultType"] !== INPUT_REQUIRED || !clientElicitation) {
      return initialRes;
    }

    // The question, one elicitation per missing grant. An ask that produced no answer at all — no
    // transport to ask on, an RPC error, the 60 s window closing — is left out of `inputResponses`
    // rather than answered on the user's behalf: the specification's rule for an answer a server
    // cannot use is to ask again for that grant, which is exactly what makes the retry below report
    // it as still missing instead of as a refusal nobody uttered.
    const inputRequests = asRecord(initialRes["inputRequests"]) as
      | Record<string, { method: string; params: Record<string, unknown> }>
      | undefined;
    const transport = currentTransport ?? activeTransports.values().next().value;
    const inputResponses: Record<string, unknown> = {};
    for (const [grant, req] of Object.entries(inputRequests ?? {})) {
      if (transport === undefined) {
        warn(`No client transport to ask about ${grant}: the consent question stays unanswered.`);
        continue;
      }
      try {
        inputResponses[grant] = await transport.request(req.method, req.params, {
          timeoutMs: ELICITATION_TIMEOUT_MS,
        });
      } catch (e) {
        warn(`Consent question for ${grant} went unanswered: ${String(e)}`);
      }
    }

    const retryRes = await handleToolsCall(
      { ...callParams, requestState: initialRes["requestState"], inputResponses },
      ctx,
    );
    // Everything the client had to say is in, and a grant is still missing: there is nobody left to
    // ask, so the call ends as the refusal a model reads — worded for what actually happened, since
    // no human refused anything here. A `deny` never reaches this line; `handleToolsCall` returns
    // that refusal itself, from the same builder with the same `_meta`.
    return retryRes["resultType"] === INPUT_REQUIRED
      ? policyRefusal(ctx, Object.keys(asRecord(retryRes["inputRequests"]) ?? {}), "unresolved")
      : retryRes;
  }

  /**
   * `capsule_test_tool` addresses a served tool by capsule and tool name instead of by its gateway
   * name, and is answered by the very same dispatch — which is the whole of its promise: what an
   * author sees while iterating is what a client will see, down to the `_meta`. Nothing here decides
   * anything about the run; a tool the catalog withheld is not testable either, because the route
   * table is the catalog.
   */
  async function handleTestTool(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const args = asRecord(request["arguments"]) ?? {};
    const tool = typeof args["tool"] === "string" ? args["tool"].trim() : "";
    const capsuleId = typeof args["capsuleId"] === "string" ? args["capsuleId"].trim() : undefined;
    const name = typeof args["name"] === "string" ? args["name"].trim() : undefined;
    if (tool === "") {
      throw new RpcFailure(JSON_RPC_ERROR.InvalidParams, "capsule_test_tool requires 'tool'");
    }
    if (capsuleId === undefined && name === undefined) {
      throw new RpcFailure(
        JSON_RPC_ERROR.InvalidParams,
        "capsule_test_tool requires either 'capsuleId' or 'name'",
      );
    }

    const route = [...(await buildGateway()).routes.values()].find(
      (candidate) =>
        candidate.innerName === tool &&
        (capsuleId === undefined
          ? candidate.loaded.manifest.meta.name === name
          : candidate.loaded.capsuleId === capsuleId),
    );
    if (route === undefined) {
      throw new RpcFailure(
        JSON_RPC_ERROR.InvalidParams,
        `no served tool '${sanitizeModelText(tool, 120)}' in installed capsule ` +
          `'${sanitizeModelText(capsuleId ?? name ?? "", 120)}'`,
      );
    }

    return callCapsuleTool(route, { ...request, arguments: args["args"] ?? {} });
  }

  async function handleToolsCallGateway(params: unknown): Promise<Record<string, unknown>> {
    const request = asRecord(params);
    const fullName = request?.["name"];
    if (typeof fullName !== "string" || fullName === "") {
      throw new RpcFailure(JSON_RPC_ERROR.InvalidParams, "tools/call needs a non-empty string name");
    }

    // Not in `managerTools`: its answer is a capsule's answer, not the manager's, so it is not a
    // `ToolExecutionResult` the manager wraps in its own identity.
    if (fullName === "capsule_test_tool") {
      return handleTestTool(request ?? {});
    }

    const managerTool = managerTools.get(fullName);
    if (managerTool !== undefined) {
      const res = await managerTool(request?.["arguments"]);
      return result({
        content: [{ type: "text", text: res.text }],
        structuredContent: res.structured,
        isError: res.isError,
      });
    }

    // Gateway dispatch reads the routing table the merged catalog was built from, so the name the
    // model saw is the name that resolves: no prefix guessing, and a tool the catalog withheld — a
    // suppressed tool, a suppressed capsule, an unverifiable file — is not reachable by name either.
    const route = (await buildGateway()).routes.get(fullName);
    if (route === undefined) {
      throw new RpcFailure(
        JSON_RPC_ERROR.InvalidParams,
        `unknown tool: ${sanitizeModelText(fullName, 120)}`,
      );
    }

    return callCapsuleTool(route, request ?? {});
  }

  const handlers = new Map<string, RpcHandler>([
    [
      "initialize",
      (params) => {
        const p = asRecord(params);
        const requested = p?.["protocolVersion"];
        negotiatedVersion =
          typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : MCP_PROTOCOL_VERSION;
        const capabilities = asRecord(p?.["capabilities"]);
        clientElicitation =
          capabilities?.["elicitation"] !== undefined && capabilities?.["elicitation"] !== null;
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
    ["tools/list", async () => result({ tools: (await buildGateway()).tools, ttlMs: CATALOG_TTL_MS, cacheScope: "public" })],
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

  const handleMessage = createRpcDispatcher(handlers, warn);

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
            currentTransport = transport;
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
