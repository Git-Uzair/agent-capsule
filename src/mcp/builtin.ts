import { existsSync } from "node:fs";
import { CapsuleError } from "../core/errors.ts";
import type { ManifestTool } from "../format/manifest.ts";
import { openSidecar, sidecarPaths } from "../runtime/invoke.ts";
import { openJournal } from "../runtime/journal.ts";
import { replayRun } from "../runtime/replay.ts";
import { sanitizeModelText } from "../security/text.ts";
import type { McpServerContext } from "./call.ts";

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
    description: "Query recent execution runs from the journal sidecar, newest first.",
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
      const meta = ctx.capsule.manifest.meta;
      return {
        capsuleId: ctx.capsule.capsuleId,
        keyId: ctx.capsule.keyId,
        trust: ctx.capsule.trust,
        meta: {
          ...meta,
          title: sanitizeModelText(meta.title, 1024),
          description: sanitizeModelText(meta.description, 1024),
        },
        capabilities: ctx.capsule.manifest.capabilities,
        tools: ctx.capsule.manifest.tools.map((t) => ({
          name: t.name,
          title: sanitizeModelText(t.title, 1024),
          description: sanitizeModelText(t.description, 1024),
          effects: [...t.effects],
        })),
      };
    }
    case "capsule_runs": {
      const limit = typeof args["limit"] === "number" ? args["limit"] : 10;
      const paths = sidecarPaths(ctx.capsule.file);
      const journalPath = ctx.journalPath ?? paths.journal;
      if (!existsSync(journalPath)) {
        return [];
      }
      const journal = openSidecar("journal", () => openJournal(journalPath));
      try {
        return journal.recentRuns({ capsuleId: ctx.capsule.capsuleId, limit });
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
