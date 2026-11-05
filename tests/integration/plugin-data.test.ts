import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ExtensionHost } from "../../src/agent/extension-host";
import type { ExtensionContext, ExtensionDeclaration, ExtensionRegistration, PluginMigrationTransaction, PluginStateMigration, PluginStateTransaction } from "../../src/agent/extensions";
import { contributionConfigurationKey, type PluginConfiguration } from "../../src/agent/plugin-data";
import { preparePluginState } from "../../src/agent/plugin-state";
import { RuntimeStore } from "../../src/services/runtime/store";
import { digestJson } from "../../src/services/runtime/json";
import { loadHostPlugins } from "../../src/agent/plugins";
import { loadPlugins } from "../../src/services/plugins/loader";
import { trustPlugin } from "../../src/services/plugins/trust";
import { loadSettings } from "../../src/services/settings/load";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const plugin = { name: "data-pack", version: "1.0.0", fingerprint: "a".repeat(64) };
const ref = { kind: "application" as const, id: "panel", version: "1" };
const declaration: ExtensionDeclaration = { ...ref, entry: "index.mjs", services: [], requires: [] };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tnb-plugin-data-")); cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const path = join(root, "state.sqlite"), store = new RuntimeStore(path); cleanup.push(async () => { store.close(); if (process.platform === "win32") Bun.gc(true); });
  const stateId = digestJson({ plugin: plugin.name, kind: ref.kind, id: ref.id, version: ref.version }), namespace = `plugin:${stateId.slice(0, 48)}`;
  async function open(overrides: Partial<ExtensionDeclaration> = {}, migrations: PluginStateMigration[] = [], configuration?: PluginConfiguration,
    start: (context: ExtensionContext) => void = () => {}, identity = plugin) {
    let context: ExtensionContext | undefined;
    const registration: ExtensionRegistration = { plugin: identity, declaration: { ...declaration, ...overrides }, definition: { id: ref.id, version: ref.version, migrations,
      start(ctx) { context = ctx; start(ctx); return { handle: () => Response.json(ctx.state.get("counter")?.value ?? null) }; } } };
    const host = new ExtensionHost([registration], [], root); cleanup.push(() => host.stop());
    await host.start({ store, configuration }); return { host, context, state: () => host.list()[0]! };
  }
  const seed = (value: unknown) => store.command("seed", {}, Date.now(), tx => tx.saveApplicationRecord({ namespace, id: "counter", value }, 0));
  return { root, path, store, namespace, open, seed };
}

test("versioned config is validated before start, copied per context and reported without its value", async () => {
  const f = await fixture(), configuration: PluginConfiguration = { [plugin.name]: { [contributionConfigurationKey(ref)]: { version: 1, value: { label: "private-config-secret" } } } };
  const contract = { version: 1, schema: { type: "object" as const, properties: { label: { type: "string" as const, maxLength: 64 } }, required: ["label"], additionalProperties: false } };
  const valid = await f.open({ configuration: contract }, [], configuration);
  expect(valid.context?.configuration).toEqual({ label: "private-config-secret" });
  expect(valid.state().configuration).toMatchObject({ status: "ready", version: 1 }); expect(valid.state().configuration?.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(valid.state())).not.toContain("private-config-secret"); await valid.host.stop();
  for (const input of [undefined, { [plugin.name]: { [contributionConfigurationKey(ref)]: { version: 2, value: "private-config-secret" } } },
    { [plugin.name]: { [contributionConfigurationKey(ref)]: { version: 1, value: "private-config-secret" } } }]) {
    const failed = await f.open({ configuration: contract }, [], input);
    expect(failed.context).toBeUndefined(); expect(failed.state().configuration?.status).toBe("invalid");
    expect(failed.state().error).toContain("PLUGIN_CONFIG_INVALID"); expect(JSON.stringify(failed.state())).not.toContain("private-config-secret");
  }
});

test("new state starts at its target version and does not run historical migration steps", async () => {
  const f = await fixture(); let migrations = 0;
  const fresh = await f.open({ state: { version: 2, migrations: [{ from: 0, to: 2 }] } }, [{ from: 0, to: 2, migrate() { migrations++; } }]);
  expect(fresh.state().state).toEqual({ status: "ready", version: 2, target: 2 }); expect(migrations).toBe(0);
  expect(f.store.applicationRecord<{ version: number }>("host.plugin-state-schema", f.namespace)?.value.version).toBe(2);
});

