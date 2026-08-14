import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.ts";

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function digestOf(value: unknown): string {
  return `sha256:${sha256Hex(canonicalize(value))}`;
}

export function digestBytes(data: Uint8Array): string {
  return `sha256:${sha256Hex(data)}`;
}
