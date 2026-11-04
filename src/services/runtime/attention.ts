import { readFile, realpath } from "node:fs/promises";
import type { UserQuestion } from "../../tools/interaction";
import type { WaitView } from "./waits";
import type { RunStatus } from "./types";
import { digestJson } from "./json";
import { runtimePaths, runtimeRequest } from "./server";
import type { RunNotice } from "./notices";

export type QuestionNotice = WaitView & { runObjective: string; runStatus: RunStatus };
export type ConnectionStatus = { state: "connecting" | "online" | "offline" | "stopped" | "incompatible" | "unauthorized"; message: string; lastConnectedAt?: number };
export type QuestionInbox = Pick<DurableQuestionInbox, "current" | "subscribe" | "next" | "dismiss" | "answer">
  & Partial<Pick<DurableQuestionInbox, "notifications" | "connection" | "acknowledge">>;
export const questionNoticeKey = (notice: QuestionNotice) => `${notice.waitId}:${notice.version}`;

/** A local UI subscription only: never starts an owner/model or treats a notification as an answer. */
export class DurableQuestionInbox {
  #questions: readonly QuestionNotice[] = [];
  #notifications: readonly RunNotice[] = [];
  #connection: ConnectionStatus = { state: "connecting", message: "正在连接长任务后台服务" };
  readonly #acknowledging = new Map<string, Promise<void>>();
  readonly #listeners = new Set<() => void>();
  readonly #dismissed = new Set<string>();
  readonly #controller = new AbortController();
  #done?: Promise<void>;
  #scope?: string;
  constructor(readonly options: { configDir: string; workspace(): string }) {}
  current = (): readonly QuestionNotice[] => this.#questions;
  notifications = (): readonly RunNotice[] => this.#notifications;
  connection = (): ConnectionStatus => this.#connection;
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  next = (): QuestionNotice | undefined => this.#questions.find((question) => !this.#dismissed.has(questionNoticeKey(question)));
  dismiss = (question: QuestionNotice): void => { this.#dismissed.add(questionNoticeKey(question)); this.#publish([...this.#questions]); };
  start(): void {
    if (this.#done || this.#controller.signal.aborted) throw new Error("Question subscription is already started or closed");
    this.#done = this.#watch();
  }
  async close(): Promise<void> { this.#controller.abort(); await this.#done; }
  async answer(question: QuestionNotice, answer: string): Promise<{ paused: boolean }> {
    if (this.#controller.signal.aborted) throw new Error("对话已关闭，回答没有提交。");
    if (this.#connection.state !== "online") throw new Error("长任务后台离线或连接尚未恢复，回答没有提交。");
    const scope = await realpath(this.options.workspace());
    if (scope !== this.#scope || !this.#questions.some((current) => questionNoticeKey(current) === questionNoticeKey(question))) throw new Error("问题已处理或工作区已切换，请使用当前问题。");
    const input = { action: "answer", runId: question.runId, waitId: question.waitId, expectedVersion: question.version, answer };
    const result = await runtimeRequest(this.options.configDir, "/command", { ...input, commandId: `ui:${digestJson(input)}` }) as { run: { status: RunStatus } };
    this.#publish(this.#questions.filter((current) => current.waitId !== question.waitId));
    return { paused: result.run.status === "paused" || result.run.status === "pausing" };
  }
  acknowledge(notice: RunNotice): Promise<void> {
    const existing = this.#acknowledging.get(notice.noticeId); if (existing) return existing;
    const pending = (async () => {
      if (this.#controller.signal.aborted || this.#connection.state !== "online") throw new Error("Notification connection is unavailable");
      if (await realpath(this.options.workspace()) !== this.#scope) throw new Error("Notification workspace changed");
      await runtimeRequest(this.options.configDir, "/command", { action: "ack", commandId: `notice:${notice.noticeId}`, runId: notice.runId, noticeId: notice.noticeId });
      this.#notifications = this.#notifications.filter((current) => current.noticeId !== notice.noticeId); this.#emit();
    })().finally(() => { this.#acknowledging.delete(notice.noticeId); });
    this.#acknowledging.set(notice.noticeId, pending); return pending;
  }
  async #watch(): Promise<void> {
    const signal = this.#controller.signal;
    while (!signal.aborted) {
      const connection = new AbortController();
      const connectedSignal = AbortSignal.any([signal, connection.signal]);
      const workspace = this.options.workspace();
      let lastFrameAt = Date.now(), stale = false;
      // Changing projects must revoke an old dialog before its answer can target another scope.
      const scopeTimer = setInterval(() => {
        if (workspace !== this.options.workspace()) { this.#scope = undefined; this.#publish([]); this.#notifications = []; this.#emit(); connection.abort(); }
        else if (Date.now() - lastFrameAt > 45000) { stale = true; connection.abort(); }
      }, 250);
      scopeTimer.unref();
      try {
        const scope = await realpath(workspace);
        if (this.#scope !== scope) { this.#scope = scope; this.#publish([]); }
        const paths = await runtimePaths(this.options.configDir);
        const token = (await readFile(paths.token, "utf8")).trim();
        const handshake = setTimeout(() => connection.abort(), 5000); handshake.unref();
        let response: Response;
        try { response = await fetch(`http://localhost/attention?workspace=${encodeURIComponent(scope)}`, { unix: paths.socket,
          headers: { authorization: `Bearer ${token}` }, signal: connectedSignal }); }
        finally { clearTimeout(handshake); }
        if (response.status === 403) throw new NotificationConnectionError("unauthorized", "后台控制凭据已变化，正在重新连接");
        if (!response.ok || !response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) throw new NotificationConnectionError("incompatible", "后台服务版本不支持完整提醒，请使用新版 tnb runtime restart");
        const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = "";
        try {
          for (;;) {
            const chunk = await reader.read(); if (chunk.done) break;
            lastFrameAt = Date.now();
            pending += decoder.decode(chunk.value, { stream: true });
            for (;;) {
              const end = pending.indexOf("\n\n"); if (end < 0) break;
              const frame = pending.slice(0, end); pending = pending.slice(end + 2);
              if (frame.length > 2 * 1024 * 1024) throw new Error("Question notification exceeds limit");
              if (!frame.startsWith("data: ")) continue;
              const snapshot = JSON.parse(frame.slice(6)) as { workspace: string; questions: QuestionNotice[]; notifications?: RunNotice[]; lifecycleNotifications?: boolean; ready?: boolean };
              if (snapshot.workspace !== scope || !Array.isArray(snapshot.questions) || snapshot.questions.length > 4096) throw new Error("Question notification scope mismatch");
              if (!snapshot.lifecycleNotifications || !Array.isArray(snapshot.notifications)) throw new NotificationConnectionError("incompatible", "后台服务版本较旧，请使用新版 tnb runtime restart 后继续接收提醒");
              if (snapshot.ready === false) throw new NotificationConnectionError("offline", "后台调度已停止，请使用 tnb runtime restart 重启后恢复");
              if (this.options.workspace() !== workspace) { connection.abort(); break; }
              if (JSON.stringify(snapshot.questions) !== JSON.stringify(this.#questions)) this.#publish(snapshot.questions);
              if (JSON.stringify(snapshot.notifications) !== JSON.stringify(this.#notifications)) { this.#notifications = snapshot.notifications; this.#emit(); }
              this.#setConnection("online", "长任务后台已连接");
            }
            if (pending.length > 2 * 1024 * 1024) throw new Error("Question notification exceeds limit");
          }
        } finally { await reader.cancel().catch(() => undefined); }
        if (!signal.aborted) this.#setConnection("offline", "长任务后台连接已断开，正在重连；可用 tnb runtime start 启动服务");
      } catch (error) {
        if (!signal.aborted && workspace === this.options.workspace()) {
          if (error instanceof NotificationConnectionError) this.#setConnection(error.state, error.message);
          else if ((error as NodeJS.ErrnoException).code === "ENOENT" && !this.#connection.lastConnectedAt) this.#setConnection("stopped", "长任务后台尚未启动；提交任务时自动启动，也可用 tnb runtime start 启动");
          else this.#setConnection("offline", stale ? "长任务后台长时间无响应，正在重连；可用 tnb runtime restart 重启"
            : "长任务后台离线，正在重连；可用 tnb runtime start 启动服务");
        }
      }
      finally { clearInterval(scopeTimer); connection.abort(); }
      if (!signal.aborted) await new Promise<void>((resolve) => {
        const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(); };
        const timer = setTimeout(abort, 500); timer.unref(); signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  }
  #publish(questions: readonly QuestionNotice[]): void {
    this.#questions = questions;
    const keys = new Set(questions.map(questionNoticeKey));
    for (const key of this.#dismissed) if (!keys.has(key)) this.#dismissed.delete(key);
    this.#emit();
  }
  #setConnection(state: ConnectionStatus["state"], message: string): void {
    if (this.#connection.state === state && this.#connection.message === message) return;
    this.#connection = { state, message, ...(state === "online" ? { lastConnectedAt: Date.now() } : this.#connection.lastConnectedAt ? { lastConnectedAt: this.#connection.lastConnectedAt } : {}) };
    this.#emit();
  }
  #emit(): void { for (const listener of this.#listeners) { try { listener(); } catch { /* UI observers cannot affect the task. */ } } }
}

class NotificationConnectionError extends Error {
  constructor(readonly state: ConnectionStatus["state"], message: string) { super(message); }
}

export function durableUserQuestion(notice: QuestionNotice): UserQuestion {
  if (notice.proposal.kind !== "question") throw new Error("Not a user question");
  return { header: `长任务需要你决定 · ${displayQuestionText(notice.runObjective).slice(0, 100)}`,
    question: displayQuestionText(notice.proposal.question),
    options: (notice.proposal.options ?? []).map((option) => ({ label: displayQuestionText(option), description: "" })), multiSelect: false };
}
export function displayQuestionText(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}
