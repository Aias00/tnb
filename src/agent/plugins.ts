import { cp, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadPlugins, assertPluginContributionPath, type LoadedPlugin } from "../services/plugins/loader";
import { computePluginTreeSha256, pluginTrustState } from "../services/plugins/trust";
import { bindDomainAdapter, DomainRegistry, type AgentDomainAdapter, type AdapterPluginIdentity, type PluginAdapterRegistration } from "./domain";

/** Trusted in-process code. This API does not confer sandbox isolation. */
export type AdapterPluginAPI = {
  readonly identity: Readonly<AdapterPluginIdentity>;
  registerAdapter(adapter: AgentDomainAdapter): void;
  onDispose(callback: () => void | Promise<void>): void;
};
export type AdapterPluginFactory = (api: AdapterPluginAPI) => void | Promise<void>;
export type AgentPluginOptions = {
  roots: Array<{ directory: string; source: LoadedPlugin["source"] }>;
  enabled?: Record<string, boolean>;
  /** Always required for executable contributions; discovery without trust is insufficient. */
  trustStorePath: string;
};
export type AdapterPluginState = {
  name: string;
  version?: string;
  fingerprint?: string;
  root: string;
  enabled: boolean;
  trust: LoadedPlugin["trust"];
  status: "inactive" | "blocked" | "loading" | "active" | "failed" | "draining" | "stopped";
  error?: string;
};

/** One immutable generation per host lifetime. Installation, trust and compatibility use the existing plugin services. */
export async function loadAdapterPlugins(options: AgentPluginOptions, inline: readonly AgentDomainAdapter[] = [], snapshotRoot?: string) {
  if (!options.trustStorePath?.trim()) throw new Error("Adapter plugins require a trust store");
  // The host supplies a private directory only after acquiring its owner lock.
  if (snapshotRoot) { await rm(snapshotRoot, { recursive: true, force: true }); await mkdir(snapshotRoot, { recursive: true, mode: 0o700 }); }
  const discovered = await loadPlugins(options.roots, options.enabled, { trustStorePath: options.trustStorePath, includeDisabled: true });
  const states: AdapterPluginState[] = discovered.errors.map(error => ({ name: error.path, root: error.path, enabled: false, trust: "untrusted", status: "failed", error: error.error }));
  const registrations: PluginAdapterRegistration[] = [];
  const generations: Array<{ state: AdapterPluginState; dispose: () => Promise<void> }> = [];
  // Detect invalid host registrations before executing any plugin code.
  new DomainRegistry(inline);
  for (const plugin of discovered.plugins) {
    if (!plugin.adapterContributions?.length) continue;
    const enabled = options.enabled?.[plugin.name] !== false && options.enabled?.[plugin.name.toLowerCase()] !== false
      && (plugin.lifecycle.activation === "auto" || plugin.explicitlyEnabled);
    const state: AdapterPluginState = { name: plugin.name, version: plugin.version, fingerprint: plugin.fingerprint, root: plugin.root,
      enabled, trust: plugin.trust, status: !enabled ? "inactive" : plugin.trust !== "trusted" ? "blocked" : "loading" };
    states.push(state);
    if (state.status !== "loading") continue;
    const callbacks: Array<() => void | Promise<void>> = [];
    let snapshot: string | undefined;
    const dispose = async () => {
      const errors: unknown[] = [];
      for (const callback of callbacks.splice(0).reverse()) { try { await callback(); } catch (error) { errors.push(error); } }
      if (snapshot) { try { await rm(snapshot, { recursive: true, force: true }); } catch (error) { errors.push(error); } }
      if (errors.length) throw new AggregateError(errors, "Plugin cleanup failed");
    };
    try {
      const fingerprint = plugin.fingerprint!;
      if (await computePluginTreeSha256(plugin.root) !== fingerprint
        || await pluginTrustState(options.trustStorePath, plugin.root, fingerprint) !== "trusted") throw new Error("Plugin trust/content changed before activation");
      // Load a verified private copy, so edits or uninstall cannot change deferred module reads in this generation.
      snapshot = await mkdtemp(join(snapshotRoot ?? tmpdir(), "tnb-adapter-"));
      const copyTarget = join(snapshot, "package");
      await cp(plugin.root, copyTarget, { recursive: true, verbatimSymlinks: true,
        filter: source => ![".git", ".tnb-provenance.json"].includes(source.split(/[\\/]/).at(-1)!) });
      const target = await realpath(copyTarget);
      if (await computePluginTreeSha256(target) !== fingerprint) throw new Error("Plugin content changed while taking snapshot");
      const identity = Object.freeze({ name: plugin.name, version: plugin.version!, fingerprint });
      const staged: PluginAdapterRegistration[] = [];
      const byEntry = new Map<string, NonNullable<LoadedPlugin["adapterContributions"]>>();
      for (const contribution of plugin.adapterContributions) {
        const key = resolve(target, contribution.entry);
        byEntry.set(key, [...(byEntry.get(key) ?? []), contribution]);
      }
      for (const [entry, expected] of byEntry) {
        const path = await assertPluginContributionPath({ ...plugin, root: target }, entry);
        const loaded: { default?: unknown } = await import(pathToFileURL(path).href);
        if (typeof loaded.default !== "function") throw new Error("Adapter module must export a default factory");
        const pending: AgentDomainAdapter[] = [];
        let accepting = true;
        const assertLoading = () => { if (!accepting) throw new Error("Plugin registration is closed"); };
        const api: AdapterPluginAPI = Object.freeze({ identity,
          registerAdapter(adapter: AgentDomainAdapter) {
            assertLoading();
            if (!expected.some(item => item.id === adapter.id && item.version === adapter.version)) throw new Error("Adapter was not declared by this entry");
            // Freeze the public method surface immediately; later factory mutation cannot replace registered methods.
            pending.push(bindDomainAdapter(adapter));
          },
          onDispose(callback: () => void | Promise<void>) { assertLoading(); if (typeof callback !== "function") throw new Error("Invalid disposer"); callbacks.push(callback); },
        });
        try { await (loaded.default as AdapterPluginFactory)(api); } finally { accepting = false; }
        if (pending.length !== expected.length || expected.some(item => !pending.some(adapter => adapter.id === item.id && adapter.version === item.version))) throw new Error("Plugin did not register exactly its declared adapters");
        staged.push(...pending.map(adapter => ({ adapter, plugin: identity })));
      }
      if (await computePluginTreeSha256(target) !== fingerprint
        || await pluginTrustState(options.trustStorePath, plugin.root, fingerprint) !== "trusted") throw new Error("Plugin content/trust changed during activation");
      new DomainRegistry(inline, [...registrations, ...staged]);
      registrations.push(...staged); // Commit only after all entries and identities validate.
      state.status = "active";
      generations.push({ state, dispose });
    } catch (error) {
      state.status = "failed";
      state.error = String(error);
      try { await dispose(); } catch (cleanup) { state.error += `; ${String(cleanup)}`; }
    }
  }
  let closing: Promise<void> | undefined;
  return { registrations,
    list: () => structuredClone(states),
    close() {
      return closing ??= (async () => {
        const errors: unknown[] = [];
        for (const { state, dispose } of generations.reverse()) {
          state.status = "draining";
          try { await dispose(); state.status = "stopped"; }
          catch (error) { state.status = "failed"; state.error = String(error); errors.push(error); }
        }
        if (errors.length) throw new AggregateError(errors, "Adapter plugin shutdown failed");
      })();
    },
  };
}
