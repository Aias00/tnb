import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDurableCapabilityHost, validateCapabilitySelection } from "../../src/adapters/coding/capabilities";
import { createRuntimeWorkerFactory } from "../../src/adapters/coding/worker";
import { createCodingAdapter } from "../../src/adapters/coding/adapter";
import { DurableRuntime, type RuntimeConfiguration } from "../../src/services/runtime/engine";
import { RuntimeStore } from "../../src/services/runtime/store";
import type { ModelTransport } from "../../src/providers/types";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const signal = () => new AbortController().signal;
// The existing durable owner/workspace coordinator uses POSIX ownership and Unix sockets.
// Keep portable capability assembly and real stdio MCP coverage enabled on Windows.
const ownerTest = test.skipIf(process.platform === "win32");
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tnb-durable-capabilities-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const configDir = join(root, "settings"), workspace = join(root, "work"), state = join(configDir, "runtime");
  const skillDir = join(configDir, "skills", "inspect");
  await mkdir(workspace); await mkdir(skillDir, { recursive: true });
  const markdown = (extra = "") => `---\nname: inspect\ndescription: Inspect local evidence\n${extra}---\nRead the supporting checklist with skill_resource.\n`;
  await writeFile(join(skillDir, "SKILL.md"), markdown()); await writeFile(join(skillDir, "checklist.txt"), "Check durable authority before execution.");
  const log = join(root, "calls"), version = join(root, "version"); await writeFile(version, "v1");
  await writeFile(join(configDir, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: process.execPath,
    args: [resolve(import.meta.dir, "../fixtures/durable-mcp-server.mjs"), log, version], protocol: "legacy", env: { EXPLICIT_FIXTURE_SECRET: "fixture-credential" } } } }));
  const policy = (replay?: "safe" | "never") => writeFile(join(configDir, "durable-mcp.json"), JSON.stringify({ tools: [{ server: "fixture", tool: "inspect", ...(replay ? { replay } : {}) }] }));
  await policy();
  await writeFile(join(configDir, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", models: [{ id: "fixture", maxTokens: 4096, pricing: { input: 0, output: 0 } }] } } }));
  const env = { PATH: process.env.PATH, HOME: root, TNB_TEST_UNRELATED_SECRET: "must-not-inherit" };
  const config: RuntimeConfiguration = { workspace, allowedWorkspaces: [workspace], allowWrite: false, allowShell: false, checks: [],
    skills: ["inspect"], mcpTools: ["mcp__fixture__inspect"], provider: "fixture", model: "fixture", maxTurns: 20, maxRetries: 0, strategyVersion: 1, compactThreshold: 10000 };
  const host = createDurableCapabilityHost({ configDir, env });
  const factory = createRuntimeWorkerFactory({ configDir, runtimeRoot: state, env });
  return { root, configDir, workspace, state, skillDir, log, version, markdown, policy, config, host, factory, env };
}
async function open(f: Awaited<ReturnType<typeof fixture>>, transport: ModelTransport, start = true) {
  const store = new RuntimeStore(join(f.state, "state.sqlite"));
  const factory = Object.assign(async (context: Parameters<typeof f.factory>[0]) => ({ ...await f.factory(context), transport }), { prepareCapabilities: f.factory.prepareCapabilities });
  const runtime = new DurableRuntime(store, f.state, factory); if (start) await runtime.start();
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await runtime.close(); store.close(); } };
  cleanup.push(close); return { runtime, store, close };
}
async function until(runtime: DurableRuntime, predicate: () => boolean) {
  const end = Date.now() + 10000;
  while (!predicate()) { if (Date.now() > end) throw new Error(`Timed out: ${JSON.stringify(runtime.store.runs())}`); await runtime.tick(); await Bun.sleep(10); }
}
function* call(name: string, input: unknown, id = name) {
  yield { type: "tool-start" as const, index: 0, id, name }; yield { type: "tool-input" as const, index: 0, json: JSON.stringify(input) };
  yield { type: "response-end" as const, reason: "tool-use" as const };
}
function* done() { yield { type: "text" as const, index: 0, text: "Evidence inspected" }; yield { type: "response-end" as const, reason: "end-turn" as const }; }

