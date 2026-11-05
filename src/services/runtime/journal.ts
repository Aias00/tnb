import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolCallJournal, JournalOutcome } from "../../core/call-journal";
import { toolCallScope } from "../../core/call-journal";
import type { ConversationMessage, ToolUseBlock } from "../../core/message";
import { assertBalancedToolHistory } from "../../core/history";
import { appendJsonl } from "../../utils/jsonl-append";
import { digestJson, encodeJson } from "./json";
import { RuntimeStore } from "./store";

export class UnknownEffectError extends Error {}
export type Operation = {
  operationId: string; taskId: string; scope: string; call: ToolUseBlock; input: unknown; digest: string;
  state: "intended" | "dispatched" | "settled"; replay: "safe" | "never";
  outcome?: JournalOutcome; effectOutcome?: "confirmed" | "not_applied" | "unknown";
};
type Entry = { version: 2; operationId: string; digest: string; state: Operation["state"]; outcome?: JournalOutcome; effectOutcome?: Operation["effectOutcome"] };

/** SQLite allocates identity before the fsynced JSONL barrier. Neither store is guessed from tool names. */
export class DurableCallJournal implements ToolCallJournal {
  scope(messages: readonly ConversationMessage[]): string {
    // SQLite canonicalizes object keys; call identity must survive that serialization boundary.
    // Preserve the legacy journal's scope protocol by opting in only this v2 adapter.
    return toolCallScope(JSON.parse(encodeJson(messages, 64 * 1024 * 1024)));
  }
  constructor(readonly options: {
    store: RuntimeStore; root: string; runId: string; taskId: string;
    assertLive(): void;
    isReplaySafe(call: ToolUseBlock, input: unknown): boolean;
    fault?(point: string): void;
  }) {}

  async intend(call: ToolUseBlock, input: unknown, scope?: string): Promise<string> {
    if (!scope) throw new Error("Durable calls require an exact history scope");
    this.options.assertLive();
    const id = digestJson({ taskId: this.options.taskId, scope, callId: call.id });
    const digest = digestJson({ call, input, scope });
    const operation = this.options.store.command(randomUUID(), { kind: "operation.intent", id, digest }, Date.now(), (tx) => {
      const existing = tx.record<Operation>("operation", id);
      if (existing) {
        if (existing.value.digest !== digest) throw new Error("Conflicting durable operation identity");
        return existing.value;
      }
      const value: Operation = { operationId: id, taskId: this.options.taskId, scope, call: structuredClone(call), input,
        digest, state: "intended", replay: this.options.isReplaySafe(call, input) ? "safe" : "never" };
      tx.saveRecord({ kind: "operation", id, runId: this.options.runId, taskId: this.options.taskId, value }, 0);
      tx.event(this.options.runId, "operation.intended", { operationId: id, tool: call.name, scope }, this.options.taskId);
      return value;
    });
    this.options.fault?.("after-db-intent");
    const entries = await this.#entries(operation);
    if (!entries.length) await this.#append(operation, { state: "intended" });
    this.options.fault?.("after-journal-intent");
    return id;
  }

  async dispatch(id: string): Promise<void> {
    this.options.assertLive();
    const operation = await this.lookup(id);
    if (operation.state === "settled") throw new Error("Settled operation must be recovered, not dispatched");
    if (operation.state === "dispatched" && (operation.replay !== "safe" || !this.options.isReplaySafe(operation.call, operation.input))) throw new UnknownEffectError(`Outcome unknown for ${operation.call.name}; reconcile ${id}`);
    await this.#append(operation, { state: "dispatched" });
    this.options.fault?.("after-journal-dispatch");
    this.options.assertLive();
    this.#mirror({ ...operation, state: "dispatched" });
  }

