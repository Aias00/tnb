import { describe, expect, test } from "bun:test";

import { createFallbackTransport } from "../../src/providers/fallback";
import { ProviderHttpError } from "../../src/providers/retry";
import type { ModelEvent, ModelTransport } from "../../src/providers/types";

const request = { model: "primary", messages: [], tools: [] };

describe("provider fallback", () => {
  test("switches before output on a transient primary failure and stays on fallback", async () => {
    const requestedModels: string[] = [];
    let activated = 0;
    const primary: ModelTransport = {
      async *stream() {
        throw new ProviderHttpError(529, "overloaded", new Headers());
      },
    };
    const fallback: ModelTransport = {
      async *stream(value) {
        requestedModels.push(value.model);
        yield { type: "response-end", reason: "end-turn" } as ModelEvent;
      },
    };
    const transport = createFallbackTransport({
      primary,
      fallback,
      fallbackModel: "backup",
      onFallback: () => void (activated += 1),
    });

    for await (const _event of transport.stream(request)) {}
    for await (const _event of transport.stream(request)) {}

    expect(activated).toBe(1);
    expect(requestedModels).toEqual(["backup", "backup"]);
  });

  test("does not switch after primary output or for a non-transient error", async () => {
    let fallbackCalls = 0;
    const fallback: ModelTransport = {
      async *stream() {
        fallbackCalls += 1;
        yield { type: "response-end", reason: "end-turn" } as ModelEvent;
      },
    };
    const partial: ModelTransport = {
      async *stream() {
        yield { type: "text", index: 0, text: "partial" } as ModelEvent;
        throw new ProviderHttpError(529, "overloaded", new Headers());
      },
    };
    const invalid: ModelTransport = {
      async *stream() {
        throw new ProviderHttpError(401, "unauthorized", new Headers());
      },
    };

    await expect(consume(createFallbackTransport({ primary: partial, fallback, fallbackModel: "backup" }))).rejects.toThrow("overloaded");
    await expect(consume(createFallbackTransport({ primary: invalid, fallback, fallbackModel: "backup" }))).rejects.toThrow("unauthorized");
    expect(fallbackCalls).toBe(0);
  });
});

async function consume(transport: ModelTransport): Promise<void> {
  for await (const _event of transport.stream(request)) {}
}