test("durable selections require a host allowlist and reject executable skill metadata", async () => {
  const f = await fixture();
  await expect(f.host.prepare({ ...f.config, mcpTools: ["mcp__fixture__other"] })).rejects.toThrow("not host-authorized");
  for (const extra of ["context: fork\n", "model: different\n", "effort: high\n", "disable-model-invocation: true\n", "agent: hidden\n"]) {
    await writeFile(join(f.skillDir, "SKILL.md"), f.markdown(extra));
    await expect(f.host.prepare(f.config)).rejects.toThrow("instruction-only");
  }
  expect(await readFile(f.log, "utf8").catch(() => "")).toBe("");
  expect(() => validateCapabilitySelection({ skills: ["inspect", "inspect"] })).toThrow("selection");
  expect(() => validateCapabilitySelection({ capabilityPins: { unselected: "a".repeat(64) } })).toThrow("pins");
});

test("skill resources are immutable per worker; restart rejects changed files and policy without leaking credentials", async () => {
  const f = await fixture(); await f.host.prepare(f.config);
  const previous = process.env.TNB_TEST_UNRELATED_SECRET;
  process.env.TNB_TEST_UNRELATED_SECRET = "must-not-inherit";
  cleanup.push(async () => { if (previous === undefined) delete process.env.TNB_TEST_UNRELATED_SECRET; else process.env.TNB_TEST_UNRELATED_SECRET = previous; });
  const original = JSON.stringify(f.config); expect(original).not.toContain("fixture-credential"); expect(original).not.toContain(f.env.TNB_TEST_UNRELATED_SECRET);
  const worker = await f.host.open(f.config, signal()); cleanup.push(worker.close);
  expect(worker.tools.map(tool => tool.name)).toEqual(["skill", "skill_resource", "mcp__fixture__inspect"]);
  const skill = worker.tools[0]!, resource = worker.tools[1]!, mcp = worker.tools[2]!;
  expect(await skill.execute(skill.validate({ name: "inspect" }), signal())).toContain("skill:inspect");
  expect(mcp.effects?.replay).toBe("never"); expect(mcp.isReadOnly({})).toBe(false); expect(mcp.bindExecution).toBeUndefined();
  expect(await mcp.execute({}, signal())).toContain('"token":"absent"');
  expect(await mcp.execute({}, signal())).toContain('"credential":"fixture-credential"');
  await writeFile(join(f.skillDir, "checklist.txt"), "changed");
  expect(await resource.execute(resource.validate({ skill: "inspect", path: "checklist.txt" }), signal())).toContain("Check durable authority");
  await expect(resource.execute({ skill: "inspect", path: "../../mcp.json" }, signal())).rejects.toThrow("Unknown");
  await expect(f.host.open(f.config, signal())).rejects.toThrow("configuration changed");
  await writeFile(join(f.skillDir, "checklist.txt"), "Check durable authority before execution."); await f.policy("safe");
  await expect(f.host.open(f.config, signal())).rejects.toThrow("configuration changed");
});

test("durable MCP list changes cannot replace the admitted tool generation", async () => {
  const f = await fixture(); await f.host.prepare(f.config);
  const worker = await f.host.open(f.config, signal()); cleanup.push(worker.close);
  const mcp = worker.tools.find(tool => tool.name === "mcp__fixture__inspect")!;
  await mcp.execute({ notify: true }, signal());
  await expect(mcp.execute({}, signal())).rejects.toThrow("catalog changed");
  expect((await readFile(f.log, "utf8")).trim().split("\n")).toHaveLength(1);
});

