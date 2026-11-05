import { expect, test } from "bun:test";
import { UsageBudget, type UsageRecord } from "../../src/services/usage/budget";
import type { ModelEvent, ModelRequest, ModelTransport } from "../../src/providers/types";
import { createFallbackTransport } from "../../src/providers/fallback";
import { ProviderHttpError } from "../../src/providers/retry";
import { createTransportSummarizer } from "../../src/services/compact/compact";

const request: ModelRequest = { model: "primary", messages: [], tools: [] };
const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
const route = { provider: "fixture", model: "primary", pricing: { input: 1, output: 1 } };
async function drain(transport: ModelTransport) { for await (const _ of transport.stream(request)) {} }
const response = (...events: ModelEvent[]): ModelTransport => ({ async *stream() { yield* events; } });

test("root, child and maintenance routes share FIFO request slots, released on return and failure", async () => {
  const budget = new UsageBudget({ maxConcurrentRequests: 1 });
  const entered: string[] = [];
  const transport = (name: string, fail = false) => budget.wrap({ async *stream() {
    entered.push(name);
    yield { type: "text", index: 0, text: name };
    if (fail) throw new Error("fixture stream failure");
  } }, () => route);
  const root = transport("root").stream(request);
  await root.next();
  const child = transport("child", true).stream(request);
  const childNext = child.next();
  const summary = transport("summary").stream(request);
  const summaryNext = summary.next();
  expect(entered).toEqual(["root"]);
  await root.return(undefined);
  await childNext;
  expect(entered).toEqual(["root", "child"]);
  await expect(child.next()).rejects.toThrow("fixture stream failure");
  await summaryNext;
  expect(entered).toEqual(["root", "child", "summary"]);
  await summary.return(undefined);
  await drain(transport("next turn"));
  await budget.close();
});

test("queued requests cancel before dispatch and close drains pending requests", async () => {
  const budget = new UsageBudget({ maxConcurrentRequests: 1 });
  let dispatched = 0;
  const transport = budget.wrap({ async *stream(_, signal) {
    dispatched++;
    await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
  } }, () => route);
  const active = drain(transport).catch((e: Error) => e.message);
  const abort = new AbortController();
  const queued = (async () => { for await (const _ of transport.stream(request, abort.signal)) {} })().catch((e: Error) => e.message);
  abort.abort(new Error("cancel queued"));
  expect(await queued).toBe("cancel queued");
  const remaining = drain(transport).catch((e: Error) => e.message);
  await budget.close();
  expect(await active).toBe("Invocation ended");
  expect(await remaining).toBe("Invocation ended");
  expect(dispatched).toBe(1);
});

test("request admission bounds the waiting queue and rejects invalid concurrency", async () => {
  expect(() => new UsageBudget({ maxConcurrentRequests: 0 })).toThrow("positive integer");
  const budget = new UsageBudget({ maxConcurrentRequests: 1 });
  const transport = budget.wrap({ async *stream(_, signal) {
    await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
  } }, () => route);
  const pending = Array.from({ length: 65 }, () => drain(transport).catch(() => undefined));
  await expect(drain(transport)).rejects.toThrow("queue is full");
  await budget.close();
  await Promise.all(pending);
});

test("shared ledger stops new child and summary requests and persists the crossing usage", async () => {
  const records: UsageRecord[] = [];
  const budget = new UsageBudget({ maxCostUsd: 2, onUsage: async (record) => { records.push(record); } });
  let calls = 0;
  const raw: ModelTransport = { async *stream() { calls++; yield { type: "usage", usage }; } };
  const main = budget.wrap(raw, () => route);
  const child = budget.wrap(raw, () => route);
  await drain(main);
  await expect(drain(child)).rejects.toThrow("Maximum budget");
  await expect(drain(main)).rejects.toThrow("Maximum budget");
  expect(calls).toBe(2);
  expect(records).toHaveLength(2);
  expect(budget.totals.costUsd).toBe(2);
  await budget.close();
});

test("in-flight usage is retained after another concurrent request exhausts the budget", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const budget = new UsageBudget({ maxCostUsd: 1 });
  let secondSignal: AbortSignal | undefined;
  const background = budget.wrap({ async *stream(_, signal) {
    secondSignal = signal;
    await gate;
    yield { type: "usage", usage };
  } }, () => route);
  const running = drain(background);
  await expect(drain(budget.wrap(response({ type: "usage", usage }), () => route))).rejects.toThrow("Maximum budget");
  expect(secondSignal?.aborted).toBe(true);
  release();
  await expect(running).rejects.toThrow("Maximum budget");
  expect(budget.totals.costUsd).toBe(2); // Honest accounting of already-issued requests.
  await budget.close();
});

test("fallback charges the physical response route, independently of the original request model", async () => {
  const fallback = createFallbackTransport({
    primary: { async *stream() { throw new ProviderHttpError(503, "offline", new Headers()); } },
    fallback: response({ type: "usage", usage, billing: { provider: "backup", model: "cheap", pricing: { input: 0.25, output: 1 } } }),
    fallbackModel: "cheap",
  });
  const records: UsageRecord[] = [];
  const budget = new UsageBudget({ onUsage: async (record) => { records.push(record); } });
  await drain(budget.wrap(fallback, () => route));
  expect(budget.totals.costUsd).toBe(0.25);
  expect(records[0]).toMatchObject({ provider: "backup", model: "cheap", costUsd: 0.25 });
  await budget.close();
});

test("unknown child pricing is refused before sending; failed streams retain reported spend", async () => {
  const budget = new UsageBudget({ maxCostUsd: 10 });
  let sent = false;
  await expect(drain(budget.wrap({ async *stream() { sent = true; } }, () => ({ provider: "fixture", model: "unknown" })))).rejects.toThrow("requires pricing");
  expect(sent).toBe(false);
  await expect(drain(budget.wrap({ async *stream() { yield { type: "usage", usage }; throw new Error("stream failed"); } }, () => route))).rejects.toThrow("stream failed");
  expect(budget.totals.costUsd).toBe(1);
  await budget.close();
});

test("close cancels and joins active streams before releasing invocation ownership", async () => {
  const budget = new UsageBudget();
  let ended = false;
  const pending = drain(budget.wrap({ async *stream(_, signal) {
    await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
    ended = true;
  } }, () => route));
  const outcome = pending.catch((error: Error) => error.message);
  await budget.close();
  expect(ended).toBe(true);
  expect(await outcome).toBe("Invocation ended");
});

test("a compaction summary consumes the same budget and blocks the next main request", async () => {
  const budget = new UsageBudget({ maxCostUsd: 1 });
  const transport = budget.wrap(response({ type: "usage", usage }, { type: "text", index: 0, text: "summary" }, { type: "response-end", reason: "end-turn" }), () => route);
  await expect(createTransportSummarizer({ transport, model: "primary" })([])).rejects.toThrow("Maximum budget");
  await expect(drain(transport)).rejects.toThrow("Maximum budget");
  expect(budget.totals.costUsd).toBe(1);
  await budget.close();
});

test("managed background activations retain the originating budget after the main turn finishes", async () => {
  const budget = new UsageBudget({ maxCostUsd: 2 });
  const release = budget.retain();
  const transport = budget.wrap(response({ type: "usage", usage }), () => route);
  await budget.finish();
  expect(budget.signal.aborted).toBe(false);
  await drain(transport);
  expect(budget.totals.costUsd).toBe(1);
  release();
  // Finish's deferred cleanup resolves after the activation lease.
  await Promise.resolve(); await Promise.resolve();
  expect(budget.signal.aborted).toBe(true);
});
