import { readFile, realpath } from "node:fs/promises";
import type { UserQuestion } from "../../tools/interaction";
import type { WaitView } from "./waits";
import type { RunStatus } from "./types";
import { digestJson } from "./json";
import { runtimePaths, runtimeRequest } from "./server";

export type QuestionNotice = WaitView & { runObjective: string; runStatus: RunStatus };
export type QuestionInbox = Pick<DurableQuestionInbox, "current" | "subscribe" | "next" | "dismiss" | "answer">;
export const questionNoticeKey = (notice: QuestionNotice) => `${notice.waitId}:${notice.version}`;

/** A local UI subscription only: never starts an owner/model or treats a notification as an answer. */
export class DurableQuestionInbox {
  #questions: readonly QuestionNotice[] = [];
  readonly #listeners = new Set<() => void>();
  readonly #dismissed = new Set<string>();
  readonly #controller = new AbortController();
  #done?: Promise<void>;
  #scope?: string;
  constructor(readonly options: { configDir: string; workspace(): string }) {}
  current = (): readonly QuestionNotice[] => this.#questions;
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
    const scope = await realpath(this.options.workspace());
    if (scope !== this.#scope || !this.#questions.some((current) => questionNoticeKey(current) === questionNoticeKey(question))) throw new Error("问题已处理或工作区已切换，请使用当前问题。");
    const input = { action: "answer", runId: question.runId, waitId: question.waitId, expectedVersion: question.version, answer };
    const result = await runtimeRequest(this.options.configDir, "/command", { ...input, commandId: `ui:${digestJson(input)}` }) as { run: { status: RunStatus } };
    this.#publish(this.#questions.filter((current) => current.waitId !== question.waitId));
    return { paused: result.run.status === "paused" || result.run.status === "pausing" };
  }
  async #watch(): Promise<void> {
    const signal = this.#controller.signal;
    while (!signal.aborted) {
      const connection = new AbortController();
      const connectedSignal = AbortSignal.any([signal, connection.signal]);
      const workspace = this.options.workspace();
      // Changing projects must revoke an old dialog before its answer can target another scope.
      const scopeTimer = setInterval(() => { if (workspace !== this.options.workspace()) { this.#scope = undefined; this.#publish([]); connection.abort(); } }, 250);
      scopeTimer.unref();
      try {
        const scope = await realpath(workspace);
        if (this.#scope !== scope) { this.#scope = scope; this.#publish([]); }
        const paths = await runtimePaths(this.options.configDir);
        const token = (await readFile(paths.token, "utf8")).trim();
        const response = await fetch(`http://localhost/attention?workspace=${encodeURIComponent(scope)}`, { unix: paths.socket,
          headers: { authorization: `Bearer ${token}` }, signal: connectedSignal });
        if (!response.ok || !response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) throw new Error("Question notifications unavailable");
        const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = "";
        try {
          for (;;) {
            const chunk = await reader.read(); if (chunk.done) break;
            pending += decoder.decode(chunk.value, { stream: true });
            for (;;) {
              const end = pending.indexOf("\n\n"); if (end < 0) break;
              const frame = pending.slice(0, end); pending = pending.slice(end + 2);
              if (frame.length > 2 * 1024 * 1024) throw new Error("Question notification exceeds limit");
              if (!frame.startsWith("data: ")) continue;
              const snapshot = JSON.parse(frame.slice(6)) as { workspace: string; questions: QuestionNotice[] };
              if (snapshot.workspace !== scope || !Array.isArray(snapshot.questions) || snapshot.questions.length > 4096) throw new Error("Question notification scope mismatch");
              if (this.options.workspace() !== workspace) { connection.abort(); break; }
              if (JSON.stringify(snapshot.questions) !== JSON.stringify(this.#questions)) this.#publish(snapshot.questions);
            }
            if (pending.length > 2 * 1024 * 1024) throw new Error("Question notification exceeds limit");
          }
        } finally { await reader.cancel().catch(() => undefined); }
      } catch { /* Reconnect with the new owner key; the next snapshot repairs missed changes. */ }
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
    for (const listener of this.#listeners) { try { listener(); } catch { /* UI observers cannot affect the task. */ } }
  }
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
