import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RuntimeStore } from "../../src/services/runtime/store";
import { createChatService } from "../../src/services/workbench/chat";
import { createWebWorkbench } from "../../src/plugins/web/server";
import type { ChatSummary } from "../../src/agent/chat-service";
import { SessionStore } from "../../src/services/session/storage";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const sse = (delta: unknown, finish = "stop") => new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
async function until(check: () => boolean, label = "conversation") { const end = Date.now() + 10000; while (!check()) { if (Date.now() > end) throw new Error(label + " timed out"); await Bun.sleep(10); } }
async function fixture(query?: Parameters<typeof createChatService>[0]["query"]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tnb-web-chat-"))); cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const workspace = join(root, "work"), other = join(root, "other"), configDir = join(root, "config"); await mkdir(workspace); await mkdir(other); await mkdir(configDir);
  const requests: any[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const input = await request.json() as any; requests.push(input); const latest = [...input.messages].reverse().find((message: any) => message.role === "user")?.content ?? "";
    const last = input.messages.at(-1);
    if (String(latest).includes("WRITE") && last.role !== "tool") return sse({ tool_calls: [{ index: 0, id: "write-proof", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "proof.txt", content: "approved once" }) } }] }, "tool_calls");
    if (String(latest).includes("WAIT")) return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(": waiting\n\n")); } }), { headers: { "content-type": "text/event-stream" } });
    if (String(latest).includes("LARGE")) return sse({ content: "\n".repeat(100000) });
    return sse({ content: last.role === "tool" ? "tool handled" : "记住了 CONTEXT_MARKER <script>globalThis.pwned=true</script>" });
  } }); cleanup.push(() => server.stop(true));
  await writeFile(join(configDir, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: server.url.href + "v1", apiKey: "never-send-this-key-to-browser", models: [{ id: "fixture", contextWindow: 32000, maxTokens: 256 }] } } }));
  const store = new RuntimeStore(join(configDir, "runtime/state.sqlite")); cleanup.push(async () => { store.close(); if (process.platform === "win32") Bun.gc(true); });
  const manager = createChatService({ store, configDir, env: {}, ...(query ? { query } : {}) }); cleanup.push(manager.close);
  const chats = await manager.service.open(workspace), outside = await manager.service.open(other);
  const create = (commandId: string = crypto.randomUUID()) => chats.command({ action: "create", commandId, provider: "fixture", model: "fixture" }) as Promise<ChatSummary>;
  const send = (chatId: string, text: string, commandId: string = crypto.randomUUID()) => chats.command({ action: "send", chatId, text, commandId }) as Promise<ChatSummary>;
  return { root, workspace, configDir, store, manager, chats, outside, requests, create, send };
}

test("web conversations use the terminal executor, preserve multi-turn context and deduplicate sends", async () => {
  const f = await fixture(), chat = await f.create("same-create"); expect((await f.create("same-create")).id).toBe(chat.id);
  const first = await f.send(chat.id, "remember CONTEXT_MARKER", "first-send");
  await until(() => f.chats.detail(chat.id).chat.status === "idle");
  expect(f.chats.detail(chat.id).messages.map(message => message.role)).toEqual(["user", "assistant"]);
  expect(f.chats.detail(chat.id).messages[1]?.text).toContain("CONTEXT_MARKER");
  expect((await f.send(chat.id, "remember CONTEXT_MARKER", "first-send")).turnId).toBe(first.turnId); expect(f.requests).toHaveLength(1);
  await f.send(chat.id, "what did I ask?"); await until(() => f.chats.detail(chat.id).chat.status === "idle");
  expect(JSON.stringify(f.requests[1].messages)).toContain("remember CONTEXT_MARKER"); expect(f.chats.detail(chat.id).messages).toHaveLength(4);
  expect(f.outside.list()).toEqual([]); expect(() => f.outside.detail(chat.id)).toThrow("outside");
  for (const field of ["workspace", "env", "settings", "permissionMode", "sessionId", "systemPrompt"]) await expect(f.chats.command({ action: "send", chatId: chat.id, commandId: field, text: "forged", [field]: "bypassPermissions" })).rejects.toThrow("authority");
  expect(JSON.stringify(f.chats.detail(chat.id))).not.toContain("never-send-this-key-to-browser");
}, 20000);

