import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadHostPlugins, type BuiltinAdapterPlugin } from "../../src/agent/plugins";
import { packPlugin, unpackPlugin } from "../../src/agent/packed-plugin";
import { builtinGenerationAuthority } from "../../src/agent/builtin-generations";
import { pluginGenerationKey, pluginGenerationReferences } from "../../src/agent/plugin-generations";
import { DomainRegistry, type DomainDescriptor } from "../../src/agent/domain";
import { RuntimeStore } from "../../src/services/runtime/store";
import { RuntimeCommands } from "../../src/services/runtime/commands";
import { openAgentRuntime, type AgentRuntimeHost } from "../../src/agent/runtime";
import { installLocalPlugin } from "../../src/services/plugins/management";
import { trustPlugin } from "../../src/services/plugins/trust";
import { createCodingPlugin } from "../../src/adapters/coding/plugin";
import { codingTask } from "../../src/adapters/coding/adapter";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const ownerTest = test.skipIf(process.platform === "win32");
const descriptor = (wait = true): DomainDescriptor => ({ id: "fixture", version: "1", config: { wait }, resources: [{ id: "fixture/document", mode: "read" }], grants: [{ name: "read", resources: ["fixture/document"], mode: "read" }] });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tnb-builtin-generation-")); cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const source = join(root, "source"), plugins = join(root, "plugins"), trace = join(root, "trace"); await mkdir(source); await mkdir(plugins);
  const manifest = { name: "builtin-fixture", version: "1.0.0", manifestVersion: 2, apiVersion: "tnb.plugin/v1", contributes: { adapters: [{ id: "fixture", version: "1", entry: "index.mjs" }] } };
  await writeFile(join(source, "plugin.json"), JSON.stringify(manifest));
  const original = await readFile(new URL("../fixtures/agent-domain-plugin.mjs", import.meta.url), "utf8");
  await writeFile(join(source, "index.mjs"), original); await writeFile(join(source, "settings.json"), JSON.stringify({ trace }));
  async function builtin(text = original): Promise<BuiltinAdapterPlugin> {
    await writeFile(join(source, "index.mjs"), text); const packed = await packPlugin(source);
    return { identity: { name: manifest.name, version: manifest.version, fingerprint: packed.fingerprint }, package: packed,
      adapters: [{ id: "fixture", version: "1" }], setup() { throw new Error("Inline factory must never run for a packaged builtin"); } };
  }
  const options = { roots: [{ directory: plugins, source: "user" as const }], trustStorePath: join(root, "trust.json"), channelReferences: [] };
  async function open(value: BuiltinAdapterPlugin, extra = {}) {
    const host = await openAgentRuntime({ directory: join(root, "control/runtime"), plugins: { ...options, builtins: [value], ...extra } }); cleanup.push(() => host.close()); return host;
  }
  const events = async () => (await readFile(trace, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  return { root, source, plugins, options, original, builtin, open, events };
}
async function until(host: AgentRuntimeHost, predicate: () => boolean) {
  const end = Date.now() + 8000;
  while (!predicate()) { if (Date.now() > end) throw new Error(JSON.stringify({ runs: host.store.runs(), tasks: host.store.runs().flatMap(run => host.store.tasks(run.runId)) })); await host.runtime.tick(); await Bun.sleep(10); }
}

test("packaged builtins execute their archived bytes, require independent host approval, and honor exact fingerprint blocks", async () => {
  const f = await fixture(), first = await f.builtin(), store = new RuntimeStore(":memory:"); cleanup.push(async () => store.close());
  const snapshot = join(f.root, "state", "plugin-snapshots"), authority = builtinGenerationAuthority(store);
  expect(authority.inspect?.(first.identity)).toBe("missing");
  async function load(value: BuiltinAdapterPlugin, extra = {}) {
    const host = await loadHostPlugins({ ...f.options, builtins: [value], builtinAuthority: authority, generationReferences: pluginGenerationReferences(store), ...extra }, [], snapshot);
    cleanup.push(() => host.close()); return host;
  }
  let host = await load(first); expect(host.list()[0], JSON.stringify(host.list())).toMatchObject({ status: "active", root: "builtin:builtin-fixture" });
  expect(authority.approved(first.identity)).toBe(true);
  expect(authority.inspect?.(first.identity)).toBe("approved");
  const pinned = new DomainRegistry([], host.registrations).prepare(descriptor()), commands = new RuntimeCommands(store);
  commands.createRun({ commandId: "keep", objective: "Keep old code", configuration: { domain: pinned } }); await host.close();
  const second = await f.builtin(f.original.replaceAll("actual plugin fact", "updated plugin fact"));
  host = await load(second); expect(host.list().map(item => [item.generation, item.status]), JSON.stringify(host.list())).toEqual([["current", "active"], ["retained", "active"]]);
  const registry = new DomainRegistry([], host.registrations); expect(registry.prepare(descriptor()).plugin).toEqual(second.identity); expect(registry.resolve(pinned).id).toBe("fixture"); await host.close();
  host = await load(second, { blockedFingerprints: [first.identity.fingerprint] }); expect(host.list().find(item => item.generation === "retained")?.error).toContain("blocked by host policy"); await host.close();
  host = await load(second, { enabled: { "builtin-fixture": false } }); expect(host.list().find(item => item.generation === "retained")?.status).toBe("blocked"); await host.close();
  host = await load(second, { builtinAuthority: { approved: () => false, approve() {} } }); expect(host.list().find(item => item.generation === "retained")?.error).toContain("approval or recovery ABI"); await host.close();
  const emptyApprovals = new RuntimeStore(":memory:"); cleanup.push(async () => emptyApprovals.close());
  host = await load(second, { builtinAuthority: builtinGenerationAuthority(emptyApprovals) });
  const evidence = emptyApprovals.snapshot();
  expect((await host.checkRecovery({ generationReferences: pluginGenerationReferences(store), channelReferences: [] })).generations[0]?.diagnostics[0]?.code).toBe("PLUGIN_BUILTIN_APPROVAL_MISSING");
  expect(emptyApprovals.snapshot()).toEqual(evidence); expect(emptyApprovals.applicationRecord("host.builtin-generations", pluginGenerationKey(first.identity))).toBeUndefined();
  await host.close();
  const approval = store.applicationRecord<{ identity: unknown; abi: { bun: string } }>("host.builtin-generations", pluginGenerationKey(first.identity))!;
  store.command("abi-change", {}, Date.now(), tx => tx.saveApplicationRecord({ ...approval, value: { ...approval.value, abi: { ...approval.value.abi, bun: "incompatible" } } }, approval.revision));
  host = await load(second); expect(host.list().find(item => item.generation === "retained")?.error).toContain("approval or recovery ABI");
  expect(authority.inspect?.(first.identity)).toBe("abi-incompatible");
  expect((await host.checkRecovery({ generationReferences: pluginGenerationReferences(store), channelReferences: [] })).generations[0]?.diagnostics[0]?.code).toBe("PLUGIN_BUILTIN_ABI_INCOMPATIBLE");
  expect(host.list().find(item => item.generation === "retained")?.recoveryDiagnostic?.code).toBe("PLUGIN_BUILTIN_ABI_INCOMPATIBLE");
  await host.close();
  const archive = join(f.root, "state", "plugin-generations", pluginGenerationKey(first.identity), "package", "index.mjs");
  await writeFile(archive, "throw new Error('tampered old builtin must not execute');");
  host = await load(second); expect(host.list().find(item => item.generation === "retained")?.error).toContain("fingerprint mismatch"); await host.close();
});

test("packed builtin paths cannot escape their private directory and executable bytes must match the host fingerprint", async () => {
  const f = await fixture(), value = await f.builtin(), target = join(f.root, "unpack");
  await expect(unpackPlugin({ fingerprint: value.identity.fingerprint, files: { "../outside.mjs": "eA==" } }, target)).rejects.toThrow("Invalid packed plugin file");
  const changed = { ...value.package!, files: { ...value.package!.files, "index.mjs": Buffer.from("throw new Error('unapproved')").toString("base64") } };
  await expect(unpackPlugin(changed, target)).rejects.toThrow("fingerprint mismatch");
  expect(await readFile(join(f.root, "outside.mjs")).catch(() => undefined)).toBeUndefined();
});

test("source-host Coding package identity is independent of the caller's working directory", async () => {
  const f = await fixture();
  const module = new URL("../../src/adapters/coding/recovery-package.ts", import.meta.url).href;
  const script = `import {buildCodingRecoveryPackage} from ${JSON.stringify(module)};console.log((await buildCodingRecoveryPackage()).fingerprint);`;
  const fingerprint = async (cwd: string) => {
    const child = Bun.spawn([process.execPath, "-e", script], { cwd, stdout: "pipe", stderr: "pipe" });
    const [exit, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit, error).toBe(0); return output.trim();
  };
  const [first, second] = await Promise.all([fingerprint(process.cwd()), fingerprint(f.root)]);
  expect(first).toMatch(/^[a-f0-9]{64}$/); expect(second).toBe(first);
});

test("builtin archives cannot bypass an installed package's selection, and identical approved bytes can retain both origins", async () => {
  const f = await fixture(), builtin = await f.builtin(), store = new RuntimeStore(":memory:"); cleanup.push(async () => store.close());
  const snapshot = join(f.root, "state", "plugin-snapshots"), authority = builtinGenerationAuthority(store);
  const options = () => ({ ...f.options, builtins: [builtin], builtinAuthority: authority, generationReferences: pluginGenerationReferences(store) });
  let host = await loadHostPlugins(options(), [], snapshot); cleanup.push(() => host.close());
  const pinned = new DomainRegistry([], host.registrations).prepare(descriptor());
  new RuntimeCommands(store).createRun({ commandId: "keep", objective: "Keep", configuration: { domain: pinned } }); await host.close();
  const installed = await installLocalPlugin({ source: f.source, targetRoot: f.plugins, sourceType: "user" });
  host = await loadHostPlugins(options(), [], snapshot); cleanup.push(() => host.close());
  expect(host.list().some(item => item.root === "builtin:builtin-fixture" && item.status === "active")).toBe(false);
  expect(host.registrations).toHaveLength(0); await host.close();
  await trustPlugin(f.options.trustStorePath, installed.root);
  host = await loadHostPlugins(options(), [], snapshot); cleanup.push(() => host.close());
  expect(host.list()[0], JSON.stringify(host.list())).toMatchObject({ status: "active", root: installed.root }); await host.close();
  const metadata = JSON.parse(await readFile(join(f.root, "state", "plugin-generations", pluginGenerationKey(builtin.identity), "generation.json"), "utf8"));
  expect(metadata.origins).toEqual(expect.arrayContaining(["builtin:builtin-fixture", installed.root]));
  await rm(installed.root, { recursive: true });
  host = await loadHostPlugins(options(), [], snapshot); cleanup.push(() => host.close());
  expect(host.list()[0], JSON.stringify(host.list())).toMatchObject({ status: "active", root: "builtin:builtin-fixture" }); await host.close();
});

test("case-insensitive installed package selection also blocks retained builtin code", async () => {
  const f = await fixture(), builtin = await f.builtin(), store = new RuntimeStore(":memory:"); cleanup.push(async () => store.close());
  const snapshot = join(f.root, "state", "plugin-snapshots"), authority = builtinGenerationAuthority(store);
  let host = await loadHostPlugins({ ...f.options, builtins: [builtin], builtinAuthority: authority, generationReferences: [] }, [], snapshot); cleanup.push(() => host.close());
  const pinned = new DomainRegistry([], host.registrations).prepare(descriptor());
  new RuntimeCommands(store).createRun({ commandId: "case-sensitive", objective: "Keep original", configuration: { domain: pinned } }); await host.close();
  const manifestPath = join(f.source, "plugin.json"), manifest = JSON.parse(await readFile(manifestPath, "utf8")); manifest.name = "BUILTIN-FIXTURE";
  await writeFile(manifestPath, JSON.stringify(manifest)); await installLocalPlugin({ source: f.source, targetRoot: f.plugins, sourceType: "user" });
  host = await loadHostPlugins({ ...f.options, builtins: [builtin], builtinAuthority: authority, generationReferences: pluginGenerationReferences(store) }, [], snapshot); cleanup.push(() => host.close());
  expect(host.registrations).toHaveLength(0); expect(host.list().find(item => item.generation === "retained")?.status).toBe("blocked");
  expect((await f.events()).filter(item => item === "import")).toHaveLength(1); await host.close();
});

test("unreferenced or terminal builtin history is never executed and collection follows explicit Run pruning", async () => {
  const f = await fixture(), first = await f.builtin(), store = new RuntimeStore(":memory:"); cleanup.push(async () => store.close());
  const snapshot = join(f.root, "state", "plugin-snapshots"), authority = builtinGenerationAuthority(store);
  const load = async (builtin: BuiltinAdapterPlugin) => { const host = await loadHostPlugins({ ...f.options, builtins: [builtin], builtinAuthority: authority, generationReferences: pluginGenerationReferences(store) }, [], snapshot); cleanup.push(() => host.close()); return host; };
  let host = await load(first); const pinned = new DomainRegistry([], host.registrations).prepare(descriptor());
  const { run } = new RuntimeCommands(store).createRun({ commandId: "terminal", objective: "Terminal evidence", configuration: { domain: pinned } });
  store.command("finish-terminal", { action: "finish" }, Date.now(), tx => { const value = tx.getRun(run.runId)!; tx.saveRun({ ...value, status: "cancelled", revision: value.revision + 1 }, value.revision); return true; }); await host.close();
  const second = await f.builtin(f.original + "\n// next generation\n");
  host = await load(second); expect(host.list().find(item => item.generation === "retained")?.status).toBe("inactive"); expect((await f.events()).filter(item => item === "import")).toHaveLength(2); await host.close();
  store.deleteTerminalRun(run.runId); host = await load(second);
  expect(await readdir(join(f.root, "state", "plugin-generations"))).not.toContain(pluginGenerationKey(first.identity)); await host.close();
});

ownerTest("upgrading a packaged builtin preserves the same question and old implementation while new tasks use the new code", async () => {
  const f = await fixture(), first = await f.builtin(); let host = await f.open(first);
  const input = { commandId: "wait", objective: "Wait", namespace: "fixture", adapter: descriptor(), mode: "single" as const };
  const { run, tasks } = await host.submit(input); await until(host, () => host.store.getTask(tasks[0]!.taskId)?.status === "waiting");
  const wait = host.runtime.waits.questions(run.runId)[0]!; await host.close();
  const next = await f.builtin(f.original.replaceAll("actual plugin fact", "updated plugin fact")); host = await f.open(next);
  expect((await host.submit(input)).run.runId).toBe(run.runId);
  expect(host.runtime.waits.questions(run.runId)[0]!.waitId).toBe(wait.waitId);
  expect(host.runtime.configuration(run.runId).domain!.plugin).toEqual(first.identity);
  expect(host.plugins.list().find(item => item.generation === "retained")?.status).toBe("active");
  const current = await host.submit({ commandId: "new", objective: "Current", namespace: "fixture", adapter: descriptor(false), mode: "single" });
  host.runtime.waits.answer({ commandId: "answer", runId: run.runId, waitId: wait.waitId, expectedVersion: wait.version, answer: "A" });
  await until(host, () => host.store.getRun(run.runId)?.status === "succeeded" && host.store.getRun(current.run.runId)?.status === "succeeded");
  expect((await host.runtime.artifacts.get<{ report: string }>(host.store.getTask(tasks[0]!.taskId)!.resultRef!)).report).toContain("actual plugin fact");
  expect((await host.runtime.artifacts.get<{ report: string }>(host.store.getTask(current.tasks[0]!.taskId)!.resultRef!)).report).toContain("updated plugin fact");
  expect((await f.events()).filter(item => item === "tool")).toHaveLength(2);
});

ownerTest("real default Coding preserves archived tools and bundled skill pins after its executable package changes", async () => {
  const f = await fixture(), configDir = join(f.root, "config"), workspace = join(f.root, "work"); await mkdir(configDir); await mkdir(workspace);
  await writeFile(join(workspace, "evidence.txt"), "real builtin recovery evidence");
  let requests = 0;
  const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { messages: unknown[]; tools: Array<{ function: { name: string } }> };
    const step = ++requests, content = JSON.stringify(body.messages);
    expect(body.tools.some(tool => tool.function.name === "skill")).toBe(true);
    if (step <= 3) expect(content).toContain("You are a coding agent executing an authorized durable task.");
    else expect(content).toContain("You are a NEW coding agent executing an authorized durable task.");
    if (step === 2 || step === 3) expect(content).toContain("real builtin recovery evidence");
    const tool = step === 1 ? { name: "read", input: { path: "evidence.txt" } } : step === 2 ? { name: "durable_wait", input: { kind: "question", key: "continue", question: "Continue?", options: ["A", "B"], about: "Read evidence, waiting for a decision" } } : undefined;
    const delta = tool ? { tool_calls: [{ index: 0, id: `tool-${step}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.input) } }] } : { content: step === 3 ? "Original builtin report" : "New builtin report" };
    const events = [{ choices: [{ index: 0, delta, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } }];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } }); cleanup.push(() => model.stop(true));
  await writeFile(join(configDir, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: `${model.url}v1`, models: [{ id: "fixture", maxTokens: 1024 }] } } }));
  const first = await createCodingPlugin({ configDir, runtimeRoot: join(f.root, "control/runtime"), env: {} });
  expect(first.package).toBeDefined();
  const adapter = await codingTask({ workspace, allowedWorkspaces: [workspace], allowWrite: false, allowShell: false, checks: [], provider: "fixture", model: "fixture", skills: ["docs-writer"] });
  let host = await f.open(first); const input = { commandId: "coding", objective: "Inspect evidence", namespace: "coding", adapter, mode: "single" as const };
  const { run, tasks } = await host.submit(input); await until(host, () => host.store.getTask(tasks[0]!.taskId)?.status === "waiting");
  const wait = host.runtime.waits.questions(run.runId)[0]!, pins = host.runtime.configuration(run.runId).capabilityPins;
  expect(pins?.["skill:docs-writer"]).toMatch(/^[a-f0-9]{64}$/); await host.close();
  const nextRoot = join(f.root, "next-package"); await mkdir(nextRoot);
  for (const [name, data] of Object.entries(first.package!.files)) {
    const path = join(nextRoot, name); await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, name === "index.mjs" ? Buffer.from(data, "base64").toString("utf8").replaceAll("You are a coding agent executing an authorized durable task.", "You are a NEW coding agent executing an authorized durable task.") : Buffer.from(data, "base64"));
  }
  const packed = await packPlugin(nextRoot), second = { ...first, identity: { ...first.identity, fingerprint: packed.fingerprint }, package: packed };
  expect(second.identity.fingerprint).not.toBe(first.identity.fingerprint);
  host = await f.open(second); expect(host.runtime.configuration(run.runId).capabilityPins).toEqual(pins);
  expect(host.runtime.waits.questions(run.runId)[0]!.waitId).toBe(wait.waitId);
  expect((await host.submit(input)).run.runId).toBe(run.runId);
  host.runtime.waits.answer({ commandId: "coding-answer", runId: run.runId, waitId: wait.waitId, expectedVersion: wait.version, answer: "A" });
  await until(host, () => host.store.getRun(run.runId)?.status === "succeeded"); expect(requests).toBe(3);
  const current = await host.submit({ ...input, commandId: "new-coding", objective: "Use new code" });
  await until(host, () => host.store.getRun(current.run.runId)?.status === "succeeded"); expect(requests).toBe(4);
  expect(host.runtime.configuration(current.run.runId).domain!.plugin).toEqual(second.identity);
});
