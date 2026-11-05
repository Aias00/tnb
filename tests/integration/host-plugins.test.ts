import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAgentRuntime } from "../../src/agent/runtime";
import { loadHostPlugins, type BuiltinHostPlugin } from "../../src/agent/plugins";
import type { ContributionReference, ExtensionContext } from "../../src/agent/extensions";
import { RuntimeStore } from "../../src/services/runtime/store";
import { installLocalPlugin } from "../../src/services/plugins/management";
import { trustPlugin } from "../../src/services/plugins/trust";
import { loadPlugins } from "../../src/services/plugins/loader";
import { DurableRuntime } from "../../src/services/runtime/engine";
import { runtimeRequest, serveDurableRuntime } from "../../src/services/runtime/server";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const app: ContributionReference = { kind: "application", id: "status-panel", version: "1" }, view: ContributionReference = { kind: "interface", id: "status-view", version: "1" };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tnb-host-plugins-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source"), directory = join(root, "plugins"), trust = join(root, "trust.json");
  await cp(new URL("../../examples/host-plugin", import.meta.url), source, { recursive: true });
  const installed = await installLocalPlugin({ source, targetRoot: directory, sourceType: "user" });
  const options = { roots: [{ directory, source: "user" as const }], trustStorePath: trust };
  async function open(grant = true) {
    const host = await openAgentRuntime({ directory: join(root, "runtime"), plugins: options,
      services: new Map([["tnb.runtime.read/v1", { runs: () => [] }]]), serviceGrants: grant ? { "example-host": ["tnb.runtime.read/v1"] } : {} }); cleanup.push(() => host.close()); return host;
  }
  return { root, source, installed: installed.root, trust, options, open };
}
const request = (commandId?: string) => new Request("http://localhost/status", commandId ? { method: "POST", body: JSON.stringify({ commandId }) } : {});
async function until(predicate: () => boolean | Promise<boolean>) { const deadline = Date.now() + 10000; while (!await predicate()) { if (Date.now() > deadline) throw new Error("condition timed out"); await Bun.sleep(10); } }

test("installed application/interface/channel share discovery and trust, then preserve scoped command receipts across restart", async () => {
  const f = await fixture(); const discovered = await loadPlugins(f.options.roots);
  expect(discovered.plugins[0]!.contributionSummary).toMatchObject({ applications: ["status-panel@1"], interfaces: ["status-view@1"], channels: ["local-notes@1"] });
  expect(discovered.plugins[0]!.lifecycle.reload).toBe("restart");
  const untrusted = await f.open(); expect(untrusted.plugins.list()[0]?.status).toBe("blocked"); expect(untrusted.plugins.extensions()).toEqual([]); await untrusted.close();
  await trustPlugin(f.trust, f.installed);
  let host = await f.open(); expect(host.plugins.extensions().map(item => item.status)).toEqual(["active", "active", "active"]);
  expect(await (await host.plugins.request(app, request("visit-1"))).json()).toEqual({ runs: 0, visits: 1 });
  expect(await (await host.plugins.request(app, request("visit-1"))).json()).toEqual({ runs: 0, visits: 1 });
  expect(await (await host.plugins.request(view, request())).text()).toContain("Runs: 0 · Visits: 1");
  const connection = await host.plugins.channels!.connect({ id: "local-notes", version: "1" }, { command: "/tnb run Inspect" });
  expect(connection.descriptor.plugin?.name).toBe("example-host");
  const message = { id: "notice", thread: "thread", text: "Question" }, signal = new AbortController().signal;
  expect(await connection.port.send(message, signal)).toBe("local-note:notice"); await connection.close();
  await expect(connection.port.send(message, signal)).rejects.toThrow("closed");
  await host.close(); await expect(host.plugins.request(app, request())).rejects.toThrow("unavailable");
  host = await f.open(); expect(await (await host.plugins.request(app, request())).json()).toEqual({ runs: 0, visits: 1 });
  const second = await host.plugins.channels!.connect(connection.descriptor, { command: "/tnb run Inspect" });
  expect(await second.port.find!(message, signal)).toBe("local-note:notice");
});