test("web tool approval is scoped to the live turn, survives reconnect and does not grant future turns", async () => {
  const f = await fixture(), chat = await f.create(); await f.send(chat.id, "WRITE a proof file");
  await until(() => f.chats.detail(chat.id).approvals.length > 0, "tool approval");
  const pending = f.chats.detail(chat.id).approvals[0]!; expect(pending.tool).toBe("write"); expect(await readFile(join(f.workspace, "proof.txt"), "utf8").catch(() => "")).toBe("");
  await expect(f.chats.command({ action: "approve", commandId: "stale", chatId: chat.id, turnId: "stale", requestId: pending.requestId, behavior: "allow" })).rejects.toThrow("轮次");
  const stream = f.chats.watch(chat.id, new AbortController().signal), reader = stream.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain(pending.requestId); await reader.cancel();
  const decision = { action: "approve", commandId: "approve-once", chatId: chat.id, turnId: pending.turnId, requestId: pending.requestId, behavior: "allow" };
  await f.chats.command(decision); await until(() => f.chats.detail(chat.id).chat.status === "idle");
  expect(await readFile(join(f.workspace, "proof.txt"), "utf8")).toBe("approved once"); expect(f.chats.detail(chat.id).messages[1]?.tools?.[0]?.status).toBe("complete");
  await f.chats.command(decision); expect(f.requests).toHaveLength(2);
  await f.send(chat.id, "WRITE again"); await until(() => f.chats.detail(chat.id).approvals.length > 0, "fresh approval");
  const next = f.chats.detail(chat.id).approvals[0]!; expect(next.turnId).not.toBe(pending.turnId);
  await f.chats.command({ action: "approve", commandId: "deny", chatId: chat.id, turnId: next.turnId, requestId: next.requestId, behavior: "deny" });
  await until(() => f.chats.detail(chat.id).chat.status === "idle");
}, 20000);

test("disconnecting a chat stream keeps the turn alive, while explicit stop joins the executor", async () => {
  const f = await fixture(), chat = await f.create(); const turn = await f.send(chat.id, "WAIT");
  await until(() => f.requests.length > 0);
  const reader = f.chats.watch(chat.id, new AbortController().signal).body!.getReader(); await reader.read(); await reader.cancel();
  expect(f.chats.detail(chat.id).chat.status).toBe("running");
  await expect(f.send(chat.id, "a second turn")).rejects.toThrow("正在执行");
  await f.chats.command({ action: "stop", commandId: "stop", chatId: chat.id, turnId: turn.turnId });
  await until(() => f.chats.detail(chat.id).chat.status === "interrupted");
  expect(f.requests).toHaveLength(1); await f.manager.close();
}, 15000);

test("owner restart retains conversation history and marks uncertain turns interrupted without replay", async () => {
  const f = await fixture(), chat = await f.create(); await f.send(chat.id, "remember CONTEXT_MARKER"); await until(() => f.chats.detail(chat.id).chat.status === "idle"); await f.manager.close();
  f.store.command("crashed-turn", {}, Date.now(), tx => { const row = tx.applicationRecord<ChatSummary>("host.web-chats", chat.id)!; tx.saveApplicationRecord({ ...row, value: { ...row.value, status: "waiting-approval", turnId: "lost-turn" } }, row.revision); return true; });
  const restarted = createChatService({ store: f.store, configDir: f.configDir, env: {} }); cleanup.push(restarted.close);
  const view = await restarted.service.open(f.workspace); expect(view.detail(chat.id).chat.status).toBe("interrupted"); expect(view.detail(chat.id).approvals).toEqual([]); expect(f.requests).toHaveLength(1);
  await view.command({ action: "send", chatId: chat.id, commandId: "continue", text: "continue from history" }); await until(() => view.detail(chat.id).chat.status === "idle");
  expect(JSON.stringify(f.requests[1].messages)).toContain("CONTEXT_MARKER");
  await rm(new SessionStore({ configDir: f.configDir, cwd: f.workspace, sessionId: chat.id }).filePath);
  await expect(view.command({ action: "send", chatId: chat.id, commandId: "missing-history", text: "continue" })).rejects.toThrow("原会话文件缺失");
  expect(f.requests).toHaveLength(2);
}, 20000);

