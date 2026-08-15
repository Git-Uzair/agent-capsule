import { StringDecoder } from "node:string_decoder";
import { asRecord } from "../core/canonical.ts";

export type JsonRpcId = string | number;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
};

export type JsonRpcErrorResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: { code: number; message: string; data?: unknown };
};

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse
  | JsonRpcErrorResponse;

// Standard JSON-RPC 2.0 codes. An object literal rather than an enum: this
// project compiles with `erasableSyntaxOnly`.
export const JSON_RPC_ERROR = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

export type Transport = {
  onMessage(handler: (msg: JsonRpcMessage) => void | Promise<void>): void;
  send(msg: JsonRpcMessage): void;
  close(): void;
};

// 16 MiB. Large enough for any legitimate payload, small enough that a peer
// cannot exhaust our heap by never sending a newline.
const DEFAULT_MAX_LINE_LENGTH = 16 * 1024 * 1024;

function asId(v: unknown): JsonRpcId | undefined {
  return typeof v === "string" || typeof v === "number" ? v : undefined;
}

// The id to answer an invalid request with: the peer's own id when it is usable,
// null when it is absent or unusable (JSON-RPC 2.0 §5).
function replyId(v: unknown): JsonRpcId | null {
  const record = asRecord(v);
  return record === undefined ? null : (asId(record["id"]) ?? null);
}

function isJsonRpcMessage(v: unknown): v is JsonRpcMessage {
  const record = asRecord(v);
  if (record === undefined || record["jsonrpc"] !== "2.0") {
    return false;
  }
  const hasId = "id" in record;
  const id = asId(record["id"]);

  if (typeof record["method"] === "string") {
    // Request (id present and usable) or notification (no id at all).
    return !hasId || id !== undefined;
  }

  // Otherwise it must be a response, which always carries an id. Only an error
  // response may use a null id, so a null id without an `error` member is not a
  // message we can route.
  if (!hasId) {
    return false;
  }
  if ("result" in record) {
    return id !== undefined;
  }
  const error = asRecord(record["error"]);
  return (
    error !== undefined &&
    typeof error["code"] === "number" &&
    typeof error["message"] === "string" &&
    (id !== undefined || record["id"] === null)
  );
}

function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return "method" in msg && "id" in msg;
}

export function createStdioTransport(
  opts: { in?: NodeJS.ReadableStream; out?: NodeJS.WritableStream; maxLineLength?: number } = {},
): Transport {
  // Annotated rather than inferred: the inferred union of the stream interface and
  // the concrete `process.stdin`/`process.stdout` types has no callable `on`.
  const input: NodeJS.ReadableStream = opts.in ?? process.stdin;
  const output: NodeJS.WritableStream = opts.out ?? process.stdout;
  const maxLineLength = opts.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
  // Chunk boundaries fall wherever the OS puts them, including inside a
  // multi-byte code point; the decoder holds the partial bytes back.
  const decoder = new StringDecoder("utf8");

  let handler: ((msg: JsonRpcMessage) => void | Promise<void>) | undefined;
  let buffer = "";
  // True while discarding the tail of a line that already exceeded the cap.
  let discarding = false;
  let closed = false;

  function send(msg: JsonRpcMessage): void {
    if (closed) {
      return;
    }
    // JSON.stringify escapes every control character, so the serialised message
    // can never contain the newline that frames it.
    output.write(`${JSON.stringify(msg)}\n`);
  }

  function sendError(id: JsonRpcId | null, code: number, message: string): void {
    send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  function onHandlerError(msg: JsonRpcMessage, err: unknown): void {
    if (isRequest(msg)) {
      sendError(msg.id, JSON_RPC_ERROR.InternalError, "internal error");
      return;
    }
    // Nothing may be sent in reply to a notification or a response, so the only
    // place left for the diagnostic is stderr.
    const what = "method" in msg ? msg.method : "response";
    process.stderr.write(`transport: handler failed for ${what}: ${String(err)}\n`);
  }

  function deliver(msg: JsonRpcMessage): void {
    if (handler === undefined) {
      return;
    }
    try {
      // A rejected handler must not become an unhandled rejection: that would
      // kill the process and take every in-flight request with it.
      void Promise.resolve(handler(msg)).catch((err: unknown) => {
        onHandlerError(msg, err);
      });
    } catch (err) {
      onHandlerError(msg, err);
    }
  }

  function handleLine(line: string): void {
    const text = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (text.trim() === "") {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      sendError(null, JSON_RPC_ERROR.ParseError, "invalid JSON");
      return;
    }
    if (!isJsonRpcMessage(parsed)) {
      sendError(replyId(parsed), JSON_RPC_ERROR.InvalidRequest, "not a JSON-RPC 2.0 message");
      return;
    }
    deliver(parsed);
  }

  function consume(text: string): void {
    buffer += text;
    for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (discarding) {
        discarding = false;
        continue;
      }
      if (line.length > maxLineLength) {
        sendError(null, JSON_RPC_ERROR.ParseError, `line exceeds ${maxLineLength} characters`);
        continue;
      }
      handleLine(line);
    }
    if (discarding) {
      buffer = "";
      return;
    }
    if (buffer.length > maxLineLength) {
      // Report once, then drop everything up to the next newline so the peer can
      // resynchronise instead of having the tail parsed as a fresh message.
      buffer = "";
      discarding = true;
      sendError(null, JSON_RPC_ERROR.ParseError, `line exceeds ${maxLineLength} characters`);
    }
  }

  function onData(chunk: string | Buffer): void {
    if (closed) {
      return;
    }
    consume(typeof chunk === "string" ? chunk : decoder.write(chunk));
  }

  function onEnd(): void {
    if (closed) {
      return;
    }
    // A peer may close without a trailing newline; the last line is still a message.
    consume(`${decoder.end()}\n`);
  }

  input.on("data", onData);
  input.on("end", onEnd);

  return {
    onMessage(next: (msg: JsonRpcMessage) => void | Promise<void>): void {
      handler = next;
    },
    send,
    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      buffer = "";
      input.off("data", onData);
      input.off("end", onEnd);
    },
  };
}
