import { randomUUID } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import type { JournalOutcome, ToolCallJournal } from "../../core/call-journal";
import { toolCallScope } from "../../core/call-journal";
import type { ConversationMessage, ToolUseBlock } from "../../core/message";
import { withFileLock } from "../../utils/lockfile";
import { appendJsonl, readExactly } from "../../utils/jsonl-append";

type CallRecord = {
  version: 1;
  invocationId: string;
  state: "intended" | "dispatched" | "settled";
  call?: ToolUseBlock;
  normalizedInput?: unknown;
  scope?: string;
  outcome?: JournalOutcome;
};

/** Local call ledger separate from the model-visible transcript. Defaults to conservative recovery. */
export class CallJournal implements ToolCallJournal {
  private states = new Map<string, InvocationState>();
  private offset = 0;
  private identity = "";

  constructor(readonly filePath: string) {}

  async intend(call: ToolUseBlock, input: unknown, scope?: string): Promise<string> {
    const invocationId = randomUUID();
    await this.append({ version: 1, invocationId, state: "intended", call: structuredClone(call), normalizedInput: structuredClone(input), scope });
    return invocationId;
  }

  dispatch(invocationId: string): Promise<void> {
    return this.append({ version: 1, invocationId, state: "dispatched" });
  }

  settle(invocationId: string, outcome: JournalOutcome): Promise<void> {
    return this.append({ version: 1, invocationId, state: "settled", outcome: structuredClone(outcome) });
  }

  /** Reuse a committed outcome; preserve and block calls whose effects cannot be established. */
  async recover(messages: ConversationMessage[], append: (message: ConversationMessage) => Promise<void>): Promise<ConversationMessage[]> {
    const records = await this.read();
    const tail = messages.at(-1);
    if (tail?.role !== "assistant") return messages;
    const calls = tail.content.filter((block): block is ToolUseBlock => block.type === "tool-use");
    if (!calls.length) return messages;
    const intents = new Map<string, CallRecord>();
    const states = new Map<string, CallRecord>();
    const scope = toolCallScope(messages);
    for (const record of records) {
      if (record.call && (record.scope === undefined || record.scope === scope)) intents.set(record.call.id, record);
      states.set(record.invocationId, record);
    }
    const content: Extract<ConversationMessage, { role: "user" }>["content"] = [];
    for (const call of calls) {
      const intent = intents.get(call.id);
      const state = intent ? states.get(intent.invocationId) : undefined;
      if (intent && (intent.call?.name !== call.name || JSON.stringify(intent.call.input) !== JSON.stringify(call.input))) {
        throw new Error(`Conflicting recovered tool invocation: ${call.id}`);
      }
      if (state?.state !== "settled" || !state.outcome) {
        throw new Error(`Tool outcome unknown for ${call.name} (${call.id}). It may have partially run; reconcile its effects before resuming. The original call has been preserved.`);
      }
      content.push(state.outcome.result, ...state.outcome.attachments);
    }
    const recovered: ConversationMessage = { role: "user", content: structuredClone(content) };
    await append(recovered);
    return [...messages, recovered];
  }

  private async read(): Promise<CallRecord[]> {
    return withFileLock(this.filePath, async () => {
      this.states.clear(); this.offset = 0; this.identity = "";
      let file: FileHandle;
      try { file = await open(this.filePath, "r"); }
      catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
        throw error;
      }
      const records: CallRecord[] = [];
      try { await this.refresh(file, records); return records; }
      finally { await file.close(); }
    });
  }

  /** Validate each appended byte range once under the cooperating-writer lock. */
  private async refresh(file: FileHandle, records?: CallRecord[]): Promise<void> {
    const info = await file.stat();
    const identity = `${info.dev}:${info.ino}`;
    if (identity !== this.identity || info.size < this.offset) {
      this.states.clear(); this.offset = 0; this.identity = identity;
    }
    const buffer = Buffer.alloc(info.size - this.offset);
    await readExactly(file, buffer, this.offset);
    let start = 0;
    while (start < buffer.length) {
      const newline = buffer.indexOf(0x0a, start);
      const end = newline === -1 ? buffer.length : newline;
      const line = buffer.toString("utf8", start, end).trim();
      const next = newline === -1 ? end : end + 1;
      if (line) {
        let value: unknown;
        try { value = JSON.parse(line); }
        catch (error) {
          if (newline === -1) break; // Only an unterminated syntax fragment is a crash tail.
          throw new Error("Invalid tool call journal record", { cause: error });
        }
        const record = validateRecord(value, this.states);
        const prior = this.states.get(record.invocationId);
        this.states.set(record.invocationId, { callId: prior?.callId ?? record.call!.id, state: record.state });
        records?.push(record);
      }
      this.offset += next - start;
      start = next;
    }
  }

  private async append(record: CallRecord): Promise<void> {
    await appendJsonl(this.filePath, [record], { sync: true, validate: async (file) => {
      await this.refresh(file);
      validateRecord(record, this.states);
    } });
  }
}

type InvocationState = { callId: string; state: CallRecord["state"] };
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function invalid(): never { throw new Error("Invalid tool call journal record or lifecycle transition"); }
function validateRecord(value: unknown, states: Map<string, InvocationState>): CallRecord {
  if (!object(value) || value.version !== 1 || typeof value.invocationId !== "string" || !value.invocationId) invalid();
  const prior = states.get(value.invocationId);
  if (value.state === "intended") {
    if (prior || !object(value.call) || value.call.type !== "tool-use" || typeof value.call.id !== "string" || !value.call.id ||
      typeof value.call.name !== "string" || !value.call.name || !("input" in value.call) ||
      (value.scope !== undefined && typeof value.scope !== "string") || value.outcome !== undefined) invalid();
  } else {
    if (!prior || value.call !== undefined || value.scope !== undefined || value.normalizedInput !== undefined) invalid();
    if (value.state === "dispatched") {
      if (prior.state !== "intended" || value.outcome !== undefined) invalid();
    } else if (value.state === "settled") {
      const outcome = value.outcome;
      if (!object(outcome) || !object(outcome.result) || outcome.result.type !== "tool-result" ||
        outcome.result.toolUseId !== prior.callId || typeof outcome.result.content !== "string" ||
        typeof outcome.result.isError !== "boolean" || !Array.isArray(outcome.attachments) || !outcome.attachments.every(validAttachment)) invalid();
    } else invalid();
  }
  return value as CallRecord;
}
function validAttachment(value: unknown): boolean {
  if (!object(value) || !object(value.source) || value.source.type !== "base64" || typeof value.source.data !== "string") return false;
  return (value.type === "image" && ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(String(value.source.mediaType))) ||
    (value.type === "document" && value.source.mediaType === "application/pdf" && typeof value.filename === "string");
}
