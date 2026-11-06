import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ChatService, ChatSummary, ChatMessage, ChatSnapshot, ChatApproval } from "../../agent/chat-service";
import { query, type QueryInput, type Query, type CanUseToolResult } from "../../sdk/query";
import { loadProviderCatalog, resolveProviderSelection } from "../../providers/config";
import { SessionStore } from "../session/storage";
import type { RuntimeStore } from "../runtime/store";
import { digestJson, encodeJson, text } from "../runtime/json";

const CHATS = "host.web-chats", MESSAGES = "host.web-chat-messages";
type LiveTurn = { controller: AbortController; done: Promise<void>; message: ChatMessage;
  approvals: Map<string, { value: ChatApproval; resolve(value: CanUseToolResult): void }> };
const messageId = (chatId: string, sequence: number) => `${chatId}:${String(sequence).padStart(10, "0")}`;
const clipped = (value: string, limit = 128 * 1024) => Buffer.byteLength(value) <= limit ? value : Buffer.from(value).subarray(0, limit).toString("utf8") + "\n[显示内容已截断；原会话由执行器保存]";
function boundedMessage(message: ChatMessage): ChatMessage {
  const result = structuredClone(message);
  for (;;) {
    try { encodeJson(result, 120 * 1024); return result; }
    catch {
      if (result.text.length > 1024) result.text = clipped(result.text, Math.max(512, Buffer.byteLength(result.text) >> 1));
      else if (result.tools?.length) result.tools.pop();
      else throw new Error("Conversation message exceeds storage limits");
    }
  }
}