  async settle(id: string, outcome: JournalOutcome): Promise<void> {
    const operation = await this.lookup(id);
    if (outcome.result.toolUseId !== operation.call.id || outcome.result.type !== "tool-result" || typeof outcome.result.content !== "string"
      || typeof outcome.result.isError !== "boolean" || !Array.isArray(outcome.attachments)) throw new Error("Durable result identity or payload mismatch");
    encodeJson(outcome, 1024 * 1024);
    const effectOutcome = !outcome.result.isError ? "confirmed" : operation.replay === "safe" ? "not_applied" : "unknown";
    await this.#append(operation, { state: "settled", outcome, effectOutcome });
    this.options.fault?.("after-journal-result");
    this.#mirror({ ...operation, state: "settled", outcome, effectOutcome });
    if (effectOutcome === "unknown") throw new UnknownEffectError(`Tool may have partially run; reconcile ${id} before continuing`);
  }

  async lookup(id: string): Promise<Operation> {
    const record = this.options.store.record<Operation>("operation", id);
    if (!record || record.taskId !== this.options.taskId) throw new Error("Unknown durable operation");
    const entries = await this.#entries(record.value);
    const last = entries.at(-1);
    const order = { intended: 0, dispatched: 1, settled: 2 };
    if (last && order[last.state] < order[record.value.state]) throw new Error("Durable journal evidence regressed; stop and inspect storage");
    const operation: Operation = last ? { ...record.value, state: last.state,
      ...(last.outcome ? { outcome: last.outcome, effectOutcome: last.effectOutcome } : {}) } : record.value;
    if (!last && operation.state !== "intended") throw new Error("Durable journal evidence is missing");
    if (digestJson(operation) !== digestJson(record.value)) this.#mirror(operation);
    return operation;
  }

  async unresolved(): Promise<Operation[]> {
    const result: Operation[] = [];
    for (const record of this.options.store.operationHeaders(this.options.runId, this.options.taskId)) {
      if (record.state === "settled" && record.effectOutcome !== "unknown") continue;
      const operation = await this.lookup(record.id);
      if ((operation.state === "dispatched" && operation.replay !== "safe") || operation.effectOutcome === "unknown") result.push(operation);
    }
    return result;
  }

  async recover(messages: ConversationMessage[], execute: (call: ToolUseBlock, scope: string) => Promise<JournalOutcome>,
    append: (message: ConversationMessage[]) => Promise<void>): Promise<ConversationMessage[]> {
    const tail = messages.at(-1);
    if (tail?.role !== "assistant") { assertBalancedToolHistory(messages); return messages; }
    const calls = tail.content.filter((block): block is ToolUseBlock => block.type === "tool-use");
    if (!calls.length) { assertBalancedToolHistory(messages); return messages; }
    assertBalancedToolHistory(messages.slice(0, -1));
    if (new Set(calls.map((call) => call.id)).size !== calls.length || calls.some((call) => !call.id)) throw new Error("Duplicate pending durable call IDs");
    const scope = this.scope(messages);
    const outcomes: JournalOutcome[] = [];
    // Check every pending effect before executing even an earlier replay-safe call.
    for (const call of calls) {
      const id = digestJson({ taskId: this.options.taskId, scope, callId: call.id });
      if (!this.options.store.record("operation", id)) continue;
      const operation = await this.lookup(id);
      if (digestJson(operation.call) !== digestJson(call)) throw new Error("Recovered durable call conflict");
      if ((operation.state === "dispatched" && (operation.replay !== "safe" || !this.options.isReplaySafe(operation.call, operation.input))) || operation.effectOutcome === "unknown") {
        throw new UnknownEffectError(`Outcome unknown for ${call.name}; reconcile ${id}`);
      }
    }
    for (const call of calls) {
      const id = digestJson({ taskId: this.options.taskId, scope, callId: call.id });
      const operation = this.options.store.record("operation", id) ? await this.lookup(id) : undefined;
      outcomes.push(operation?.state === "settled" && operation.outcome ? operation.outcome : await execute(call, scope));
    }
    const message: ConversationMessage = { role: "user", content: outcomes.flatMap((outcome) => [outcome.result, ...outcome.attachments]) };
    const restored = [...messages, message]; assertBalancedToolHistory(restored);
    await append([message]);
    return restored;
  }

