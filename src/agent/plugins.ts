import { cp, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadPlugins, assertPluginContributionPath, type LoadedPlugin } from "../services/plugins/loader";
import { computePluginTreeSha256, pluginTrustState } from "../services/plugins/trust";
import { ExtensionHost } from "./extension-host";
import type { ExtensionDeclaration, ExtensionRegistration, PluginApplication, PluginInterface, PluginChannel, ExtensionState } from "./extensions";
import { bindDomainAdapter, DomainRegistry, type AgentDomainAdapter, type AdapterPluginIdentity, type PluginAdapterRegistration } from "./domain";

/** Trusted in-process code. This API does not confer sandbox isolation. */
export type AdapterPluginAPI = {
  readonly identity: Readonly<AdapterPluginIdentity>;
  readonly stateDirectory?: string;
  /** Host-supplied transient settings. Never persisted as task configuration. */
  readonly configuration?: unknown;
  registerAdapter(adapter: AgentDomainAdapter): void;
  onDispose(callback: () => void | Promise<void>): void;
};
export type HostPluginAPI = AdapterPluginAPI & {
  registerApplication(application: PluginApplication): void;
  registerInterface(frontend: PluginInterface): void;
  registerChannel(channel: PluginChannel): void;
};
export type HostPluginFactory = (api: HostPluginAPI) => void | Promise<void>;
export type BuiltinHostPlugin = { identity: AdapterPluginIdentity; adapters?: Array<{ id: string; version: string }>; extensions?: ExtensionDeclaration[]; setup: HostPluginFactory };
export type AdapterPluginFactory = (api: AdapterPluginAPI) => void | Promise<void>;
export type BuiltinAdapterPlugin = { identity: AdapterPluginIdentity; adapters: Array<{ id: string; version: string }>; setup: AdapterPluginFactory };
export type AgentPluginOptions = {
  roots: Array<{ directory: string; source: LoadedPlugin["source"] }>;
  enabled?: Record<string, boolean>;
  /** Always required for executable contributions; discovery without trust is insufficient. */
  trustStorePath: string;
  builtins?: readonly (BuiltinAdapterPlugin | BuiltinHostPlugin)[];
  configuration?: Record<string, unknown>;
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
  contributions?: ExtensionState[];
};

