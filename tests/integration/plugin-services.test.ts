import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ExtensionHost } from "../../src/agent/extension-host";
import { createServiceRef, PluginServiceRegistry, provideService, type ServiceProvider } from "../../src/agent/services";
import { loadHostPlugins } from "../../src/agent/plugins";
import type { ExtensionContext, ExtensionRegistration } from "../../src/agent/extensions";
import { RuntimeStore } from "../../src/services/runtime/store";
import { installLocalPlugin } from "../../src/services/plugins/management";
import { trustPlugin } from "../../src/services/plugins/trust";
import { createTaskService } from "../../src/services/workbench/tasks";
import { DurableRuntime } from "../../src/services/runtime/engine-core";
import { DomainRegistry } from "../../src/agent/domain";
import { COLLABORATION_SERVICE_REF } from "../../src/agent/collaboration-service";
import { createCollaborationService } from "../../src/services/collaboration/runtime-service";
import type { CollaborationConfig } from "../../src/services/collaboration/types";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const plugin = { name: "fixture", version: "1.0.0", fingerprint: "a".repeat(64) };
type Probe = { ping(input: string): string };
const probe = createServiceRef<Probe>({ id: "fixture.probe", version: 1, scope: "contribution", methods: { ping: true } });
const signal = () => new AbortController().signal;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tnb-plugin-services-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new RuntimeStore(":memory:"); cleanup.push(async () => { store.close(); if (process.platform === "win32") Bun.gc(true); });
  return { root, store };
}
function app(id: string, start: (context: ExtensionContext) => ReturnType<Extract<ExtensionRegistration["definition"], { start: unknown }>["start"]>, services = [probe.name]): ExtensionRegistration {
  return { plugin, declaration: { kind: "application", id, version: "1", entry: "index.mjs", services, requires: [] }, definition: { id, version: "1", start } };
}
async function start(registrations: ExtensionRegistration[], providers: ServiceProvider[], grants: string[] = [probe.name]) {
  const f = await fixture(), host = new ExtensionHost(registrations, [], f.root); cleanup.push(() => host.stop());
  await host.start({ store: f.store, serviceProviders: providers, grants: { fixture: grants } }); return { ...f, host };
}

test("missing grants and invalid service contracts fail only their consumers before factories execute", async () => {
  let factories = 0, started = false;
  const provider = provideService(probe, () => { factories++; return { ping: value => value }; });
  const f = await start([app("denied", () => { started = true; }), app("independent", () => ({}), [])], [provider], []);
  expect(f.host.list().find(row => row.id === "denied")?.error).toContain("not granted");
  expect(f.host.list().find(row => row.id === "independent")?.status).toBe("active"); expect(started).toBe(false); expect(factories).toBe(0);
  const mismatch = await start([app("mismatch", context => { context.service(createServiceRef<Probe>({ ...probe, scope: "host" })); }), app("healthy", context => {
    const service = context.service(probe); return { status: () => ({ value: service.ping("ok") }) };
  })], [provider]);
  expect(mismatch.host.list().find(row => row.id === "mismatch")?.error).toContain("SERVICE_CONTRACT_MISMATCH");
  expect(mismatch.host.status({ kind: "application", id: "healthy", version: "1" })).toEqual({ value: "ok" }); expect(factories).toBe(1);
});

test("legacy string consumers receive revocable typed provider facades and failed startup releases partial services", async () => {
  let cached!: Probe; let released = 0;
  const provider = provideService(probe, scope => { scope.onDispose(() => { released++; }); return { ping: value => value }; });
  const f = await start([app("failed", context => { context.service(probe); throw new Error("app startup failed"); }), app("healthy", context => {
    cached = context.service<Probe>(probe.name); return {};
  })], [provider]);
  expect(released).toBe(1); expect(cached.ping("live")).toBe("live"); await f.host.stop();
  expect(released).toBe(2); expect(() => cached.ping("late")).toThrow("SERVICE_SCOPE_ENDED");
});