test("legacy records require an explicit path and migrate once across package upgrades and restart", async () => {
  const f = await fixture(); f.seed({ count: 3 });
  const blocked = await f.open({ state: { version: 2 } }); expect(blocked.context).toBeUndefined(); expect(blocked.state().error).toContain("no migration path"); await blocked.host.stop();
  let migrations = 0;
  const steps: PluginStateMigration[] = [{ from: 0, to: 1, migrate(tx) { const row = tx.get<{ count: number }>("counter")!; tx.save("counter", { total: row.value.count }, row.revision); migrations++; } },
    { from: 1, to: 2, migrate(tx) { const row = tx.get<{ total: number }>("counter")!; tx.save("counter", { total: row.value.total, ready: true }, row.revision); migrations++; } }];
  const contract = { version: 2, migrations: steps.map(({ from, to }) => ({ from, to })) };
  let upgraded = await f.open({ state: contract }, steps, undefined, () => {}, { ...plugin, fingerprint: "b".repeat(64) });
  expect(upgraded.state().status).toBe("active"); expect(upgraded.context?.state.get("counter")?.value).toEqual({ total: 3, ready: true }); expect(migrations).toBe(2); await upgraded.host.stop();
  upgraded = await f.open({ state: contract }, steps, undefined, () => {}, { ...plugin, fingerprint: "b".repeat(64) });
  expect(migrations).toBe(2); expect(upgraded.state().state?.version).toBe(2); await upgraded.host.stop();
  const downgraded = await f.open({ state: { version: 1 } }); expect(downgraded.context).toBeUndefined(); expect(downgraded.state().error).toContain("cannot downgrade");
  const legacy = await f.open(); expect(legacy.context).toBeUndefined(); expect(legacy.state().error).toContain("legacy code cannot resume");
});

test("a failed migration step rolls back records and schema, can retry, and revokes cached transaction handles", async () => {
  const f = await fixture(); f.seed({ count: 4 }); let captured!: PluginMigrationTransaction;
  const contract = { version: 1, migrations: [{ from: 0, to: 1 }] };
  const failed = await f.open({ state: contract }, [{ from: 0, to: 1, migrate(tx) { captured = tx; const row = tx.get("counter")!; tx.save("counter", { count: 100 }, row.revision); throw new Error("private-migration-secret"); } }]);
  expect(failed.context).toBeUndefined(); expect(failed.state().error).toContain("PLUGIN_STATE_MIGRATION_FAILED"); expect(failed.state().error).not.toContain("private-migration-secret");
  expect(f.store.applicationRecord("host.plugin-state-schema", f.namespace)).toBeUndefined(); expect(f.store.applicationRecord(f.namespace, "counter")?.value).toEqual({ count: 4 });
  expect(() => captured.get("counter")).toThrow("lifetime ended"); expect(() => captured.save("late", {}, 0)).toThrow("lifetime ended");
  await failed.host.stop();
  const retried = await f.open({ state: contract }, [{ from: 0, to: 1, migrate(tx) { const row = tx.get<{ count: number }>("counter")!; tx.save("counter", { count: row.value.count + 1 }, row.revision); } }]);
  expect(retried.state().status).toBe("active"); expect(retried.context?.state.get("counter")?.value).toEqual({ count: 5 });
});

test("ordinary plugin state transactions also expire and asynchronous mutation cannot escape rollback", async () => {
  const f = await fixture(), opened = await f.open(); let captured!: PluginStateTransaction;
  opened.context!.state.command("first", {}, tx => { captured = tx; return tx.save("first", { ok: true }, 0); });
  expect(() => captured.get("first")).toThrow("transaction lifetime ended");
  const gate = Promise.withResolvers<void>(); let late: unknown;
  expect(() => opened.context!.state.command("async", {}, tx => {
    tx.save("rollback", {}, 0);
    return gate.promise.then(() => { try { tx.save("late", {}, 0); } catch (error) { late = error; } });
  })).toThrow("synchronous");
  gate.resolve(); await gate.promise; await Bun.sleep(0);
  expect(String(late)).toContain("lifetime ended"); expect(opened.context!.state.get("rollback")).toBeUndefined(); expect(opened.context!.state.get("late")).toBeUndefined();
});

test("state record migrations enforce bounded scans and cannot access host metadata namespaces", async () => {
  const f = await fixture();
  f.store.command("many", {}, Date.now(), tx => { for (let i = 0; i < 257; i++) tx.saveApplicationRecord({ namespace: f.namespace, id: String(i).padStart(3, "0"), value: {} }, 0); return true; });
  let called = false;
  const failed = await f.open({ state: { version: 1, migrations: [{ from: 0, to: 1 }] } }, [{ from: 0, to: 1, migrate() { called = true; } }]);
  expect(failed.state().error).toContain("MIGRATION_FAILED"); expect(called).toBe(false); expect(f.store.applicationRecord("host.plugin-state-schema", f.namespace)).toBeUndefined();
});

