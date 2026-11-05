import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { openAgentRuntime, type AgentRuntimeHost, type BuiltinAdapterPlugin } from "../../src/agent/runtime";
import { createCodingPlugin, codingTask } from "../../src/adapters/coding";
import { createReadTool, createWriteTool } from "../../src/tools/builtins";
import type { RuntimeWorkerFactory, WorkerResources } from "../../src/services/runtime/engine-core";
import type { ModelTransport } from "../../src/providers/types";
import { installLocalPlugin } from "../../src/services/plugins/management";
import { trustPlugin } from "../../src/services/plugins/trust";
import { tryAcquireResources } from "../../src/services/runtime/resources";
import { RuntimeStore } from "../../src/services/runtime/store";
import { RuntimeCommands } from "../../src/services/runtime/commands";
import { RuntimeArtifacts, workspaceManifest } from "../../src/services/runtime/artifacts";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tnb-coding-plugin-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "work"), configDir = join(root, "settings"), state = join(root, "control/runtime");
  await mkdir(workspace); await mkdir(configDir); await writeFile(join(workspace, "source.txt"), "actual workspace evidence");
  return { root, workspace: await realpath(workspace), configDir, state, env: { ...process.env } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function* report(text = "Inspected actual workspace") { yield { type: "text" as const, index: 0, text }; yield { type: "response-end" as const, reason: "end-turn" as const }; }
function* call(name: string, input: unknown) {
  yield { type: "tool-start" as const, index: 0, id: name, name }; yield { type: "tool-input" as const, index: 0, json: JSON.stringify(input) };
  yield { type: "response-end" as const, reason: "tool-use" as const };
}
function factory(f: Fixture, transport: ModelTransport, check?: WorkerResources["check"]): RuntimeWorkerFactory {
  return async () => ({ transport, model: "fixture", route: { provider: "fixture", model: "fixture" }, maxOutputTokens: 512,
    tools: [createReadTool(f.workspace), createWriteTool(f.workspace)], authorize: async () => ({ behavior: "allow" }), check });
}
function config(f: Fixture) { return { workspace: f.workspace, allowedWorkspaces: [f.workspace], allowWrite: false, allowShell: false, checks: [] as string[] }; }
async function plugin(f: Fixture, workerFactory: RuntimeWorkerFactory) { return createCodingPlugin({ configDir: f.configDir, runtimeRoot: f.state, env: f.env, workerFactory }); }
async function open(f: Fixture, builtin: BuiltinAdapterPlugin, enabled = true) {
  const host = await openAgentRuntime({ directory: f.state, legacyAdapterId: "coding",
    plugins: { roots: [], trustStorePath: join(f.configDir, "plugin-trust.json"), builtins: [builtin], enabled: { "tnb-coding": enabled } } });
  cleanup.push(() => host.close()); return host;
}
async function until(host: AgentRuntimeHost, predicate: () => boolean) {
  const end = Date.now() + 8000;
  while (!predicate()) { if (Date.now() > end) throw new Error(`Timed out: ${JSON.stringify(host.store.runs())}; ${JSON.stringify(host.store.runs().flatMap(run => host.store.tasks(run.runId)))}`); await host.runtime.tick(); await Bun.sleep(10); }
}

test("the built-in coding plugin writes through actual tools and accepts only its authorized verification", async () => {
  const f = await fixture(); let requests = 0, checks = 0;
  const builtin = await plugin(f, factory(f, { async *stream(request) {
    expect(request.systemPrompt).toContain(`Working directory: ${f.workspace}`);
    if (++requests === 1) yield* call("write", { path: "result.ts", content: "export const value = 42;\n" }); else yield* report("Implemented value");
  } }, async command => { expect(command).toBe("verify-result"); checks++; expect(await readFile(join(f.workspace, "result.ts"), "utf8")).toContain("42"); return "Actual file verified"; }));
  const host = await open(f, builtin);
  const descriptor = await codingTask({ ...config(f), allowWrite: true, checks: ["verify-result"] });
  const { run, tasks } = await host.submit({ commandId: "write", namespace: "coding", objective: "Implement value", adapter: descriptor, mode: "single" });
  await until(host, () => host.store.getRun(run.runId)?.status === "succeeded");
  expect(host.runtime.configuration(run.runId).domain!.plugin).toEqual(builtin.identity);
  expect(host.plugins.list()[0]).toMatchObject({ name: "tnb-coding", status: "active", root: "builtin:tnb-coding" });
  expect(checks).toBe(1); expect(requests).toBe(2);
  expect(await host.runtime.artifacts.get(host.store.getTask(tasks[0]!.taskId)!.resultRef!)).toMatchObject({ acceptance: "verification-commands", adapter: { id: "coding", version: "1" } });
});

test("read-only coding capabilities cannot be enlarged by forging descriptor resource grants", async () => {
  const f = await fixture(); let requests = 0;
  const host = await open(f, await plugin(f, factory(f, { async *stream() { requests++; yield* report(); } })));
  const descriptor = await codingTask(config(f)); descriptor.resources[0]!.mode = "write";
  descriptor.grants.push({ name: "workspace.write", mode: "write", resources: [descriptor.resources[0]!.id] });
  await expect(host.submit({ commandId: "forged", namespace: "coding", objective: "Read", adapter: descriptor })).rejects.toThrow("capabilities do not match");
  expect(requests).toBe(0); expect(host.store.runs()).toHaveLength(0);
});

test("coding admission keeps generic resource exclusion as well as its workspace lease", async () => {
  const f = await fixture(); let requests = 0;
  const host = await open(f, await plugin(f, factory(f, { async *stream() { requests++; yield* report(); } })));
  const release = tryAcquireResources([{ id: `workspace:${f.workspace}`, mode: "write" }])!;
  expect(release).toBeDefined();
  const { run, tasks } = await host.submit({ commandId: "busy", namespace: "coding", objective: "Read", adapter: await codingTask(config(f)) });
  try { await until(host, () => !!host.store.record("resource-wait", tasks[0]!.taskId)); expect(requests).toBe(0); } finally { release(); }
  await until(host, () => host.store.getRun(run.runId)?.status === "succeeded"); expect(requests).toBe(1);
});

test("disabled coding has no fallback and a changed plugin generation cannot resume its question", async () => {
  const f = await fixture(); let requests = 0;
  const builtin = await plugin(f, factory(f, { async *stream() {
    if (++requests === 1) yield* call("durable_wait", { kind: "question", key: "choice", question: "Continue?", options: ["A", "B"], about: "Read complete" }); else yield* report();
  } }));
  let host = await open(f, builtin, false);
  await expect(host.submit({ commandId: "disabled", namespace: "coding", objective: "Read", adapter: await codingTask(config(f)) })).rejects.toThrow("unavailable");
  expect(requests).toBe(0); await host.close();
  host = await open(f, builtin);
  const { run, tasks } = await host.submit({ commandId: "wait", namespace: "coding", objective: "Ask", adapter: await codingTask(config(f)) });
  await until(host, () => host.store.getTask(tasks[0]!.taskId)?.status === "waiting"); const wait = host.runtime.waits.questions(run.runId)[0]!; await host.close();
  host = await open(f, { ...builtin, identity: { ...builtin.identity, fingerprint: "b".repeat(64) } });
  expect(host.store.getRun(run.runId)!.status).toBe("paused"); await expect(host.runtime.resume(run.runId)).rejects.toThrow("identity changed"); await host.close();
  host = await open(f, builtin); await host.runtime.resume(run.runId);
  host.runtime.waits.answer({ commandId: "answer", runId: run.runId, waitId: wait.waitId, expectedVersion: wait.version, answer: "A" });
  await until(host, () => host.store.getRun(run.runId)?.status === "succeeded"); expect(requests).toBe(2);
});

test("a legacy coding candidate without domain metadata retains its task, snapshot digest and original configuration", async () => {
  const f = await fixture(); const store = new RuntimeStore(join(f.state, "state.sqlite"));
  const configuration = { ...config(f), strategyVersion: 1 as const, maxTurns: 10, maxRetries: 0, compactThreshold: 10000, maxModelRequests: 256 };
  const commands = new RuntimeCommands(store), artifacts = new RuntimeArtifacts(join(f.state, "artifacts"));
  const { run, tasks } = commands.createRun({ commandId: "legacy", objective: "Legacy report", configuration,
    policy: { mode: "auto", maxActiveAgents: 4, maxDelegationDepth: 2 }, source: { inputId: "legacy", rawText: "Legacy report", workspace: f.workspace, source: "api" } });
  const task = tasks[0]!, { attempt } = commands.startAttempt({ commandId: "attempt", taskId: task.taskId, expectedRevision: task.revision, ownerId: "old-owner", leaseMs: 60000 });
  const candidateRef = await artifacts.put({ report: "Original pre-plugin candidate", inputDigest: (await workspaceManifest(f.workspace)).digest });
  commands.finishAttempt({ commandId: "candidate", taskId: task.taskId, expectedRevision: store.getTask(task.taskId)!.revision,
    worker: { attemptId: attempt.attemptId, ownerId: attempt.ownerId, epoch: attempt.epoch }, next: "validating", candidateRef, checkpointRef: "original-checkpoint" });
  store.close();
  const host = await open(f, await plugin(f, factory(f, { async *stream() { throw new Error("Legacy validation must not re-run the model"); } })));
  await until(host, () => host.store.getRun(run.runId)?.status === "succeeded");
  expect(host.store.getTask(task.taskId)!.checkpointRef).toBe("original-checkpoint");
  expect(host.store.record("configuration", run.runId)!.value).toEqual(configuration);
  expect(await host.runtime.artifacts.get(host.store.getTask(task.taskId)!.resultRef!)).toMatchObject({ report: "Original pre-plugin candidate", acceptance: "report-delivered" });
  expect((await host.runtime.submit({ commandId: "legacy", objective: "Legacy report", configuration })).run.runId).toBe(run.runId);
  await expect(host.runtime.submit({ commandId: "legacy", objective: "Changed objective", configuration })).rejects.toThrow("different input");
  expect(host.store.runs()).toHaveLength(1);
});

test("a bundled installed coding package preserves real read receipts and question identity across an upgrade", async () => {
  const f = await fixture(), source = join(f.root, "package"), plugins = join(f.root, "plugins"); await mkdir(source);
  const bundle = await Bun.build({ entrypoints: [fileURLToPath(new URL("../../src/adapters/coding/plugin.ts", import.meta.url))], target: "bun", outdir: source, naming: "index.mjs" });
  expect(bundle.success).toBe(true);
  await cp(new URL("../../src/adapters/coding/plugin.json", import.meta.url), join(source, "plugin.json"));
  await cp(new URL("../../src/services/skills/bundled", import.meta.url), join(source, "bundled"), { recursive: true });
  const installed = await installLocalPlugin({ source, targetRoot: plugins, sourceType: "user" }); await trustPlugin(join(f.configDir, "trust.json"), installed.root);
  let requests = 0;
  const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { tools: Array<{ function: { name: string } }>; messages: unknown[] };
    expect(body.tools.some(tool => ["write", "edit", "bash"].includes(tool.function.name))).toBe(false);
    expect(body.tools.some(tool => tool.function.name === "skill")).toBe(true);
    const step = ++requests, first = step === 1;
    if (!first) expect(JSON.stringify(body.messages)).toContain("actual workspace evidence");
    const delta = first ? { tool_calls: [{ index: 0, id: "read-file", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "source.txt" }) } }] }
      : step === 2 ? { tool_calls: [{ index: 0, id: "question", type: "function", function: { name: "durable_wait", arguments: JSON.stringify({ kind: "question", key: "continue", question: "Continue?", options: ["A", "B"], about: "Read evidence; waiting for a decision before the final report" }) } }] }
      : { content: "Verified actual workspace evidence" };
    const events = [{ choices: [{ index: 0, delta, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: step <= 2 ? "tool_calls" : "stop" }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } }];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } }); cleanup.push(() => model.stop(true));
  await writeFile(join(f.configDir, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: `${model.url}v1`, models: [{ id: "fixture", maxTokens: 1024 }] } } }));
  const skill = join(f.configDir, "skills", "inspect"); await mkdir(skill, { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "---\nname: inspect\ndescription: Inspect evidence\ncontext: inline\n---\nRead source.txt.\n");
  const options = { directory: f.state, legacyAdapterId: "coding", plugins: { roots: [{ directory: plugins, source: "user" as const }], trustStorePath: join(f.configDir, "trust.json"),
    configuration: { "tnb-coding": { configDir: f.configDir, env: f.env } } } };
  const host = await openAgentRuntime(options); cleanup.push(() => host.close());
  const input = { commandId: "installed", namespace: "coding", objective: "Read source.txt", adapter: await codingTask({ ...config(f), provider: "fixture", model: "fixture", skills: ["inspect"] }), mode: "single" as const };
  const { run, tasks } = await host.submit(input); await until(host, () => host.store.getTask(tasks[0]!.taskId)?.status === "waiting");
  const wait = host.runtime.waits.questions(run.runId)[0]!, originalPlugin = host.runtime.configuration(run.runId).domain!.plugin!;
  expect(host.plugins.list()[0]!.root).toBe(installed.root); expect(requests).toBe(2); await host.close();
  await writeFile(join(installed.root, "index.mjs"), await readFile(join(installed.root, "index.mjs"), "utf8") + "\n// installed package upgrade\n");
  await trustPlugin(join(f.configDir, "trust.json"), installed.root);
  const reopened = await openAgentRuntime(options); cleanup.push(() => reopened.close());
  expect((await reopened.submit(input)).run.runId).toBe(run.runId); expect(requests).toBe(2);
  expect(reopened.plugins.list().find(item => item.generation === "retained")?.status).toBe("active");
  expect(reopened.runtime.configuration(run.runId).domain!.plugin).toEqual(originalPlugin);
  expect(reopened.runtime.waits.questions(run.runId)[0]!.waitId).toBe(wait.waitId);
  reopened.runtime.waits.answer({ commandId: "answer-installed", runId: run.runId, waitId: wait.waitId, expectedVersion: wait.version, answer: "A" });
  await until(reopened, () => reopened.store.getRun(run.runId)?.status === "succeeded"); expect(requests).toBe(3); await reopened.close();
  const terminal = await openAgentRuntime(options); cleanup.push(() => terminal.close());
  expect(terminal.plugins.list().find(item => item.generation === "retained")?.status).toBe("inactive");
  expect((await terminal.submit(input)).run.runId).toBe(run.runId); expect(requests).toBe(3);
});

