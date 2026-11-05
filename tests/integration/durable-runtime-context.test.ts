import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DurableRuntime, type RuntimeWorkerFactory } from "../../src/services/runtime/engine";
import { RuntimeStore } from "../../src/services/runtime/store";
import { RuntimeCommands } from "../../src/services/runtime/commands";
import { DurableTranscript } from "../../src/services/runtime/transcript";
import type { TaskProgress } from "../../src/services/runtime/progress";
import { defineTool } from "../../src/core/tool";
import { assertBalancedToolHistory } from "../../src/core/history";
import { estimateRequestTokens, requestInputLimit } from "../../src/services/compact/request-budget";

const roots: string[] = []; const runtimes: DurableRuntime[] = []; const stores: RuntimeStore[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function waitFor(check: () => boolean, runtime: DurableRuntime) {
  const until = Date.now() + 10000;
  while (!check()) {
    if (Date.now() > until) throw new Error(`Timed out: ${runtime.lastError}`);
    await runtime.tick(); await Bun.sleep(5);
  }
}

test("compacted long tasks retain pinned goals and atomic progress through question/owner/store restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "tnb-context-restart-")); roots.push(root);
  const workspace = join(root, "work"); await mkdir(workspace);
  const state = join(root, "control", "runtime"); const database = join(state, "state.sqlite");
  let store = new RuntimeStore(database); stores.push(store);
  let reads = 0; let turns = 0; let summaries = 0; let restarted = false; let recallStage = 0;
  const factory: RuntimeWorkerFactory = async () => ({
    model: "small", contextWindowTokens: 16000, maxOutputTokens: 512,
    route: { provider: "fixture", model: "small" }, authorize: async () => ({ behavior: "allow" }),
    tools: [defineTool({ name: "probe", description: "Read fixture evidence", access: "read", isReadOnly: () => true,
      inputSchema: { type: "object" }, validate: (input) => input, execute: async () => { reads++; return `evidence-${reads}:` + "persisted-fact ".repeat(3000); } })],
    transport: { async *stream(request) {
      expect(estimateRequestTokens(request)).toBeLessThanOrEqual(requestInputLimit(16000, request.maxOutputTokens ?? 512));
      expect(() => assertBalancedToolHistory(request.messages)).not.toThrow();
      if (!request.tools.length) {
        summaries++; yield { type: "text", index: 0, text: "Earlier evidence read. Follow pinned goal and recent receipts; inspect current files." };
        yield { type: "response-end", reason: "end-turn" }; return;
      }
      expect(request.systemPrompt).toContain("Preserve UNIQUE-GOAL and reconcile evidence");
      expect(request.systemPrompt).toContain('"write":false');
      if (restarted) {
        expect(request.systemPrompt).toContain("checkpoint");
        expect(request.systemPrompt).toContain("durable_wait");
        expect(request.systemPrompt).toContain('"latestUserDecision"');
        expect(request.systemPrompt).toContain("Choose SQLite");
        if (recallStage === 0) {
          expect(JSON.stringify(request.messages)).toContain("Choose SQLite");
          recallStage++;
          yield { type: "tool-start", index: 0, id: "recall-index", name: "durable_recall" };
          yield { type: "tool-input", index: 0, json: JSON.stringify({ query: "persisted-fact" }) };
          yield { type: "response-end", reason: "tool-use" }; return;
        }
        const result = request.messages.at(-1)?.content.find((block) => block.type === "tool-result");
        expect(result?.type).toBe("tool-result");
        if (result?.type !== "tool-result") throw new Error("Recall result missing");
        if (recallStage === 1) {
          const index = JSON.parse(result.content).evidence.find((entry: { compact: boolean; toolResults: boolean }) => !entry.compact && entry.toolResults).delivery;
          recallStage++;
          yield { type: "tool-start", index: 0, id: "recall-original", name: "durable_recall" };
          yield { type: "tool-input", index: 0, json: JSON.stringify({ delivery: index }) };
          yield { type: "response-end", reason: "tool-use" }; return;
        }
        expect(JSON.parse(result.content).fragment).toContain("persisted-fact");
        if (typeof JSON.parse(result.content).nextOffset !== "number") throw new Error(`Recall page was not partial: ${result.content}`);
        expect(JSON.parse(result.content).nextOffset).toBeGreaterThan(0);
        yield { type: "text", index: 0, text: "Finished the original goal using SQLite; evidence reconciled." };
        yield { type: "response-end", reason: "end-turn" }; return;
      }
      turns++;
      yield { type: "tool-start", index: 0, id: `call-${turns}`, name: turns <= 5 ? "probe" : "durable_wait" };
      yield { type: "tool-input", index: 0, json: turns <= 5 ? "{}" : JSON.stringify({ kind: "question", key: "database", question: "Which database?", about: "Read evidence completed; choose storage and finish" }) };
      yield { type: "response-end", reason: "tool-use" };
    } },
  });
  let runtime = new DurableRuntime(store, state, factory); runtimes.push(runtime); await runtime.start();
  const { run, tasks } = await runtime.submit({ commandId: "submit", objective: "Preserve UNIQUE-GOAL and reconcile evidence",
    mode: "single", configuration: { workspace, allowedWorkspaces: [workspace], allowWrite: false, allowShell: false,
      checks: [], maxTurns: 30, maxRetries: 0, compactThreshold: 1000 } });
  const taskId = tasks[0]!.taskId;
  await waitFor(() => store.getTask(taskId)?.status === "waiting" || store.getRun(run.runId)?.status === "paused", runtime);
  expect(store.getTask(taskId)?.status).toBe("waiting"); expect(reads).toBe(5); expect(summaries).toBeGreaterThan(0);
  expect(store.events(run.runId).some((event) => event.type === "context.compacted" && (event.data as { compaction?: unknown }).compaction)).toBe(true);
  const evidence = await readFile(join(state, taskId, "transcript.jsonl"), "utf8");
  expect(evidence).toContain("persisted-fact ".repeat(100));
  await runtime.close(); store.close();
  restarted = true;
  store = new RuntimeStore(database); stores.push(store);
  runtime = new DurableRuntime(store, state, factory); runtimes.push(runtime);
  const question = runtime.waits.questions(run.runId)[0]!;
  runtime.waits.answer({ commandId: "answer", runId: run.runId, waitId: question.waitId, expectedVersion: question.version, answer: "Choose SQLite" });
  await runtime.start();
  await waitFor(() => ["succeeded", "paused", "failed"].includes(store.getRun(run.runId)!.status), runtime);
  if (store.getRun(run.runId)?.status !== "succeeded") throw new Error(`Task did not complete: ${store.getTask(taskId)?.error}`);
  expect(store.getRun(run.runId)?.status).toBe("succeeded"); expect(reads).toBe(5);
  const progress = store.record<TaskProgress>("task-progress", taskId)!.value;
  expect(progress.pending).toEqual([]); expect(progress.recent.some((receipt) => receipt.name === "durable_wait")).toBe(true);
  expect((await new DurableTranscript({ store, root: state, runId: run.runId, taskId }).load()).length).toBeLessThan(20);
});

