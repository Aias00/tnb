import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadHostPlugins, type BuiltinHostPlugin } from "../../src/agent/plugins";
import { RuntimeStore } from "../../src/services/runtime/store";
import { installLocalPlugin } from "../../src/services/plugins/management";
import { trustPlugin, revokePluginTrust, computePluginTreeSha256 } from "../../src/services/plugins/trust";
import { channelGenerationReferences, resolveChannelBinding } from "../../src/agent/channel-bindings";
import { builtinChannelGenerationAuthority } from "../../src/agent/builtin-generations";
import { packPlugin } from "../../src/agent/packed-plugin";
import type { ChannelDescriptor } from "../../src/agent/extensions";
import { pluginGenerationKey } from "../../src/agent/plugin-generations";
import { createCollaborationPlugin, COLLABORATION_EXTENSION, CHANNEL_SERVICE } from "../../src/plugins/collaboration/plugin";
import { COLLABORATION_SERVICE, COLLABORATION_SERVICE_REF } from "../../src/agent/collaboration-service";
import { CHANNEL_SERVICE_REF } from "../../src/agent/channel-service";
import { provideService } from "../../src/agent/services";
import { createCollaborationService } from "../../src/services/collaboration/runtime-service";
import { DurableRuntime } from "../../src/services/runtime/engine-core";
import type { CollaborationConfig } from "../../src/services/collaboration/types";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const signal = () => new AbortController().signal;
const message = (id: string, text = "notify") => ({ id, thread: "thread", text });
async function fixture(app = true, dependent = false) {
  const root = await mkdtemp(join(tmpdir(), "tnb-channel-generations-")); cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const source = join(root, "source"), plugins = join(root, "plugins"), trace = join(root, "trace"); await mkdir(source); await mkdir(plugins);
  const manifest = { name: "fixture-channel", version: "1.0.0", manifestVersion: 2, apiVersion: "tnb.host-plugin/v1", contributes: {
    channels: [{ id: "fixture-channel", version: "1", entry: "index.mjs", ...(dependent ? { requires: [{ kind: "application", id: "panel", version: "1" }] } : {}) }],
    ...(app ? { applications: [{ id: "panel", version: "1", entry: "app.mjs" }] } : {}),
  } };
  await writeFile(join(source, "plugin.json"), JSON.stringify(manifest));
  async function code(directory: string, version: string) {
    await writeFile(join(directory, "index.mjs"), `import {appendFile} from 'node:fs/promises';
      const log = value => appendFile(${JSON.stringify(trace)}, value+'\\n'); await log('${version}:import');
      export default api => api.registerChannel({id:'fixture-channel',version:'1',connect(options,ctx){
        ctx.onDispose(()=>log('${version}:dispose'));
        return {async send(msg,signal){if(msg.text==='hold'){await log('${version}:holding'); if(!signal.aborted)await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));await log('${version}:aborted');signal.throwIfAborted();}
          const receipt=ctx.state.command('send:'+msg.id,msg,tx=>{const old=tx.get('counter');const value=(old?.value??0)+1;tx.save('counter',value,old?.revision??0);return '${version}:'+value});await log('${version}:send:'+msg.id);return receipt;},
          async poll(cursor){return {events:[],cursor:'${version}:'+String(ctx.state.get('counter')?.value??0)}},async close(){await log('${version}:close')}};
      }});`);
    if (app) await writeFile(join(directory, "app.mjs"), `import {appendFile} from 'node:fs/promises';await appendFile(${JSON.stringify(trace)},'${version}:app-import\\n');export default api=>api.registerApplication({id:'panel',version:'1',start(){return {}}});`);
  }
  await code(source, "old"); const installed = await installLocalPlugin({ source, targetRoot: plugins, sourceType: "user" });
  const store = new RuntimeStore(":memory:"); cleanup.push(async () => store.close());
  const options = { roots: [{ directory: plugins, source: "user" as const }], trustStorePath: join(root, "trust.json") };
  const snapshot = join(root, "state", "plugin-snapshots"), authority = builtinChannelGenerationAuthority(store);
  async function load(extra = {}) {
    const host = await loadHostPlugins({ ...options, generationReferences: [], channelReferences: channelGenerationReferences(store), builtinChannelAuthority: authority, ...extra }, [], snapshot); cleanup.push(() => host.close());
    await host.extensions.start({ store }); return host;
  }
  const events = async () => (await readFile(trace, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  return { root, source, installed: installed.root, store, options, authority, code, load, events, manifest };
}
const reference = { id: "fixture-channel", version: "1" };

test("installed old channels preserve their state while new sources use current code and independent state", async () => {
  const f = await fixture(); await trustPlugin(f.options.trustStorePath, f.installed); let host = await f.load();
  const old = resolveChannelBinding(f.store, "application", "old-source", "fixed-transport", reference, host.extensions.channels);
  let connection = await host.extensions.channels.connect(old, {});
  expect(await connection.port.send(message("same"), signal())).toBe("old:1"); await host.close();
  await f.code(f.installed, "new"); await trustPlugin(f.options.trustStorePath, f.installed); host = await f.load();
  expect(host.list().map(item => [item.generation, item.status]), JSON.stringify(host.list())).toEqual([["current", "active"], ["retained", "active"]]);
  expect(host.extensions.channels.descriptor(reference).plugin?.fingerprint).not.toBe(old.plugin!.fingerprint);
  expect(resolveChannelBinding(f.store, "application", "old-source", "fixed-transport", reference, host.extensions.channels)).toEqual(old);
  expect(() => resolveChannelBinding(f.store, "application", "old-source", "changed-transport", reference, host.extensions.channels)).toThrow("transport changed");
  const current = resolveChannelBinding(f.store, "application", "new-source", "new-transport", reference, host.extensions.channels);
  const oldConnection = connection = await host.extensions.channels.connect(old, {}), newConnection = await host.extensions.channels.connect(current, {});
  expect(await oldConnection.port.send(message("same"), signal())).toBe("old:1");
  expect(await newConnection.port.send(message("same"), signal())).toBe("new:1");
  expect(await oldConnection.port.send(message("second"), signal())).toBe("old:2");
  expect((await oldConnection.port.poll!(undefined, signal())).cursor).toBe("old:2");
  expect((await newConnection.port.poll!(undefined, signal())).cursor).toBe("new:1");
  expect((await f.events()).filter(item => item === "old:app-import")).toHaveLength(1);
  expect(host.extensions.list().filter(item => item.kind === "application")).toHaveLength(1);
  const pending = oldConnection.port.send(message("hold", "hold"), signal()).catch(error => error);
  const end = Date.now() + 2000; while (!(await f.events()).includes("old:holding")) { if (Date.now() > end) throw new Error("Channel did not start hold"); await Bun.sleep(5); }
  await host.close(); expect(await pending).toBeInstanceOf(Error); expect((await f.events())).toContain("old:aborted");
  await expect(connection.port.send(message("closed"), signal())).rejects.toThrow("closed");
});

test("retained channels with dependencies are rejected without importing their old entry or starting old apps", async () => {
  const f = await fixture(true, true); await trustPlugin(f.options.trustStorePath, f.installed); let host = await f.load();
  const old = resolveChannelBinding(f.store, "application", "source", "transport", reference, host.extensions.channels); await host.close();
  await f.code(f.installed, "new"); await trustPlugin(f.options.trustStorePath, f.installed); host = await f.load();
  expect(host.list().find(item => item.generation === "retained")?.error).toContain("self-contained");
  expect(() => host.extensions.channels.descriptor(old)).toThrow("unavailable");
  expect((await f.events()).filter(item => item === "old:import")).toHaveLength(1);
});

test("disabled, revoked, blocked, missing and damaged installed channel history cannot fall back to current code", async () => {
  for (const mode of ["disabled", "revoked", "blocked", "missing", "damaged"] as const) {
    const f = await fixture(false); await trustPlugin(f.options.trustStorePath, f.installed); let host = await f.load();
    const old = resolveChannelBinding(f.store, "application", "source", "transport", reference, host.extensions.channels); await host.close();
    await f.code(f.installed, "new"); await trustPlugin(f.options.trustStorePath, f.installed);
    if (mode === "revoked") { await revokePluginTrust(f.options.trustStorePath, f.installed); await trustPlugin(f.options.trustStorePath, f.installed); }
    const archive = join(f.root, "state", "plugin-generations", pluginGenerationKey(old.plugin!));
    if (mode === "missing") await rm(archive, { recursive: true });
    if (mode === "damaged") await writeFile(join(archive, "package", "index.mjs"), "throw new Error('must not import');");
    host = await f.load({ ...(mode === "disabled" ? { enabled: { "fixture-channel": false } } : {}), ...(mode === "blocked" ? { blockedFingerprints: [old.plugin!.fingerprint] } : {}) });
    expect(() => host.extensions.channels.descriptor(old)).toThrow("unavailable");
    expect(host.list().find(item => item.generation === "retained")?.status).toBe("blocked");
    expect((await f.events()).filter(item => item === "old:import")).toHaveLength(1); await host.close();
  }
});

test("packaged builtin channels require a channel-specific host approval and preserve their original namespace", async () => {
  const f = await fixture(false); await rm(f.installed, { recursive: true });
  const builtin = async (): Promise<BuiltinHostPlugin> => {
    const packed = await packPlugin(f.source);
    return { identity: { name: f.manifest.name, version: f.manifest.version, fingerprint: packed.fingerprint }, package: packed,
      extensions: [{ kind: "channel", id: "fixture-channel", version: "1", entry: "index.mjs", services: [], requires: [] }], setup() { throw new Error("Inline fallback must not run"); } };
  };
  const first = await builtin(); let host = await f.load({ builtins: [first] });
  const old = resolveChannelBinding(f.store, "application", "source", "transport", reference, host.extensions.channels), port = await host.extensions.channels.connect(old, {});
  expect(await port.port.send(message("first"), signal())).toBe("old:1"); await host.close();
  expect(f.authority.approved(first.identity)).toBe(true);
  await f.code(f.source, "new"); const second = await builtin(); host = await f.load({ builtins: [second] });
  const restored = await host.extensions.channels.connect(old, {}); expect(await restored.port.send(message("next"), signal())).toBe("old:2"); await host.close();
  host = await f.load({ builtins: [second], builtinChannelAuthority: { approved: () => false, approve() {} } });
  expect(host.list().find(item => item.generation === "retained")?.error).toContain("approval or recovery ABI"); await host.close();
});

test("a failed Source is reported as unavailable while healthy Sources and the core remain usable", async () => {
  const f = await fixture(false); await rm(f.installed, { recursive: true });
  const provider: BuiltinHostPlugin = { identity: { name: "inline-channel", version: "1.0.0", fingerprint: "c".repeat(64) },
    extensions: [{ kind: "channel", id: "health", version: "1", entry: "index.mjs", services: [], requires: [] }], setup(api) {
      api.registerChannel({ id: "health", version: "1", connect(options) {
        if ((options as { fail?: boolean }).fail) throw new Error("Channel is unavailable");
        return { async send() { return "receipt"; } };
      } });
    } };
  const host = await loadHostPlugins({ ...f.options, builtins: [provider, await createCollaborationPlugin()] }); cleanup.push(() => host.close());
  const configuration: CollaborationConfig = { enabled: true, sources: [false, true].map(fail => ({ id: fail ? "blocked" : "healthy", type: "plugin", channel: { id: "health", version: "1" }, options: { fail }, actors: ["alice"], controllers: ["alice"], mode: "single", pollIntervalMs: 1000,
    configuration: { workspace: "agent:fixture", allowedWorkspaces: ["agent:fixture"], allowWrite: false, allowShell: false, checks: [], maxTurns: 10, maxRetries: 1, compactThreshold: 10000 } })) };
  const runtime = new DurableRuntime(f.store, join(f.root, "runtime"));
  await host.extensions.start({ store: f.store, serviceProviders: [provideService(CHANNEL_SERVICE_REF, () => host.extensions.channels), provideService(COLLABORATION_SERVICE_REF, scope => createCollaborationService(runtime, configuration, host.extensions.channels, scope.signal))],
    grants: { "tnb-collaboration": [CHANNEL_SERVICE, COLLABORATION_SERVICE] } });
  const response = await host.extensions.handle(COLLABORATION_EXTENSION, new Request("http://localhost/status"));
  const status = await response.json() as { ready: boolean; sources: Array<{ id: string; available: boolean; error?: string }> };
  expect(status.ready).toBe(false); expect(status.sources.find(source => source.id === "healthy")?.available).toBe(true);
  expect(status.sources.find(source => source.id === "blocked")).toMatchObject({ available: false, error: "Channel is unavailable" });
  expect(f.store.runs()).toHaveLength(0); await host.close();
});
