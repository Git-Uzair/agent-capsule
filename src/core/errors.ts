export type CapsuleErrorCode =
  | "E_MANIFEST" | "E_CONTAINER" | "E_DIGEST" | "E_SIGNATURE" | "E_TRUST"
  | "E_POLICY" | "E_GUEST" | "E_TIMEOUT" | "E_NONDETERMINISM" | "E_PROTOCOL" | "E_USAGE";

export class CapsuleError extends Error {
  readonly code: CapsuleErrorCode;
  readonly detail: Record<string, unknown>;
  constructor(code: CapsuleErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "CapsuleError";
    this.code = code;
    this.detail = detail;
  }
}
