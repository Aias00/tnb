import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CallJournal } from "../../src/services/session/call-journal";
import { SessionStore } from "../../src/services/session/storage";
import { runAgentLoop } from "../../src/core/agent-loop";
import { defineTool } from "../../src/core/tool";
import type { ConversationMessage, ToolUseBlock } from "../../src/core/message";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function directory() { const root = await mkdtemp(join(tmpdir(), "tnb-call-journal-")); roots.push(root); return root; }
const call: ToolUseBlock = { type: "tool-use", id: "call-1", name: "write", input: { path: "code.txt" } };
const history: ConversationMessage[] = [{ role: "user", content: [{ type: "text", text: "act" }] }, { role: "assistant", content: [call] }];

test("a dispatched call with no outcome remains unknown and is never retried", async () => {
  const path = join(await directory(), "calls.jsonl");
  const journal = new CallJournal(path);
  const id = await journal.intend(call, call.input);
  await journal.dispatch(id);
  let appended = false;
  await expect(new CallJournal(path).recover(history, async () => { appended = true; })).rejects.toThrow("outcome unknown");
  expect(appended).toBe(false);
  expect(await readFile(path, "utf8")).toContain('"dispatched"');
});

test("a saved result survives a transcript write failure without repeating the effect", async () => {
  const root = await directory();
  const store = new SessionStore({ configDir: root, cwd: root, sessionId: "crash" });
  let effects = 0;
  const tool = defineTool({ name: "write", description: "fixture", inputSchema: {}, validate: (input) => input,
    execute: async () => { effects++; return "written exactly once"; } });
  await expect(runAgentLoop({ model: "fixture", prompt: "act", tools: [tool], callJournal: store.calls,
    authorize: async () => ({ behavior: "allow" }),
    onMessage: async (message) => {
      if (message.role === "user" && message.content.some((block) => block.type === "tool-result")) throw new Error("transcript disk failure");
      await store.append([message]);
    },
    transport: { async *stream() {
      yield { type: "tool-start", index: 0, id: "call-1", name: "write" };
      yield { type: "tool-input", index: 0, json: "{}" };
      yield { type: "response-end", reason: "tool-use" };
    } },
  })).rejects.toThrow("transcript disk failure");
  const reopened = new SessionStore({ configDir: root, cwd: root, sessionId: "crash" });
  const restored = await reopened.calls.recover(await reopened.read(), (message) => reopened.append([message]));
  expect(effects).toBe(1);
  expect(restored.at(-1)?.content[0]).toMatchObject({ type: "tool-result", content: "written exactly once", isError: false });
  expect(await reopened.read()).toEqual(restored);
});

test("failure to persist a dispatch barrier prevents tool execution", async () => {
  let effects = 0;
  const tool = defineTool({ name: "write", description: "fixture", inputSchema: {}, validate: (x) => x, execute: async () => { effects++; return "bad"; } });
  await expect(runAgentLoop({ model: "fixture", prompt: "act", tools: [tool], authorize: async () => ({ behavior: "allow" }),
    callJournal: { intend: async () => "id", dispatch: async () => { throw new Error("disk full"); }, settle: async () => {} },
    transport: { async *stream() { yield { type: "tool-start", index: 0, id: "x", name: "write" }; yield { type: "tool-input", index: 0, json: "{}" }; yield { type: "response-end", reason: "tool-use" }; } },
  })).rejects.toThrow("journal failed");
  expect(effects).toBe(0);
});

test("only one whole-session runner is admitted while append locks stay usable", async () => {
  const root = await directory();
  const first = new SessionStore({ configDir: root, cwd: root, sessionId: "single" });
  const second = new SessionStore({ configDir: root, cwd: root, sessionId: "single" });
  const release = await first.acquireRun();
  try {
    await expect(second.acquireRun()).rejects.toThrow("active runner");
    await first.append([{ role: "user", content: [{ type: "text", text: "accepted" }] }]);
  } finally { await release(); }
  await (await second.acquireRun())();
});

test("journal scope survives coalesced user inputs and prompt metadata", async () => {
  const { toolCallScope } = await import("../../src/core/call-journal");
  const root = await directory();
  const journal = new CallJournal(join(root, "scope.jsonl"));
  const separate: ConversationMessage[] = [
    { role: "user", content: [{ type: "text", text: "first" }], promptInput: { version: 1, display: "first", mode: "prompt", pastedContents: [] } },
    { role: "user", content: [{ type: "text", text: "second" }] },
    { role: "assistant", content: [call] },
  ];
  const coalesced: ConversationMessage[] = [
    { role: "user", content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] },
    { role: "assistant", content: [call] },
  ];
  const id = await journal.intend(call, call.input, toolCallScope(separate));
  await journal.dispatch(id);
  await journal.settle(id, { result: { type: "tool-result", toolUseId: call.id, content: "once", isError: false }, attachments: [] });
  expect((await journal.recover(coalesced, async () => {})).at(-1)?.content[0]).toMatchObject({ type: "tool-result", content: "once" });
});
