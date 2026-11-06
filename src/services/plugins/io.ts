/** Host-owned budgets, independent of plugin manifest claims. */
export type PluginToolLimits = {
  timeoutMs: number;
  maxInputBytes: number;
  maxOutputBytes: number;
  maxStderrBytes: number;
  maxFrameBytes: number;
  maxStdioBytes: number;
  maxConcurrentCalls: number;
  maxStdioProcesses: number;
  killGraceMs: number;
  maxProcessEnvironments: number;
};

export const DEFAULT_PLUGIN_TOOL_LIMITS: Readonly<PluginToolLimits> = Object.freeze({
  timeoutMs: 120_000, maxInputBytes: 1024 * 1024, maxOutputBytes: 1024 * 1024,
  maxStderrBytes: 256 * 1024, maxFrameBytes: 1024 * 1024, maxStdioBytes: 8 * 1024 * 1024,
  maxConcurrentCalls: 32, maxStdioProcesses: 16, killGraceMs: 250, maxProcessEnvironments: 128,
});

export function pluginToolLimits(overrides: Partial<PluginToolLimits> = {}): Readonly<PluginToolLimits> {
  const limits = { ...DEFAULT_PLUGIN_TOOL_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Object.hasOwn(DEFAULT_PLUGIN_TOOL_LIMITS, name) || !Number.isSafeInteger(value) || value < 1 || value > DEFAULT_PLUGIN_TOOL_LIMITS[name as keyof PluginToolLimits]) {
      throw new Error(`Invalid plugin tool limit ${name}; host overrides must be positive integers at or below the default ceiling`);
    }
  }
  return Object.freeze(limits);
}

/** Count bytes before decoding or allocating a complete result. Abort also cancels a stalled read. */
export async function consumePluginBytes(stream: ReadableStream<Uint8Array>, maxBytes: number, label: string,
  signal: AbortSignal, onChunk: (chunk: Uint8Array) => void): Promise<void> {
  const reader = stream.getReader();
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  let size = 0;
  try {
    signal.throwIfAborted();
    for (;;) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) return;
      size += value.byteLength;
      if (size > maxBytes) throw new Error(`Plugin tool ${label} exceeds ${maxBytes} byte limit`);
      onChunk(value);
    }
  } catch (error) {
    // Cancel the upstream producer as well as releasing our lock.
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
}

export async function readPluginText(stream: ReadableStream<Uint8Array>, maxBytes: number, label: string, signal: AbortSignal): Promise<string> {
  const chunks: Uint8Array[] = [];
  await consumePluginBytes(stream, maxBytes, label, signal, chunk => { chunks.push(chunk.slice()); });
  return Buffer.concat(chunks).toString("utf8");
}

/** Both a per-frame and a per-runtime ceiling apply, including unsolicited notifications. */
export async function consumePluginLines(stream: ReadableStream<Uint8Array>, limits: Readonly<PluginToolLimits>,
  signal: AbortSignal, onLine: (line: string) => void): Promise<void> {
  let pieces: Uint8Array[] = [], size = 0;
  const append = (part: Uint8Array) => {
    size += part.byteLength;
    if (size > limits.maxFrameBytes) throw new Error(`Plugin tool stdio frame exceeds ${limits.maxFrameBytes} byte limit`);
    if (part.length) pieces.push(part.slice());
  };
  const emit = () => {
    if (size) onLine(Buffer.concat(pieces, size).toString("utf8").replace(/\r$/, ""));
    pieces = []; size = 0;
  };
  await consumePluginBytes(stream, limits.maxStdioBytes, "stdio output", signal, chunk => {
    let start = 0;
    for (let index = 0; index < chunk.length; index++) if (chunk[index] === 10) {
      append(chunk.subarray(start, index)); emit(); start = index + 1;
    }
    append(chunk.subarray(start));
  });
  emit();
}