test("crash between transcript fsync and receipt replays progress once; compaction cannot overwrite it", async () => {
  const root = await mkdtemp(join(tmpdir(), "tnb-progress-crash-")); roots.push(root);
  const store = new RuntimeStore(join(root, "state.sqlite")); stores.push(store);
  const { run, tasks } = new RuntimeCommands(store).createRun({ commandId: "create", objective: "recover progress" });
  const taskId = tasks[0]!.taskId; let crash = true;
  const options = { store, root, runId: run.runId, taskId };
  const transcript = new DurableTranscript({ ...options, fault() { if (crash) { crash = false; throw new Error("crash after fsync"); } } });
  await expect(transcript.append([
    { role: "assistant", content: [{ type: "tool-use", id: "once", name: "read", input: {} }] },
    { role: "user", content: [{ type: "tool-result", toolUseId: "once", content: "source checked", isError: false }] },
  ])).rejects.toThrow("crash after fsync");
  expect(store.record("task-progress", taskId)).toBeUndefined();
  const recovered = new DurableTranscript(options); await recovered.load(); await recovered.load();
  const before = store.record<TaskProgress>("task-progress", taskId)!.value;
  expect(before.recent).toHaveLength(1); expect(before.recent[0]?.name).toBe("read"); expect(before.pending).toEqual([]);
  await recovered.append([{ role: "user", content: [{ type: "text", text: "compact summary" }] }], true, undefined, undefined, { strategy: "full" });
  expect(store.record<TaskProgress>("task-progress", taskId)!.value).toEqual(before);
  expect(await recovered.load()).toEqual([{ role: "user", content: [{ type: "text", text: "compact summary" }] }]);
  const index = JSON.parse(recovered.recall({ query: "source checked" }));
  expect(index.evidence[0].delivery).toBe(0);
  expect(JSON.parse(recovered.recall({ delivery: 0 })).fragment).toContain("source checked");
  expect(() => recovered.recall({ delivery: 99 })).toThrow("not found");
  expect(() => recovered.recall({ delivery: 0, offset: -1 })).toThrow("offset");
  const other = new RuntimeCommands(store).createRun({ commandId: "other", objective: "private task" });
  const foreign = new DurableTranscript({ store, root, runId: other.run.runId, taskId: other.tasks[0]!.taskId });
  await foreign.append([{ role: "user", content: [{ type: "text", text: "foreign-secret" }] }]);
  expect(JSON.parse(recovered.recall({ query: "foreign-secret" })).evidence).toEqual([]);
});