test("service grants and explicit dependency failures isolate unavailable contributions", async () => {
  const f = await fixture(); await trustPlugin(f.trust, f.installed);
  const host = await f.open(false), states = host.plugins.extensions();
  expect(states.find(item => item.kind === "channel")?.status).toBe("active");
  expect(states.find(item => item.kind === "application")?.status).toBe("failed");
  expect(states.find(item => item.kind === "interface")?.error).toContain("dependency");
  await expect(host.plugins.request(view, request())).rejects.toThrow("unavailable");
});

test("a later entry failure rolls back all contribution kinds and does not import a disabled installed package", async () => {
  const f = await fixture(), manifest = JSON.parse(await readFile(join(f.installed, "plugin.json"), "utf8"));
  manifest.contributes.applications.push({ id: "late", version: "1", entry: "late.mjs" });
  await writeFile(join(f.installed, "plugin.json"), JSON.stringify(manifest));
  await writeFile(join(f.installed, "late.mjs"), 'export default () => { throw new Error("late entry failed"); };');
  await trustPlugin(f.trust, f.installed);
  const host = await f.open(); expect(host.plugins.list()[0]?.error).toContain("late entry failed"); expect(host.plugins.extensions()).toEqual([]);
  await host.close();
  const disabled = await loadHostPlugins({ ...f.options, enabled: { "example-host": false } }); cleanup.push(() => disabled.close()); expect(disabled.list()[0]?.status).toBe("inactive");
});

test("missing and cyclic exact dependencies fail without starting code; an undeclared registration fails atomically", async () => {
  const f = await fixture(), manifest = JSON.parse(await readFile(join(f.installed, "plugin.json"), "utf8"));
  manifest.contributes.applications[0].requires = [{ kind: "interface", id: "status-view", version: "1" }];
  await writeFile(join(f.installed, "plugin.json"), JSON.stringify(manifest)); await trustPlugin(f.trust, f.installed);
  let host = await f.open(); expect(host.plugins.extensions().filter(item => item.kind !== "channel").every(item => item.status === "failed")).toBe(true); await host.close();
  manifest.contributes.applications[0].requires = [{ kind: "application", id: "missing", version: "1" }];
  await writeFile(join(f.installed, "plugin.json"), JSON.stringify(manifest)); await trustPlugin(f.trust, f.installed);
  host = await f.open(); expect(host.plugins.extensions().find(item => item.kind === "application")?.error).toContain("Missing"); await host.close();
  manifest.contributes.interfaces = []; delete manifest.contributes.interfaces;
  await writeFile(join(f.installed, "plugin.json"), JSON.stringify(manifest)); await trustPlugin(f.trust, f.installed);
  host = await f.open(); expect(host.plugins.list()[0]?.error).toContain("not declared"); expect(host.plugins.extensions()).toEqual([]);
});

test("host stop aborts and joins handlers, runs all disposers, and revokes cached APIs", async () => {
  const f = await fixture(), store = new RuntimeStore(join(f.root, "state.sqlite")); cleanup.push(async () => store.close());
  const entered = Promise.withResolvers<void>(); let context!: ExtensionContext; const trace: string[] = [];
  const builtin: BuiltinHostPlugin = { identity: { name: "lifetime", version: "1.0.0", fingerprint: "a".repeat(64) }, extensions: [{ kind: "application", id: "lifetime", version: "1", entry: "index.mjs", services: [], requires: [] }], setup(api) {
    api.registerApplication({ id: "lifetime", version: "1", start(ctx) { context = ctx;
      ctx.onDispose(() => { trace.push("first"); }); ctx.onDispose(() => { trace.push("last"); throw new Error("cleanup failure"); });
      return { async handle() { entered.resolve(); await new Promise<void>(resolve => ctx.signal.addEventListener("abort", () => resolve(), { once: true })); trace.push("drained"); return Response.json({ aborted: true }); } };
    } });
  } };
  const plugins = await loadHostPlugins({ roots: [], trustStorePath: f.trust, builtins: [builtin] });
  await plugins.extensions.start({ store });
  const pending = plugins.extensions.handle({ kind: "application", id: "lifetime", version: "1" }, request()); await entered.promise;
  await expect(plugins.close()).rejects.toThrow("shutdown failed"); expect(await (await pending).json()).toEqual({ aborted: true });
  expect(trace).toEqual(expect.arrayContaining(["first", "last", "drained"]));
  expect(() => context.onDispose(() => {})).toThrow("ended"); expect(() => context.state.get("late")).toThrow("ended");
});

