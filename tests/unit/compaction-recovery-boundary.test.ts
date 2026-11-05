import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactConversationPipeline, collapseOldRounds, pruneToolResults } from "../../src/services/compact/pipeline";
import { estimateConversationTokens } from "../../src/services/compact/compact";
import { SessionMemoryStore } from "../../src/services/compact/session-memory";
import { CallJournal } from "../../src/services/session/call-journal";
import { toolCallScope } from "../../src/core/call-journal";
import type { ConversationMessage, ToolUseBlock } from "../../src/core/message";
import { withFileLock } from "../../src/utils/lockfile";
import { runAgentLoop } from "../../src/core/agent-loop";
import { defineTool } from "../../src/core/tool";
import { SessionStore } from "../../src/services/session/storage";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function directory() { const root = await mkdtemp(join(tmpdir(), "tnb-compact-boundary-")); roots.push(root); return root; }
function round(name: string, chars: number): ConversationMessage[] {
  return [{ role: "assistant", content: [{ type: "tool-use", id: "reused", name, input: {} }] },
    { role: "user", content: [{ type: "tool-result", toolUseId: "reused", content: "x".repeat(chars), isError: false }] }];
}
const messages = (...rounds: ConversationMessage[][]): ConversationMessage[] => [{ role: "user", content: [{ type: "text", text: "task" }] }, ...rounds.flat()];

test("recent-result retention applies to occurrences when provider call IDs are reused", () => {
  const result = pruneToolResults(messages(round("bash", 6000), round("bash", 6000)), { keepRecent: 1, minimumChars: 2000 });
  expect(result.pruned).toBe(1);
  expect(result.messages[2]?.content[0]).toMatchObject({ content: expect.stringContaining("pruned") });
  expect(result.messages[4]?.content[0]).toMatchObject({ content: "x".repeat(6000) });
});

test("a reused ID uses the tool name from its own round for pruning thresholds", () => {
  const result = pruneToolResults(messages(round("bash", 1500), round("read", 1500)), { keepRecent: 0, minimumChars: 4000 });
  expect(result.pruned).toBe(1);
  expect(result.messages[2]?.content[0]).toMatchObject({ content: expect.stringContaining("bash") });
  expect(result.messages[4]?.content[0]).toMatchObject({ content: "x".repeat(1500) });
});

test("pruning is idempotent and never replaces short output with a larger marker", () => {
  const source = messages(round("bash", 6000));
  const first = pruneToolResults(source, { keepRecent: 0, minimumChars: 0 });
  const second = pruneToolResults(first.messages, { keepRecent: 0, minimumChars: 0 });
  expect(second.pruned).toBe(0); expect(second.messages).toEqual(first.messages);
  const short = messages(round("bash", 2));
  expect(pruneToolResults(short, { keepRecent: 0, minimumChars: 0 }).messages).toEqual(short);
});

test("context-collapse refuses a replacement that increases context size", () => {
  const source: ConversationMessage[] = Array.from({ length: 12 }, (_, index) => index % 2
    ? { role: "assistant", content: [{ type: "text", text: "b" }] } : { role: "user", content: [{ type: "text", text: "a" }] });
  const result = collapseOldRounds(source, 1);
  expect(result.collapsed).toBe(false);
  expect(estimateConversationTokens(result.messages)).toBe(estimateConversationTokens(source));
});

test("context-collapse cannot replace an entire ongoing task with only a deletion marker", async () => {
  const source = messages(...Array.from({ length: 6 }, () => round("bash", 6000)));
  const collapsed = collapseOldRounds(source, 1);
  expect(collapsed.collapsed).toBe(false); expect(collapsed.messages).toEqual(source);
  await expect(compactConversationPipeline({ messages: source, thresholdTokens: 1,
    summarize: async () => { throw new Error("summary unavailable"); } })).rejects.toThrow("summary unavailable");
});

test("even the microcompaction fast path rejects orphaned tool results", async () => {
  await expect(compactConversationPipeline({ messages: [{ role: "user", content: [{ type: "tool-result", toolUseId: "orphan", content: "bad", isError: false }] }],
    thresholdTokens: 100000, summarize: async () => "must not run" })).rejects.toThrow("Orphan");
});