test("large escaped responses fit the UI storage budget while native context remains complete", async () => {
  const f = await fixture(), chat = await f.create(); await f.send(chat.id, "LARGE");
  await until(() => f.chats.detail(chat.id).chat.status === "idle");
  const message = f.chats.detail(chat.id).messages[1]!; expect(message.text).toContain("截断"); expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThan(128 * 1024);
  const native = await new SessionStore({ configDir: f.configDir, cwd: f.workspace, sessionId: chat.id }).readState();
  expect(JSON.stringify(native.messages).length).toBeGreaterThan(200000);
}, 15000);

test("authenticated HTTP chat endpoints share workspace isolation, SSE limits and logout behavior", async () => {
  const f = await fixture();
  const tasks = { async open(workspace: string) { return { workspace, info: async () => ({ workspace, coding: true, models: [], defaults: { provider: "fixture", model: "fixture" } }), list: () => [], detail: async () => { throw new Error("unused"); }, events: () => [], attention: () => new Response(), command: async () => ({}) }; } };
  const host = createWebWorkbench({ tasks, chats: f.manager.service }); cleanup.push(host.close);
  const link = await host.launch(f.workspace), url = new URL(link.url), base = url.origin + url.pathname;
  expect((await fetch(base + "api/chats")).status).toBe(401);
  const auth = await fetch(base + "auth/exchange", { method: "POST", headers: { origin: url.origin, "content-type": "application/json" }, body: JSON.stringify({ code: new URLSearchParams(url.hash.slice(1)).get("code") }) });
  const cookie = auth.headers.get("set-cookie")!.split(";")[0]!;
  const post = (input: unknown, origin = url.origin) => fetch(base + "api/chat/command", { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify(input) });
  expect((await post({ action: "create", commandId: "wrong-origin" }, "https://evil.example")).status).toBe(403);
  await writeFile(join(f.workspace, "search.ts"), "before\nneedle.<script>\nafter\n");
  const search = (input: unknown, origin = url.origin, authenticated = true) => fetch(base + "api/search", { method: "POST", headers: { ...(authenticated ? { cookie } : {}), origin, "content-type": "application/json" }, body: JSON.stringify(input) });
  expect((await search({ query: "needle" }, url.origin, false)).status).toBe(401);
  expect((await search({ query: "needle" }, "https://evil.example")).status).toBe(403);
  expect((await search({ query: "needle", workspace: f.root })).status).toBe(400);
  expect((await search({ query: "" })).status).toBe(400);
  const found = await (await search({ query: "needle.<script>" })).json() as any;
  expect(found.matches).toEqual([{ file: "search.ts", line: 2, text: "needle.<script>", preview: ["1: before", "2: needle.<script>", "3: after"] }]);
  expect((await f.outside.search!("needle")).matches).toEqual([]); expect(f.requests).toHaveLength(0);
  const response = await post({ action: "create", commandId: "web-create", provider: "fixture", model: "fixture" }); expect(response.status).toBe(200); const chat = await response.json() as ChatSummary;
  const inspect = (input: unknown, authenticated = true) => fetch(base + "api/inspect", { method: "POST", headers: { ...(authenticated ? { cookie } : {}), origin: url.origin, "content-type": "application/json" }, body: JSON.stringify(input) });
  expect((await inspect({ kind: "history" }, false)).status).toBe(401);
  expect((await inspect({ kind: "history", workspace: f.root })).status).toBe(400);
  expect((await inspect({ kind: "changes", chatId: "not-here" })).status).toBe(400);
  expect((await inspect({ kind: "changes", chatId: chat.id })).status).toBe(200);

  const stream = await fetch(base + "api/chats/" + chat.id + "/stream", { headers: { cookie } }), reader = stream.body!.getReader(); expect(new TextDecoder().decode((await reader.read()).value)).toContain(chat.id);
  await fetch(base + "auth/logout", { method: "POST", headers: { cookie, origin: url.origin, "content-type": "application/json" }, body: "{}" }); expect((await reader.read()).done).toBe(true);
  expect((await post({ action: "create", commandId: "after-logout" })).ok).toBe(false);
});

