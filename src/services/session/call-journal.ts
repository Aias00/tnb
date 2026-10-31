import { randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { JournalOutcome, ToolCallJournal } from "../../core/call-journal";
import { toolCallScope } from "../../core/call-journal";
import type { ConversationMessage, ToolUseBlock } from "../../core/message";
import { withFileLock } from "../../utils/lockfile";

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
    return this.append({ version: 1, invocationId, state: "settled", outcome });
  }

  /** Reuse a committed outcome; preserve and block calls whose effects cannot be established. */
  async recover(messages: ConversationMessage[], append: (message: ConversationMessage) => Promise<void>): Promise<ConversationMessage[]> {
    const tail = messages.at(-1);
    if (tail?.role !== "assistant") return messages;
    const calls = tail.content.filter((block): block is ToolUseBlock => block.type === "tool-use");
    if (!calls.length) return messages;
    const records = await this.read();
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
    let text: string;
    try { text = await readFile(this.filePath, "utf8"); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    const lines = text.split("\n");
    const records: CallRecord[] = [];
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      if (!line.trim()) continue;
      let value: CallRecord;
      try { value = JSON.parse(line); }
      catch (error) { if (index === lines.length - 1) break; throw error; }
      if (value.version !== 1 || typeof value.invocationId !== "string" || !["intended", "dispatched", "settled"].includes(value.state)) {
        throw new Error("Invalid tool call journal record");
      }
      records.push(value);
    }
    return records;
  }

  private async append(record: CallRecord): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    await withFileLock(this.filePath, async () => {
      const file = await open(this.filePath, "a", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(record)}\n`);
        await file.sync();
      } finally { await file.close(); }
    });
  }
}
