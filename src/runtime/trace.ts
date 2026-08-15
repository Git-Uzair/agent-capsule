import { sha256Hex } from "../core/digest.ts";
import { CapsuleError } from "../core/errors.ts";
import { EVENT, type Journal, type RecordedEffect } from "./journal.ts";
import { HOST_VERSION } from "../version.ts";

export type OTelSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Array<{
    key: string;
    value: {
      stringValue?: string;
      intValue?: number;
      boolValue?: boolean;
    };
  }>;
  status: {
    code: number;
    message?: string;
  };
};

export type OTelResourceSpans = {
  resource: {
    attributes: Array<{
      key: string;
      value: { stringValue: string };
    }>;
  };
  scopeSpans: Array<{
    scope: {
      name: string;
      version: string;
    };
    spans: OTelSpan[];
  }>;
};

const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

export function exportTrace(opts: {
  journal: Journal;
  runId: string;
  traceparent?: string;
  capsuleName?: string;
  capsuleVersion?: string;
}): OTelResourceSpans {
  opts.journal.verifyChain(opts.runId);

  const events = opts.journal.events(opts.runId);
  const runStarted = events.find((e) => e.type === EVENT.runStarted);
  if (!runStarted) {
    throw new CapsuleError("E_USAGE", `no run.started event found for run: ${opts.runId}`);
  }

  const runStartedPayload = runStarted.payload as
    | { capsuleId?: string; tool?: string; mode?: string; argsDigest?: string }
    | undefined;
  const toolName = runStartedPayload?.tool ?? "unknown";

  const toolCompleted = events.find((e) => e.type === EVENT.toolCompleted);
  const toolCompletedPayload = toolCompleted?.payload as
    | { tool?: string; error?: { code: string; message: string }; valueDigest?: string }
    | undefined;

  const runFinished = events.find((e) => e.type === EVENT.runFinished);
  const runFinishedPayload = runFinished?.payload as
    | { status?: string; code?: string }
    | undefined;

  let traceId = sha256Hex(opts.runId).slice(0, 32);
  let rootParentSpanId: string | undefined;

  if (opts.traceparent) {
    const match = TRACEPARENT_PATTERN.exec(opts.traceparent);
    if (match && match[1] && match[2]) {
      traceId = match[1].toLowerCase();
      rootParentSpanId = match[2].toLowerCase();
    }
  }

  const isError = Boolean(toolCompletedPayload?.error || runFinishedPayload?.status === "error");
  const errorMessage =
    toolCompletedPayload?.error?.message ??
    (runFinishedPayload?.status === "error" ? runFinishedPayload.code : undefined);

  const rootSpanId = sha256Hex(`${opts.runId}:root`).slice(0, 16);

  const rootAttributes: Array<{
    key: string;
    value: { stringValue?: string; intValue?: number; boolValue?: boolean };
  }> = [
    { key: "gen_ai.operation.name", value: { stringValue: "execute_tool" } },
    { key: "gen_ai.tool.name", value: { stringValue: toolName } },
    { key: "capsule.run_id", value: { stringValue: opts.runId } },
  ];

  if (runStartedPayload?.mode) {
    rootAttributes.push({ key: "capsule.mode", value: { stringValue: runStartedPayload.mode } });
  }
  if (runStartedPayload?.capsuleId) {
    rootAttributes.push({ key: "capsule.id", value: { stringValue: runStartedPayload.capsuleId } });
  }
  if (toolCompletedPayload?.error) {
    rootAttributes.push({ key: "error.type", value: { stringValue: toolCompletedPayload.error.code } });
    rootAttributes.push({ key: "error.message", value: { stringValue: toolCompletedPayload.error.message } });
  }
  if (toolCompletedPayload?.valueDigest) {
    rootAttributes.push({ key: "capsule.output.digest", value: { stringValue: toolCompletedPayload.valueDigest } });
  }

  const runSummary = opts.journal.recentRuns({ limit: 1000 }).find((r) => r.runId === opts.runId);
  const startTimeMs = runSummary ? new Date(runSummary.startedAt).getTime() : Date.now();
  const baseNano = BigInt(Number.isFinite(startTimeMs) && startTimeMs > 0 ? startTimeMs : Date.now()) * 1_000_000n;

  let currentNano = baseNano;
  const childSpans: OTelSpan[] = [];

  const effectEvents = events.filter((e) => e.type === EVENT.effectCompleted);
  for (let idx = 0; idx < effectEvents.length; idx++) {
    const effectEvent = effectEvents[idx];
    if (!effectEvent) continue;
    const payload = effectEvent.payload as RecordedEffect;
    const ordinal = payload.i ?? idx;
    const childSpanId = sha256Hex(`${opts.runId}:effect:${ordinal}`).slice(0, 16);
    const durationMs = typeof payload.ms === "number" && payload.ms >= 0 ? payload.ms : 1;
    const durationNano = BigInt(Math.max(1, durationMs)) * 1_000_000n;
    const spanStartNano = currentNano;
    const spanEndNano = currentNano + durationNano;
    currentNano = spanEndNano;

    const childAttributes: Array<{
      key: string;
      value: { stringValue?: string; intValue?: number; boolValue?: boolean };
    }> = [
      { key: "capsule.effect.op", value: { stringValue: payload.op } },
      { key: "capsule.effect.params_digest", value: { stringValue: payload.paramsDigest } },
      { key: "capsule.effect.ordinal", value: { intValue: ordinal } },
    ];
    if (payload.valueDigest) {
      childAttributes.push({ key: "capsule.effect.value_digest", value: { stringValue: payload.valueDigest } });
    }
    if (payload.ms !== undefined) {
      childAttributes.push({ key: "capsule.effect.duration_ms", value: { intValue: payload.ms } });
    }

    childSpans.push({
      traceId,
      spanId: childSpanId,
      parentSpanId: rootSpanId,
      name: `capsule.effect ${payload.op}`,
      kind: 1,
      startTimeUnixNano: spanStartNano.toString(),
      endTimeUnixNano: spanEndNano.toString(),
      attributes: childAttributes,
      status: { code: 1 },
    });
  }

  const rootSpan: OTelSpan = {
    traceId,
    spanId: rootSpanId,
    ...(rootParentSpanId !== undefined ? { parentSpanId: rootParentSpanId } : {}),
    name: `execute_tool ${toolName}`,
    kind: 1,
    startTimeUnixNano: baseNano.toString(),
    endTimeUnixNano: (currentNano > baseNano ? currentNano : baseNano + 1_000_000n).toString(),
    attributes: rootAttributes,
    status: isError
      ? { code: 2, ...(errorMessage ? { message: errorMessage } : {}) }
      : { code: 1 },
  };

  const resourceAttributes: Array<{ key: string; value: { stringValue: string } }> = [
    { key: "service.name", value: { stringValue: opts.capsuleName ?? "agent-capsule" } },
    { key: "service.version", value: { stringValue: opts.capsuleVersion ?? HOST_VERSION } },
  ];

  return {
    resource: {
      attributes: resourceAttributes,
    },
    scopeSpans: [
      {
        scope: {
          name: "agent-capsule",
          version: opts.capsuleVersion ?? HOST_VERSION,
        },
        spans: [rootSpan, ...childSpans],
      },
    ],
  };
}
