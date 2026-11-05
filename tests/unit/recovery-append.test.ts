import { afterEach, expect, test } from "bun:test";
import { appendFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/services/session/storage";
import { SubagentTranscript } from "../../src/services/session/subagent-transcript";
import { CallJournal } from "../../src/services/session/call-journal";
import { TaskManager } from "../../src/services/tasks/manager";
import { toolCallScope } from "../../src/core/call-journal";
import type { ConversationMessage, ToolUseBlock } from "../../src/core/message";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function directory() { const root = await mkdtemp(join(tmpdir(), "tnb-recovery-append-")); roots.push(root); return root; }
const call: ToolUseBlock = { type: "tool-use", id: "call", name: "write", input: { path: "code.txt" } };
const history: ConversationMessage[] = [{ role: "user", content: [{ type: "text", text: "act" }] }, { role: "assistant", content: [call] }];
const outcome = { result: { type: "tool-result" as const, toolUseId: call.id, content: "saved", isError: false }, attachments: [] };

test("main transcript appends after a crash tail without losing the new user message", async () => {
  const root = await directory(); const store = new SessionStore({ configDir: root, cwd: root, sessionId: "fixture" });
  const first: ConversationMessage = { role: "user", content: [{ type: "text", text: "before" }] };
  const next: ConversationMessage = { role: "assistant", content: [{ type: "text", text: "after" }] };
  await store.append([first]); await appendFile(store.filePath, '{"version":1,"message":"截断');
  await store.append([next]);
  expect(await store.read()).toEqual([first, next]);
});

test("subagent recovery can append a saved result after a torn transcript tail", async () => {
  const root = await directory(); const transcript = new SubagentTranscript({ projectDir: root, sessionId: "fixture", agentId: "child" });
  for (const message of history) await transcript.append(message);
  const id = await transcript.calls.intend(call, call.input, toolCallScope(history));
  await transcript.calls.dispatch(id); await transcript.calls.settle(id, outcome);
  const torn = Buffer.concat([Buffer.from('{"version":1,"message":"'), Buffer.from([0xe6, 0x88])]);
  await appendFile(transcript.filePath, torn);
  const recovered = await transcript.read();
  expect(recovered.at(-1)?.content[0]).toEqual(outcome.result);
  expect(await new SubagentTranscript({ projectDir: root, sessionId: "fixture", agentId: "child" }).read()).toEqual(recovered);
  const backups = (await readdir(join(root, "fixture", "subagents"))).filter((name) => name.includes(".torn-"));
  expect(backups).toHaveLength(1);
  expect(await readFile(join(root, "fixture", "subagents", backups[0]!))).toEqual(torn);
});

test("an unterminated valid record is preserved and separated from the next append", async () => {
  const root = await directory(); const transcript = new SubagentTranscript({ projectDir: root, sessionId: "fixture", agentId: "child" });
  const original: ConversationMessage = { role: "user", content: [{ type: "text", text: "原始文本🌊".repeat(2000) }] };
  await transcript.append(original);
  const bytes = await readFile(transcript.filePath); await writeFile(transcript.filePath, bytes.subarray(0, -1));
  await transcript.append({ role: "assistant", content: [{ type: "text", text: "after" }] });
  const restored = await transcript.read();
  expect(restored).toHaveLength(2);
  expect(restored[0]).toEqual(original);
});

test("a torn optional final outcome cannot corrupt the next journal invocation", async () => {
  const root = await directory(); const journal = new CallJournal(join(root, "calls.jsonl"));
  const id = await journal.intend(call, call.input); await journal.dispatch(id); await journal.settle(id, outcome);
  await appendFile(journal.filePath, '{"version":1,"state":"settled"');
  const second = { ...call, id: "call-2" };
  const pending: ConversationMessage[] = [...history.slice(0, -1), { role: "assistant", content: [second] }];
  const next = await journal.intend(second, second.input, toolCallScope(pending));
  await journal.dispatch(next); await journal.settle(next, { ...outcome, result: { ...outcome.result, toolUseId: second.id } });
  const restored = await new CallJournal(journal.filePath).recover(pending, async () => {});
  expect(restored.at(-1)?.content[0]).toMatchObject({ toolUseId: second.id, content: "saved" });
});

test("a result for a different tool call cannot be accepted as this invocation's outcome", async () => {
  const root = await directory(); const journal = new CallJournal(join(root, "calls.jsonl"));
  const id = await journal.intend(call, call.input); await journal.dispatch(id);
  await appendFile(journal.filePath, JSON.stringify({ version: 1, state: "settled", invocationId: id,
    outcome: { ...outcome, result: { ...outcome.result, toolUseId: "wrong-call" } } }) + "\n");
  await expect(journal.recover(history, async () => {})).rejects.toThrow();
});

test("journal corruption blocks new execution barriers even when the transcript is already balanced", async () => {
  const root = await directory(); const journal = new CallJournal(join(root, "calls.jsonl"));
  await writeFile(journal.filePath, "{broken-record}\n");
  await expect(journal.intend(call, call.input)).rejects.toThrow();
});

test("shutdown cannot be undone by a concurrent session switch", async () => {
  const root = await directory(); const manager = new TaskManager(join(root, "old.json")); await manager.initialize();
  let release!: () => void; const pause = new Promise<void>((resolve) => { release = resolve; });
  await manager.startAgent({ subject: "fixture", description: "fixture", profile: "general-purpose", run: async () => { await pause; return "done"; } });
  const switching = manager.switchStorage(join(root, "next.json")); const closing = manager.shutdown(); release();
  try {
    const results = await Promise.allSettled([switching, closing]);
    expect(results[1]?.status).toBe("fulfilled");
    await expect(manager.startAgent({ subject: "late", description: "fixture", profile: "general-purpose", run: async () => "must not run" })).rejects.toThrow();
    await expect(manager.switchStorage(join(root, "third.json"))).rejects.toThrow();
    await expect(manager.createWorkItem({ subject: "late item", description: "must not write" })).rejects.toThrow();
  } finally { release(); await manager.shutdown(); }
});

test("concurrent journal instances share valid append boundaries after a torn tail", async () => {
  const root = await directory(); const file = join(root, "calls.jsonl");
  await writeFile(file, '{"version":1,"partial":"');
  const journals = [new CallJournal(file), new CallJournal(file)];
  const pending: ConversationMessage[] = [{ role: "assistant", content: journals.map((_, index) => ({ ...call, id: `call-${index}` })) }];
  await Promise.all(journals.map(async (journal, index) => {
    const invocation = { ...call, id: `call-${index}` };
    const id = await journal.intend(invocation, invocation.input, toolCallScope(pending));
    await journal.dispatch(id);
    await journal.settle(id, { ...outcome, result: { ...outcome.result, toolUseId: invocation.id } });
  }));
  const restored = await new CallJournal(file).recover(pending, async () => {});
  expect(restored.at(-1)?.content).toHaveLength(2);
  expect((await readdir(root)).filter((name) => name.includes(".torn-"))).toHaveLength(1);
});

test("journal lifecycle validation refuses dispatch after settlement and incomplete outcome schemas", async () => {
  const root = await directory(); const journal = new CallJournal(join(root, "calls.jsonl"));
  const id = await journal.intend(call, call.input); await journal.dispatch(id); await journal.settle(id, outcome);
  await expect(journal.dispatch(id)).rejects.toThrow("lifecycle");
  await appendFile(journal.filePath, JSON.stringify({ version: 1, invocationId: id, state: "settled", outcome: { result: outcome.result } }));
  await expect(new CallJournal(journal.filePath).recover(history, async () => {})).rejects.toThrow("journal");
});

test("a failed destination load restores the old task storage before accepting more work", async () => {
  const root = await directory(); const old = join(root, "old.json"); const bad = join(root, "bad.json");
  const manager = new TaskManager(old); await manager.initialize();
  await manager.createWorkItem({ subject: "before", description: "fixture" });
  await writeFile(bad, "{invalid}");
  try {
    await expect(manager.switchStorage(bad)).rejects.toThrow();
    await manager.createWorkItem({ subject: "after", description: "fixture" });
    const restored = new TaskManager(old); await restored.initialize();
    expect(restored.list().map((task) => task.subject)).toEqual(["before", "after"]);
    expect(await readFile(bad, "utf8")).toBe("{invalid}");
  } finally { await manager.shutdown(); }
});

for (const stage of ["creation", "completion"] as const) {
  test(`an old work-item ${stage} Hook cannot write into a newly selected session`, async () => {
    const root = await directory(); const manager = new TaskManager(join(root, "old.json")); await manager.initialize();
    const existing = await manager.createWorkItem({ subject: "old", description: "fixture" });
    let entered!: () => void; let resume!: () => void;
    const active = new Promise<void>((resolve) => { entered = resolve; }); const gate = new Promise<void>((resolve) => { resume = resolve; });
    const hook = async () => { entered(); await gate; };
    manager.setLifecycleHooks(stage === "creation" ? { beforeCreate: hook } : { beforeComplete: hook });
    const operation = (stage === "creation" ? manager.createWorkItem({ subject: "late", description: "fixture" })
      : manager.update(existing.id, { status: "completed" })).then(() => "written", () => "cancelled");
    try {
      await active; await manager.switchStorage(join(root, "next.json")); resume();
      expect(await operation).toBe("cancelled"); expect(manager.list()).toEqual([]);
    } finally { resume(); await operation; await manager.shutdown(); }
  });
}
