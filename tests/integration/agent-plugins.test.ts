import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { openAgentRuntime, type AgentRuntimeHost } from "../../src/agent/runtime";
import { loadAdapterPlugins } from "../../src/agent/plugins";
import type { DomainDescriptor } from "../../src/agent/domain";
import { loadPlugins } from "../../src/services/plugins/loader";
import { installLocalPlugin } from "../../src/services/plugins/management";
import { trustPlugin, computePluginTreeSha256, revokePluginTrust } from "../../src/services/plugins/trust";
import { pluginGenerationKey, pluginGenerationReferences } from "../../src/agent/plugin-generations";
import { RuntimeStore } from "../../src/services/runtime/store";
import { RuntimeCommands } from "../../src/services/runtime/commands";
import { DomainRegistry } from "../../src/agent/domain";

const cleanup: Array<() => Promise<unknown>> = [];
// The durable owner artifact barrier currently requires POSIX directory fsync.
// Windows runs real installation/retention/registry tests below without claiming owner execution support.
const ownerTest = test.skipIf(process.platform === "win32");
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(settings: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "tnb-plugin-agent-")); cleanup.push(async () => {
    try { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    catch (error) { throw new Error(`Fixture cleanup failed; remaining paths: ${JSON.stringify(await readdir(root, { recursive: true }).catch(() => []))}`, { cause: error }); }
  });
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

test("portable installed generations retain bytes, pin SQLite references, enforce revocation and collect after pruning", async () => {
  const f = await fixture(); await trustPlugin(f.trust, f.installedRoot);
  const stateRoot = join(f.root, "portable-state"), snapshotRoot = join(stateRoot, "plugin-snapshots"), historyRoot = join(stateRoot, "plugin-generations");
  const store = new RuntimeStore(join(stateRoot, "state.sqlite")); cleanup.push(async () => store.close());
  let loaded = await loadAdapterPlugins({ ...f.options, generationReferences: [] }, [], snapshotRoot); cleanup.push(() => loaded.close());
  const registry = new DomainRegistry([], loaded.registrations), pinned = registry.prepare(descriptor()), old = pinned.plugin!;
  const commands = new RuntimeCommands(store), { run } = commands.createRun({ commandId: "portable", objective: "Keep code", configuration: { domain: pinned } });
  expect(loaded.list()[0], JSON.stringify(loaded.list())).toMatchObject({ status: "active", generation: "current" }); await loaded.close();
  const entry = join(f.installedRoot, "index.mjs"); await writeFile(entry, await readFile(entry, "utf8") + "\n// portable upgraded generation\n"); await trustPlugin(f.trust, f.installedRoot);
  loaded = await loadAdapterPlugins({ ...f.options, generationReferences: pluginGenerationReferences(store) }, [], snapshotRoot); cleanup.push(() => loaded.close());
  expect(loaded.list().map(item => [item.generation, item.status]), JSON.stringify(loaded.list())).toEqual([["current", "active"], ["retained", "active"]]);
  const upgraded = new DomainRegistry([], loaded.registrations);
  expect(upgraded.prepare(descriptor()).plugin?.fingerprint).not.toBe(old.fingerprint);
  expect(upgraded.resolve(pinned).id).toBe("fixture"); expect(() => upgraded.prepare(pinned)).toThrow("recovery only");
  await loaded.close(); await revokePluginTrust(f.trust, f.installedRoot); await trustPlugin(f.trust, f.installedRoot);
  loaded = await loadAdapterPlugins({ ...f.options, generationReferences: pluginGenerationReferences(store) }, [], snapshotRoot); cleanup.push(() => loaded.close());
  expect(loaded.list().find(item => item.generation === "retained")?.error).toContain("no longer trusted");
  expect(await readdir(historyRoot)).toContain(pluginGenerationKey(old)); await loaded.close();
  store.command("terminal", {}, Date.now(), tx => { const value = tx.getRun(run.runId)!; tx.saveRun({ ...value, status: "cancelled", revision: value.revision + 1 }, value.revision); return true; });
  store.deleteTerminalRun(run.runId);
  loaded = await loadAdapterPlugins({ ...f.options, generationReferences: pluginGenerationReferences(store) }, [], snapshotRoot); cleanup.push(() => loaded.close());
  expect(await readdir(historyRoot)).not.toContain(pluginGenerationKey(old));
  await loaded.close(); store.close();
  // Bun SQLite statement wrappers can retain native handles until collected on Windows.
  if (process.platform === "win32") Bun.gc(true);
});

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
    expect(host.plugins.list().map(plugin => [plugin.name, plugin.status]), JSON.stringify(host.plugins.list())).toEqual([["fixture-plugin", "failed"], ["healthy-plugin", "active"]]);
    expect(host.runtime.domains.prepare({ ...descriptor(), id: "healthy" }).plugin?.name).toBe("healthy-plugin");
  } finally { await host.close(); }
});

