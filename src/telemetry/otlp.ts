import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "../core/digest.ts";
import { CapsuleError } from "../core/errors.ts";
import { EVENT, type Journal, type RecordedEffect } from "../runtime/journal.ts";
import { HOST_VERSION } from "../version.ts";
import { ATTR } from "./semconv.ts";

export type OTelAttributeValue = {
  stringValue?: string;
  intValue?: number;
  boolValue?: boolean;
};

export type OTelAttribute = {
  key: string;
  value: OTelAttributeValue;
};

export type OTelSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OTelAttribute[];
  status: {
    code: number;
    message?: string;
  };
};

export type OTelResourceSpans = {
  resource: {
    attributes: OTelAttribute[];
  };
  scopeSpans: Array<{
    scope: {
      name: string;
      version: string;
    };
    spans: OTelSpan[];
  }>;
};

export type OTelTraceExport = {
  resourceSpans: OTelResourceSpans[];
};

export type SpanDraft = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  attributes: OTelAttribute[];
};

export const SPAN_KIND = {
  INTERNAL: 1,
  CLIENT: 3,
} as const;

export const STATUS_CODE = {
  OK: 1,
  ERROR: 2,
} as const;

const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;
const ALL_ZEROS_32 = "0".repeat(32);
const ALL_ZEROS_16 = "0".repeat(16);

export function startSpan(opts: {
  name: string;
  traceId: string;
  spanId?: string;
  parentSpanId?: string;
  kind?: number;
  startTimeUnixNano?: string;
  attributes?: OTelAttribute[];
}): SpanDraft {
  return {
    name: opts.name,
    traceId: opts.traceId,
    spanId: opts.spanId ?? sha256Hex(`${opts.traceId}:${opts.name}:${Date.now()}`).slice(0, 16),
    ...(opts.parentSpanId !== undefined ? { parentSpanId: opts.parentSpanId } : {}),
    kind: opts.kind ?? SPAN_KIND.INTERNAL,
    startTimeUnixNano: opts.startTimeUnixNano ?? (BigInt(Date.now()) * 1_000_000n).toString(),
    attributes: opts.attributes ?? [],
  };
}

export function endSpan(
  draft: SpanDraft,
  opts?: {
    endTimeUnixNano?: string;
    status?: { code: number; message?: string };
    attributes?: OTelAttribute[];
  },
): OTelSpan {
  const endTimeUnixNano =
    opts?.endTimeUnixNano ??
    (BigInt(draft.startTimeUnixNano) + 1_000_000n > BigInt(Date.now()) * 1_000_000n
      ? (BigInt(draft.startTimeUnixNano) + 1_000_000n).toString()
      : (BigInt(Date.now()) * 1_000_000n).toString());

  return {
    ...draft,
    endTimeUnixNano,
    attributes: opts?.attributes ? [...draft.attributes, ...opts.attributes] : draft.attributes,
    status: opts?.status ?? { code: STATUS_CODE.OK },
  };
}