/** One immutable generation per host lifetime. Installation, trust and compatibility use the existing plugin services. */
export async function loadHostPlugins(options: AgentPluginOptions, inline: readonly AgentDomainAdapter[] = [], snapshotRoot?: string) {
  if (!options.trustStorePath?.trim()) throw new Error("Adapter plugins require a trust store");
  // The host supplies a private directory only after acquiring its owner lock.
  if (snapshotRoot) { await rm(snapshotRoot, { recursive: true, force: true }); await mkdir(snapshotRoot, { recursive: true, mode: 0o700 }); }
  const discovered = await loadPlugins(options.roots, options.enabled, { trustStorePath: options.trustStorePath, includeDisabled: true });
  const states: AdapterPluginState[] = discovered.errors.map(error => ({ name: error.path, root: error.path, enabled: false, trust: "untrusted", status: "failed", error: error.error }));
  const registrations: PluginAdapterRegistration[] = [];
  const extensionRegistrations: ExtensionRegistration[] = [];
  const generations: Array<{ state: AdapterPluginState; dispose: () => Promise<void> }> = [];
  // Detect invalid host registrations before executing any plugin code.
  new DomainRegistry(inline);
  const stateDirectory = snapshotRoot ? resolve(snapshotRoot, "..") : undefined;
  for (const builtin of options.builtins ?? []) {
    // An explicitly installed package owns this name even if blocked or failed; never fall back past its trust decision.
    if (discovered.plugins.some(plugin => plugin.name.toLowerCase() === builtin.identity.name.toLowerCase()) || discovered.errors.some(error => basename(error.path).toLowerCase() === builtin.identity.name.toLowerCase())) continue;
    const identity = Object.freeze({ ...builtin.identity });
    const state: AdapterPluginState = { ...identity, root: `builtin:${identity.name}`, enabled: options.enabled?.[identity.name] !== false && options.enabled?.[identity.name.toLowerCase()] !== false, trust: "trusted", status: "loading" };
    states.push(state);
    if (!state.enabled) { state.status = "inactive"; continue; }
    const callbacks: Array<() => void | Promise<void>> = [];
    try {
      const declarations: EntryDeclaration[] = [...(builtin.adapters ?? []).map(adapter => ({ ...adapter, kind: "adapter" as const })), ...("extensions" in builtin ? builtin.extensions ?? [] : [])];
      const staged = await initializeEntry(builtin.setup, declarations, identity, callbacks, stateDirectory, options.configuration?.[identity.name]);
      new DomainRegistry(inline, [...registrations, ...staged.adapters]);
      new ExtensionHost([...extensionRegistrations, ...staged.extensions], registrations, stateDirectory);
      registrations.push(...staged.adapters); extensionRegistrations.push(...staged.extensions); state.status = "active";
      generations.push({ state, dispose: () => disposeCallbacks(callbacks) });
    } catch (error) {
      state.status = "failed"; state.error = String(error);
      try { await disposeCallbacks(callbacks); } catch (cleanup) { state.error += `; ${String(cleanup)}`; }
    }
  }
  for (const plugin of discovered.plugins) {
    if (!plugin.adapterContributions?.length && !plugin.extensionContributions?.length) continue;
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
      try { await disposeCallbacks(callbacks); } catch (error) { errors.push(error); }
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
      const staged: PluginAdapterRegistration[] = [], stagedExtensions: ExtensionRegistration[] = [];
      const byEntry = new Map<string, EntryDeclaration[]>();
      const declarations: Array<EntryDeclaration & { entry: string }> = [...(plugin.adapterContributions ?? []).map(adapter => ({ ...adapter, kind: "adapter" as const })), ...(plugin.extensionContributions ?? [])];
      for (const contribution of declarations) {
        const key = resolve(target, contribution.entry);
        byEntry.set(key, [...(byEntry.get(key) ?? []), contribution]);
      }
      for (const [entry, expected] of byEntry) {
        const path = await assertPluginContributionPath({ ...plugin, root: target }, entry);
        const loaded: { default?: unknown } = await import(pathToFileURL(path).href);
        if (typeof loaded.default !== "function") throw new Error("Adapter module must export a default factory");
        const entryResult = await initializeEntry(loaded.default as HostPluginFactory, expected, identity, callbacks, stateDirectory, options.configuration?.[plugin.name]);
        staged.push(...entryResult.adapters); stagedExtensions.push(...entryResult.extensions);
      }
      if (await computePluginTreeSha256(target) !== fingerprint
        || await pluginTrustState(options.trustStorePath, plugin.root, fingerprint) !== "trusted") throw new Error("Plugin content/trust changed during activation");
      new DomainRegistry(inline, [...registrations, ...staged]);
      new ExtensionHost([...extensionRegistrations, ...stagedExtensions], registrations, stateDirectory);
      registrations.push(...staged); extensionRegistrations.push(...stagedExtensions); // Commit only after all entries and identities validate.
      state.status = "active";
      generations.push({ state, dispose });
    } catch (error) {
      state.status = "failed";
      state.error = String(error);
      try { await dispose(); } catch (cleanup) { state.error += `; ${String(cleanup)}`; }
    }
  }
  const extensions = new ExtensionHost(extensionRegistrations, [...registrations, ...inline.map(adapter => ({ adapter }))], stateDirectory);
  let closing: Promise<void> | undefined;
  return { registrations, extensions,
    list: () => structuredClone(states.map(state => {
      const contributions = extensions.list().filter(contribution => contribution.plugin.name === state.name);
      return contributions.length ? { ...state, contributions } : state;
    })),
    close() {
      return closing ??= (async () => {
        const errors: unknown[] = [];
        try { await extensions.stop(); } catch (error) { errors.push(error); }
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

export type HostPluginOptions = AgentPluginOptions;
export type HostPluginState = AdapterPluginState;
export const loadAdapterPlugins = loadHostPlugins;
type EntryDeclaration = { kind: "adapter"; id: string; version: string } | ExtensionDeclaration;
async function initializeEntry(factory: HostPluginFactory, expected: EntryDeclaration[], identity: Readonly<AdapterPluginIdentity>,
  callbacks: Array<() => void | Promise<void>>, stateDirectory?: string, configuration?: unknown): Promise<{ adapters: PluginAdapterRegistration[]; extensions: ExtensionRegistration[] }> {
  const pending: AgentDomainAdapter[] = [], extensions: ExtensionRegistration[] = [];
  const registered = new Set<string>();
  let accepting = true;
  const assertLoading = () => { if (!accepting) throw new Error("Plugin registration is closed"); };
  const claim = (kind: EntryDeclaration["kind"], value: { id: string; version: string }) => {
    assertLoading();
    const declaration = expected.find(item => item.kind === kind && item.id === value.id && item.version === value.version);
    if (!declaration) throw new Error(`${kind} was not declared by this entry`);
    const key = JSON.stringify([kind, value.id, value.version]);
    if (registered.has(key)) throw new Error("Duplicate plugin contribution registration");
    registered.add(key); return declaration;
  };
  const registerExtension = (kind: ExtensionDeclaration["kind"], definition: PluginApplication | PluginChannel) => {
    const declaration = claim(kind, definition) as ExtensionDeclaration;
    if (kind === "channel" ? typeof (definition as PluginChannel).connect !== "function" : typeof (definition as PluginApplication).start !== "function") throw new Error("Invalid plugin extension lifecycle");
    const bound = kind === "channel" ? { id: definition.id, version: definition.version, connect: (definition as PluginChannel).connect.bind(definition) }
      : { id: definition.id, version: definition.version, start: (definition as PluginApplication).start.bind(definition) };
    extensions.push({ declaration: structuredClone(declaration), definition: Object.freeze(bound), plugin: identity });
  };
  const api: HostPluginAPI = Object.freeze({ identity, stateDirectory, configuration,
    registerAdapter(adapter: AgentDomainAdapter) { claim("adapter", adapter); pending.push(bindDomainAdapter(adapter)); },
    registerApplication: application => registerExtension("application", application),
    registerInterface: frontend => registerExtension("interface", frontend),
    registerChannel: channel => registerExtension("channel", channel),
    onDispose(callback: () => void | Promise<void>) { assertLoading(); if (typeof callback !== "function") throw new Error("Invalid disposer"); callbacks.push(callback); },
  });
  try { await factory(api); } finally { accepting = false; }
  if (registered.size !== expected.length) throw new Error("Plugin did not register exactly its declared contributions");
  return { adapters: pending.map(adapter => ({ adapter, plugin: identity })), extensions };
}
async function disposeCallbacks(callbacks: Array<() => void | Promise<void>>) {
  const errors: unknown[] = [];
  for (const callback of callbacks.splice(0).reverse()) { try { await callback(); } catch (error) { errors.push(error); } }
  if (errors.length) throw new AggregateError(errors, "Plugin cleanup failed");
}