test("independently bundled installed plugins share structural service references without shared module identity", async () => {
  const f = await fixture(), source = join(f.root, "source"), directory = join(f.root, "plugins"), trust = join(f.root, "trust.json");
  await mkdir(source);
  const entry = join(f.root, "entry.ts");
  await writeFile(entry, `import {createServiceRef} from ${JSON.stringify(fileURLToPath(new URL("../../src/agent/services.ts", import.meta.url)))};
    const ref=createServiceRef({id:'fixture.probe',version:1,scope:'contribution',methods:{ping:true}});
    export default api=>api.registerApplication({id:'separate',version:'1',start(context){const service=context.service(ref);return {handle:()=>Response.json({result:service.ping('separate bundle')})};}});`);
  const bundle = await Bun.build({ entrypoints: [entry], target: "bun", outdir: source, naming: "index.mjs" });
  expect(bundle.success).toBe(true);
  await writeFile(join(source, "plugin.json"), JSON.stringify({ name: "separate", version: "1.0.0", manifestVersion: 2, apiVersion: "tnb.host-plugin/v1", contributes: { applications: [{ id: "separate", version: "1", entry: "index.mjs", services: [probe.name] }] } }));
  const installed = await installLocalPlugin({ source, targetRoot: directory, sourceType: "user" }); await trustPlugin(trust, installed.root);
  const host = await loadHostPlugins({ roots: [{ directory, source: "user" }], trustStorePath: trust }); cleanup.push(() => host.close());
  await host.extensions.start({ store: f.store, serviceProviders: [provideService(probe, scope => ({ ping: value => `${scope.consumer!.plugin.name}:${value}` }))], grants: { separate: [probe.name] } });
  expect(host.extensions.list()[0]?.status).toBe("active");
  const response = await host.extensions.handle({ kind: "application", id: "separate", version: "1" }, new Request("http://plugin/status"));
  expect(await response.json()).toEqual({ result: "separate:separate bundle" });
});

test("channel connections get separate service scopes and aborting one revokes only its handles", async () => {
  let created = 0, released = 0; const cached: Probe[] = [];
  const channel: ExtensionRegistration = { plugin, declaration: { kind: "channel", id: "notes", version: "1", entry: "index.mjs", services: [probe.name], requires: [] }, definition: {
    id: "notes", version: "1", connect(_configuration, context) { const service = context.service(probe); cached.push(service); return { async send() { return service.ping(""); } }; },
  } };
  const f = await start([channel], [provideService(probe, scope => {
    const instance = ++created; scope.onDispose(() => { released++; }); return { ping: () => String(instance) };
  })]);
  const firstSignal = new AbortController(), first = await f.host.channels.connect({ id: "notes", version: "1" }, {}, firstSignal.signal);
  const second = await f.host.channels.connect({ id: "notes", version: "1" }, {});
  expect(await first.port.send({ id: "one", thread: "t", text: "x" }, signal())).toBe("1");
  expect(await second.port.send({ id: "two", thread: "t", text: "x" }, signal())).toBe("2");
  firstSignal.abort(); expect(() => cached[0]!.ping("")).toThrow("SERVICE_SCOPE_ENDED");
  await expect(first.port.send({ id: "late", thread: "t", text: "x" }, signal())).rejects.toThrow();
  await first.close(); expect(released).toBe(1);
  expect(await second.port.send({ id: "healthy", thread: "t", text: "x" }, signal())).toBe("2");
  await f.host.stop(); expect(released).toBe(2);
});

test("cancellation during channel construction drains the opening operation and releases acquired services", async () => {
  const entered = Promise.withResolvers<void>(); let released = 0, portClosed = false;
  const channel: ExtensionRegistration = { plugin, declaration: { kind: "channel", id: "slow", version: "1", entry: "index.mjs", services: [probe.name], requires: [] }, definition: {
    id: "slow", version: "1", async connect(_configuration, context) {
      context.service(probe); entered.resolve();
      await new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), { once: true }));
      return { async send() { return "unused"; }, close() { portClosed = true; } };
    },
  } };
  const f = await start([channel], [provideService(probe, scope => { scope.onDispose(() => { released++; }); return { ping: value => value }; })]);
  const controller = new AbortController(), opening = f.host.channels.connect({ id: "slow", version: "1" }, {}, controller.signal); void opening.catch(() => {});
  await entered.promise; controller.abort(); await expect(opening).rejects.toThrow("consumer closed");
  expect(released).toBe(1); expect(portClosed).toBe(true);
});