export function exportTrace(opts: {
  journal: Journal;
  runId: string;
  traceparent?: string;
  capsuleName?: string;
  capsuleVersion?: string;
}): OTelTraceExport {
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
    if (match && match[1] && match[2] && match[1] !== ALL_ZEROS_32 && match[2] !== ALL_ZEROS_16) {
      traceId = match[1];
      rootParentSpanId = match[2];
    }
  }

  const isError = Boolean(toolCompletedPayload?.error || runFinishedPayload?.status === "error");
  const errorMessage =
    toolCompletedPayload?.error?.message ??
    (runFinishedPayload?.status === "error" ? runFinishedPayload.code : undefined);

  const rootSpanId = sha256Hex(`${opts.runId}:root`).slice(0, 16);

  const rootAttributes: OTelAttribute[] = [
    { key: ATTR.GEN_AI_OPERATION_NAME, value: { stringValue: "execute_tool" } },
    { key: ATTR.GEN_AI_TOOL_NAME, value: { stringValue: toolName } },
    { key: ATTR.CAPSULE_RUN_ID, value: { stringValue: opts.runId } },
  ];

  if (runStartedPayload?.mode) {
    rootAttributes.push({ key: ATTR.CAPSULE_MODE, value: { stringValue: runStartedPayload.mode } });
  }
  if (runStartedPayload?.capsuleId) {
    rootAttributes.push({ key: ATTR.CAPSULE_ID, value: { stringValue: runStartedPayload.capsuleId } });
  }
  if (toolCompletedPayload?.error) {
    rootAttributes.push({ key: ATTR.ERROR_TYPE, value: { stringValue: toolCompletedPayload.error.code } });
    rootAttributes.push({ key: ATTR.ERROR_MESSAGE, value: { stringValue: toolCompletedPayload.error.message } });
  }
  if (toolCompletedPayload?.valueDigest) {
    rootAttributes.push({ key: ATTR.CAPSULE_OUTPUT_DIGEST, value: { stringValue: toolCompletedPayload.valueDigest } });
  }

  const runRecord = opts.journal.run(opts.runId);
  const startTimeMs = runRecord ? new Date(runRecord.started_at).getTime() : Date.now();
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

    const childAttributes: OTelAttribute[] = [
      { key: ATTR.CAPSULE_EFFECT_OP, value: { stringValue: payload.op } },
      { key: ATTR.CAPSULE_EFFECT_PARAMS_DIGEST, value: { stringValue: payload.paramsDigest } },
      { key: ATTR.CAPSULE_EFFECT_ORDINAL, value: { intValue: ordinal } },
    ];
    if (payload.valueDigest) {
      childAttributes.push({ key: ATTR.CAPSULE_EFFECT_VALUE_DIGEST, value: { stringValue: payload.valueDigest } });
    }
    if (payload.ms !== undefined) {
      childAttributes.push({ key: ATTR.CAPSULE_EFFECT_DURATION_MS, value: { intValue: payload.ms } });
    }

    const childKind = payload.op === "net.fetch" ? SPAN_KIND.CLIENT : SPAN_KIND.INTERNAL;

    childSpans.push({
      traceId,
      spanId: childSpanId,
      parentSpanId: rootSpanId,
      name: `capsule.effect ${payload.op}`,
      kind: childKind,
      startTimeUnixNano: spanStartNano.toString(),
      endTimeUnixNano: spanEndNano.toString(),
      attributes: childAttributes,
      status: { code: STATUS_CODE.OK },
    });
  }

  const rootSpan: OTelSpan = {
    traceId,
    spanId: rootSpanId,
    ...(rootParentSpanId !== undefined ? { parentSpanId: rootParentSpanId } : {}),
    name: `execute_tool ${toolName}`,
    kind: SPAN_KIND.INTERNAL,
    startTimeUnixNano: baseNano.toString(),
    endTimeUnixNano: (currentNano > baseNano ? currentNano : baseNano + 1_000_000n).toString(),
    attributes: rootAttributes,
    status: isError
      ? { code: STATUS_CODE.ERROR, ...(errorMessage ? { message: errorMessage } : {}) }
      : { code: STATUS_CODE.OK },
  };

  const resourceAttributes: OTelAttribute[] = [
    { key: ATTR.SERVICE_NAME, value: { stringValue: opts.capsuleName ?? "agent-capsule" } },
    { key: ATTR.SERVICE_VERSION, value: { stringValue: opts.capsuleVersion ?? HOST_VERSION } },
  ];

  return {
    resourceSpans: [
      {
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
      },
    ],
  };
}

export function writeTrace(opts: {
  journal: Journal;
  runId: string;
  traceDir?: string;
  traceparent?: string;
  capsuleName?: string;
  capsuleVersion?: string;
}): string | undefined {
  const dir = opts.traceDir ?? process.env.CAPSULE_TRACE_DIR;
  if (!dir) return undefined;
  mkdirSync(dir, { recursive: true });
  const trace = exportTrace({
    journal: opts.journal,
    runId: opts.runId,
    traceparent: opts.traceparent,
    capsuleName: opts.capsuleName,
    capsuleVersion: opts.capsuleVersion,
  });
  const outPath = join(dir, `${opts.runId}.otlp.json`);
  writeFileSync(outPath, `${JSON.stringify(trace, null, 2)}\n`);
  return outPath;
}
