import type { RetryProgress } from "./types";
export const DEFAULT_MAX_RETRIES = 10;
export const BASE_RETRY_DELAY_MS = 500;
export const MAX_RETRY_DELAY_MS = 32_000;

export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Headers,
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

export class ProviderStreamError extends Error {
  constructor(
    message: string,
    readonly category: "invalid_request" | "server_error" | "unknown" = "unknown",
  ) {
    super(message);
    this.name = "ProviderStreamError";
  }
}

export type RetryOptions<T = unknown> = {
  maxRetries?: number;
  signal?: AbortSignal;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  /** Observational metadata; never treated as response output. */
  progress?: (event: RetryProgress) => T;
};

export async function* streamWithRetry<T>(
  operation: (attempt: number) => AsyncGenerator<T>,
  options: RetryOptions<T> = {},
): AsyncGenerator<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const sleep = options.sleep ?? abortableSleep;
  const random = options.random ?? Math.random;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    options.signal?.throwIfAborted();
    let emitted = false;
    try {
      for await (const value of operation(attempt)) {
        emitted = true;
        yield value;
      }
      return;
    } catch (error) {
      if (emitted || attempt > maxRetries || !isRetryableProviderError(error)) throw error;
      const retryAfter =
        error instanceof ProviderHttpError ? error.headers.get("retry-after") : undefined;
      const delayMs = Math.max(0, getRetryDelay(attempt, retryAfter, random));
      const progress: Omit<RetryProgress, "phase"> = { type: "retry", retry: attempt, maxRetries, delayMs,
        ...(error instanceof ProviderHttpError ? { status: error.status } : {}),
        reason: error instanceof ProviderHttpError ? error.status === 429 ? "rate-limit" : error.status >= 500 ? "server" : "transient" : "connection" };
      if (options.progress) yield options.progress({ ...progress, phase: "waiting" });
      await sleep(delayMs, options.signal);
      options.signal?.throwIfAborted();
      if (options.progress) yield options.progress({ ...progress, phase: "requesting" });
    }
  }
}

export function getRetryDelay(
  attempt: number,
  retryAfterHeader?: string | null,
  random: () => number = Math.random,
): number {
  if (retryAfterHeader) {
    const seconds = Number.parseInt(retryAfterHeader, 10);
    if (Number.isFinite(seconds)) return seconds * 1_000;
  }
  const base = Math.min(
    BASE_RETRY_DELAY_MS * 2 ** Math.max(0, attempt - 1),
    MAX_RETRY_DELAY_MS,
  );
  return base + random() * 0.25 * base;
}

export function isRetryableProviderError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return false;
  if (error instanceof ProviderHttpError) {
    const directive = error.headers.get("x-should-retry");
    if (directive === "false") return false;
    if (directive === "true") return true;
    return (
      error.status === 408 ||
      error.status === 409 ||
      error.status === 429 ||
      error.status >= 500
    );
  }
  return error instanceof TypeError;
}

async function abortableSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) return;
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const stop = () => { clearTimeout(timeout); signal?.removeEventListener("abort", stop); reject(signal?.reason); };
    const timeout = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, delayMs);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
  });
}
