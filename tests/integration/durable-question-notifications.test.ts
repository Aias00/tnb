// Pending decisions must reach an idle UI without a model/query turn, reappear after
// reconnect, stay scoped to the workspace, and disappear when another client answers.
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DurableRuntime, type RuntimeConfiguration, type RuntimeWorkerFactory } from "../../src/services/runtime/engine";
import { RuntimeStore } from "../../src/services/runtime/store";
import { serveDurableRuntime, runtimePaths } from "../../src/services/runtime/server";
import { DurableQuestionInbox } from "../../src/services/runtime/attention";
import { runRepl } from "../../src/ui/repl";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function until(predicate: () => boolean) {
  const end = Date.now() + 6000;
  while (!predicate()) { if (Date.now() > end) throw new Error("Notification condition timed out"); await Bun.sleep(10); }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tnb-attention-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "work"), other = join(root, "other"), configDir = join(root, "config");
  await mkdir(workspace); await mkdir(other);
  const state = join(configDir, "runtime"), store = new RuntimeStore(join(state, "state.sqlite")); cleanup.push(async () => store.close());
  let calls = 0;
  const factory: RuntimeWorkerFactory = async () => ({ model: "fixture", tools: [], authorize: async () => ({ behavior: "allow" }),
    route: { provider: "fixture", model: "fixture", pricing: { input: 1, output: 1 } }, maxOutputTokens: 100, transport: { async *stream(request) {
      calls++;
      if (!JSON.stringify(request.messages).includes("tool-result")) {
        yield { type: "tool-start", index: 0, id: "ask", name: "durable_wait" };
        yield { type: "tool-input", index: 0, json: JSON.stringify({ kind: "question", key: "database", question: "选择数据库", options: ["SQLite", "其他"], about: "完成剩余分析" }) };
        yield { type: "response-end", reason: "tool-use" };
      } else { yield { type: "text", index: 0, text: "Finished with user's decision" }; yield { type: "response-end", reason: "end-turn" }; }
    } } });
  const config: RuntimeConfiguration = { workspace, allowedWorkspaces: [workspace], allowWrite: false, allowShell: false,
    checks: [], maxTurns: 10, maxRetries: 0, compactThreshold: 10000 };
  async function owner() {
    const runtime = new DurableRuntime(store, state, factory), controller = new AbortController(), ready = Promise.withResolvers<void>();
    const done = serveDurableRuntime({ configDir, env: process.env, runtime, signal: controller.signal, ready: () => ready.resolve() });
    const close = async () => { controller.abort(); await done; }; cleanup.push(close);
    await Promise.race([ready.promise, done.then(() => { throw new Error("Owner stopped before ready"); })]); return { runtime, close };
  }
  const first = await owner();
  function inbox(path = workspace) {
    const inbox = new DurableQuestionInbox({ configDir, workspace: () => path }); inbox.start(); cleanup.push(() => inbox.close()); return inbox;
  }
  return { ...first, owner, store, config, configDir, workspace, other, inbox, calls: () => calls };
}

test("a streamed question automatically interrupts idle input and its answer never reaches the chat model", async () => {
  const f = await fixture(), inbox = f.inbox(); let output = "", turns = 0, inputCalls = 0;
  const pendingInput = Promise.withResolvers<string>();
  const repl = runRepl({ sessionIdFactory: () => "idle", durableQuestions: inbox,
    inputValue: () => "", write: (text) => { output += text; },
    question: async () => ++inputCalls === 1 ? pendingInput.promise : "/exit",
    runTurn: async () => { turns++; return 0; },
  });
  const { run } = await f.runtime.submit({ commandId: "automatic", objective: "Ask automatically", configuration: f.config });
  await until(() => output.includes("选择数据库")); expect(f.calls()).toBe(1); expect(turns).toBe(0);
  pendingInput.resolve("1"); expect(await repl).toBe(0);
  await until(() => f.store.getRun(run.runId)?.status === "succeeded"); expect(f.calls()).toBe(2); expect(turns).toBe(0);
});