test("installed same-name failure cannot fall back to a built-in application", async () => {
  const f = await fixture(); let executed = false;
  const plugins = await loadHostPlugins({ ...f.options, builtins: [{ identity: { name: "example-host", version: "1.0.0", fingerprint: "a".repeat(64) }, setup() { executed = true; }, extensions: [] }] }); cleanup.push(() => plugins.close());
  expect(executed).toBe(false); expect(plugins.list()[0]?.status).toBe("blocked");
});

test("a trusted installed channel feeds the existing collaboration application and persists result notifications", async () => {
  const f = await fixture(), configDir = join(f.root, "control"), pluginRoot = join(configDir, "plugins");
  await mkdir(join(f.root, "work"));
  const manifest = JSON.parse(await readFile(join(f.source, "plugin.json"), "utf8")); delete manifest.contributes.applications; delete manifest.contributes.interfaces;
  await writeFile(join(f.source, "plugin.json"), JSON.stringify(manifest));
  await writeFile(join(f.source, "index.mjs"), (await readFile(join(f.source, "index.mjs"), "utf8")).replace(/  api\.registerApplication[\s\S]*?(?=  api\.registerChannel)/, ""));
  const installed = await installLocalPlugin({ source: f.source, targetRoot: pluginRoot, sourceType: "user" }); await trustPlugin(join(configDir, "plugin-trust.json"), installed.root);
  const workspace = join(f.root, "work");
  await writeFile(join(configDir, "collaboration.json"), JSON.stringify({ enabled: true, sources: [{ id: "notes", type: "plugin", channel: { id: "local-notes", version: "1" }, options: { command: "/tnb run Inspect the repository" }, actors: ["operator"], controllers: ["operator"], mode: "single", configuration: { workspace, allowWrite: false, allowShell: false, checks: [] } }] }));
  const state = join(configDir, "runtime"), store = new RuntimeStore(join(state, "state.sqlite")); cleanup.push(async () => store.close());
  const runtime = new DurableRuntime(store, state, async () => ({ transport: { async *stream() { yield { type: "text", index: 0, text: "Installed channel report" }; yield { type: "response-end", reason: "end-turn" }; } }, model: "fixture", tools: [], authorize: async () => ({ behavior: "allow" }), route: { provider: "fixture", model: "fixture" }, maxOutputTokens: 128 }));
  const controller = new AbortController(), ready = Promise.withResolvers<void>();
  const serving = serveDurableRuntime({ configDir, runtime, env: {}, signal: controller.signal, ready: () => ready.resolve() }); cleanup.push(async () => { controller.abort(); await serving; }); await Promise.race([ready.promise, serving]);
  await until(async () => (await runtimeRequest(configDir, "/collaboration?kind=outbox") as any[]).some(row => row.value.state === "sent" && row.value.text.includes("Installed channel report")));
  expect(store.runs()).toHaveLength(1);
  const inventory = await runtimeRequest(configDir, "/extensions") as any[];
  expect(inventory.some(item => item.kind === "channel" && item.plugin.name === "example-host" && item.status === "active")).toBe(true);
  controller.abort(); await serving;
  const restarted = new DurableRuntime(store, state, runtime.factory), secondController = new AbortController(), secondReady = Promise.withResolvers<void>();
  const secondServing = serveDurableRuntime({ configDir, runtime: restarted, env: {}, signal: secondController.signal, ready: () => secondReady.resolve() });
  cleanup.push(async () => { secondController.abort(); await secondServing; }); await Promise.race([secondReady.promise, secondServing]);
  expect(store.runs()).toHaveLength(1);
  expect((await runtimeRequest(configDir, "/collaboration") as { enabled: boolean }).enabled).toBe(true);
}, 20000);

