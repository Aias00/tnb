import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeStore } from "../../src/services/runtime/store";
import { RuntimeCommands } from "../../src/services/runtime/commands";
import { DurableCallJournal } from "../../src/services/runtime/journal";
import { DurableTranscript } from "../../src/services/runtime/transcript";
import type { ConversationMessage } from "../../src/core/message";

const roots: string[] = []; const stores: RuntimeStore[] = [];
afterEach(async () => { stores.splice(0).forEach((store) => store.close()); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(safe = false) {
  const root = await mkdtemp(join(tmpdir(), "tnb-runtime-journal-")); roots.push(root);
  const store = new RuntimeStore(join(root, "state.sqlite")); stores.push(store);
  const { run, tasks } = new RuntimeCommands(store).createRun({ commandId: "create", objective: "fixture" });
  const options = { store, root, runId: run.runId, taskId: tasks[0]!.taskId, assertLive() {}, isReplaySafe: () => safe };
  return { root, store, options };
}
const call = { type: "tool-use" as const, id: "one", name: "write", input: { value: "changed" } };
const history: ConversationMessage[] = [{ role: "user", content: [{ type: "text", text: "work" }] }, { role: "assistant", content: [call] }];
const outcome = { result: { type: "tool-result" as const, toolUseId: call.id, content: "done", isError: false }, attachments: [] };

test("journal result fsynced before DB settlement repairs the original call without executing again", async () => {
  const f = await fixture(); let crash = false;
  const journal = new DurableCallJournal({ ...f.options, fault(point) { if (crash && point === "after-journal-result") throw new Error("simulated crash"); } });
  const id = await journal.intend(call, call.input, journal.scope(history)); await journal.dispatch(id); crash = true;
  await expect(journal.settle(id, outcome)).rejects.toThrow("simulated crash");
  let executions = 0; const appended: ConversationMessage[] = [];
  const restored = await new DurableCallJournal(f.options).recover(history, async () => { executions++; return outcome; }, async (items) => { appended.push(...items); });
  expect(executions).toBe(0); expect(restored).toHaveLength(3); expect(appended[0]!.content[0]).toEqual(outcome.result);
});

test("dispatched unsafe operations block recovery, but explicit confirmed reconciliation releases the original result", async () => {
  const f = await fixture(); const journal = new DurableCallJournal(f.options);
  const id = await journal.intend(call, call.input, journal.scope(history)); await journal.dispatch(id);
  await expect(journal.recover(history, async () => { throw new Error("must not execute"); }, async () => {})).rejects.toThrow("Outcome unknown");
  await journal.reconcile(id, outcome);
  expect((await journal.recover(history, async () => { throw new Error("must not execute"); }, async () => {}))).toHaveLength(3);
});

test("safe recovery reuses preallocated operation identity and refuses changed arguments", async () => {
  const f = await fixture(true); const journal = new DurableCallJournal(f.options);
  const scope = journal.scope(history); const id = await journal.intend(call, call.input, scope); await journal.dispatch(id);
  expect(await journal.intend(call, call.input, scope)).toBe(id);
  await journal.dispatch(id); await journal.settle(id, outcome);
  await expect(journal.intend(call, { value: "other" }, scope)).rejects.toThrow("Conflicting durable");
});

test("transcript append before receipt commit is recovered without duplicate messages or terminal decisions", async () => {
  const f = await fixture(); let crash = true;
  const transcript = new DurableTranscript({ ...f.options, fault() { if (crash) throw new Error("simulated crash"); } });
  await expect(transcript.append([{ role: "assistant", content: [{ type: "text", text: "deliverable" }] }], false, "end-turn")).rejects.toThrow("simulated crash");
  crash = false;
  const recovered = new DurableTranscript(f.options);
  expect(await recovered.load()).toHaveLength(1);
  expect(recovered.completedReport()).toBe("deliverable");
  expect((await readFile(recovered.path, "utf8")).trim().split("\n")).toHaveLength(1);
  expect(await recovered.load()).toHaveLength(1);
});

test("replay requires both the saved policy and the current tool to be safe", async () => {
  const f = await fixture(true); const journal = new DurableCallJournal(f.options);
  const id = await journal.intend(call, call.input, journal.scope(history)); await journal.dispatch(id);
  const changed = new DurableCallJournal({ ...f.options, isReplaySafe: () => false });
  await expect(changed.dispatch(id)).rejects.toThrow("Outcome unknown");
  await expect(changed.recover(history, async () => { throw new Error("must not execute"); }, async () => {})).rejects.toThrow("Outcome unknown");
});