test("settings keep background configuration user-owned and reject unsupported envelopes", async () => {
  const f = await fixture(), configDir = join(f.root, "config"), work = join(f.root, "work"); await mkdir(configDir); await mkdir(join(work, ".tnb"), { recursive: true });
  const value = (label: string) => ({ [plugin.name]: { [contributionConfigurationKey(ref)]: { version: 1, value: { label } } } });
  await writeFile(join(configDir, "settings.json"), JSON.stringify({ pluginConfiguration: value("user") }));
  await writeFile(join(work, ".tnb", "settings.json"), JSON.stringify({ pluginConfiguration: value("project") }));
  const settings = await loadSettings({ configDir, cwd: work }); expect(settings.pluginConfiguration).toEqual(value("user")); expect(settings.warnings?.join(" ")).toContain("Ignored pluginConfiguration");
  await writeFile(join(configDir, "settings.json"), JSON.stringify({ pluginConfiguration: { pack: { bad: "private-secret" } } }));
  await expect(loadSettings({ configDir, cwd: work })).rejects.toThrow("pluginConfiguration");
});

test("installed contributions share discovery schema checks and exact migration registration", async () => {
  const f = await fixture(), root = join(f.root, "plugins"), pack = join(root, plugin.name), imported = join(f.root, "imported"); await mkdir(pack, { recursive: true });
  const manifest = (extra: unknown) => ({ name: plugin.name, version: "1.0.0", manifestVersion: 2, apiVersion: "tnb.host-plugin/v1", contributes: { applications: [{ id: ref.id, version: ref.version, entry: "index.mjs", ...extra as object }] } });
  await writeFile(join(pack, "index.mjs"), `await Bun.write(${JSON.stringify(imported)},'imported');export default api=>api.registerApplication({id:'panel',version:'1',start(){return {}}});`);
  await writeFile(join(pack, "plugin.json"), JSON.stringify(manifest({ configuration: { version: 1, schema: { type: "object", unsupported: true } } })));
  const invalid = await loadPlugins([{ directory: root, source: "user" }]); expect(invalid.plugins).toEqual([]); expect(invalid.errors[0]?.error).toContain("schema"); expect(await readFile(imported, "utf8").catch(() => "")).toBe("");
  await writeFile(join(pack, "plugin.json"), JSON.stringify(manifest({ state: { version: 1, migrations: [{ from: 0, to: 1 }] } })));
  const trust = join(f.root, "trust.json"); await trustPlugin(trust, pack);
  const loaded = await loadHostPlugins({ roots: [{ directory: root, source: "user" }], trustStorePath: trust }); cleanup.push(() => loaded.close());
  expect(loaded.list()[0]?.status).toBe("failed"); expect(loaded.list()[0]?.error).toContain("exactly");
  await loaded.close(); f.seed({ count: 8 });
  await writeFile(join(pack, "plugin.json"), JSON.stringify(manifest({ state: { version: 1, migrations: [{ from: 0, to: 1 }] },
    configuration: { version: 1, schema: { type: "object", properties: { label: { type: "string" } }, required: ["label"], additionalProperties: false } } })));
  await writeFile(join(pack, "index.mjs"), `export default api=>api.registerApplication({id:'panel',version:'1',migrations:[{from:0,to:1,migrate(tx){const row=tx.get('counter');tx.save('counter',{total:row.value.count},row.revision);}}],
    start(context){return {handle:()=>Response.json({configuration:context.configuration,state:context.state.get('counter').value})};}});`);
  await trustPlugin(trust, pack);
  const healthy = await loadHostPlugins({ roots: [{ directory: root, source: "user" }], trustStorePath: trust }); cleanup.push(() => healthy.close());
  await healthy.extensions.start({ store: f.store, configuration: { [plugin.name]: { [contributionConfigurationKey(ref)]: { version: 1, value: { label: "installed" } } } } });
  expect(healthy.extensions.list()[0]?.status).toBe("active");
  expect(await (await healthy.extensions.handle(ref, new Request("http://plugin/status"))).json()).toEqual({ configuration: { label: "installed" }, state: { total: 8 } });
});