  /** Explicit operator evidence. It never redispatches the original action. */
  async reconcile(id: string, outcome: JournalOutcome): Promise<void> {
    const operation = await this.lookup(id);
    if (outcome.result.toolUseId !== operation.call.id || outcome.result.isError !== false || outcome.result.type !== "tool-result"
      || typeof outcome.result.content !== "string" || !Array.isArray(outcome.attachments)) throw new Error("Reconciliation requires a confirmed result for the original call");
    encodeJson(outcome, 1024 * 1024);
    if (operation.state === "settled" && operation.effectOutcome === "confirmed" && digestJson(operation.outcome) === digestJson(outcome)) return;
    if (operation.state !== "dispatched" && operation.effectOutcome !== "unknown") throw new Error("Only an unknown dispatched effect can be reconciled");
    await this.#append(operation, { state: "settled", outcome, effectOutcome: "confirmed" });
    this.#mirror({ ...operation, state: "settled", outcome, effectOutcome: "confirmed" });
  }

  async #entries(operation: Operation): Promise<Entry[]> {
    let raw: string;
    try { raw = await readFile(this.#path(operation.operationId), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw new Error("Operation journal exceeds limit");
    const lines = raw.split("\n"); const entries: Entry[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]!.trim()) continue;
      let entry: Entry;
      try { entry = JSON.parse(lines[i]!); }
      catch (error) { if (i === lines.length - 1) break; throw new Error("Corrupt durable journal", { cause: error }); }
      if (entry.version !== 2 || entry.operationId !== operation.operationId || entry.digest !== operation.digest
        || !["intended", "dispatched", "settled"].includes(entry.state)) throw new Error("Invalid durable journal identity");
      const previous = entries.at(-1);
      if ((!previous && entry.state !== "intended") || (previous && entry.state === "intended")
        || (entry.state === "dispatched" && previous?.state === "settled")
        || (entry.state === "dispatched" && previous?.state === "dispatched" && operation.replay !== "safe")) throw new Error("Invalid durable journal transition");
      if (entry.state === "settled" && (!entry.outcome || entry.outcome.result?.toolUseId !== operation.call.id
        || typeof entry.outcome.result.content !== "string" || typeof entry.outcome.result.isError !== "boolean"
        || !Array.isArray(entry.outcome.attachments) || !["confirmed", "not_applied", "unknown"].includes(entry.effectOutcome!))) throw new Error("Invalid durable journal result");
      entries.push(entry);
    }
    return entries;
  }
  #path(id: string): string { return join(this.options.root, this.options.taskId, "operations", `${id}.jsonl`); }
  async #append(operation: Operation, value: Pick<Entry, "state"> & Partial<Entry>): Promise<void> {
    const entry = { version: 2, operationId: operation.operationId, digest: operation.digest, ...value };
    await appendJsonl(this.#path(operation.operationId), [entry], { sync: true, validate: async (file) => {
      if ((await file.stat()).size + Buffer.byteLength(JSON.stringify(entry)) + 1 > 8 * 1024 * 1024) throw new Error("Operation journal exceeds limit");
    } });
  }
  #mirror(operation: Operation): void {
    this.options.store.command(randomUUID(), { kind: "operation.mirror", operationId: operation.operationId, state: operation.state }, Date.now(), (tx) => {
      const current = tx.record<Operation>("operation", operation.operationId)!;
      tx.saveRecord({ ...current, value: operation }, current.revision);
      tx.event(this.options.runId, `operation.${operation.state}`, { operationId: operation.operationId, effectOutcome: operation.effectOutcome }, this.options.taskId);
      return true;
    });
  }
}
