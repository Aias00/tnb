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

export type RetryOptions = {
  maxRetries?: number;
  signal?: AbortSignal;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
};

export async function* streamWithRetry<T>(
  operation: (attempt: number) => AsyncGenerator<T>,
  options: RetryOptions = {},
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
      await sleep(getRetryDelay(attempt, retryAfter, random), options.signal);
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
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, delayMs);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