test("SIGKILL during a record migration leaves both records and version recoverable", async () => {
  const f = await fixture(); f.seed({ count: 6 }); f.store.close(); if (process.platform === "win32") Bun.gc(true);
  const marker = join(f.root, "inside-transaction"), script = join(f.root, "crash.mjs");
  await writeFile(script, `import {writeFileSync} from 'node:fs';
    import {RuntimeStore} from ${JSON.stringify(fileURLToPath(new URL("../../src/services/runtime/store.ts", import.meta.url)))};
    import {preparePluginState} from ${JSON.stringify(fileURLToPath(new URL("../../src/agent/plugin-state.ts", import.meta.url)))};
    const store=new RuntimeStore(${JSON.stringify(f.path)});
    preparePluginState(store,${JSON.stringify(f.namespace)},${JSON.stringify(plugin)},{version:1,migrations:[{from:0,to:1}]},[{from:0,to:1,migrate(tx){
      const row=tx.get('counter');tx.save('counter',{count:999},row.revision);writeFileSync(${JSON.stringify(marker)},'ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
    }}],new AbortController().signal,()=>{});`);
  const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe" }); cleanup.push(async () => { child.kill("SIGKILL"); await child.exited; });
  const deadline = Date.now() + 3000;
  while (await readFile(marker, "utf8").catch(() => "") !== "ready") { if (Date.now() > deadline) throw new Error("Crash fixture did not enter migration"); await Bun.sleep(5); }
  child.kill("SIGKILL"); await child.exited;
  const recovered = new RuntimeStore(f.path); cleanup.push(async () => { recovered.close(); if (process.platform === "win32") Bun.gc(true); });
  expect(recovered.applicationRecord(f.namespace, "counter")?.value).toEqual({ count: 6 }); expect(recovered.applicationRecord("host.plugin-state-schema", f.namespace)).toBeUndefined();
  let executions = 0;
  const migrate = { from: 0, to: 1, migrate(tx: PluginMigrationTransaction) { const row = tx.get<{ count: number }>("counter")!; tx.save("counter", { count: row.value.count + 1 }, row.revision); executions++; } };
  for (let i = 0; i < 2; i++) preparePluginState(recovered, f.namespace, plugin, { version: 1, migrations: [{ from: 0, to: 1 }] }, [migrate], new AbortController().signal, () => {});
  expect(recovered.applicationRecord(f.namespace, "counter")?.value).toEqual({ count: 7 }); expect(executions).toBe(1);
}, 10000);

test("each completed migration step stays durable while a later failed step rolls back and retries from its checkpoint", async () => {
  const f = await fixture(); f.seed({ count: 1 }); let first = 0, second = 0;
  const contract = { version: 2, migrations: [{ from: 0, to: 1 }, { from: 1, to: 2 }] };
  const steps: PluginStateMigration[] = [{ from: 0, to: 1, migrate(tx) { const row = tx.get("counter")!; tx.save("counter", { count: 2 }, row.revision); first++; } },
    { from: 1, to: 2, migrate(tx) { second++; const row = tx.get("counter")!; tx.save("counter", { count: 3 }, row.revision); throw new Error("second step failed"); } }];
  const failed = await f.open({ state: contract }, steps);
  expect(failed.state().state).toMatchObject({ status: "blocked", version: 1, target: 2 });
  expect(f.store.applicationRecord(f.namespace, "counter")?.value).toEqual({ count: 2 }); await failed.host.stop();
  steps[1] = { from: 1, to: 2, migrate(tx) { second++; const row = tx.get("counter")!; tx.save("counter", { count: 3 }, row.revision); } };
  const retried = await f.open({ state: contract }, steps); expect(retried.state().state?.version).toBe(2); expect(first).toBe(1); expect(second).toBe(2);
});

test("record write ceilings and disguised async migrations roll back without permitting late writes", async () => {
  const f = await fixture(); f.seed({ count: 1 }); const contract = { version: 1, migrations: [{ from: 0, to: 1 }] };
  const oversized = await f.open({ state: contract }, [{ from: 0, to: 1, migrate(tx) { for (let i = 0; i < 257; i++) tx.save(`new-${i}`, {}, 0); } }]);
  expect(oversized.state().error).toContain("MIGRATION_FAILED"); expect(f.store.applicationRecords(f.namespace)).toHaveLength(1); await oversized.host.stop();
  const gate = Promise.withResolvers<void>(); let late: unknown;
  const async = await f.open({ state: contract }, [{ from: 0, to: 1, migrate(tx) {
    return gate.promise.then(() => { try { tx.save("late", {}, 0); } catch (error) { late = error; } });
  } }]);
  expect(async.state().error).toContain("MIGRATION_FAILED"); gate.resolve(); await Bun.sleep(0);
  expect(String(late)).toContain("lifetime ended"); expect(f.store.applicationRecord(f.namespace, "late")).toBeUndefined();
});

