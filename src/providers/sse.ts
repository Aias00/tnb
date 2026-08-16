import { ProviderHttpError, ProviderStreamError } from "./retry";

export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 90_000;

export type SseParseOptions = {
  idleTimeoutMs?: number;
  signal?: AbortSignal;
};

type StreamReadResult =
  | { done: false; value: Uint8Array }
  | { done: true; value?: Uint8Array };

export async function* parseSseJson(
  response: Response,
  options: SseParseOptions = {},
): AsyncGenerator<unknown> {
  if (!response.ok) {
    const detail = await response.text();
    throw new ProviderHttpError(
      response.status,
      `Provider request failed (${response.status}): ${detail}`,
      response.headers,
    );
  }
  if (!response.body) throw new ProviderStreamError("Provider response has no body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  let buffer = "";
  try {
    while (true) {
      const result = await readWithIdleTimeout(reader, idleTimeoutMs, options.signal);
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      const parsed = extractFrames(buffer);
      buffer = parsed.remainder;
      for (const frame of parsed.frames) {
        const data = frameData(frame);
        if (!data || data === "[DONE]") continue;
        yield parseFrameJson(data);
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      const data = frameData(buffer);
      if (data && data !== "[DONE]") yield parseFrameJson(data);
    }
  } finally {
    reader.releaseLock();
  }
}

function extractFrames(input: string): { frames: string[]; remainder: string } {
  const frames: string[] = [];
  let offset = 0;
  while (offset < input.length) {
    const match = /\r\n\r\n|\n\n|\r\r/.exec(input.slice(offset));
    if (!match || match.index === undefined) break;
    const boundary = offset + match.index;
    frames.push(input.slice(offset, boundary));
    offset = boundary + match[0].length;
  }
  return { frames, remainder: input.slice(offset) };
}

function frameData(frame: string): string {
  return frame
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .filter((line) => line === "data" || line.startsWith("data:"))
    .map((line) => line === "data" ? "" : line.slice(5).trimStart())
    .join("\n");
}

function parseFrameJson(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch (error) {
    throw new ProviderStreamError(
      `Provider returned malformed SSE JSON: ${error instanceof Error ? error.message : String(error)}`,
      "server_error",
    );
  }
}

async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
  signal?: AbortSignal,
): Promise<StreamReadResult> {
  signal?.throwIfAborted();
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) return reader.read();

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new ProviderStreamError(`Provider stream was idle for ${idleTimeoutMs}ms`, "server_error"));
          void reader.cancel("Provider stream idle timeout").catch(() => undefined);
        }, idleTimeoutMs);
        timeout.unref();
      }),
      ...(signal
        ? [new Promise<never>((_, reject) => {
            abort = () => {
              reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
              void reader.cancel(signal.reason).catch(() => undefined);
            };
            signal.addEventListener("abort", abort, { once: true });
          })]
        : []),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}