test("web projection retains bounded structured child progress without leaking full tool output", async () => {
  const finish = Promise.withResolvers<void>();
  const f = await fixture(() => {
    const generator = (async function* () {
      yield { type: "tool_event", event: { type: "tool-execution-start", id: "child", name: "agent" } };
      yield { type: "tool_event", event: { type: "tool-execution-progress", id: "child", name: "agent", data: { agentPhase: "tool", latestTool: "read", elapsedTimeSeconds: 7, fullOutput: "NOT_FOR_BROWSER" } } };
      await finish.promise;
      yield { type: "tool_event", event: { type: "tool-execution-end", id: "child", name: "agent", output: "done" } };
      yield { type: "result", subtype: "success", result: "done" };
    })();
    return Object.assign(generator, { close() { finish.resolve(); }, waitForExit: async () => {} }) as unknown as import("../../src/sdk/query").Query;
  });
  const chat = await f.create(); await f.send(chat.id, "read code");
  try {
    await until(() => f.chats.detail(chat.id).messages[1]?.tools?.[0]?.phase === "tool");
    const snapshot = f.chats.detail(chat.id);
    expect(snapshot.messages[1]?.tools?.[0]).toMatchObject({ status: "running", phase: "tool", latestTool: "read", elapsedSeconds: 7 });
    expect(JSON.stringify(snapshot)).not.toContain("NOT_FOR_BROWSER");
  } finally { finish.resolve(); }
  await until(() => f.chats.detail(chat.id).chat.status === "idle");
});

test("workspace inspection exposes history, changes, compactions and explicit MCP diagnostics without models or credentials", async () => {
  const f = await fixture(), chat = await f.create();
  const native = new SessionStore({ configDir: f.configDir, cwd: f.workspace, sessionId: chat.id });
  const { fileChangeEvidence } = await import("../../src/services/git/change-evidence");
  await native.append([{ role: "user", content: [{ type: "text", text: "user source" }] }, { role: "assistant", content: [{ type: "text", text: "answer INSPECTION_MARK" }] }, { role: "user", content: [{ type: "tool-result", toolUseId: "edit", content: "edited", isError: false, fileChanges: [fileChangeEvidence("example.ts", "old", "new")], workspaceObservations: [{ partial: false, changes: [{ path: "external.ts", before: "a", after: "b", window: "between-commands" }] }] }] }]);
  await native.appendCompactBoundary({ strategy: "microcompact", messages: [{ role: "user", content: [{ type: "text", text: "retained input" }] }], preTokens: 1000, postTokens: 900 });
  const history = await f.chats.inspect!({ kind: "history", query: "INSPECTION_MARK" });
  expect(history.items[0]?.referenceText).toContain("INSPECTION_MARK"); expect(history.items[0]?.draftText).toBeUndefined();
  const changes = await f.chats.inspect!({ kind: "changes", chatId: chat.id });
  expect(changes.items.some(item => item.body.includes("-old") && item.body.includes("+new"))).toBe(true);
  expect(changes.items.some(item => item.title === "external.ts" && item.subtitle?.includes("来源未确认"))).toBe(true);
  expect((await f.chats.inspect!({ kind: "compactions", chatId: chat.id })).items[0]).toMatchObject({ title: "旧工具输出清理", body: "此记录未生成对话摘要。" });
  await expect(f.outside.inspect!({ kind: "changes", chatId: chat.id })).rejects.toThrow("outside");
  await writeFile(join(f.root, "mcp-version"), "fixture");
  await writeFile(join(f.configDir, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [join(import.meta.dir, "../fixtures/durable-mcp-server.mjs"), join(f.root, "mcp-log"), join(f.root, "mcp-version")], env: { EXPLICIT_FIXTURE_SECRET: "DO_NOT_EXPOSE" } } } }));
  expect((await f.chats.inspect!({ kind: "mcp" })).items[0]?.subtitle).toBe("未检查");
  const checked = await f.chats.inspect!({ kind: "mcp-reconnect", server: "fixture" });
  expect(checked.items[0]?.subtitle).toBe("connected"); expect(JSON.stringify(checked)).not.toContain("DO_NOT_EXPOSE");
  expect(f.requests).toHaveLength(0);
}, 15000);
