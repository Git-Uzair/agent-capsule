import { CapsuleError } from "../core/errors.ts";
import type { ManifestTool } from "../format/manifest.ts";
import { openSidecar, sidecarPaths } from "../runtime/invoke.ts";
import { openJournal } from "../runtime/journal.ts";
import { replayRun } from "../runtime/replay.ts";
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
      return {
        capsuleId: ctx.capsule.capsuleId,
        keyId: ctx.capsule.keyId,
        trust: ctx.capsule.trust,
        meta: ctx.capsule.manifest.meta,
        capabilities: ctx.capsule.manifest.capabilities,
        tools: ctx.capsule.manifest.tools.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          effects: [...t.effects],
        })),
      };
    }
    case "capsule_runs": {
      const limit = typeof args["limit"] === "number" ? args["limit"] : 10;
      const paths = sidecarPaths(ctx.capsule.file);
      const journal = openSidecar("journal", () => openJournal(ctx.journalPath ?? paths.journal));
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