test("registration APIs close after setup, undeclared services/requests are refused and host credentials are stripped", async () => {
  const f = await fixture(), store = new RuntimeStore(join(f.root, "state.sqlite")); cleanup.push(async () => store.close());
  let apiRef!: Parameters<BuiltinHostPlugin["setup"]>[0]; let ctx!: ExtensionContext;
  const builtin: BuiltinHostPlugin = { identity: { name: "boundary", version: "1.0.0", fingerprint: "b".repeat(64) }, extensions: [{ kind: "application", id: "boundary", version: "1", entry: "index.mjs", services: [], requires: [] }], setup(api) { apiRef = api; api.registerApplication({ id: "boundary", version: "1", start(context) { ctx = context; return { handle: request => Response.json({ authorization: request.headers.get("authorization"), cookie: request.headers.get("cookie") }) }; } }); } };
  const plugins = await loadHostPlugins({ roots: [], trustStorePath: f.trust, builtins: [builtin] }); cleanup.push(() => plugins.close());
  expect(() => apiRef.registerApplication({ id: "late", version: "1", start() {} })).toThrow("closed");
  await plugins.extensions.start({ store, services: new Map([["secret", "private"]]), grants: { boundary: ["secret"] } });
  expect(() => ctx.service("secret")).toThrow("denied"); expect(() => ctx.request(app, request())).toThrow("not declared");
  const response = await plugins.extensions.handle({ kind: "application", id: "boundary", version: "1" }, new Request("http://localhost", { headers: { authorization: "Bearer private-host-key", cookie: "private-session" } }));
  expect(await response.json()).toEqual({ authorization: null, cookie: null });
});

test("channel startup failure closes partial resources and closing a connection joins its in-flight calls", async () => {
  const f = await fixture(), store = new RuntimeStore(join(f.root, "state.sqlite")); cleanup.push(async () => store.close());
  const entered = Promise.withResolvers<void>(), events: string[] = [];
  const builtin: BuiltinHostPlugin = { identity: { name: "channels-test", version: "1.0.0", fingerprint: "c".repeat(64) }, extensions: [{ kind: "channel", id: "slow", version: "1", entry: "index.mjs", services: [], requires: [] }], setup(api) {
    api.registerChannel({ id: "slow", version: "1", connect(config, context) {
      context.onDispose(() => { events.push("connection-dispose"); });
      if ((config as { fail?: boolean }).fail) throw new Error("startup failed");
      return { async send(_message, signal) { entered.resolve(); await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); events.push("send-drained"); return "receipt"; }, close() { events.push("port-close"); } };
    } });
  } };
  const plugins = await loadHostPlugins({ roots: [], trustStorePath: f.trust, builtins: [builtin] }); cleanup.push(() => plugins.close()); await plugins.extensions.start({ store });
  await expect(plugins.extensions.channels.connect({ id: "slow", version: "1" }, { fail: true })).rejects.toThrow("startup failed"); expect(events).toEqual(["connection-dispose"]);
  const channel = await plugins.extensions.channels.connect({ id: "slow", version: "1" }, {});
  const pending = channel.port.send({ id: "one", thread: "thread", text: "test" }, new AbortController().signal); await entered.promise;
  await channel.close(); expect(await pending).toBe("receipt"); expect(events.slice(1)).toEqual(["send-drained", "port-close", "connection-dispose"]);
  await expect(plugins.extensions.channels.connect({ ...channel.descriptor, plugin: { ...channel.descriptor.plugin!, fingerprint: "d".repeat(64) } }, {})).rejects.toThrow("generation");
});

test("cancellation during plugin startup joins partial initialization before disposal and releases the runtime owner", async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), controller = new AbortController(), events: string[] = [];
  const builtin: BuiltinHostPlugin = { identity: { name: "startup-cancel", version: "1.0.0", fingerprint: "e".repeat(64) }, extensions: [{ kind: "application", id: "startup-cancel", version: "1", entry: "index.mjs", services: [], requires: [] }], setup(api) {
    api.registerApplication({ id: "startup-cancel", version: "1", async start(context) {
      context.onDispose(() => { events.push("disposed"); }); entered.resolve();
      await new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), { once: true }));
      events.push("initialization-drained");
    } });
  } };
  const opening = openAgentRuntime({ directory: join(f.root, "runtime"), signal: controller.signal, plugins: { roots: [], trustStorePath: f.trust, builtins: [builtin] } });
  // Attach before cancellation so the expected rejection never becomes an unhandled promise.
  const rejected = opening.then(() => { throw new Error("Startup unexpectedly succeeded"); }, error => error);
  await entered.promise; controller.abort();
  expect(String(await rejected)).toContain("cancelled");
  expect(events).toEqual(["initialization-drained", "disposed"]);
  const next = await openAgentRuntime({ directory: join(f.root, "runtime") }); await next.close();
});
