import { sanitizeModelText } from "../security/text.ts";

export type Meta = {
  progressToken?: string | number;
  traceparent?: string;
  caller?: { name: string; kind?: string };
};

// W3C Trace Context, version 00: `00-<32 hex trace-id>-<16 hex span-id>-<2 hex flags>`.
// Hex is lower case by specification, so no `i` flag here.
const TRACEPARENT_PATTERN = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

const CALLER_NAME_MAX = 128;
const CALLER_KIND_MAX = 64;

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

// Every field is optional and every invalid field is dropped rather than rejected:
// `_meta` is advisory transport metadata, so a bad progress token must not fail a
// request that is otherwise well formed. Callers that need a field enforce it.
export function parseMeta(params: unknown): Meta | undefined {
  const raw = asRecord(asRecord(params)?.["_meta"]);
  if (raw === undefined) {
    return undefined;
  }

  const meta: Meta = {};

  const progressToken = raw["progressToken"];
  if (
    typeof progressToken === "string" ||
    (typeof progressToken === "number" && Number.isFinite(progressToken))
  ) {
    meta.progressToken = progressToken;
  }

  const traceparent = raw["traceparent"];
  if (typeof traceparent === "string" && TRACEPARENT_PATTERN.test(traceparent)) {
    meta.traceparent = traceparent;
  }

  const caller = asRecord(raw["caller"]);
  const callerName = caller?.["name"];
  if (typeof callerName === "string") {
    // The caller identity is attacker-controlled text that ends up in logs and
    // prompts, so it goes through the same sanitiser as any other model-facing
    // string. A name that sanitises away entirely is no name at all.
    const name = sanitizeModelText(callerName, CALLER_NAME_MAX);
    if (name !== "") {
      meta.caller = { name };
      const callerKind = caller?.["kind"];
      if (typeof callerKind === "string") {
        const kind = sanitizeModelText(callerKind, CALLER_KIND_MAX);
        if (kind !== "") {
          meta.caller.kind = kind;
        }
      }
    }
  }

  return meta;
}
