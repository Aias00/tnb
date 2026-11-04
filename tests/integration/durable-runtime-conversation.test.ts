import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli, runInteractiveCli } from "../../src/entrypoints/cli";
import { runRuntimeChatCommand, runLongTaskChatCommand } from "../../src/entrypoints/runtime";
import { DurableRuntime } from "../../src/services/runtime/engine";
import { RuntimeStore } from "../../src/services/runtime/store";
import { serveDurableRuntime, runtimeRequest } from "../../src/services/runtime/server";
import { createDurableTaskTool } from "../../src/services/runtime/conversation-tool";
import { acquireWorkspace } from "../../src/services/runtime/workspace";
import type { ModelEvent, ModelRequest, ModelTransport } from "../../src/providers/types";

const roots: string[] = []; const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
function call(action: string, input: object, id = action): ModelEvent[] { return [{ type: "tool-start", index: 0, id, name: action },
  { type: "tool-input", index: 0, json: JSON.stringify(input) }, { type: "response-end", reason: "tool-use" }]; }
const done: ModelEvent[] = [{ type: "text", index: 0, text: "已记录" }, { type: "response-end", reason: "end-turn" }];
async function fixture(workerTransport?: ModelTransport) {
  const root = await mkdtemp(join(tmpdir(), "tnb-durable-chat-")); roots.push(root);
  const workspace = join(root, "workspace"); const configDir = join(root, "config"); const state = join(configDir, "runtime");
  await mkdir(workspace); await mkdir(configDir);
  await writeFile(join(configDir, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", models: [{ id: "fixture", pricing: { input: 1, output: 1 } }] } } }));
  const store = new RuntimeStore(join(state, "state.sqlite")); let workerCalls = 0;
  let finish = Promise.withResolvers<void>();
  const runtime = new DurableRuntime(store, state, async () => ({ model: "fixture", tools: [], maxOutputTokens: 100,
    route: { provider: "fixture", model: "fixture", pricing: { input: 1, output: 1 } }, authorize: async () => ({ behavior: "allow" }),
    transport: workerTransport ?? { async *stream(_request, signal) {
      workerCalls++;
      await Promise.race([finish.promise, new Promise<void>((resolve) => {
        if (signal?.aborted) resolve(); else signal?.addEventListener("abort", () => resolve(), { once: true });
      })]); signal?.throwIfAborted(); yield* done;
    } },
  }));
  const controller = new AbortController(); const ready = Promise.withResolvers<void>();
  const service = serveDurableRuntime({ configDir, env: process.env, runtime, signal: controller.signal, ready: () => ready.resolve() });
  cleanup.push(async () => { finish.resolve(); controller.abort(); await service; store.close(); });
  await Promise.race([ready.promise, service.then(() => { throw new Error("Owner exited early"); })]);
  const context = { configDir, env: process.env, sessionId: "chat-session", workspace: () => workspace, roots: () => [workspace], provider: "fixture", model: "fixture" };
  async function chat(responses: (request: ModelRequest, index: number) => ModelEvent[], resume = false, permission = true, prompt = "把我们讨论的方案作为后台长任务执行") {
    let index = 0; let approvals = 0; let output = ""; let error = "";
    const transport: ModelTransport = { async *stream(request) { yield* responses(request, index++); } };
    const code = await runCli({ cwd: workspace, configDir, env: process.env,
      argv: ["-p", prompt, "--provider", "fixture", "--model", "fixture", ...(resume ? ["--resume", context.sessionId] : [])],
      sessionIdFactory: () => context.sessionId, transport,
      stdout: { write: (value) => { output += value; } }, stderr: { write: (value) => { error += value; } },
      permissionPrompt: async () => { approvals++; return permission ? "allow" : "deny"; },
    });
    expect(error).toBe(""); expect(code).toBe(0); return { output, approvals };
  }
  return { root, workspace, configDir, store, runtime, context, chat, workerCalls: () => workerCalls, finish: () => finish.resolve() };
}
async function until(predicate: () => boolean, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("Conversation runtime condition timed out"); await Bun.sleep(15); }
}

test("natural language handoff persists context, waits for the foreground lease, and keeps chat controls usable", async () => {
  const f = await fixture();
  const first = await f.chat((request, index) => {
    expect(request.tools.some((tool) => tool.name === "durable_task")).toBe(true);
    expect(request.systemPrompt).toContain("explicitly asks");
    if (!index) return call("durable_task", { action: "submit", key: "design-task", objective: "Implement the agreed design", context: "Use SQLite; preserve existing user changes", mode: "auto" });
    expect(f.workerCalls()).toBe(0);
    const result = request.messages.at(-1)!.content.find((block) => block.type === "tool-result");
    expect(result?.type === "tool-result" ? JSON.parse(result.content).accepted : false).toBe(true); return done;
  });
  expect(first.approvals).toBe(1); const run = f.store.runs()[0]!;
  expect(f.runtime.configuration(run.runId)).toMatchObject({ originSessionId: "chat-session", conversationContext: "Use SQLite; preserve existing user changes", provider: "fixture", model: "fixture", allowWrite: false });
  await until(() => f.workerCalls() === 1);
  const status = await f.chat((request, index) => {
    expect(request.tools.map((tool) => tool.name)).toEqual(["durable_task"]);
    if (!index) return call("durable_task", { action: "status" });
    expect(JSON.stringify(request.messages)).toContain(run.runId); return done;
  }, true, true, "刚才的长任务现在进展怎么样？");
  expect(status.approvals).toBe(0); expect(f.store.runs()).toHaveLength(1);
  f.finish(); await until(() => f.store.getRun(run.runId)?.status === "succeeded");
  await f.chat((request, index) => {
    if (!index) return call("durable_task", { action: "result", runId: run.runId });
    expect(JSON.stringify(request.messages)).toContain("report-delivered"); return done;
  }, true, true, "看看它最后交付的结果");
});

test("conversation rejects background submission when its normal permission prompt is denied", async () => {
  const f = await fixture();
  const result = await f.chat((request, index) => {
    if (!index) return call("durable_task", { action: "submit", key: "denied", objective: "Run only when approved" });
    expect(JSON.stringify(request.messages)).toContain("User denied"); return done;
  }, false, false);
  expect(result.approvals).toBe(1); expect(f.store.runs()).toHaveLength(0); expect(f.workerCalls()).toBe(0);
});

test("a repeated handoff key reuses one Run and cannot silently change its authority", async () => {
  const f = await fixture(); const tool = createDurableTaskTool(f.context);
  const input = tool.validate({ action: "submit", key: "stable", objective: "same work", context: "same decision" });
  const first = JSON.parse(await tool.execute(input, new AbortController().signal) as string);
  const second = JSON.parse(await tool.execute(input, new AbortController().signal) as string);
  expect(first.run.runId).toBe(second.run.runId); expect(f.store.runs()).toHaveLength(1);
  await expect(tool.execute(tool.validate({ action: "submit", key: "stable", objective: "changed work" }), new AbortController().signal)).rejects.toThrow("different input");
  expect(() => tool.validate({ action: "submit", key: "write", objective: "write", allowWrite: true })).toThrow("verification");
  expect(() => tool.validate({ action: "submit", key: "outside", objective: "outside", workspace: "/" })).toThrow("capability");
  expect(() => tool.validate({ action: "resume", runId: first.run.runId, allowWrite: true })).toThrow("expand");
});

test("busy conversations can pause and resume the same Run with no duplicate task", async () => {
  const f = await fixture(); const tool = createDurableTaskTool(f.context);
  const accepted = JSON.parse(await tool.execute(tool.validate({ action: "submit", key: "control", objective: "control me" }), new AbortController().signal) as string);
  const runId = accepted.run.runId; await until(() => f.workerCalls() === 1);
  await f.chat((_request, index) => !index ? call("durable_task", { action: "pause", runId }) : done, false, true, "暂停刚才的长任务");
  await until(() => f.store.getRun(runId)?.status === "paused");
  expect(f.store.routes(f.runtime.configuration(runId).workspace)).toContainEqual(expect.objectContaining({
    action: "run.pause", rawText: "暂停刚才的长任务", source: "conversation", sessionId: f.context.sessionId, runId,
  }));
  await f.chat((_request, index) => !index ? call("durable_task", { action: "resume", runId }) : done, true, true, "继续刚才的长任务");
  await until(() => f.workerCalls() === 2); expect(f.store.runs()).toHaveLength(1);
  f.finish(); await until(() => f.store.getRun(runId)?.status === "succeeded");
});

test("identical control words in different persisted call scopes create distinct intents while replay keeps one identity", async () => {
  const f = await fixture(); const release = await acquireWorkspace(f.workspace); cleanup.push(release);
  const submit = createDurableTaskTool(f.context);
  const accepted = [];
  for (const key of ["first", "second"]) accepted.push(JSON.parse(await submit.execute(submit.validate({ action: "submit", key, objective: key }), new AbortController().signal) as string));
  const context = { ...f.context, sourceText: "暂停任务" };
  const bound = (scope: string, sourceText = context.sourceText) => createDurableTaskTool({ ...context, sourceText }).bindExecution!({ toolUseId: "reused-provider-call-id", scope });
  const invoke = async (scope: string, action = "pause") => { const tool = bound(scope, action === "cancel" ? "取消任务" : context.sourceText); return JSON.parse(await tool.execute(tool.validate({ action }), new AbortController().signal) as string); };
  const first = await invoke("message-one"); expect(first.status).toBe("clarify");
  expect(await invoke("message-one")).toEqual(first);
  const runId = accepted[0].run.runId;
  const choose = (decision: typeof first, commandId: string) => runtimeRequest(f.configDir, "/command", { action: "resolve-route", commandId, runId,
    resolveInputId: decision.inputId, expectedRevision: decision.revision,
    source: { inputId: commandId, workspace: decision.workspace, rawText: runId, source: "conversation", sessionId: context.sessionId } });
  await choose(first, "choose-first"); expect(f.store.getRun(runId)?.status).toBe("paused");
  await f.runtime.resume(runId);
  const second = await invoke("message-two");
  expect(second.status).toBe("clarify"); expect(second.inputId).not.toBe(first.inputId); expect(await invoke("message-two")).toEqual(second);
  await choose(second, "choose-second"); expect(f.store.getRun(runId)?.status).toBe("paused"); expect(f.workerCalls()).toBe(0);
  const cancellation = await invoke("cancel-message", "cancel"); expect(cancellation.status).toBe("clarify");
  await choose(cancellation, "choose-cancel"); await until(() => f.store.getRun(runId)?.status === "cancelled");
  expect(await invoke("cancel-message", "cancel")).toMatchObject({ status: "accepted", runId });
  const other = accepted[1].run.runId;
  expect(f.store.getRun(other)?.status).toBe("active");
  f.runtime.commands.cancelRun({ commandId: "clean-other", runId: other, expectedRevision: f.store.getRun(other)!.revision });
  await until(() => f.store.getRun(other)?.status === "cancelled");
});

test("historical terminal runs do not make a unique eligible conversational control ambiguous", async () => {
  const f = await fixture(); const release = await acquireWorkspace(f.workspace); cleanup.push(release);
  const tool = createDurableTaskTool(f.context); const created = [];
  for (const key of ["historical", "current"]) created.push(JSON.parse(await tool.execute(tool.validate({ action: "submit", key, objective: key }), new AbortController().signal) as string));
  const historical = created[0].run.runId, current = created[1].run.runId;
  f.runtime.commands.cancelRun({ commandId: "cancel-history", runId: historical, expectedRevision: f.store.getRun(historical)!.revision });
  await until(() => f.store.getRun(historical)?.status === "cancelled");
  const control = createDurableTaskTool({ ...f.context, sourceText: "暂停刚才的任务" });
  const result = JSON.parse(await control.execute(control.validate({ action: "pause" }), new AbortController().signal) as string);
  expect(result.run).toMatchObject({ runId: current, status: "paused" });
  expect(f.store.routes<{ status: string }>(f.runtime.configuration(current).workspace).some((row) => row.status === "clarify")).toBe(false);
  expect(f.workerCalls()).toBe(0);
});

test("direct slash submission inherits the conversation's model and works in the terminal REPL", async () => {
  const f = await fixture(); let output = ""; let error = ""; let modelCalls = 0;
  const answers = ['/runtime submit "Investigate the agreed protocol" --mode single', "/runtime list", "/exit"];
  const code = await runInteractiveCli({ cwd: f.workspace, configDir: f.configDir, env: process.env,
    argv: ["--provider", "fixture", "--model", "fixture"], sessionIdFactory: () => "slash-session",
    transport: { async *stream() { modelCalls++; throw new Error("Slash commands must not ask the chat model to interpret flags"); } },
    question: async () => answers.shift() ?? "/exit", stdout: { write: (value) => { output += value; } }, stderr: { write: (value) => { error += value; } } });
  expect(code).toBe(0); expect(error).toBe(""); expect(modelCalls).toBe(0); expect(output).toContain("Durable task accepted");
  const run = f.store.runs()[0]!; expect(run.policy.mode).toBe("single");
  expect(f.runtime.configuration(run.runId)).toMatchObject({ provider: "fixture", model: "fixture", originSessionId: "slash-session" });
  await expect(runRuntimeChatCommand({ args: ["serve"], cwd: f.workspace, workspace: f.workspace, configDir: f.configDir, env: process.env,
    provider: "fixture", model: "fixture", sessionId: "slash-session" })).rejects.toThrow("/runtime supports");
});

test("foreground child agents cannot open a separate durable Run", async () => {
  const f = await fixture(); let mainCalls = 0;
  await f.chat((request) => {
    if (request.tools.some((tool) => tool.name === "durable_task")) return mainCalls++ === 0
      ? call("agent", { prompt: "Investigate only", description: "Inspect", subagentType: "general-purpose" }) : done;
    expect(request.tools.some((tool) => tool.name === "durable_task")).toBe(false); return done;
  });
  expect(f.store.runs()).toHaveLength(0);
});

test("Plan mode denies a new durable task instead of indirectly gaining background writes", async () => {
  const f = await fixture(); let request = 0; let approvals = 0; let error = "";
  const code = await runCli({ cwd: f.workspace, configDir: f.configDir, env: process.env,
    argv: ["-p", "考虑后台任务", "--provider", "fixture", "--model", "fixture", "--permission-mode", "plan"],
    sessionIdFactory: () => "plan-chat", stdout: { write() {} }, stderr: { write: (value) => { error += value; } },
    permissionPrompt: async () => { approvals++; return "allow"; }, transport: { async *stream(message) {
      if (!request++) yield* call("durable_task", { action: "submit", key: "plan", objective: "must not start" });
      else { expect(JSON.stringify(message.messages)).toContain("plan mode"); yield* done; }
    } },
  });
  expect(code).toBe(0); expect(error).toBe(""); expect(approvals).toBe(0); expect(f.store.runs()).toHaveLength(0);
});

test("conversation task controls cannot target a Run from another workspace", async () => {
  const f = await fixture(); const other = join(f.root, "other"); await mkdir(other);
  const created = await f.runtime.submit({ commandId: "other", objective: "other workspace", configuration: {
    workspace: other, allowedWorkspaces: [other], allowWrite: false, allowShell: false, checks: [], maxTurns: 10, maxRetries: 1, compactThreshold: 10000,
  } });
  const tool = createDurableTaskTool(f.context);
  await expect(tool.execute(tool.validate({ action: "status", runId: created.run.runId }), new AbortController().signal)).rejects.toThrow("conversation workspace");
  await expect(tool.execute(tool.validate({ action: "cancel", runId: created.run.runId }), new AbortController().signal)).rejects.toThrow("conversation workspace");
  expect(f.store.getRun(created.run.runId)?.status).toBe("active");
});

test("legacy runtime owners cannot silently ignore conversation workspace scoping", async () => {
  const f = await fixture(); const { runtimePaths } = await import("../../src/services/runtime/server");
  const configDir = join(f.root, "legacy"); const paths = await runtimePaths(configDir);
  await writeFile(paths.token, "legacy-fixture-token"); const resources: string[] = [];
  const owner = Bun.serve({ unix: paths.socket, fetch(request) {
    const path = new URL(request.url).pathname; resources.push(path);
    return Response.json(path === "/health" ? { ready: true, capabilities: { protocol: 2 } } : [{ runId: "outside-workspace" }]);
  } }); cleanup.push(() => owner.stop(true));
  const tool = createDurableTaskTool({ ...f.context, configDir });
  await expect(tool.execute(tool.validate({ action: "list" }), new AbortController().signal)).rejects.toThrow("update/restart");
  await expect(tool.execute(tool.validate({ action: "submit", key: "legacy", objective: "do not submit" }), new AbortController().signal)).rejects.toThrow("update/restart");
  expect(resources).toEqual(["/health", "/health"]);
});

test("busy conversation restores Plan mode from transcript before authorizing durable controls", async () => {
  const f = await fixture(); const tool = createDurableTaskTool(f.context);
  await tool.execute(tool.validate({ action: "submit", key: "running", objective: "keep workspace busy" }), new AbortController().signal);
  await until(() => f.workerCalls() === 1);
  const { SessionStore } = await import("../../src/services/session/storage");
  const session = new SessionStore({ configDir: f.configDir, cwd: f.workspace, sessionId: f.context.sessionId });
  await session.append([{ role: "user", content: [{ type: "text", text: "先规划" }] },
    { role: "assistant", content: [{ type: "tool-use", id: "plan", name: "enter_plan_mode", input: {} }] },
    { role: "user", content: [{ type: "tool-result", toolUseId: "plan", content: "Entered plan mode.", isError: false }] }]);
  const response = await f.chat((request, index) => {
    if (!index) return call("durable_task", { action: "submit", key: "forbidden", objective: "must stay in planning" });
    expect(JSON.stringify(request.messages)).toContain("plan mode"); return done;
  }, true);
  expect(response.approvals).toBe(0); expect(f.store.runs()).toHaveLength(1);
});

test("busy control hooks cannot reuse a prior foreground handler with workspace tools", async () => {
  const f = await fixture(); const tool = createDurableTaskTool(f.context);
  const accepted = JSON.parse(await tool.execute(tool.validate({ action: "submit", key: "held", objective: "hold workspace" }), new AbortController().signal) as string);
  await until(() => f.workerCalls() === 1);
  const { HookRunner } = await import("../../src/services/hooks/runner"); let leaked = 0; let requests = 0; let error = "";
  const hooks = new HookRunner({ cwd: f.workspace, sessionId: "control-hooks", env: process.env,
    hooks: { PreToolUse: [{ matcher: "durable_task", hooks: [{ type: "agent", tools: ["write"], prompt: "Inspect and change workspace files" }] }] } });
  hooks.setModelHandlers({ agent: async () => { leaked++; return { ok: true }; } });
  const code = await runCli({ cwd: f.workspace, configDir: f.configDir, env: process.env, hookRunner: hooks,
    argv: ["-p", "暂停后台任务", "--provider", "fixture", "--model", "fixture"], sessionIdFactory: () => "control-hooks",
    stdout: { write() {} }, stderr: { write: (value) => { error += value; } }, permissionPrompt: async () => "allow",
    transport: { async *stream(request) {
      if (!requests++) yield* call("durable_task", { action: "cancel", runId: accepted.run.runId });
      else { expect(JSON.stringify(request.messages)).toContain("Hook workspace tools are unavailable"); yield* done; }
    } },
  });
  expect(code).toBe(0); expect(error).toBe(""); expect(leaked).toBe(0); expect(f.store.getRun(accepted.run.runId)?.status).toBe("active");
});

test("long-task slash commands and aliases submit directly without a chat model call", async () => {
  const f = await fixture(); let output = ""; let error = ""; let modelCalls = 0;
  const answers = ['/task "Inspect durable execution" --mode single', "/task status", "/long status", "/长任务 list", "/exit"];
  const code = await runInteractiveCli({ cwd: f.workspace, configDir: f.configDir, env: process.env,
    argv: ["--provider", "fixture", "--model", "fixture"], sessionIdFactory: () => "longtask-session",
    transport: { async *stream() { modelCalls++; throw new Error("Long-task slash commands must bypass model interpretation"); } },
    question: async () => answers.shift() ?? "/exit", stdout: { write: (value) => { output += value; } }, stderr: { write: (value) => { error += value; } } });
  expect(code).toBe(0); expect(error).toBe(""); expect(modelCalls).toBe(0);
  expect(output).toContain("/longtask status"); expect(f.store.runs()).toHaveLength(1);
  const run = f.store.runs()[0]!; expect(run.objective).toBe("Inspect durable execution"); expect(run.policy.mode).toBe("single");
  expect(output).toContain(run.runId); expect(f.runtime.configuration(run.runId).originSessionId).toBe("longtask-session");
});

test("long-task controls prefer the current conversation and list only its workspace", async () => {
  const f = await fixture();
  const options = { cwd: f.workspace, workspace: f.workspace, configDir: f.configDir, env: process.env, provider: "fixture", model: "fixture", sessionId: "conversation-a" };
  const execute = (args: string[], sessionId = options.sessionId) => runLongTaskChatCommand({ ...options, sessionId, args });
  await execute(["Inspect", "protocol", "A"]);
  await execute(["submit", "Inspect protocol B"], "conversation-b");
  const [a, b] = f.store.runs();
  expect(a!.objective).toBe("Inspect protocol A");
  const other = join(f.root, "other-command-workspace"); await mkdir(other);
  const outside = await f.runtime.submit({ commandId: "outside-longtask", objective: "Do not select this other workspace", configuration: {
    workspace: other, allowedWorkspaces: [other], allowWrite: false, allowShell: false, checks: [], maxTurns: 10, maxRetries: 1, compactThreshold: 10000,
  } });
  expect(JSON.parse(await execute(["status"])).run.runId).toBe(a!.runId);
  expect(JSON.parse(await execute(["status"], "new-conversation")).run.runId).toBe(b!.runId);
  const listed = JSON.parse(await execute(["list"])); expect(listed.map((run: { runId: string }) => run.runId)).toEqual([a!.runId, b!.runId]);
  expect(listed.some((run: { runId: string }) => run.runId === outside.run.runId)).toBe(false);
  await execute(["pause"]); await until(() => f.store.getRun(a!.runId)?.status === "paused");
  expect(f.store.getRun(b!.runId)?.status).toBe("active");
  await execute(["resume"]); expect(f.store.getRun(a!.runId)?.status).toBe("active"); expect(f.store.runs()).toHaveLength(3);
  await execute(["cancel"]); await until(() => f.store.getRun(a!.runId)?.status === "cancelled");
});

test("bare long-task command shows help without starting or accepting work", async () => {
  const f = await fixture(); const options = { args: [] as string[], cwd: f.workspace, workspace: f.workspace, configDir: join(f.root, "unused-config"), env: process.env,
    provider: "fixture", model: "fixture", sessionId: "help-session" };
  const help = await runLongTaskChatCommand(options);
  expect(help).toContain("/longtask"); expect(help).toContain("--check"); expect(f.store.runs()).toHaveLength(0); expect(f.workerCalls()).toBe(0);
});

test("task limits extend a paused Run once and never change its write grants or consume its budget ledger", async () => {
  const f = await fixture();
  const options = { cwd: f.workspace, workspace: f.workspace, configDir: f.configDir, env: process.env, provider: "fixture", model: "fixture", sessionId: "limits-session" };
  const execute = (args: string[]) => runLongTaskChatCommand({ ...options, args });
  const deadline = new Date(Date.now() + 3600000).toISOString();
  await execute(["Inspect limits", "--mode", "single", "--max-budget-usd", "1", "--deadline", deadline]);
  const runId = f.store.runs()[0]!.runId; await until(() => f.workerCalls() === 1);
  await execute(["pause"]); await until(() => f.store.getRun(runId)?.status === "paused");
  const before = f.runtime.budget.totals(runId), original = f.store.getRun(runId)!.deadline!;
  const args = ["limits", "--extend-hours", "24", "--max-budget-usd", "2", "--command-id", "same-limits"];
  await execute(args); await execute(args);
  expect(f.store.getRun(runId)?.deadline).toBe(original + 86400000);
  expect(f.store.getRun(runId)?.status).toBe("paused"); expect(f.runtime.budget.totals(runId)).toEqual(before);
  expect(f.runtime.configuration(runId)).toMatchObject({ maxCostUsd: 2, allowWrite: false, allowShell: false });
  expect(f.store.record<{ maxCostUsd: number }>("configuration", runId)!.value.maxCostUsd).toBe(2);
  expect(f.store.record<{ maxCostUsd: number }>("binding-limits", runId)!.value.maxCostUsd).toBe(1);
  await expect(execute(["limits", "--max-budget-usd", "3", "--revision", "invalid"])).rejects.toThrow("revision");
  const tool = createDurableTaskTool(f.context);
  expect(() => tool.validate({ action: "limits", runId, maxCostUsd: 3 })).toThrow("revision");
  expect(() => tool.validate({ action: "limits", runId, expectedRevision: f.store.getRun(runId)!.revision, maxCostUsd: 3, allowWrite: true })).toThrow("expand");
  await execute(["resume"]); await until(() => f.workerCalls() === 2); f.finish();
  await until(() => f.store.getRun(runId)?.status === "succeeded");
});

test("task question/answer slash commands bypass the chat model and reuse the persisted Run", async () => {
  let calls = 0;
  const f = await fixture({ async *stream(request) {
    if (!calls++) yield* call("durable_wait", { kind: "question", key: "choice", question: "数据库用哪个", options: ["SQLite", "其他"], about: "按答案完成报告" });
    else { expect(JSON.stringify(request.messages)).toContain("SQLite"); yield* done; }
  } });
  let output = "", error = "", chatCalls = 0, step = 0;
  const options = { cwd: f.workspace, workspace: f.workspace, configDir: f.configDir, env: process.env, provider: "fixture", model: "fixture", sessionId: "question-slash" };
  const code = await runInteractiveCli({ cwd: f.workspace, configDir: f.configDir, env: process.env,
    argv: ["--provider", "fixture", "--model", "fixture"], sessionIdFactory: () => options.sessionId,
    transport: { async *stream() { chatCalls++; throw new Error("Slash commands must not invoke the chat model"); } },
    question: async () => {
      if (step++ === 0) return '/task "选择存储并完成报告"';
      if (step === 2) {
        await until(() => !!f.store.runs()[0] && f.runtime.waits.questions(f.store.runs()[0]!.runId).length === 1);
        return "/task questions";
      }
      if (step === 3) {
        const question = f.runtime.waits.questions(f.store.runs()[0]!.runId)[0]!;
        return `/task answer --question ${question.waitId} --answer "SQLite" --version ${question.version}`;
      }
      if (step === 4) { await until(() => f.store.runs()[0]?.status === "succeeded"); return "/task result"; }
      return "/exit";
    }, stdout: { write: (value) => { output += value; } }, stderr: { write: (value) => { error += value; } } });
  expect(code).toBe(0); expect(error).toBe(""); expect(chatCalls).toBe(0); expect(calls).toBe(2);
  expect(output).toContain("数据库用哪个"); expect(output).toContain("report-delivered"); expect(f.store.runs()).toHaveLength(1);
  const runId = f.store.runs()[0]!.runId;
  expect(JSON.parse(await runLongTaskChatCommand({ ...options, args: ["questions", runId] }))).toEqual([]);
});

test("conversational answers require approval, question version and the original workspace scope", async () => {
  let calls = 0;
  const f = await fixture({ async *stream() {
    if (!calls++) yield* call("durable_wait", { kind: "question", key: "chat-choice", question: "继续吗", about: "完成报告" });
    else yield* done;
  } });
  const tool = createDurableTaskTool(f.context);
  const submitted = JSON.parse(await tool.execute(tool.validate({ action: "submit", key: "answer-test", objective: "Ask before continuing" }), new AbortController().signal) as string);
  const runId = submitted.run.runId;
  await until(() => f.runtime.waits.questions(runId).length === 1);
  const question = f.runtime.waits.questions(runId)[0]!;
  const answer = { action: "answer", runId, waitId: question.waitId, answer: "继续", expectedVersion: question.version };
  expect(() => tool.validate({ ...answer, expectedVersion: undefined })).toThrow("version");
  expect(() => tool.validate({ ...answer, allowWrite: true })).toThrow("expand");
  const denied = await f.chat((_request, index) => index ? done : call("durable_task", answer), false, false, "回答刚才的问题：继续");
  expect(denied.approvals).toBe(1); expect(f.runtime.waits.questions(runId)).toHaveLength(1);
  const other = join(f.root, "answer-other-workspace"); await mkdir(other);
  const scoped = createDurableTaskTool({ ...f.context, workspace: () => other, roots: () => [other] });
  await expect(scoped.execute(scoped.validate(answer), new AbortController().signal)).rejects.toThrow("conversation workspace");
  const accepted = await f.chat((_request, index) => index ? done : call("durable_task", answer), true, true, "回答刚才的问题：继续");
  expect(accepted.approvals).toBe(1);
  await until(() => f.store.getRun(runId)?.status === "succeeded"); expect(calls).toBe(2);
});
