import type { TnbJsonRpcMessage } from "./types";

const HEADER_SEPARATOR = Buffer.from("\r\n\r\n", "utf8");

export function encodeTnbLspMessage(message: TnbJsonRpcMessage): Uint8Array {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "utf8");
  return Uint8Array.from(Buffer.concat([header, body]));
}

export class TnbLspMessageDecoder {
  #buffer = Buffer.alloc(0);

  push(chunk: Uint8Array | string): TnbJsonRpcMessage[] {
    const part = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    this.#buffer = this.#buffer.length === 0 ? part : Buffer.concat([this.#buffer, part]);
    const messages: TnbJsonRpcMessage[] = [];

    while (true) {
      const headerEnd = this.#buffer.indexOf(HEADER_SEPARATOR);
      if (headerEnd < 0) break;
      const headerText = this.#buffer.subarray(0, headerEnd).toString("utf8");
      const contentLength = parseContentLength(headerText);
      const frameStart = headerEnd + HEADER_SEPARATOR.length;
      const frameEnd = frameStart + contentLength;
      if (this.#buffer.length < frameEnd) break;
      const body = this.#buffer.subarray(frameStart, frameEnd).toString("utf8");
      this.#buffer = this.#buffer.subarray(frameEnd);
      messages.push(parseTnbJsonRpcMessage(body));
    }

    return messages;
  }
}

function parseContentLength(headerText: string): number {
  const lines = headerText.split("\r\n");
  const header = lines.find((line) => line.toLowerCase().startsWith("content-length:"));
  if (!header) throw new Error("LSP message missing Content-Length header");
  const value = Number.parseInt(header.slice("content-length:".length).trim(), 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid LSP Content-Length header: ${header}`);
  }
  return value;
}

function parseTnbJsonRpcMessage(body: string): TnbJsonRpcMessage {
  const value: unknown = JSON.parse(body);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("LSP message body is not a JSON-RPC object");
  }
  const message = value as Record<string, unknown>;
  if (message.jsonrpc !== "2.0") throw new Error("LSP message body is not JSON-RPC 2.0");
  return value as TnbJsonRpcMessage;
}
