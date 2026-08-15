// Semantic conventions from open-telemetry/semantic-conventions-genai (Development status, checked: 2026-08-15)
export const ATTR = {
  GEN_AI_OPERATION_NAME: "gen_ai.operation.name",
  GEN_AI_TOOL_NAME: "gen_ai.tool.name",
  GEN_AI_CLIENT_OPERATION_DURATION: "gen_ai.client.operation.duration",
  MCP_METHOD_NAME: "mcp.method.name",
  MCP_TOOL_NAME: "mcp.tool.name",
  ERROR_TYPE: "error.type",
  ERROR_MESSAGE: "error.message",
  SERVICE_NAME: "service.name",
  SERVICE_VERSION: "service.version",
  CAPSULE_ID: "capsule.id",
  CAPSULE_RUN_ID: "capsule.run_id",
  CAPSULE_MODE: "capsule.mode",
  CAPSULE_OUTPUT_DIGEST: "capsule.output.digest",
  CAPSULE_EFFECT_OP: "capsule.effect.op",
  CAPSULE_EFFECT_PARAMS_DIGEST: "capsule.effect.params_digest",
  CAPSULE_EFFECT_ORDINAL: "capsule.effect.ordinal",
  CAPSULE_EFFECT_VALUE_DIGEST: "capsule.effect.value_digest",
  CAPSULE_EFFECT_DURATION_MS: "capsule.effect.duration_ms",
} as const;

export type AttrKey = (typeof ATTR)[keyof typeof ATTR];
