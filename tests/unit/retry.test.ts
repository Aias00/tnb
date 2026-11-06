import { describe, expect, test } from "bun:test";

import {
  DEFAULT_MAX_RETRIES,
  ProviderHttpError,
  getRetryDelay,
  streamWithRetry,
} from "../../src/providers/retry";

describe("provider retry", () => {
  test("uses the established retry count and exponential delay", () => {
    expect(DEFAULT_MAX_RETRIES).toBe(10);
    expect(getRetryDelay(1, undefined, () => 0)).toBe(500);
    expect(getRetryDelay(2, undefined, () => 0)).toBe(1_000);
    expect(getRetryDelay(3, "7", () => 0)).toBe(7_000);
  });

  test("retries transient failures before any stream event is emitted", async () => {
    let attempts = 0;
    const waits: number[] = [];
    const values: string[] = [];

    for await (const value of streamWithRetry(
      async function* () {
        attempts += 1;
        if (attempts === 1) {
          throw new ProviderHttpError(429, "rate limited", new Headers({ "retry-after": "2" }));
        }
        yield "done";
      },
      {
        sleep: async (delay) => void waits.push(delay),
        random: () => 0,
      },
    )) {
      values.push(value);
    }

    expect(attempts).toBe(2);
    expect(waits).toEqual([2_000]);
    expect(values).toEqual(["done"]);
  });

  test("does not retry after a stream event has been emitted", async () => {
    let attempts = 0;
    const consume = async () => {
      for await (const _value of streamWithRetry(async function* () {
        attempts += 1;
        yield "partial";
        throw new ProviderHttpError(529, "overloaded", new Headers());
      })) {
        // Consume the partial event before the failure.
      }
    };

    await expect(consume()).rejects.toThrow("overloaded");
    expect(attempts).toBe(1);
  });

  test("does not retry non-transient client failures", async () => {
    let attempts = 0;
    const consume = async () => {
      for await (const _value of streamWithRetry(async function* () {
        attempts += 1;
        throw new ProviderHttpError(400, "bad request", new Headers());
      })) {
        // No values expected.
      }
    };

    await expect(consume()).rejects.toThrow("bad request");
    expect(attempts).toBe(1);
  });
});

test("retry progress is sanitized and does not count as streamed response output", async () => {
  let attempts = 0;
  const events: unknown[] = [];
  for await (const event of streamWithRetry<unknown>(async function* () {
    if (++attempts <= 2) throw new ProviderHttpError(429, "SECRET_PROVIDER_BODY", new Headers({ "retry-after": "2" }));
    yield "done";
  }, { maxRetries: 2, sleep: async () => {}, progress: progress => progress, random: () => 0 })) events.push(event);
  expect(events).toHaveLength(5);
  expect(events[0]).toMatchObject({ type: "retry", phase: "waiting", retry: 1, maxRetries: 2, delayMs: 2000, status: 429, reason: "rate-limit" });
  expect(events[3]).toMatchObject({ phase: "requesting", retry: 2 });
  expect(events[4]).toBe("done"); expect(JSON.stringify(events)).not.toContain("SECRET_PROVIDER_BODY");
});

test("cancellation during visible backoff cannot dispatch the next attempt", async () => {
  const controller = new AbortController(); let attempts = 0;
  const iterator = streamWithRetry<unknown>(async function* () { attempts++; throw new TypeError("network"); }, { signal: controller.signal, progress: value => value });
  expect((await iterator.next()).value).toMatchObject({ phase: "waiting" });
  controller.abort(new Error("cancel retry"));
  await expect(iterator.next()).rejects.toThrow("cancel retry");
  expect(attempts).toBe(1);
});