test("invalid configuration isolates its contribution and cannot acquire its declared services", async () => {
  const f = await fixture(); let services = 0, started = false;
  const { createServiceRef, provideService } = await import("../../src/agent/services");
  const service = createServiceRef<{ ping(): void }>({ id: "fixture.ping", version: 1, scope: "contribution", methods: { ping: true } });
  const host = new ExtensionHost([{ plugin, declaration: { ...declaration, configuration: { version: 1, schema: { type: "string" } }, services: [service.name] },
    definition: { id: ref.id, version: ref.version, start(context) { started = true; context.service(service); } } },
    { plugin, declaration: { ...declaration, id: "healthy" }, definition: { id: "healthy", version: "1", start() { return {}; } } }], [], f.root); cleanup.push(() => host.stop());
  await host.start({ store: f.store, serviceProviders: [provideService(service, () => { services++; return { ping() {} }; })], grants: { [plugin.name]: [service.name] } });
  expect(host.list().find(row => row.id === "healthy")?.status).toBe("active"); expect(started).toBe(false); expect(services).toBe(0);
});

test("current and retained channel generations keep independent state schema versions and records", async () => {
  const f = await fixture(), old = plugin, current = { ...plugin, fingerprint: "b".repeat(64) };
  const registration = (identity: typeof plugin, version: number, recoveryOnly = false): ExtensionRegistration => ({ plugin: identity, ...(recoveryOnly ? { recoveryOnly: true } : {}),
    declaration: { kind: "channel", id: "notes", version: "1", entry: "index.mjs", services: [], requires: [], state: { version } },
    definition: { id: "notes", version: "1", connect(_config, context) { return { async send(message) {
      context.state.command(message.id, {}, tx => tx.save(message.id, { schema: version }, 0)); return `schema-${version}`;
    }, async find(message) { return context.state.get(message.id) ? `schema-${version}` : undefined; } }; } },
  });
  const first = new ExtensionHost([registration(old, 1)], [], f.root); cleanup.push(() => first.stop()); await first.start({ store: f.store });
  const original = await first.channels.connect({ id: "notes", version: "1" }, {}), message = { id: "before-upgrade", text: "notice", thread: "t" };
  await original.port.send(message, new AbortController().signal); await first.stop();
  const upgraded = new ExtensionHost([registration(current, 2), registration(old, 1, true)], [], f.root); cleanup.push(() => upgraded.stop()); await upgraded.start({ store: f.store });
  expect(upgraded.list().map(row => row.state?.version)).toEqual([2, 1]);
  const latest = await upgraded.channels.connect({ id: "notes", version: "1" }, {}), retained = await upgraded.channels.connect(original.descriptor, {});
  expect(await latest.port.find!(message, new AbortController().signal)).toBeUndefined(); expect(await retained.port.find!(message, new AbortController().signal)).toBe("schema-1");
});

test("state contracts and migration registrations are snapshotted before activation", async () => {
  const f = await fixture(); f.seed({ count: 1 }); let migrated = 0;
  const state = { version: 1, migrations: [{ from: 0, to: 1 }] }, migration = { from: 0, to: 1, migrate() { migrated++; } };
  const host = new ExtensionHost([{ plugin, declaration: { ...declaration, state }, definition: { id: ref.id, version: ref.version, migrations: [migration], start() { return {}; } } }], [], f.root); cleanup.push(() => host.stop());
  state.version = 2; migration.to = 2; migration.migrate = () => { throw new Error("changed after registration"); };
  await host.start({ store: f.store }); expect(host.list()[0]?.state?.version).toBe(1); expect(migrated).toBe(1);
});

test("corrupt schema metadata blocks recovery and cannot be treated as fresh state", async () => {
  const f = await fixture();
  f.store.command("corrupt-metadata", {}, Date.now(), tx => tx.saveApplicationRecord({ namespace: "host.plugin-state-schema", id: f.namespace, value: { protocol: 99, version: 1 } }, 0));
  const failed = await f.open({ state: { version: 1 } }); expect(failed.context).toBeUndefined(); expect(failed.state().error).toContain("invalid persisted schema metadata");
  expect(failed.state().state?.status).toBe("blocked");
});
