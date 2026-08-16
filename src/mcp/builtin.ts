import { existsSync } from "node:fs";
import { CapsuleError } from "../core/errors.ts";
import type { LoadedCapsule } from "../format/capsule.ts";
import type { EffectName, ManifestCapabilities, ManifestMeta, ManifestTool } from "../format/manifest.ts";
import { openSidecar, sidecarPaths } from "../runtime/invoke.ts";
import { openJournal } from "../runtime/journal.ts";
import { replayRun } from "../runtime/replay.ts";
import { sanitizeModelText, sanitizeValue } from "../security/text.ts";
import type { McpServerContext } from "./call.ts";

/** How much of any one piece of capsule prose an introspecting agent is given. */
const MAX_PROSE_CHARS = 1024;

/** What `capsule_info` answers: the capsule's identity, what it may do, and the tools served. */
type CapsuleInfo = {
  capsuleId: string;
  keyId: string;
  trust: LoadedCapsule["trust"];
  meta: ManifestMeta;
  capabilities: ManifestCapabilities;
  tools: { name: string; title: string; description: string; effects: EffectName[] }[];
};

export const BUILTIN_TOOLS: ManifestTool[] = [
  {
    name: "capsule_info",
    title: "Capsule Information",
    description:
      "Introspect capsule metadata, capabilities, trust state, publisher key, and tool list with effects.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    effects: [],
  },
  {
    name: "capsule_runs",
    title: "Capsule Runs",
    description:
      "Query recent execution runs from the journal sidecar. Returns { runs: [...] }, newest first.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          default: 10,
        },
      },
      additionalProperties: false,
    },
    effects: [],
  },
  {
    name: "capsule_replay",
    title: "Capsule Replay",
    description: "Replay a recorded run to verify deterministic execution.",
    inputSchema: {
      type: "object",
      properties: {
        runId: {
          type: "string",
        },
      },
      required: ["runId"],
      additionalProperties: false,
    },
    effects: [],
  },
];

export async function handleBuiltinCall(
  tool: string,
  args: Record<string, unknown>,
  ctx: McpServerContext,
): Promise<unknown> {
  switch (tool) {
    case "capsule_info": {
      const manifest = ctx.capsule.manifest;
      // The whole payload is cleaned in one pass rather than slot by slot: every string in it is
      // manifest text on its way to a model, and an optional block like `meta.author` is otherwise
      // only as safe as the list of fields somebody remembered to name. Suppressed tools are left
      // out — a tool the catalog refused to serve must not be described back to the caller either,
      // or introspection becomes the way to read the text suppression exists to withhold.
      const info = sanitizeValue({
        capsuleId: ctx.capsule.capsuleId,
        keyId: ctx.capsule.keyId,
        trust: ctx.capsule.trust,
        meta: manifest.meta,
        capabilities: manifest.capabilities,
        tools: manifest.tools
          .filter((tool) => ctx.served.has(tool.name))
          .map((tool) => ({
            name: tool.name,
            title: tool.title,
            description: tool.description,
            effects: tool.effects,
          })),
      }) as CapsuleInfo;
      // Capping happens after cleaning, not as part of it: the truncation marker is our own text,
      // and a second sanitising pass would rewrite the ellipsis it ends with.
      info.meta.title = sanitizeModelText(info.meta.title, MAX_PROSE_CHARS);
      info.meta.description = sanitizeModelText(info.meta.description, MAX_PROSE_CHARS);
      for (const tool of info.tools) {
        tool.title = sanitizeModelText(tool.title, MAX_PROSE_CHARS);
        tool.description = sanitizeModelText(tool.description, MAX_PROSE_CHARS);
      }
      return info;
    }
    case "capsule_runs": {
      const limit = typeof args["limit"] === "number" ? args["limit"] : 10;
      const paths = sidecarPaths(ctx.capsule.file);
      const journalPath = ctx.journalPath ?? paths.journal;
      // Wrapped in an object on purpose: a tool result's `structuredContent` is a JSON *object* in
      // every MCP revision this host speaks, and Claude Desktop validates that — it rejected the
      // whole envelope over a bare array here, so a call that succeeded read as "Tool execution
      // failed" to the model. The empty case wraps too, or the shape would depend on the count.
      if (!existsSync(journalPath)) {
        return { runs: [] };
      }
      const journal = openSidecar("journal", () => openJournal(journalPath));
      try {
        return { runs: journal.recentRuns({ capsuleId: ctx.capsule.capsuleId, limit }) };
      } finally {
        journal.close();
      }
    }
    case "capsule_replay": {
      const runId = args["runId"] as string;
      return await replayRun({
        capsule: ctx.capsule,
        runId,
        journalPath: ctx.journalPath,
        statePath: ctx.statePath,
        homeDir: ctx.homeDir,
      });
    }
    default:
      throw new CapsuleError("E_USAGE", `unknown built-in tool: ${tool}`, { tool });
  }
}