test("skill allowed-tools narrows task tools and explicit deny remains authoritative", async () => {
  const f = await fixture(); await writeFile(join(f.skillDir, "SKILL.md"), f.markdown("allowed-tools: [read]\n"));
  await f.factory.prepareCapabilities!(f.config);
  const context = { run: { runId: "assembly-fixture" }, task: { taskId: "assembly-fixture" }, configuration: f.config, signal: signal() } as Parameters<typeof f.factory>[0];
  const worker = await f.factory(context); cleanup.push(async () => worker.close?.());
  expect(worker.tools.map(tool => tool.name)).toEqual(["read", "skill", "skill_resource"]);
  await writeFile(join(f.configDir, "settings.json"), JSON.stringify({ permissions: { deny: ["skill"] } }));
  const again = await f.factory(context); cleanup.push(async () => again.close?.());
  const skill = again.tools.find(tool => tool.name === "skill")!;
  expect((await again.authorize(skill, skill.validate({ name: "inspect" }), { toolUseId: "denied" })).behavior).toBe("deny");
});

ownerTest("selected capabilities survive owner restart; children inherit no skill or MCP authority", async () => {
  const f = await fixture(); let requests = 0;
  const transport: ModelTransport = { async *stream(request) {
    expect(request.tools.map(tool => tool.name)).toContain("skill");
    if (++requests === 1) yield* call("skill", { name: "inspect" });
    else if (requests === 2) yield* call("mcp__fixture__inspect", {});
    else if (requests === 3) yield* call("durable_wait", { kind: "question", key: "continue", question: "Continue?", about: "Evidence loaded" });
    else { expect(JSON.stringify(request.messages)).toContain("Evidence loaded"); yield* done(); }
  } };
  const first = await open(f, transport);
  const submitted = await first.runtime.submit({ commandId: "recover", objective: "Inspect evidence", configuration: f.config, mode: "single" });
  const same = await first.runtime.submit({ commandId: "recover", objective: "Inspect evidence", configuration: f.config, mode: "single" }); expect(same.run.runId).toBe(submitted.run.runId);
  await until(first.runtime, () => first.store.getTask(submitted.tasks[0]!.taskId)?.status === "waiting");
  const config = first.runtime.configuration(submitted.run.runId);
  const adapter = createCodingAdapter(f.factory);
  const child = await adapter.runtime!.delegate!({ descriptor: config.domain!, configuration: config, namespace: "coding", run: submitted.run,
    task: submitted.tasks[0]!, signal: signal(), stateRoot: f.state }, { workspace: f.workspace } as never);
  expect(child.skills).toEqual([]); expect(child.mcpTools).toEqual([]); expect(child.capabilityPins).toEqual({});
  const question = first.runtime.waits.questions(submitted.run.runId)[0]!; await first.close();
  const second = await open(f, transport);
  second.runtime.waits.answer({ commandId: "answer", runId: submitted.run.runId, waitId: question.waitId, expectedVersion: question.version, answer: "Continue" });
  await until(second.runtime, () => second.store.getRun(submitted.run.runId)?.status === "succeeded");
  expect((await readFile(f.log, "utf8")).trim().split("\n")).toHaveLength(1);
  expect(JSON.stringify(second.runtime.configuration(submitted.run.runId))).not.toContain("fixture-credential");
});

ownerTest("a disconnected unsafe MCP effect pauses and never redispatches after owner restart", async () => {
  const f = await fixture(); let requests = 0;
  const transport: ModelTransport = { async *stream() { requests++; yield* call("mcp__fixture__inspect", { disconnect: true }); } };
  const first = await open(f, transport); const { run } = await first.runtime.submit({ commandId: "unsafe", objective: "Call external service", configuration: f.config });
  await until(first.runtime, () => first.store.getRun(run.runId)?.status === "paused");
  expect(first.store.getRun(run.runId)?.pauseReason).toBe("unknown-effects"); await first.close();
  const second = await open(f, transport);
  await second.runtime.resume(run.runId);
  await until(second.runtime, () => second.store.getRun(run.runId)?.status === "paused");
  expect(second.store.getRun(run.runId)?.pauseReason).toBe("unknown-effects");
  expect(requests).toBe(1); expect((await readFile(f.log, "utf8")).trim().split("\n")).toHaveLength(1);
});