test("reconnecting and reopening a UI restore pending questions; another client's answer withdraws them", async () => {
  const f = await fixture(), inbox = f.inbox();
  const { run } = await f.runtime.submit({ commandId: "reconnect", objective: "Restore pending decision", configuration: f.config });
  await until(() => inbox.current().length === 1);
  const question = inbox.current()[0]!; await f.close();
  await f.owner();
  await until(() => inbox.current().length === 1); expect(f.calls()).toBe(1);
  const second = f.inbox(); await until(() => second.current().length === 1);
  await second.answer(second.current()[0]!, "SQLite");
  await until(() => inbox.current().length === 0 && f.store.getRun(run.runId)?.status === "succeeded");
  await expect(inbox.answer(question, "其他")).rejects.toThrow();
  expect(f.store.events(run.runId).filter((event) => event.type === "wait.answered")).toHaveLength(1);
});

test("a question notification preserves a draft and is asked after the foreground turn", async () => {
  const f = await fixture(), inbox = f.inbox(); let output = "", turns = 0, inputCalls = 0;
  const pendingInput = Promise.withResolvers<string>();
  const repl = runRepl({ sessionIdFactory: () => "draft", durableQuestions: inbox,
    inputValue: () => "my existing draft", write: (text) => { output += text; },
    question: async () => ++inputCalls === 1 ? pendingInput.promise : inputCalls === 2 ? "SQLite" : "/exit",
    runTurn: async (turn) => { expect(turn.prompt).toBe("my existing draft"); turns++; return 0; },
  });
  const { run } = await f.runtime.submit({ commandId: "draft", objective: "Preserve typed input", configuration: f.config });
  await until(() => output.includes("选择数据库")); pendingInput.resolve("my existing draft");
  expect(await repl).toBe(0); expect(turns).toBe(1);
  await until(() => f.store.getRun(run.runId)?.status === "succeeded");
});

test("notifications stay in their workspace and cancellation removes a visible question", async () => {
  const f = await fixture(), inbox = f.inbox(), elsewhere = f.inbox(f.other);
  const { run } = await f.runtime.submit({ commandId: "scope", objective: "Scoped decision", configuration: f.config });
  await until(() => inbox.current().length === 1); expect(elsewhere.current()).toEqual([]);
  f.runtime.commands.cancelRun({ commandId: "cancel-question", runId: run.runId, expectedRevision: f.store.getRun(run.runId)!.revision });
  await until(() => inbox.current().length === 0); expect(elsewhere.current()).toEqual([]);
});

test("multiple questions queue without answering each other; deferral is local and reopening reminds again", async () => {
  const f = await fixture(), inbox = f.inbox();
  const { run } = await f.runtime.submit({ commandId: "queue", objective: "Two decisions", configuration: f.config,
    tasks: [{ key: "a", objective: "First decision", inputDigest: "a".repeat(64) }, { key: "b", objective: "Second decision", inputDigest: "b".repeat(64) }] });
  await until(() => inbox.current().length === 2);
  const first = inbox.next()!; inbox.dismiss(first);
  expect(inbox.next()!.waitId).not.toBe(first.waitId);
  await inbox.answer(inbox.next()!, "SQLite");
  await until(() => inbox.current().length === 1); expect(f.store.getRun(run.runId)?.status).toBe("active");
  expect(inbox.next()).toBeUndefined();
  const reopened = f.inbox(); await until(() => reopened.current().length === 1);
  expect(reopened.next()!.waitId).toBe(first.waitId); await reopened.answer(reopened.next()!, "SQLite");
  await until(() => f.store.getRun(run.runId)?.status === "succeeded"); expect(f.calls()).toBe(4);
});

test("switching workspace withdraws the old question and refuses a stale dialog answer", async () => {
  const f = await fixture(); let workspace = f.workspace;
  const inbox = new DurableQuestionInbox({ configDir: f.configDir, workspace: () => workspace }); inbox.start(); cleanup.push(() => inbox.close());
  await f.runtime.submit({ commandId: "switch", objective: "Switch scope", configuration: f.config });
  await until(() => inbox.current().length === 1); const question = inbox.current()[0]!;
  workspace = f.other;
  await expect(inbox.answer(question, "SQLite")).rejects.toThrow("工作区");
  await until(() => inbox.current().length === 0);
  workspace = f.workspace; await until(() => inbox.current().length === 1);
  expect(inbox.current()[0]!.waitId).toBe(question.waitId);
});

