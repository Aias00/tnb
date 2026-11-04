import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openAgentRuntime, type AgentRuntimeHost } from "../../src/agent/runtime";
import { loadAdapterPlugins } from "../../src/agent/plugins";
import type { DomainDescriptor } from "../../src/agent/domain";
import { loadPlugins } from "../../src/services/plugins/loader";
import { installLocalPlugin } from "../../src/services/plugins/management";
import { trustPlugin, computePluginTreeSha256, revokePluginTrust } from "../../src/services/plugins/trust";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(settings: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "tnb-plugin-agent-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const plugins = join(root, "plugins"), source = join(root, "source"), trace = join(root, "trace"), trust = join(root, "trust.json");
  await mkdir(source); await mkdir(plugins);
  const manifest = { name: "fixture-plugin", version: "1.0.0", manifestVersion: 2, apiVersion: "tnb.plugin/v1",
    contributes: { adapters: [{ id: settings.id ?? "fixture", version: "1", entry: "index.mjs" }] } };
  await writeFile(join(source, "plugin.json"), JSON.stringify(manifest));
  await cp(new URL("../fixtures/agent-domain-plugin.mjs", import.meta.url), join(source, "index.mjs"));
  await writeFile(join(source, "settings.json"), JSON.stringify({ trace, ...settings }));
  const installed = await installLocalPlugin({ source, targetRoot: plugins, sourceType: "user" });
  const installedRoot = installed.root;
  const options = { roots: [{ directory: plugins, source: "user" as const }], trustStorePath: trust };
  const events = async () => (await readFile(trace, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  async function open() { const host = await openAgentRuntime({ directory: join(root, "runtime"), plugins: options }); cleanup.push(() => host.close()); return host; }
  return { root, plugins, source, installedRoot, trace, trust, options, events, open, manifest };
}
const descriptor = (config: DomainDescriptor["config"] = {}): DomainDescriptor => ({ id: "fixture", version: "1", config,
  resources: [{ id: "fixture/document", mode: "read" }], grants: [{ name: "read", resources: ["fixture/document"], mode: "read" }] });
async function until(host: AgentRuntimeHost, predicate: () => boolean) {
  const end = Date.now() + 8000;
  while (!predicate()) { if (Date.now() > end) throw new Error(`Timed out: ${JSON.stringify(host.store.runs())}; ${JSON.stringify(host.store.runs().flatMap(run => host.store.tasks(run.runId)))}`); await host.runtime.tick(); await Bun.sleep(10); }
}

test("existing installation discovers adapters and forces restart lifecycle; untrusted/disabled code is never imported", async () => {
  const f = await fixture();
  const discovered = await loadPlugins(f.options.roots);
  expect(discovered.plugins[0]!.lifecycle.reload).toBe("restart");
  expect(discovered.plugins[0]!.contributionSummary.adapters).toEqual(["fixture@1"]);
  let host = await f.open(); expect(host.plugins.list()[0]!.status).toBe("blocked"); expect(await f.events()).toEqual([]); await host.close();
  await trustPlugin(f.trust, f.installedRoot);
  host = await openAgentRuntime({ directory: join(f.root, "disabled-runtime"), plugins: { ...f.options, enabled: { "fixture-plugin": false } } });
  try { expect(host.plugins.list()[0]!.status).toBe("inactive"); expect(await f.events()).toEqual([]); } finally { await host.close(); }
  await writeFile(join(f.installedRoot, "extra"), "changed");
  host = await f.open(); expect(host.plugins.list()[0]!.trust).toBe("changed"); expect(await f.events()).toEqual([]);
});

test("factory failure rolls back every registration and disposes callbacks in reverse order", async () => {
  const f = await fixture({ fail: true }); await trustPlugin(f.trust, f.installedRoot);
  const host = await f.open();
  expect(host.plugins.list()[0]).toMatchObject({ status: "failed", error: expect.stringContaining("Factory failed") });
  await expect(host.submit({ commandId: "bad", objective: "Report", namespace: "fixture", adapter: descriptor() })).rejects.toThrow("unavailable");
  expect(await f.events()).toEqual(["import", "dispose-last", "dispose-first"]);
  await host.close(); expect(await f.events()).toEqual(["import", "dispose-last", "dispose-first"]);
});

test("a failed plugin remains visible while an independent plugin activates", async () => {
  const f = await fixture({ fail: true }), healthy = await fixture({ id: "healthy" });
  healthy.manifest.name = "healthy-plugin";
  await writeFile(join(healthy.installedRoot, "plugin.json"), JSON.stringify(healthy.manifest));
  await trustPlugin(f.trust, f.installedRoot); await trustPlugin(f.trust, healthy.installedRoot);
  const host = await openAgentRuntime({ directory: join(f.root, "runtime"), plugins: { ...f.options, roots: [...f.options.roots, ...healthy.options.roots] } });
  try {
    expect(host.plugins.list().map(plugin => [plugin.name, plugin.status])).toEqual([["fixture-plugin", "failed"], ["healthy-plugin", "active"]]);
    expect(host.runtime.domains.prepare({ ...descriptor(), id: "healthy" }).plugin?.name).toBe("healthy-plugin");
  } finally { await host.close(); }
});

test("trusted installed adapter executes tools, pins provenance, waits, restarts and resumes the original task", async () => {
  const f = await fixture(); await trustPlugin(f.trust, f.installedRoot);
  const first = await f.open();
  const input = { commandId: "create", objective: "Read evidence then ask", namespace: "fixture", adapter: descriptor({ wait: true }), mode: "single" as const };
  const { run, tasks } = await first.submit(input);
  await until(first, () => first.store.getTask(tasks[0]!.taskId)?.status === "waiting");
  expect(first.runtime.configuration(run.runId).domain!.plugin).toEqual({ name: "fixture-plugin", version: "1.0.0", fingerprint: await computePluginTreeSha256(f.installedRoot) });
  const wait = first.runtime.waits.questions(run.runId)[0]!; await first.close();
  const second = await f.open();
  expect((await second.submit(input)).run.runId).toBe(run.runId);
  expect(second.runtime.waits.questions(run.runId)[0]!.waitId).toBe(wait.waitId);
  second.runtime.waits.answer({ commandId: "answer", runId: run.runId, waitId: wait.waitId, expectedVersion: wait.version, answer: "A" });
  await until(second, () => second.store.getRun(run.runId)?.status === "succeeded");
  expect(second.store.tasks(run.runId)[0]!.taskId).toBe(tasks[0]!.taskId);
  expect((await f.events()).filter(event => event === "tool")).toHaveLength(1);
  const result = await second.runtime.artifacts.get<{ acceptance: string }>(second.store.getTask(tasks[0]!.taskId)!.resultRef!);
  expect(result.acceptance).toBe("domain-verified");
});

test("a trusted replacement with the same adapter/package versions cannot resume a pinned run; restoring bytes can", async () => {
  const f = await fixture(); await trustPlugin(f.trust, f.installedRoot);
  let host = await f.open(); const { run, tasks } = await host.submit({ commandId: "create", objective: "Wait", namespace: "fixture", adapter: descriptor({ wait: true }) });
  await until(host, () => host.store.getTask(tasks[0]!.taskId)?.status === "waiting"); await host.close();
  const entry = join(f.installedRoot, "index.mjs"), original = await readFile(entry, "utf8");
  await writeFile(entry, original + "\n// new implementation, unchanged version\n"); await trustPlugin(f.trust, f.installedRoot);
  host = await f.open(); expect(host.plugins.list()[0]!.status).toBe("active"); expect(host.store.getRun(run.runId)!.status).toBe("paused");
  await expect(host.runtime.resume(run.runId)).rejects.toThrow("identity changed"); await host.close();
  await writeFile(entry, original); await trustPlugin(f.trust, f.installedRoot);
  host = await f.open(); await host.runtime.resume(run.runId);
  expect(host.store.getRun(run.runId)!.status).toBe("active");
  const wait = host.runtime.waits.questions(run.runId)[0]!;
  host.runtime.waits.answer({ commandId: "answer", runId: run.runId, waitId: wait.waitId, expectedVersion: wait.version, answer: "A" });
  await until(host, () => host.store.getRun(run.runId)?.status === "succeeded");
});

test("shutdown drains workers before disposers, concurrent close is shared and ownership lasts through cleanup", async () => {
  const f = await fixture(); await trustPlugin(f.trust, f.installedRoot);
  const host = await f.open(); await host.submit({ commandId: "hold", objective: "Hold", namespace: "fixture", adapter: descriptor({ hold: true }) });
  const end = Date.now() + 8000;
  while (!(await f.events()).includes("model")) { if (Date.now() > end) throw new Error("Worker did not start"); await Bun.sleep(10); }
  const runtimeClosing = host.runtime.close();
  const first = host.close(), second = host.close(); expect(first).toBe(second); await Promise.all([runtimeClosing, first]);
  const events = await f.events(); expect(events.indexOf("worker-aborted")).toBeLessThan(events.indexOf("dispose-last"));
  expect(events.indexOf("worker-close")).toBeLessThan(events.indexOf("dispose-last"));
  expect(events.filter(event => event === "dispose-first")).toHaveLength(1);
  expect(host.plugins.list()[0]!.status).toBe("stopped");
});

test("owner rejection imports no code; revoked trust blocks the next generation", async () => {
  const f = await fixture(); await trustPlugin(f.trust, f.installedRoot);
  const first = await f.open(); await expect(f.open()).rejects.toThrow("Lock file");
  expect((await f.events()).filter(event => event === "import")).toHaveLength(1); await first.close();
  await revokePluginTrust(f.trust, f.installedRoot);
  const second = await f.open(); expect(second.plugins.list()[0]!.status).toBe("blocked");
  expect((await f.events()).filter(event => event === "import")).toHaveLength(1);
});

test("manifest path escapes fail before executing code", async () => {
  const f = await fixture();
  f.manifest.contributes.adapters[0]!.entry = "../outside.mjs";
  await writeFile(join(f.installedRoot, "plugin.json"), JSON.stringify(f.manifest));
  const loaded = await loadPlugins(f.options.roots); expect(loaded.errors[0]!.error).toContain("escapes"); expect(await f.events()).toEqual([]);
});

test("failure in a later entry rolls back earlier entries and revokes their registration API", async () => {
  const f = await fixture();
  f.manifest.contributes.adapters.push({ id: "second", version: "1", entry: "second.mjs" });
  await writeFile(join(f.installedRoot, "plugin.json"), JSON.stringify(f.manifest));
  await writeFile(join(f.installedRoot, "second.mjs"), `export default () => { throw new Error("second entry failed"); };`);
  await trustPlugin(f.trust, f.installedRoot);
  const host = await f.open(); expect(host.plugins.list()[0]!.error).toContain("second entry failed");
  await expect(host.submit({ commandId: "create", objective: "Report", namespace: "fixture", adapter: descriptor() })).rejects.toThrow("unavailable");
  expect(await f.events()).toEqual(["import", "dispose-last", "dispose-first"]);
});

test("cleanup failure runs remaining disposers and releases the runtime owner", async () => {
  const f = await fixture({ failDispose: true }); await trustPlugin(f.trust, f.installedRoot);
  const host = await openAgentRuntime({ directory: join(f.root, "runtime"), plugins: f.options });
  await expect(host.close()).rejects.toThrow("shutdown failed");
  expect(host.plugins.list()[0]!.status).toBe("failed");
  expect(await f.events()).toEqual(["import", "dispose-last", "dispose-first"]);
  const next = await openAgentRuntime({ directory: join(f.root, "runtime") }); await next.close();
});

test("plugin registration cannot replace an inline adapter with the same identity", async () => {
  const f = await fixture(); await trustPlugin(f.trust, f.installedRoot);
  const inline = { id: "fixture", version: "1", validate() {}, async snapshot() { return {}; },
    async createWorker(): Promise<never> { throw new Error("inline worker"); }, async accept() { return { checks: [{ command: "test", output: "inline" }] }; } };
  const host = await openAgentRuntime({ directory: join(f.root, "runtime"), adapters: [inline], plugins: f.options });
  try {
    expect(host.plugins.list()[0]!.error).toContain("Duplicate");
    expect(host.runtime.domains.resolve(descriptor()).createWorker).toBeDefined();
    expect(await f.events()).toEqual(["import", "dispose-last", "dispose-first"]);
  } finally { await host.close(); }
});

test("snapshot is isolated from source edits and the owner stays locked throughout asynchronous disposal", async () => {
  const f = await fixture();
  await writeFile(join(f.installedRoot, "index.mjs"), `import { readFile, writeFile } from 'node:fs/promises';
    const settings = JSON.parse(await readFile(new URL('settings.json', import.meta.url), 'utf8'));
    export default api => {
      api.onDispose(async () => {
        let refused = false; try { api.onDispose(() => {}); } catch { refused = true; }
        await writeFile(settings.trace, 'draining:' + refused);
        while (true) { try { await readFile(settings.trace + '.release'); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); } }
        await writeFile(settings.trace, await readFile(new URL('settings.json', import.meta.url), 'utf8'));
      });
      api.registerAdapter({ id:'fixture', version:'1', validate(){}, async snapshot(){return {}}, async createWorker(){throw new Error('unused')}, async accept(){return {checks:[]}} });
    };`);
  await trustPlugin(f.trust, f.installedRoot);
  const host = await f.open(); await writeFile(join(f.installedRoot, "settings.json"), "new source bytes");
  const closing = host.close();
  try {
    const end = Date.now() + 3000;
    while (!(await f.events()).includes("draining:true")) { if (Date.now() > end) throw new Error("Disposer did not start"); await Bun.sleep(10); }
    await expect(f.open()).rejects.toThrow("Lock file");
  } finally { await writeFile(f.trace + ".release", "release"); await closing; }
  expect(JSON.parse(await readFile(f.trace, "utf8"))).toMatchObject({ trace: f.trace });
});

test.skipIf(process.platform === "win32")("symlink packages cannot bypass tree trust", async () => {
  const f = await fixture(); await symlink(join(f.source, "index.mjs"), join(f.installedRoot, "escape.mjs"));
  const loaded = await loadAdapterPlugins(f.options); cleanup.push(() => loaded.close());
  expect(loaded.list()[0]!.error).toContain("symbolic link"); expect(await f.events()).toEqual([]);
});
