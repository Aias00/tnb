import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelExecution } from "../../src/services/execution/model";
import { createWorkspaceFileTools } from "../../src/services/execution/workspace-tools";
import { loadProviderCatalog, resolveProviderSelection } from "../../src/providers/config";
import type { ModelEvent, ModelRequest, ModelTransport } from "../../src/providers/types";
import { UsageBudget } from "../../src/services/usage/budget";

const directories: string[] = [];
async function temporaryDirectory() { const path = await mkdtemp(join(tmpdir(), "tnb-execution-")); directories.push(path); return path; }
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const request: ModelRequest = { model: "gpt-4o", messages: [], tools: [] };
async function selection(withKey = false) {
  const catalog = await loadProviderCatalog({ configDir: await temporaryDirectory(), env: withKey ? { OPENAI_API_KEY: "fixture" } : {} });
  return resolveProviderSelection(catalog, "openai", "gpt-4o");
}
async function collect(transport: ModelTransport, signal?: AbortSignal) {
  const events: ModelEvent[] = [];
  for await (const event of transport.stream(request, signal)) events.push(event);
  return events;
}

test("model host stays lazy and injected transports do not require credentials", async () => {
  const route = await selection();
  const lazy = createModelExecution({ selection: route });
  expect(lazy.model).toBe("gpt-4o");
  await expect(collect(lazy.transport)).rejects.toThrow("OPENAI_API_KEY");
  const injected = createModelExecution({ selection: route, transport: { async *stream() { yield { type: "text", index: 0, text: "injected" }; } } });
  expect(await collect(injected.transport)).toEqual([{ type: "text", index: 0, text: "injected" }]);
});

test("root and child model hosts charge the same caller-owned budget", async () => {
  const route = await selection(); route.model.pricing = { input: 1, output: 1 };
  const budget = new UsageBudget({ maxCostUsd: 1.5 });
  const transport: ModelTransport = { async *stream() { yield { type: "usage", usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }; } };
  const root = createModelExecution({ selection: route, transport, budget });
  const child = createModelExecution({ selection: route, transport, budget });
  try {
    await collect(root.transport);
    expect(budget.totals.costUsd).toBe(1);
    await expect(collect(child.transport)).rejects.toThrow();
    expect(budget.signal.aborted).toBe(true);
  } finally { await budget.close(); }
});

test("fallback retains its route and stays active, with retries disabled on both providers", async () => {
  let primaryCalls = 0, fallbackCalls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    if (new URL(req.url).pathname.startsWith("/primary")) { primaryCalls++; return new Response("retryable failure", { status: 503 }); }
    fallbackCalls++;
    return new Response('data: {"choices":[{"delta":{"content":"fallback"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":1}}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const primary = await selection(true);
    primary.provider.baseUrl = `http://127.0.0.1:${server.port}/primary`;
    const fallback = structuredClone(primary); fallback.provider.id = "fallback"; fallback.provider.baseUrl = `http://127.0.0.1:${server.port}/fallback`;
    const host = createModelExecution({ selection: primary, fallbackSelection: fallback, maxRetries: 0 });
    const first = await collect(host.transport); await collect(host.transport);
    expect(primaryCalls).toBe(1); expect(fallbackCalls).toBe(2);
    expect(first.find(event => event.type === "usage")).toMatchObject({ billing: { provider: "fallback" } });
    const aborted = new AbortController(); aborted.abort();
    await expect(collect(host.transport, aborted.signal)).rejects.toThrow();
    expect(fallbackCalls).toBe(2);
  } finally { await server.stop(true); }
});

test("workspace hosts share receipts only within their own read/write/edit set", async () => {
  const workspace = await temporaryDirectory();
  await writeFile(join(workspace, "source.txt"), "before\n");
  const make = () => createWorkspaceFileTools({ workspace, allowWrite: true, media: { supportsVision: false, supportsPdf: false } });
  const first = make(), second = make();
  const signal = new AbortController().signal;
  await first.read.execute(first.read.validate({ path: "source.txt" }), signal);
  const edit = { path: "source.txt", oldText: "before", newText: "after" };
  await expect(second.edit!.execute(second.edit!.validate(edit), signal)).rejects.toThrow("has not been read");
  await first.edit!.execute(first.edit!.validate(edit), signal);
  expect(await readFile(join(workspace, "source.txt"), "utf8")).toBe("after\n");
  const readOnly = createWorkspaceFileTools({ workspace, allowWrite: false, media: { supportsVision: false, supportsPdf: false } });
  expect(readOnly.write).toBeUndefined(); expect(readOnly.edit).toBeUndefined();
});

test("live workspace roots update without broadening approved file or search roots", async () => {
  const one = await temporaryDirectory(), two = await temporaryDirectory(), external = await temporaryDirectory();
  await writeFile(join(one, "file.txt"), "one"); await writeFile(join(two, "file.txt"), "two");
  await writeFile(join(external, "private.txt"), "private");
  let current = one;
  const tools = createWorkspaceFileTools({ workspace: () => current, allowWrite: false, media: { supportsVision: false, supportsPdf: false } });
  const signal = new AbortController().signal;
  expect(await tools.read.execute(tools.read.validate({ path: "file.txt" }), signal)).toContain("one");
  current = two;
  expect(await tools.read.execute(tools.read.validate({ path: "file.txt" }), signal)).toContain("two");
  await expect(tools.read.execute(tools.read.validate({ path: join(external, "private.txt") }), signal)).rejects.toThrow();
});


test("file access roots do not implicitly become search roots", async () => {
  const workspace = await temporaryDirectory(), external = await temporaryDirectory();
  await writeFile(join(external, "memory.txt"), "approved file content");
  const tools = createWorkspaceFileTools({ workspace, allowWrite: false, media: { supportsVision: false, supportsPdf: false }, fileRoots: () => [external], searchRoots: () => [] });
  const signal = new AbortController().signal;
  expect(await tools.read.execute(tools.read.validate({ path: join(external, "memory.txt") }), signal)).toContain("approved file content");
  await expect(tools.glob.execute(tools.glob.validate({ pattern: "*.txt", path: external }), signal)).rejects.toThrow();
});

test("retry metadata does not prevent fallback after the primary exhausts its transport retries", async () => {
  const { createFallbackTransport } = await import("../../src/providers/fallback");
  const { ProviderHttpError } = await import("../../src/providers/retry");
  const transport = createFallbackTransport({ primary: { async *stream() {
    yield { type: "retry", phase: "waiting", retry: 1, maxRetries: 1, delayMs: 0, status: 503, reason: "server" };
    throw new ProviderHttpError(503, "unavailable", new Headers());
  } }, fallback: { async *stream() { yield { type: "text", index: 0, text: "fallback-after-retry" }; } }, fallbackModel: "other" });
  expect((await collect(transport)).at(-1)).toEqual({ type: "text", index: 0, text: "fallback-after-retry" });
});