ownerTest("recovery rejects changed MCP schemas/descriptions before a new model request", async () => {
  const f = await fixture(); let requests = 0;
  const transport: ModelTransport = { async *stream() { requests++; yield* call("durable_wait", { kind: "question", key: "wait", question: "Continue?", about: "Waiting" }); } };
  const first = await open(f, transport); const { run, tasks } = await first.runtime.submit({ commandId: "drift", objective: "Inspect", configuration: f.config });
  await until(first.runtime, () => first.store.getTask(tasks[0]!.taskId)?.status === "waiting");
  const question = first.runtime.waits.questions(run.runId)[0]!; await first.close(); await writeFile(f.version, "changed tool description");
  const second = await open(f, transport);
  second.runtime.waits.answer({ commandId: "answer", runId: run.runId, waitId: question.waitId, expectedVersion: question.version, answer: "Continue" });
  await until(second.runtime, () => second.store.getRun(run.runId)?.status === "paused"); expect(requests).toBe(1);
});

ownerTest("slash and approved conversational handoffs carry explicit capability selections without enabling control-time expansion", async () => {
  const f = await fixture();
  const owner = await open(f, { async *stream() { yield* done(); } }, false);
  const { serveDurableRuntime } = await import("../../src/services/runtime/server");
  const { runLongTaskChatCommand } = await import("../../src/entrypoints/runtime");
  const { createDurableTaskTool } = await import("../../src/services/runtime/conversation-tool");
  const controller = new AbortController(), ready = Promise.withResolvers<void>();
  const service = serveDurableRuntime({ configDir: f.configDir, env: f.env, runtime: owner.runtime, signal: controller.signal, ready: () => ready.resolve() });
  cleanup.push(async () => { controller.abort(); await service; });
  await Promise.race([ready.promise, service.then(() => { throw new Error("Service exited before ready"); })]);
  const output = await runLongTaskChatCommand({ args: ["Inspect", "--skill", "inspect", "--mcp-tool", "mcp__fixture__inspect", "--no-start"], cwd: f.workspace, workspace: f.workspace,
    configDir: f.configDir, env: f.env, provider: "fixture", model: "fixture", sessionId: "fixture-chat" });
  expect(output).toContain("accepted");
  const first = owner.store.runs()[0]!;
  expect(owner.runtime.configuration(first.runId)).toMatchObject({ skills: ["inspect"], mcpTools: ["mcp__fixture__inspect"] });
  const tool = createDurableTaskTool({ configDir: f.configDir, env: f.env, sessionId: "fixture-chat", workspace: () => f.workspace, roots: () => [f.workspace], provider: "fixture", model: "fixture" });
  const input = tool.validate({ action: "submit", key: "approved", objective: "Inspect again", skills: ["inspect"], mcpTools: ["mcp__fixture__inspect"] });
  expect(tool.requiresApproval!(input)).toBe(true);
  await tool.execute(input, signal());
  expect(owner.store.runs()).toHaveLength(2);
  expect(() => tool.validate({ action: "resume", runId: first.runId, skills: ["inspect"] })).toThrow("Control cannot expand");
});


test("a durable ordinary-tool grant cannot select a generated resource helper with the same exposed name", async () => {
  const f = await fixture();
  await writeFile(join(f.configDir, "durable-mcp.json"), JSON.stringify({ tools: [{ server: "fixture", tool: "read_resource" }] }));
  f.config.mcpTools = ["mcp__fixture__read_resource"];
  await f.host.prepare(f.config);
  await expect(f.host.open(f.config, signal())).rejects.toThrow("Selected MCP tool unavailable");
});