test("the public durable engine has no dependency on coding tools, model configuration or sandbox composition", async () => {
  const bundle = await Bun.build({ entrypoints: [fileURLToPath(new URL("../../src/services/runtime/engine-core.ts", import.meta.url))], target: "bun", metafile: true });
  expect(bundle.success).toBe(true);
  const inputs = Object.keys(bundle.metafile!.inputs);
  expect(inputs.filter(path => /adapters\/coding|tools\/(builtins|shell)|services\/(sandbox|settings)|providers\/(config|factory)|\/ui\//.test(path))).toEqual([]);
});

test("plugin preparation and failing resource cleanup cannot escape the runtime lifecycle", async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const adapter = { id: "preparing", version: "1", validate() {}, runtime: { async normalize() { entered.resolve(); await release.promise; } },
    async snapshot() { return 1; }, async accept() { return { checks: [{ command: "fact", output: "ok" }] }; },
    async createWorker(): Promise<never> { throw new Error("No worker should start"); } };
  const host = await openAgentRuntime({ directory: f.state, adapters: [adapter] }); cleanup.push(() => host.close());
  const pending = host.submit({ commandId: "late", namespace: "test", objective: "Prepare", adapter: { id: "preparing", version: "1", config: {}, resources: [{ id: "test", mode: "read" }], grants: [] } });
  const outcome = pending.then(() => new Error("Unexpected accepted submission"), error => error as Error);
  await entered.promise; await host.close(); release.resolve(); expect((await outcome).message).toContain("closed");
  const reopened = await openAgentRuntime({ directory: f.state, adapters: [adapter] }); cleanup.push(() => reopened.close());
  expect(reopened.store.runs()).toHaveLength(0);
  await reopened.close();
  const hostWithFailedCleanup = await openAgentRuntime({ directory: f.state, adapters: [{ ...adapter,
    runtime: { async normalize() {}, async acquire() { return async () => { throw new Error("Plugin resource release failed"); }; } },
    async createWorker() { return { model: "fixture", route: { provider: "fixture", model: "fixture" }, maxOutputTokens: 100,
      tools: [], authorize: async () => ({ behavior: "allow" as const }), transport: { async *stream() { yield* report(); } } }; },
  }] }); cleanup.push(() => hostWithFailedCleanup.close());
  await hostWithFailedCleanup.submit({ commandId: "cleanup", namespace: "test", objective: "Release", adapter: { id: "preparing", version: "1", config: {}, resources: [{ id: "test", mode: "read" }], grants: [] } });
  await until(hostWithFailedCleanup, () => !!hostWithFailedCleanup.runtime.lastError);
  expect(hostWithFailedCleanup.runtime.lastError).toContain("Plugin resource release failed");
  const resource = tryAcquireResources([{ id: "test", mode: "write" }]); expect(resource).toBeDefined(); resource!();
  await hostWithFailedCleanup.close();
});