/** Reuses the terminal executor and its native sessions; the browser only receives scoped projections. */
export function createChatService(options: { store: RuntimeStore; configDir: string; env: Record<string, string | undefined>; signal?: AbortSignal;
  query?: (input: QueryInput) => Query; track?<T>(operation: () => Promise<T>): Promise<T> }) {
  const { store } = options, controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]);
  const live = new Map<string, LiveTurn>(), listeners = new Map<string, Set<() => void>>();
  let closing: Promise<void> | undefined;
  const assertLive = () => signal.throwIfAborted();
  const emit = (id: string) => { for (const listener of listeners.get(id) ?? []) listener(); };
  const read = (id: string) => { const row = store.applicationRecord<ChatSummary>(CHATS, id); if (!row) throw new Error("Conversation not found"); return row; };
  const save = (chat: ChatSummary) => store.command(randomUUID(), { kind: "web-chat.update", id: chat.id }, Date.now(), tx => {
    const previous = tx.applicationRecord<ChatSummary>(CHATS, chat.id)!; tx.saveApplicationRecord({ namespace: CHATS, id: chat.id, value: chat }, previous.revision); return true;
  });
  const saveMessage = (message: ChatMessage) => store.command(randomUUID(), { kind: "web-chat.message", id: message.id }, Date.now(), tx => {
    const previous = tx.applicationRecord<ChatMessage>(MESSAGES, message.id); tx.saveApplicationRecord({ namespace: MESSAGES, id: message.id, value: message }, previous?.revision ?? 0); return true;
  });
  // A restarted owner never replays an uncertain conversation turn or an old approval.
  let after = "";
  for (;;) {
    const page = store.applicationRecords<ChatSummary>(CHATS, after, 256);
    for (const row of page) if (["running", "waiting-approval"].includes(row.value.status)) {
      save({ ...row.value, status: "interrupted", updatedAt: Date.now(), error: "服务曾中断；请核对工具结果后继续，不会自动重发上一条消息。" });
      const last = store.applicationRecord<ChatMessage>(MESSAGES, messageId(row.value.id, row.value.messageCount));
      if (last?.value.role === "assistant") saveMessage({ ...last.value, status: "interrupted" });
    }
    if (page.length < 256) break; after = page.at(-1)!.id;
  }
  const snapshot = (id: string): ChatSnapshot => {
    const chat = read(id).value, start = Math.max(0, chat.messageCount - 64);
    const messages = store.applicationRecords<ChatMessage>(MESSAGES, start ? messageId(id, start) : "", 64, { thread: id }).map(row => row.value);
    const active = live.get(id); if (active) { const index = messages.findIndex(message => message.id === active.message.id); if (index >= 0) messages[index] = structuredClone(active.message); }
    return { chat, messages, approvals: [...(active?.approvals.values() ?? [])].map(row => row.value), earlierMessages: start };
  };
  async function run(chat: ChatSummary, prompt: string, resume: boolean, turn: LiveTurn) {
    let client: Query | undefined, completed = false;
    let status: ChatSummary["status"] = "idle", failure: string | undefined;
    const timeout = setTimeout(() => turn.controller.abort(new Error("本轮达到 10 分钟上限，请核对执行结果后继续。")), 10 * 60 * 1000);
    const linked = AbortSignal.any([signal, turn.controller.signal]);
    const deny = () => { for (const pending of turn.approvals.values()) pending.resolve({ behavior: "deny", message: "Conversation stopped" }); turn.approvals.clear(); };
    linked.addEventListener("abort", deny, { once: true });
    try {
      client = (options.query ?? query)({ prompt, options: { cwd: chat.workspace, env: { ...options.env, TNB_HOME: options.configDir }, provider: chat.provider, model: chat.model,
        ...(resume ? { resume: chat.id } : { sessionId: chat.id }), permissionMode: "default", maxTurns: 64, includePartialMessages: true,
        pathToTnbExecutable: process.execPath, executableArgs: Bun.main.startsWith("/$bunfs/") ? [] : [fileURLToPath(new URL("../../entrypoints/cli.ts", import.meta.url))], signal: linked,
        canUseTool: async (tool, input, request) => {
          linked.throwIfAborted(); if (turn.approvals.size >= 16) return { behavior: "deny", message: "Too many pending approvals" };
          const value: ChatApproval = { requestId: request.requestId, turnId: chat.turnId!, tool, input: clipped(encodeJson(input, 1024 * 1024), 16 * 1024), message: request.message };
          const decision = Promise.withResolvers<CanUseToolResult>(); turn.approvals.set(value.requestId, { value, resolve: decision.resolve });
          save({ ...read(chat.id).value, status: "waiting-approval" }); emit(chat.id);
          return decision.promise;
        },
      } });
      for await (const message of client) {
        linked.throwIfAborted();
        if (message.type === "model_event") {
          const event = message.event as { type?: string; text?: string };
          if (event?.type === "text" && typeof event.text === "string") turn.message.text = clipped(turn.message.text + event.text);
        }
        if (message.type === "tool_event") {
          const event = message.event as { type: string; id: string; name: string; output?: string; isError?: boolean };
          if (event?.type === "tool-execution-start") {
            turn.message.tools ??= []; if (turn.message.tools.length < 64) turn.message.tools.push({ id: String(event.id).slice(0, 128), name: String(event.name).slice(0, 128), status: "running" });
          }
          if (event?.type === "tool-execution-end") {
            const tool = turn.message.tools?.find(item => item.id === event.id); if (tool) { tool.status = event.isError ? "failed" : "complete"; tool.output = clipped(event.output ?? "", 4096); }
          }
        }
        if (message.type === "result") {
          if (message.subtype !== "success") throw new Error(typeof message.error === "string" ? message.error : "本轮执行已中断");
          if (!turn.message.text && typeof message.result === "string") turn.message.text = clipped(message.result);
          completed = true;
        }
        emit(chat.id);
      }
      if (!completed) throw new Error("执行器退出但未确认本轮完成；请核对工具结果。");
      turn.message.status = "complete";
    } catch (error) {
      turn.message.status = linked.aborted ? "interrupted" : "failed";
      status = turn.message.status; failure = error instanceof Error ? clipped(error.message, 4096) : "对话执行失败";
    } finally {
      clearTimeout(timeout); linked.removeEventListener("abort", deny); deny();
      client?.close(); if (client) await client.waitForExit();
      for (const tool of turn.message.tools ?? []) if (tool.status === "running") tool.status = "interrupted";
      try {
        const message = boundedMessage(turn.message);
        store.command(randomUUID(), { kind: "web-chat.finish", id: chat.id, turnId: chat.turnId }, Date.now(), tx => {
          const previous = tx.applicationRecord<ChatSummary>(CHATS, chat.id)!, saved = tx.applicationRecord<ChatMessage>(MESSAGES, message.id)!;
          tx.saveApplicationRecord({ namespace: MESSAGES, id: message.id, value: message }, saved.revision);
          tx.saveApplicationRecord({ namespace: CHATS, id: chat.id, value: { ...previous.value, status, error: failure, updatedAt: Date.now() } }, previous.revision); return true;
        });
      } finally { live.delete(chat.id); emit(chat.id); }
    }
  }
  const service: ChatService = { async open(path) {
    assertLive(); const workspace = await realpath(text(path, "workspace", 4096)); if (!(await stat(workspace)).isDirectory()) throw new Error("Workspace must be a directory"); assertLive();
    const scoped = (id: string) => { assertLive(); text(id, "conversation", 128); const row = read(id); if (row.value.workspace !== workspace) throw new Error("Conversation is outside this workspace"); return row.value; };
    return { workspace,
      list() { assertLive(); const result: ChatSummary[] = []; let after = "";
        for (;;) { const rows = store.applicationRecords<ChatSummary>(CHATS, after, 256); for (const row of rows) if (row.value.workspace === workspace) result.push(row.value);
          if (rows.length < 256) break; after = rows.at(-1)!.id; if (result.length > 1000) throw new Error("Conversation inventory limit reached"); }
        return result.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100);
      },
      detail(id) { scoped(id); return snapshot(id); },
      async command(value) {
        assertLive(); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid conversation command");
        const input = value as Record<string, unknown>, action = input.action;
        const fields: Record<string, string[]> = { create: ["provider", "model"], send: ["chatId", "text"], approve: ["chatId", "turnId", "requestId", "behavior"], stop: ["chatId", "turnId"] };
        if (typeof action !== "string" || !Object.hasOwn(fields, action) || Object.keys(input).some(key => !["action", "commandId", ...fields[action]!].includes(key))) throw new Error("Unsupported conversation action or authority field");
        text(input.commandId as string, "command ID", 128);
        const commandId = `web-chat:${digestJson({ workspace, commandId: input.commandId })}`;
        const replayed = store.replayCommand<unknown>(commandId, { ...input, workspace });
        if (replayed !== undefined) return replayed;
        if (action === "create") {
          if (input.provider !== undefined) text(input.provider as string, "provider", 128); if (input.model !== undefined) text(input.model as string, "model", 256);
          const catalog = await loadProviderCatalog(options); assertLive();
          const ready = Object.values(catalog.providers).find(provider => provider.apiKey || !["anthropic", "openai"].includes(provider.id));
          const selection = resolveProviderSelection(catalog, input.provider as string ?? options.env.TNB_PROVIDER ?? ready?.id ?? Object.keys(catalog.providers)[0]!, input.model as string | undefined ?? options.env.TNB_MODEL);
          const chat: ChatSummary = { id: randomUUID(), title: "新对话", workspace, provider: selection.provider.id, model: selection.model.id, createdAt: Date.now(), updatedAt: Date.now(), status: "idle", messageCount: 0 };
          return store.command(commandId, { ...input, workspace }, Date.now(), tx => { tx.saveApplicationRecord({ namespace: CHATS, id: chat.id, value: chat }, 0); return chat; });
        }
        const chat = scoped(input.chatId as string);
        if (action === "send") {
          text(input.text as string, "message", 32768);
          if (await realpath(workspace) !== workspace) throw new Error("Workspace identity changed"); assertLive();
          const session = new SessionStore({ configDir: options.configDir, cwd: workspace, sessionId: chat.id });
          const resume = await stat(session.filePath).then(info => info.isFile()).catch(() => false); assertLive();
          // Dedupe is decided inside the command transaction before admission checks.
          const result = store.command(commandId, { ...input, workspace }, Date.now(), tx => {
            const current = tx.applicationRecord<ChatSummary>(CHATS, chat.id)!;
            if (live.has(chat.id) || ["running", "waiting-approval"].includes(current.value.status)) throw new Error("当前对话正在执行，请等待或先停止。");
            if (live.size >= 4) throw new Error("同时执行的对话已达上限");
            if (current.value.messageCount && !resume) throw new Error("原会话文件缺失，不能用空上下文继续。请恢复会话文件或新建对话。");
            const next = { ...current.value, title: current.value.messageCount ? current.value.title : (input.text as string).slice(0, 60), status: "running" as const, turnId: randomUUID(), updatedAt: Date.now(), messageCount: current.value.messageCount + 2, error: undefined };
            const user: ChatMessage = { id: messageId(chat.id, next.messageCount - 1), thread: chat.id, role: "user", text: input.text as string, at: Date.now(), status: "complete" };
            const assistant: ChatMessage = { id: messageId(chat.id, next.messageCount), thread: chat.id, role: "assistant", text: "", at: Date.now(), status: "running" };
            tx.saveApplicationRecord({ namespace: CHATS, id: chat.id, value: next }, current.revision);
            for (const message of [user, assistant]) tx.saveApplicationRecord({ namespace: MESSAGES, id: message.id, value: message }, 0);
            return next;
          });
          // Replayed receipts must never launch the accepted model call a second time.
          const current = read(chat.id).value;
          if (current.turnId === result.turnId && current.status === "running" && !live.has(chat.id) && current.messageCount === result.messageCount) {
            const turn: LiveTurn = { controller: new AbortController(), done: Promise.resolve(), message: store.applicationRecord<ChatMessage>(MESSAGES, messageId(chat.id, current.messageCount))!.value, approvals: new Map() };
            live.set(chat.id, turn);
            const execute = () => run(current, input.text as string, resume, turn);
            turn.done = options.track ? options.track(execute) : execute(); void turn.done.catch(() => {}); emit(chat.id);
          }
          return result;
        }
        if (input.turnId !== chat.turnId) throw new Error("对话轮次已变化，请刷新。");
        if (action === "approve" && !["allow", "deny"].includes(input.behavior as string)) throw new Error("Invalid approval decision");
        const result = store.command(commandId, { ...input, workspace }, Date.now(), () => {
          const turn = live.get(chat.id); if (!turn) throw new Error("本轮已结束，不能提交旧决定。");
          if (action === "approve" && !turn.approvals.has(input.requestId as string)) throw new Error("审批已失效，请刷新。");
          return { accepted: true };
        });
        const turn = live.get(chat.id);
        if (action === "stop") turn?.controller.abort(new Error("用户停止了本轮，请核对工具结果后继续。"));
        else { const pending = turn?.approvals.get(input.requestId as string); if (pending) { turn!.approvals.delete(input.requestId as string); pending.resolve(input.behavior === "allow" ? { behavior: "allow" } : { behavior: "deny", message: "User denied this operation" });
          save({ ...read(chat.id).value, status: turn!.approvals.size ? "waiting-approval" : "running" }); emit(chat.id); } }
        return result;
      },
      watch(id, watchSignal, onClose) {
        scoped(id); const linked = AbortSignal.any([watchSignal, signal]); const encoder = new TextEncoder(); let ended = false, timer: ReturnType<typeof setTimeout> | undefined;
        let finish = () => {};
        return new Response(new ReadableStream({ start(stream) {
          const send = () => { if (ended) return; try { if ((stream.desiredSize ?? 0) <= 0) return finish(); stream.enqueue(encoder.encode(`data: ${JSON.stringify(snapshot(id))}\n\n`)); } catch { finish(); } };
          const changed = () => { if (!timer) timer = setTimeout(() => { timer = undefined; send(); }, 80); };
          const heartbeat = setInterval(() => { if (!ended) { try { if ((stream.desiredSize ?? 0) <= 0) return finish(); stream.enqueue(encoder.encode(": keepalive\n\n")); } catch { finish(); } } }, 15000);
          finish = () => { if (ended) return; ended = true; clearTimeout(timer); clearInterval(heartbeat); linked.removeEventListener("abort", finish); listeners.get(id)?.delete(changed); if (!listeners.get(id)?.size) listeners.delete(id); try { stream.close(); } catch {} onClose?.(); };
          if (linked.aborted) return finish(); linked.addEventListener("abort", finish, { once: true });
          let set = listeners.get(id); if (!set) { set = new Set(); listeners.set(id, set); } set.add(changed); send();
        }, cancel() { finish(); } }), { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
      },
    };
  } };
  const close = () => closing ??= (async () => { controller.abort(); for (const turn of live.values()) turn.controller.abort(); await Promise.allSettled([...live.values()].map(turn => turn.done)); })();
  return { service, close };
}