test("completion is pushed and acknowledged durably; reconnect does not repeat the notification", async () => {
  const f = await fixture(), inbox = f.inbox();
  const { run } = await f.runtime.submit({ commandId: "complete-notice", objective: "Notify completion", configuration: f.config });
  await until(() => inbox.current().length === 1); await inbox.answer(inbox.current()[0]!, "SQLite");
  await until(() => inbox.notifications().some((notice) => notice.runId === run.runId && notice.kind === "succeeded"));
  const notice = inbox.notifications().find((notice) => notice.runId === run.runId)!;
  await inbox.acknowledge(notice); await until(() => inbox.notifications().length === 0);
  const reopened = f.inbox(); await until(() => reopened.connection().state === "online");
  expect(reopened.notifications()).toEqual([]); expect(f.calls()).toBe(2);
});
test("owner loss is visible, stale questions cannot be answered offline, and restart reconnects", async () => {
  const f = await fixture(), inbox = f.inbox();
  await f.runtime.submit({ commandId: "connection", objective: "Show connection status", configuration: f.config });
  await until(() => inbox.current().length === 1); const question = inbox.current()[0]!;
  await f.close(); await until(() => inbox.connection().state === "offline");
  await expect(inbox.answer(question, "SQLite")).rejects.toThrow("离线");
  await f.owner(); await until(() => inbox.connection().state === "online");
  await inbox.answer(inbox.current()[0]!, "SQLite");
});

test("budget exhaustion pushes a blocked notice; increasing the total ceiling keeps charges and stays paused", async () => {
  const f = await fixture(), inbox = f.inbox();
  const { run } = await f.runtime.submit({ commandId: "budget-notice", objective: "Report blocked budget", configuration: { ...f.config, maxCostUsd: 0.000000001 } });
  await until(() => inbox.notifications().some((notice) => notice.runId === run.runId));
  const notice = inbox.notifications().find((notice) => notice.runId === run.runId)!;
  expect(notice).toMatchObject({ kind: "blocked", reason: "budget" }); expect(notice.message).toContain("预算不足"); expect(f.calls()).toBe(0);
  await inbox.acknowledge(notice);
  f.runtime.commands.updateLimits({ commandId: "topup", runId: run.runId, expectedRevision: f.store.getRun(run.runId)!.revision, maxCostUsd: 2 });
  expect(f.store.getRun(run.runId)?.status).toBe("paused");
  await f.runtime.resume(run.runId); await until(() => inbox.current().length === 1); await inbox.answer(inbox.current()[0]!, "SQLite");
  await until(() => inbox.notifications().some((notice) => notice.runId === run.runId && notice.kind === "succeeded")); expect(f.calls()).toBe(2);
});

test("failed validation pushes failure, never a completion notice", async () => {
  const f = await fixture(), inbox = f.inbox();
  const { run } = await f.runtime.submit({ commandId: "failure-notice", objective: "Report failure", configuration: { ...f.config, checks: ["missing-check-executor"] } });
  await until(() => inbox.current().length === 1); await inbox.answer(inbox.current()[0]!, "SQLite");
  await until(() => inbox.notifications().some((notice) => notice.runId === run.runId));
  expect(inbox.notifications().find((notice) => notice.runId === run.runId)?.kind).toBe("failed");
  expect(inbox.notifications().some((notice) => notice.kind === "succeeded")).toBe(false);
});

test("old owners, invalid credentials and stopped dispatch produce explicit connection states", async () => {
  const root = await mkdtemp(join(tmpdir(), "tnb-old-attention-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = await realpath(root), configDir = join(root, "config"), paths = await runtimePaths(configDir);
  await writeFile(paths.token, "fixture-key"); let mode = "old";
  const server = Bun.serve({ unix: paths.socket, fetch() {
    if (mode === "unauthorized") return new Response("Unauthorized", { status: 403 });
    const snapshot = { workspace, questions: [], ...(mode === "old" ? {} : { notifications: [], lifecycleNotifications: true, ready: false }) };
    return new Response(`data: ${JSON.stringify(snapshot)}\n\n`, { headers: { "content-type": "text/event-stream" } });
  } }); cleanup.push(() => server.stop(true));
  const inbox = new DurableQuestionInbox({ configDir, workspace: () => workspace }); inbox.start(); cleanup.push(() => inbox.close());
  await until(() => inbox.connection().state === "incompatible"); expect(inbox.connection().message).toContain("restart");
  mode = "unauthorized"; await until(() => inbox.connection().state === "unauthorized");
  mode = "failed"; await until(() => inbox.connection().state === "offline"); expect(inbox.connection().message).toContain("调度已停止");
});
