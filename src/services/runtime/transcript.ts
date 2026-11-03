import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ConversationMessage } from "../../core/message";
import type { StopReason } from "../../providers/types";
import { appendJsonl } from "../../utils/jsonl-append";
import { withFileLock } from "../../utils/lockfile";
import { digestJson } from "./json";
import { RuntimeStore } from "./store";

type Delivery = { index: number; digest: string; state: "pending" | "written"; messages: ConversationMessage[]; compact: boolean; decision?: StopReason };

/** Stable delivery identity bridges the append and its SQLite receipt, including compaction boundaries. */
export class DurableTranscript {
  readonly path: string;
  constructor(readonly options: { store: RuntimeStore; root: string; runId: string; taskId: string; fault?(point: string): void }) {
    this.path = join(options.root, options.taskId, "transcript.jsonl");
  }
  async load(): Promise<ConversationMessage[]> {
    const records = this.options.store.records<Delivery>("message", this.options.runId, this.options.taskId)
      .sort((a, b) => a.value.index - b.value.index);
    let messages: ConversationMessage[] = [];
    for (let index = 0; index < records.length; index++) {
      const record = records[index]!;
      if (record.value.index !== index) throw new Error("Durable transcript delivery gap");
      await this.#deliver(record.id, record.value);
      if (record.value.compact) messages = structuredClone(record.value.messages);
      else messages.push(...structuredClone(record.value.messages));
    }
    return messages;
  }
  completedReport(): string | undefined {
    const record = this.options.store.records<Delivery>("message", this.options.runId, this.options.taskId)
      .sort((a, b) => a.value.index - b.value.index).at(-1)?.value;
    if (!record || !["end-turn", "stop-sequence"].includes(record.decision!)) return undefined;
    return record.messages.at(-1)?.content.filter((block) => block.type === "text").map((block) => (block as { text: string }).text).join("\n");
  }
  async append(messages: ConversationMessage[], compact = false, decision?: StopReason, deliveryKey?: string): Promise<void> {
    const records = this.options.store.records<Delivery>("message", this.options.runId, this.options.taskId);
    if (records.some((record) => record.value.state === "pending")) throw new Error("Load the pending transcript delivery before appending");
    const index = records.length;
    const id = `${this.options.taskId}:${deliveryKey ?? index}`;
    const value: Delivery = { index, state: "pending", digest: digestJson({ messages, compact, decision }), messages: structuredClone(messages), compact, ...(decision ? { decision } : {}) };
    const existing = this.options.store.record<Delivery>("message", id);
    if (existing) {
      if (existing.value.digest !== value.digest) throw new Error("Conflicting transcript delivery key");
      await this.#deliver(id, existing.value); return;
    }
    this.options.store.command(randomUUID(), { kind: "message.reserve", id, digest: value.digest }, Date.now(), (tx) => {
      tx.saveRecord({ kind: "message", id, runId: this.options.runId, taskId: this.options.taskId, value }, 0);
      return true;
    });
    await this.#deliver(id, value);
  }
  async #deliver(id: string, value: Delivery): Promise<void> {
    await withFileLock(`${this.path}.delivery`, async () => {
      let raw = "";
      try {
        if ((await stat(this.path)).size > 64 * 1024 * 1024) throw new Error("Durable transcript storage limit reached");
        raw = await readFile(this.path, "utf8");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const lines = raw.split("\n"); let found = false;
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i]!.trim()) continue;
        let entry: { id: string; digest: string; value: Delivery };
        try { entry = JSON.parse(lines[i]!); }
        catch (error) { if (i === lines.length - 1) break; throw new Error("Corrupt durable transcript", { cause: error }); }
        if (entry.id !== id) continue;
        if (found || entry.digest !== value.digest || digestJson({ messages: entry.value.messages, compact: entry.value.compact, decision: entry.value.decision }) !== value.digest) {
          throw new Error("Conflicting durable transcript delivery");
        }
        found = true;
      }
      if (!found) {
        if (value.state === "written") throw new Error("Written transcript evidence is missing");
        if (Buffer.byteLength(raw) + Buffer.byteLength(JSON.stringify({ id, digest: value.digest, value })) + 1 > 64 * 1024 * 1024) throw new Error("Durable transcript storage limit reached");
        await appendJsonl(this.path, [{ id, digest: value.digest, value }], { sync: true });
      }
      this.options.fault?.("after-transcript-append");
      if (value.state === "written") return;
      this.options.store.command(randomUUID(), { kind: "message.delivered", id }, Date.now(), (tx) => {
        const record = tx.record<Delivery>("message", id)!;
        tx.saveRecord({ ...record, value: { ...record.value, state: "written" } }, record.revision);
        tx.event(this.options.runId, value.compact ? "context.compacted" : "message.committed", { deliveryId: id, digest: value.digest }, this.options.taskId);
        return true;
      });
    });
  }
}