const call: ToolUseBlock = { type: "tool-use", id: "reused", name: "write", input: {} };
const history: ConversationMessage[] = [{ role: "user", content: [{ type: "text", text: "current task" }] }, { role: "assistant", content: [call] }];
async function completed(journal: CallJournal, content: string, scope?: string) {
  const id = await journal.intend(call, {}, scope); await journal.dispatch(id);
  await journal.settle(id, { result: { type: "tool-result", toolUseId: call.id, content, isError: false }, attachments: [] });
}
test("an unscoped old result cannot establish the outcome of a newly reused call ID", async () => {
  const journal = new CallJournal(join(await directory(), "calls.jsonl"));
  await completed(journal, "old effect"); let writes = 0;
  await expect(journal.recover(history, async () => { writes++; })).rejects.toThrow("outcome unknown");
  expect(writes).toBe(0);
});

test("a newer unscoped record cannot replace an outcome matching the exact history scope", async () => {
  const journal = new CallJournal(join(await directory(), "calls.jsonl"));
  await completed(journal, "current effect", toolCallScope(history)); await completed(journal, "unrelated old effect");
  expect((await journal.recover(history, async () => {})).at(-1)?.content[0]).toMatchObject({ content: "current effect" });
});

test("duplicate IDs in a damaged pending round are rejected before recovery writes", async () => {
  const journal = new CallJournal(join(await directory(), "calls.jsonl"));
  const damaged: ConversationMessage[] = [history[0]!, { role: "assistant", content: [call, call] }];
  await completed(journal, "once", toolCallScope(damaged)); let writes = 0;
  await expect(journal.recover(damaged, async () => { writes++; })).rejects.toThrow("Duplicate"); expect(writes).toBe(0);
});

test("cancelled background Session Memory cannot commit after waiting on another writer", async () => {
  const file = join(await directory(), "memory.json"); const memory = new SessionMemoryStore(file); await memory.initialize();
  await memory.save("keep this", history, 1000, 1);
  let unlock!: () => void; let held!: () => void;
  const ready = new Promise<void>((resolve) => { held = resolve; }); const gate = new Promise<void>((resolve) => { unlock = resolve; });
  const holding = withFileLock(file, async () => { held(); await gate; }); await ready;
  const controller = new AbortController(); let summarized!: () => void; const summary = new Promise<void>((resolve) => { summarized = resolve; });
  memory.refreshInBackground(history, 70000, async () => { summarized(); return "must not commit"; }, 2, controller.signal);
  await summary; controller.abort(); unlock(); await holding;
  const saved = await withFileLock(file, async () => JSON.parse(await readFile(file, "utf8")) as { summary: string });
  expect(saved.summary).toBe("keep this");
});

test("a result lost after microcompaction recovers under the exact persisted history scope", async () => {
  const root = await directory(); const store = new SessionStore({ configDir: root, cwd: root, sessionId: "compact-recovery" });
  const source = messages(round("bash", 6000), round("read", 6000));
  await store.append(source);
  let effects = 0; let requests = 0;
  const tool = defineTool({ name: "write", description: "fixture", inputSchema: {}, validate: (input) => input,
    execute: async () => { effects++; return "effect persisted"; } });
  await expect(runAgentLoop({ model: "fixture", prompt: "continue", messages: source, tools: [tool], callJournal: store.calls,
    authorize: async () => ({ behavior: "allow" }),
    compactMessages: (history) => compactConversationPipeline({ messages: history, thresholdTokens: 1000000,
      keepRecentToolResults: 1, summarize: async () => "unused" }),
    onCompact: ({ messages, preTokens, postTokens }) => store.appendCompactBoundary({ messages, preTokens, postTokens, permissionMode: "default" }),
    onMessage: async (message) => {
      if (message.role === "user" && message.content.some((block) => block.type === "tool-result")) throw new Error("crash after effect");
      await store.append([message]);
    },
    transport: { async *stream() {
      requests++;
      yield { type: "tool-start", index: 0, id: "reused", name: "write" };
      yield { type: "tool-input", index: 0, json: "{}" };
      yield { type: "response-end", reason: "tool-use" };
    } },
  })).rejects.toThrow("crash after effect");
  const reopened = new SessionStore({ configDir: root, cwd: root, sessionId: "compact-recovery" });
  const restored = await reopened.calls.recover(await reopened.read(), (message) => reopened.append([message]));
  expect(effects).toBe(1); expect(requests).toBe(1);
  expect(restored.at(-1)?.content[0]).toMatchObject({ content: "effect persisted", isError: false });
  expect(await reopened.read()).toEqual(restored);
});