ownerTest("trusted installed adapter executes tools, pins provenance, waits, restarts and resumes the original task", async () => {
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

ownerTest("upgrading identical package/adapter versions restores the old waiting task while new roots use current bytes", async () => {
  const f = await fixture(); await trustPlugin(f.trust, f.installedRoot);
  let host = await f.open(); const { run, tasks } = await host.submit({ commandId: "create", objective: "Wait", namespace: "fixture", adapter: descriptor({ wait: true }) });
  await until(host, () => host.store.getTask(tasks[0]!.taskId)?.status === "waiting");
  const originalIdentity = host.runtime.configuration(run.runId).domain!.plugin!; await host.close();
  // Older hosts did not write the raw submission ledger. Preserve their exact command receipt too.
  const legacy = new Database(join(f.root, "runtime", "state.sqlite"));
  legacy.query("DELETE FROM runtime_records WHERE kind = 'submission'").run(); legacy.close();
  const entry = join(f.installedRoot, "index.mjs"), original = await readFile(entry, "utf8");
  await writeFile(entry, original.replaceAll("actual plugin fact", "updated plugin fact")); await trustPlugin(f.trust, f.installedRoot);
  host = await f.open(); expect(host.plugins.list().map(item => [item.generation, item.status])).toEqual([["current", "active"], ["retained", "active"]]);
  expect(host.store.getRun(run.runId)!.status).toBe("active");
  expect(host.runtime.configuration(run.runId).domain!.plugin).toEqual(originalIdentity);
  const replay = { commandId: "create", objective: "Wait", namespace: "fixture", adapter: descriptor({ wait: true }) };
  expect((await host.submit(replay)).run.runId).toBe(run.runId);
  await expect(host.submit({ ...replay, objective: "Changed objective" })).rejects.toThrow("different input");
  await expect(host.submit({ commandId: "old-root", objective: "Old", namespace: "fixture", adapter: { ...descriptor(), plugin: originalIdentity } })).rejects.toThrow("recovery only");
  const current = await host.submit({ commandId: "new", objective: "Current", namespace: "fixture", adapter: descriptor(), mode: "single" });
  expect(host.runtime.configuration(current.run.runId).domain!.plugin!.fingerprint).not.toBe(originalIdentity.fingerprint);
  const wait = host.runtime.waits.questions(run.runId)[0]!;
  host.runtime.waits.answer({ commandId: "answer", runId: run.runId, waitId: wait.waitId, expectedVersion: wait.version, answer: "A" });
  await until(host, () => host.store.getRun(run.runId)?.status === "succeeded");
  await until(host, () => host.store.getRun(current.run.runId)?.status === "succeeded");
  const oldResult = await host.runtime.artifacts.get<{ report: string }>(host.store.getTask(tasks[0]!.taskId)!.resultRef!);
  const newResult = await host.runtime.artifacts.get<{ report: string }>(host.store.getTask(current.tasks[0]!.taskId)!.resultRef!);
  expect(oldResult.report).toContain("actual plugin fact"); expect(newResult.report).toContain("updated plugin fact");
  expect((await f.events()).filter(event => event === "tool")).toHaveLength(2);
});

ownerTest("history collection retains terminal Run references and task overrides, then collects only after explicit pruning", async () => {
  const f = await fixture(); await trustPlugin(f.trust, f.installedRoot);
  let host = await f.open(); const first = await host.submit({ commandId: "terminal", objective: "Finish", namespace: "fixture", adapter: descriptor() });
  await until(host, () => host.store.getRun(first.run.runId)?.status === "succeeded");
  const old = host.runtime.configuration(first.run.runId).domain!.plugin!;
  const history = join(f.root, "runtime", "plugin-generations"), oldKey = pluginGenerationKey(old);
  await host.close();
  const entry = join(f.installedRoot, "index.mjs"); await writeFile(entry, await readFile(entry, "utf8") + "\n// upgrade\n"); await trustPlugin(f.trust, f.installedRoot);
  host = await f.open(); expect(await readdir(history)).toContain(oldKey);
  expect(host.plugins.list().find(item => item.generation === "retained")).toMatchObject({ status: "inactive", references: 1 }); // Terminal code is retained, not executed.
  expect((await f.events()).filter(item => item === "import")).toHaveLength(2);
  expect((await host.submit({ commandId: "terminal", objective: "Finish", namespace: "fixture", adapter: descriptor() })).run.runId).toBe(first.run.runId);
  const current = await host.submit({ commandId: "hold-reference", objective: "Wait", namespace: "fixture", adapter: descriptor({ wait: true }) });
  await until(host, () => host.store.getTask(current.tasks[0]!.taskId)?.status === "waiting");
  host.store.command("override", {}, Date.now(), tx => tx.saveRecord({ kind: "task-configuration", id: current.tasks[0]!.taskId, runId: current.run.runId, taskId: current.tasks[0]!.taskId,
    value: { domain: { ...descriptor(), plugin: old } } }, 0));
  expect(pluginGenerationReferences(host.store).some(ref => ref.taskId === current.tasks[0]!.taskId && ref.plugin.fingerprint === old.fingerprint)).toBe(true);
  host.store.deleteTerminalRun(first.run.runId); await host.close();
  host = await f.open(); expect(host.plugins.list().find(item => item.generation === "retained")).toMatchObject({ status: "active", references: 1 });
  expect(await readdir(history)).toContain(oldKey);
  host.runtime.commands.cancelRun({ commandId: "cancel-current", runId: current.run.runId, expectedRevision: host.store.getRun(current.run.runId)!.revision });
  await until(host, () => host.store.getRun(current.run.runId)?.status === "cancelled");
  host.store.deleteTerminalRun(current.run.runId); await host.close();
  host = await f.open(); expect(await readdir(history)).not.toContain(oldKey);
});

ownerTest("a failed current factory cannot make retained adapters the default or restart historical application entries", async () => {
  const f = await fixture();
  const manifest = { ...f.manifest, apiVersion: "tnb.host-plugin/v1", contributes: { ...f.manifest.contributes,
    applications: [{ id: "panel", version: "1", entry: "panel.mjs" }] } };
  await writeFile(join(f.installedRoot, "plugin.json"), JSON.stringify(manifest));
  await writeFile(join(f.installedRoot, "panel.mjs"), `import { appendFile } from 'node:fs/promises';
    await appendFile(${JSON.stringify(f.trace)}, 'panel-import\\n');
    export default api => api.registerApplication({id:'panel',version:'1',start(){return {}}});`);
  await trustPlugin(f.trust, f.installedRoot);
  let host = await f.open(); const { run, tasks } = await host.submit({ commandId: "wait", objective: "Wait", namespace: "fixture", adapter: descriptor({ wait: true }) });
  await until(host, () => host.store.getTask(tasks[0]!.taskId)?.status === "waiting"); await host.close();
  await writeFile(join(f.installedRoot, "panel.mjs"), "throw new Error('current application is broken');"); await trustPlugin(f.trust, f.installedRoot);
  host = await f.open(); expect(host.plugins.list().find(item => item.generation === "current")?.status).toBe("failed");
  expect(host.plugins.list().find(item => item.generation === "retained")?.status).toBe("active");
  expect(host.plugins.extensions()).toEqual([]);
  expect((await f.events()).filter(item => item === "panel-import")).toHaveLength(1);
  await expect(host.submit({ commandId: "fresh", objective: "Fresh", namespace: "fixture", adapter: descriptor() })).rejects.toThrow("unavailable");
  const wait = host.runtime.waits.questions(run.runId)[0]!;
  host.runtime.waits.answer({ commandId: "answer", runId: run.runId, waitId: wait.waitId, expectedVersion: wait.version, answer: "A" });
  await until(host, () => host.store.getRun(run.runId)?.status === "succeeded");
});

test.skipIf(process.platform === "win32")("SIGKILL preserves referenced plugin bytes and a later upgrade recovers the same Run and question", async () => {
  const f = await fixture(); await trustPlugin(f.trust, f.installedRoot);
  const script = `import {openAgentRuntime} from ${JSON.stringify(new URL("../../src/agent/runtime.ts", import.meta.url).href)};
    const h=await openAgentRuntime({directory:process.env.PLUGIN_STATE,plugins:JSON.parse(process.env.PLUGIN_OPTIONS)});
    const {run,tasks}=await h.submit({commandId:'crash',objective:'Wait',namespace:'fixture',adapter:JSON.parse(process.env.PLUGIN_DESCRIPTOR)});
    while(h.store.getTask(tasks[0].taskId).status!=='waiting')await Bun.sleep(10);
    process.stdout.write(JSON.stringify({runId:run.runId,wait:h.runtime.waits.questions(run.runId)[0]})+'\\n');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["-e", script], { env: { ...process.env, PLUGIN_STATE: join(f.root, "runtime"), PLUGIN_OPTIONS: JSON.stringify(f.options), PLUGIN_DESCRIPTOR: JSON.stringify(descriptor({ wait: true })) }, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
  let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
  try {
    const ready = await new Promise<{ runId: string; wait: { waitId: string; version: number } }>((resolve, reject) => {
      let output = ""; const timer = setTimeout(() => reject(new Error(`Child not ready: ${stderr}`)), 10000);
      child.stdout.on("data", chunk => { output += chunk; if (output.includes("\n")) { clearTimeout(timer); resolve(JSON.parse(output.split("\n")[0]!)); } });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error(`Child exited: ${stderr}`)); });
    });
    child.kill("SIGKILL"); await exited;
    // The killed owner cannot renew; advance its heartbeat past the production stale threshold.
    const expired = new Date(Date.now() - 60000); await utimes(join(f.root, "runtime.lock"), expired, expired);
    const entry = join(f.installedRoot, "index.mjs"); await writeFile(entry, await readFile(entry, "utf8") + "\n// upgrade after crash\n"); await trustPlugin(f.trust, f.installedRoot);
    const orphan = join(f.root, "runtime", "plugin-generations", ".stage-orphan"); await mkdir(orphan);
    const host = await f.open(); expect(host.store.runs()).toHaveLength(1);
    expect(host.runtime.waits.questions(ready.runId)[0]!.waitId).toBe(ready.wait.waitId);
    expect(host.plugins.list().find(item => item.generation === "retained")?.status).toBe("active");
    expect(await readdir(join(f.root, "runtime", "plugin-generations"))).not.toContain(".stage-orphan");
    host.runtime.waits.answer({ commandId: "answer", runId: ready.runId, waitId: ready.wait.waitId, expectedVersion: ready.wait.version, answer: "A" });
    await until(host, () => host.store.getRun(ready.runId)?.status === "succeeded");
    expect((await f.events()).filter(item => item === "tool")).toHaveLength(1);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; }
});

ownerTest("revocation followed by trusting only the new installation does not resurrect the old generation", async () => {
  const f = await fixture(); await trustPlugin(f.trust, f.installedRoot);
  let host = await f.open(); const { run, tasks } = await host.submit({ commandId: "wait", objective: "Wait", namespace: "fixture", adapter: descriptor({ wait: true }) });
  await until(host, () => host.store.getTask(tasks[0]!.taskId)?.status === "waiting"); await host.close();
  await revokePluginTrust(f.trust, f.installedRoot);
  const entry = join(f.installedRoot, "index.mjs"); await writeFile(entry, await readFile(entry, "utf8") + "\n// new approved bytes\n"); await trustPlugin(f.trust, f.installedRoot);
  const imports = (await f.events()).filter(item => item === "import").length;
  host = await f.open(); expect(host.store.getRun(run.runId)?.status).toBe("paused");
  expect(host.plugins.list().find(item => item.generation === "retained")?.error).toContain("no longer trusted");
  expect((await f.events()).filter(item => item === "import")).toHaveLength(imports + 1);
});

ownerTest("disabled, removed, and changed unapproved current installations cannot activate retained code", async () => {
  for (const mode of ["disabled", "removed", "changed"] as const) {
    const f = await fixture(); await trustPlugin(f.trust, f.installedRoot);
    let host = await f.open(); const { run, tasks } = await host.submit({ commandId: "wait", objective: "Wait", namespace: "fixture", adapter: descriptor({ wait: true }) });
    await until(host, () => host.store.getTask(tasks[0]!.taskId)?.status === "waiting"); await host.close();
    if (mode === "removed") await rm(f.installedRoot, { recursive: true });
    else await writeFile(join(f.installedRoot, "extra"), "new bytes");
    const imports = (await f.events()).filter(item => item === "import").length;
    host = await openAgentRuntime({ directory: join(f.root, "runtime"), plugins: { ...f.options, ...(mode === "disabled" ? { enabled: { "fixture-plugin": false } } : {}) } });
    cleanup.push(() => host.close());
    expect(host.store.getRun(run.runId)?.status).toBe("paused");
    expect(host.plugins.list().find(item => item.generation === "retained")?.status).toBe("blocked");
    expect((await f.events()).filter(item => item === "import")).toHaveLength(imports);
    await host.close();
  }
});

ownerTest("corrupted or missing retained packages block recovery without executing their bytes", async () => {
  for (const mode of ["corrupted", "missing"] as const) {
    const f = await fixture(); await trustPlugin(f.trust, f.installedRoot);
    let host = await f.open(); const { run, tasks } = await host.submit({ commandId: "wait", objective: "Wait", namespace: "fixture", adapter: descriptor({ wait: true }) });
    await until(host, () => host.store.getTask(tasks[0]!.taskId)?.status === "waiting");
    const old = host.runtime.configuration(run.runId).domain!.plugin!; await host.close();
    const archived = join(f.root, "runtime", "plugin-generations", pluginGenerationKey(old));
    if (mode === "missing") await rm(archived, { recursive: true });
    else await writeFile(join(archived, "package", "index.mjs"), "throw new Error('must never execute');");
    const entry = join(f.installedRoot, "index.mjs"); await writeFile(entry, await readFile(entry, "utf8") + "\n// current\n"); await trustPlugin(f.trust, f.installedRoot);
    host = await f.open(); expect(host.plugins.list()[0]?.status).toBe("active");
    expect(host.plugins.list().find(item => item.generation === "retained")?.status).toBe("blocked");
    expect(host.store.getRun(run.runId)?.status).toBe("paused");
    await expect(host.runtime.resume(run.runId)).rejects.toThrow("identity changed");
  }
});

ownerTest("shutdown drains workers before disposers, concurrent close is shared and ownership lasts through cleanup", async () => {
  for (const abortBeforeSubscribe of [false, true]) {
    const f = await fixture(); await trustPlugin(f.trust, f.installedRoot);
    const host = await f.open(); await host.submit({ commandId: "hold", objective: "Hold", namespace: "fixture", adapter: descriptor({ hold: true, abortBeforeSubscribe }) });
    const end = Date.now() + 8000;
    while (!(await f.events()).includes("model")) { if (Date.now() > end) throw new Error("Worker did not start"); await Bun.sleep(10); }
    const runtimeClosing = host.runtime.close();
    const first = host.close(), second = host.close(); expect(first).toBe(second); await Promise.all([runtimeClosing, first]);
    const events = await f.events(); expect(events.indexOf("worker-aborted")).toBeLessThan(events.indexOf("dispose-last"));
    expect(events.indexOf("worker-close")).toBeLessThan(events.indexOf("dispose-last"));
    expect(events.filter(event => event === "dispose-first")).toHaveLength(1);
    expect(host.plugins.list()[0]!.status).toBe("stopped");
  }
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