test("workspace handles and attention streams obey the service owner signal after they were opened", async () => {
  const f = await fixture(), workspace = join(f.root, "work"), configDir = join(f.root, "config"); await mkdir(workspace); await mkdir(configDir);
  const runtime = new DurableRuntime(f.store, join(f.root, "runtime")); cleanup.push(() => runtime.close());
  let tracked = 0;
  const controller = new AbortController(), service = createTaskService({ runtime, configDir, env: {}, coding: false, signal: controller.signal,
    track: operation => { tracked++; return operation(); } }), view = await service.open(workspace);
  expect(view.list()).toEqual([]);
  await view.info(); await expect(view.detail("missing")).rejects.toThrow("outside");
  await expect(view.command({ action: "invalid", commandId: "invalid" })).rejects.toThrow("Unsupported"); expect(tracked).toBe(3);
  const response = view.attention(signal()), reader = response.body!.getReader(); expect((await reader.read()).done).toBe(false);
  controller.abort(); expect((await reader.read()).done).toBe(true);
  expect(() => view.list()).toThrow(); await expect(view.info()).rejects.toThrow();
  await expect(view.command({ action: "submit", commandId: "after-close", objective: "must not execute" })).rejects.toThrow();
  await expect(service.open(workspace)).rejects.toThrow(); expect(f.store.runs()).toEqual([]);
});

test("nested collaboration admission stays owned while normalization drains and cannot commit after cancellation", async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>(); let closed = false;
  const domains = new DomainRegistry([{ id: "fixture", version: "1", validate() {}, async snapshot() { return {}; }, async createWorker(): Promise<never> { throw new Error("No model may run"); },
    async accept() { return { checks: [] }; }, runtime: { async normalize() { entered.resolve(); await gate.promise; } } }]);
  const runtime = new DurableRuntime(f.store, join(f.root, "runtime"), domains); cleanup.push(() => runtime.close());
  const configuration: CollaborationConfig = { enabled: true, sources: [{ id: "notes", type: "plugin", channel: { id: "unused", version: "1" }, actors: ["alice"], controllers: ["alice"], mode: "single", pollIntervalMs: 1000,
    configuration: { workspace: "agent:fixture", allowedWorkspaces: ["agent:fixture"], allowWrite: false, allowShell: false, checks: [], maxTurns: 10, maxRetries: 0, compactThreshold: 10000,
      domain: { id: "fixture", version: "1", config: {}, resources: [{ id: "fact", mode: "read" }], grants: [] } } }] };
  const services = new PluginServiceRegistry([provideService(COLLABORATION_SERVICE_REF, scope => {
    const factory = createCollaborationService(runtime, configuration, undefined, scope.signal, scope.track);
    return { open(signal) { const service = factory.open(signal); scope.onDispose(service.close); return service; } };
  })]); cleanup.push(async () => { gate.resolve(); await services.close(); });
  const resolve = services.bind("collaboration", { plugin, contribution: { kind: "application", id: "collaboration", version: "1" } }, signal(), () => {});
  const service = resolve(COLLABORATION_SERVICE_REF).open(signal());
  const pending = service.tasks.admit("notes", { externalId: "event", actor: "alice", thread: "t", text: "/tnb run Inspect" }); void pending.catch(() => {});
  await entered.promise;
  const closing = services.close(); void closing.then(() => { closed = true; });
  await Bun.sleep(5); expect(closed).toBe(false);
  gate.resolve(); await closing; await expect(pending).rejects.toThrow();
  expect(f.store.applicationRecords("host.collaboration.admission")).toEqual([]); expect(f.store.runs()).toEqual([]);
});

test("host shutdown joins cancelled channel construction through the completion of partial port cleanup", async () => {
  const entered = Promise.withResolvers<void>(), cleaning = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let stopped = false;
  const channel: ExtensionRegistration = { plugin, declaration: { kind: "channel", id: "opening", version: "1", entry: "index.mjs", services: [], requires: [] }, definition: {
    id: "opening", version: "1", async connect(_configuration, context) {
      entered.resolve(); await new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), { once: true }));
      return { async send() { return "unused"; }, async close() { cleaning.resolve(); await release.promise; } };
    },
  } };
  const f = await start([channel], []);
  cleanup.push(async () => { release.resolve(); await f.host.stop(); });
  const opening = f.host.channels.connect({ id: "opening", version: "1" }, {}); void opening.catch(() => {}); await entered.promise;
  const closing = f.host.stop(); void closing.then(() => { stopped = true; }); await cleaning.promise;
  await Bun.sleep(5); expect(stopped).toBe(false);
  release.resolve(); await closing; await expect(opening).rejects.toThrow("closed while opening");
});
