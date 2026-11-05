import { cp, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadPlugins, assertPluginContributionPath, type LoadedPlugin } from "../services/plugins/loader";
import { computePluginTreeSha256, pluginGenerationTrusted, pluginTrustState } from "../services/plugins/trust";
import { ExtensionHost } from "./extension-host";
import type { ExtensionDeclaration, ExtensionRegistration, PluginApplication, PluginInterface, PluginChannel, ExtensionState } from "./extensions";
import { bindDomainAdapter, DomainRegistry, type AgentDomainAdapter, type AdapterPluginIdentity, type DomainContext, type PluginAdapterRegistration } from "./domain";
import type { AgentTool } from "../core/tool";
import { collectPluginGenerations, pluginGenerationKey, readRetainedPlugin, retainPluginGeneration, type PluginGenerationReference } from "./plugin-generations";
import { unpackPlugin, type PackedPlugin } from "./packed-plugin";
import type { BuiltinGenerationAuthority } from "./builtin-generations";
import type { ChannelGenerationReference } from "./channel-bindings";
import { digestJson } from "../services/runtime/json";
import { isPluginFingerprintBlocked } from "../services/plugins/policy";

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
export type BuiltinHostPlugin = { identity: AdapterPluginIdentity; adapters?: Array<{ id: string; version: string }>; extensions?: ExtensionDeclaration[]; setup: HostPluginFactory; package?: PackedPlugin; configuration?: unknown };
export type AdapterPluginFactory = (api: AdapterPluginAPI) => void | Promise<void>;
export type BuiltinAdapterPlugin = { identity: AdapterPluginIdentity; adapters: Array<{ id: string; version: string }>; setup: AdapterPluginFactory; package?: PackedPlugin; configuration?: unknown };
export type AgentPluginOptions = {
  roots: Array<{ directory: string; source: LoadedPlugin["source"] }>;
  enabled?: Record<string, boolean>;
  /** Always required for executable contributions; discovery without trust is insufficient. */
  trustStorePath: string;
  builtins?: readonly (BuiltinAdapterPlugin | BuiltinHostPlugin)[];
  configuration?: Record<string, unknown>;
  /** Complete host-owned inventory; omitted means historical collection is disabled. */
  generationReferences?: readonly PluginGenerationReference[];
  /** Owner-held host approval table. Never exposed through the plugin API. */
  builtinAuthority?: BuiltinGenerationAuthority;
  builtinChannelAuthority?: BuiltinGenerationAuthority;
  channelReferences?: readonly ChannelGenerationReference[];
  blockedFingerprints?: readonly string[];
  /** Current host policy, applied outside the loaded implementation, including historical packages. */
  workerGuard?(context: DomainContext, generation: { plugin: AdapterPluginIdentity; recoveryOnly: boolean }): Promise<() => Promise<void>>;
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
  generation?: "current" | "retained";
  references?: number;
};

/** Immutable implementations per host lifetime; pinned installed domains may retain older generations. */
export async function loadHostPlugins(options: AgentPluginOptions, inline: readonly AgentDomainAdapter[] = [], snapshotRoot?: string) {
  if (!options.trustStorePath?.trim()) throw new Error("Adapter plugins require a trust store");
  // The host supplies a private directory only after acquiring its owner lock.
  if (snapshotRoot) { await rm(snapshotRoot, { recursive: true, force: true }); await mkdir(snapshotRoot, { recursive: true, mode: 0o700 }); }
  const discovered = await loadPlugins(options.roots, options.enabled, { trustStorePath: options.trustStorePath, includeDisabled: true, blockedFingerprints: options.blockedFingerprints });
  const states: AdapterPluginState[] = discovered.errors.map(error => ({ name: error.path, root: error.path, enabled: false, trust: "untrusted", status: "failed", error: error.error }));
  const registrations: PluginAdapterRegistration[] = [];
  const extensionRegistrations: ExtensionRegistration[] = [];
  const generations: Array<{ state: AdapterPluginState; dispose: () => Promise<void> }> = [];
  // Detect invalid host registrations before executing any plugin code.
  new DomainRegistry(inline);
  const stateDirectory = snapshotRoot ? resolve(snapshotRoot, "..") : undefined;
  const historyRoot = stateDirectory ? join(stateDirectory, "plugin-generations") : undefined;
  const references = [...(options.generationReferences ?? []), ...(options.channelReferences ?? [])];
  const referenceCount = (identity: AdapterPluginIdentity) => references.filter(ref => pluginGenerationKey(ref.plugin) === pluginGenerationKey(identity)).length;
  const blocked = (fingerprint: string) => isPluginFingerprintBlocked(fingerprint, options.blockedFingerprints);
  type Candidate = { plugin: LoadedPlugin; recoveryOnly?: boolean; origin?: string; builtin?: boolean; state?: AdapterPluginState; sourceSnapshot?: string; configuration?: unknown };
  const candidates: Candidate[] = [];
  for (const builtin of options.builtins ?? []) {
    // An explicitly installed package owns this name even if blocked or failed; never fall back past its trust decision.
    if (discovered.plugins.some(plugin => plugin.name.toLowerCase() === builtin.identity.name.toLowerCase()) || discovered.errors.some(error => basename(error.path).toLowerCase() === builtin.identity.name.toLowerCase())) continue;
    const identity = Object.freeze({ ...builtin.identity });
    const state: AdapterPluginState = { ...identity, generation: "current", references: referenceCount(identity), root: `builtin:${identity.name}`, enabled: options.enabled?.[identity.name] !== false && options.enabled?.[identity.name.toLowerCase()] !== false, trust: "trusted", status: "loading" };
    states.push(state);
    if (!state.enabled) { state.status = "inactive"; continue; }
    if (blocked(identity.fingerprint)) { state.status = "blocked"; state.error = "Plugin fingerprint is blocked by host policy"; continue; }
    if (builtin.package) {
      let sourceSnapshot: string | undefined;
      try {
        if (!historyRoot || builtin.adapters?.length && !options.builtinAuthority
          || "extensions" in builtin && builtin.extensions?.some(item => item.kind === "channel") && !options.builtinChannelAuthority) throw new Error("Packaged builtin requires a private history root and host approval authority");
        if (builtin.package.fingerprint !== identity.fingerprint) throw new Error("Builtin package identity does not match its bytes");
        sourceSnapshot = await mkdtemp(join(snapshotRoot!, "tnb-builtin-"));
        await unpackPlugin(builtin.package, join(sourceSnapshot, "package"));
        const loaded = await loadPlugins([{ directory: sourceSnapshot, source: "user" }]);
        const plugin = loaded.plugins[0];
        const actualExtensions = plugin?.extensionContributions ?? [], expectedExtensions = "extensions" in builtin ? builtin.extensions ?? [] : [];
        if (!plugin || plugin.name !== identity.name || plugin.version !== identity.version || actualExtensions.some(item => item.kind !== "channel")
          || digestJson(actualExtensions) !== digestJson(expectedExtensions)
          || digestJson(plugin.adapterContributions?.map(({ id, version }) => ({ id, version })) ?? []) !== digestJson(builtin.adapters ?? [])) throw new Error(loaded.errors[0]?.error ?? "Builtin package declarations do not match its host registration");
        candidates.push({ plugin: { ...plugin, trust: "trusted", fingerprint: identity.fingerprint }, builtin: true, state, sourceSnapshot, configuration: builtin.configuration });
      } catch (error) {
        state.status = "failed"; state.error = String(error);
        if (sourceSnapshot) { try { await rm(sourceSnapshot, { recursive: true, force: true }); } catch (cleanup) { state.error += `; ${String(cleanup)}`; } }
      }
      continue;
    }
    const callbacks: Array<() => void | Promise<void>> = [];
    try {
      const declarations: EntryDeclaration[] = [...(builtin.adapters ?? []).map(adapter => ({ ...adapter, kind: "adapter" as const })), ...("extensions" in builtin ? builtin.extensions ?? [] : [])];
      const staged = await initializeEntry(builtin.setup, declarations, identity, callbacks, stateDirectory, options.configuration?.[identity.name] ?? builtin.configuration);
      staged.adapters = staged.adapters.map(row => ({ ...row, adapter: guardAdapter(row.adapter, identity, false, options.workerGuard) }));
      new DomainRegistry(inline, [...registrations, ...staged.adapters]);
      new ExtensionHost([...extensionRegistrations, ...staged.extensions], registrations, stateDirectory);
      registrations.push(...staged.adapters); extensionRegistrations.push(...staged.extensions); state.status = "active";
      generations.push({ state, dispose: () => disposeCallbacks(callbacks) });
    } catch (error) {
      state.status = "failed"; state.error = String(error);
      try { await disposeCallbacks(callbacks); } catch (cleanup) { state.error += `; ${String(cleanup)}`; }
    }
  }
  candidates.push(...discovered.plugins.map(plugin => ({ plugin })));
  const retainedStates: AdapterPluginState[] = [];
  if (historyRoot) for (const identity of new Map(references.map(ref => [pluginGenerationKey(ref.plugin), ref.plugin])).values()) {
    if (discovered.plugins.some(plugin => plugin.name === identity.name && plugin.version === identity.version && plugin.fingerprint === identity.fingerprint)
      || states.some(state => state.name === identity.name && state.version === identity.version && state.fingerprint === identity.fingerprint)) continue;
    const state: AdapterPluginState = { ...identity, generation: "retained", references: referenceCount(identity), root: join(historyRoot, pluginGenerationKey(identity)), enabled: false, trust: "untrusted", status: "blocked" };
    try {
      if (blocked(identity.fingerprint)) throw new Error("Plugin fingerprint is blocked by host policy");
      const installed = discovered.plugins.find(plugin => plugin.name.toLowerCase() === identity.name.toLowerCase());
      const retained = await readRetainedPlugin(historyRoot, identity);
      const builtin = !installed && retained.origins.includes(`builtin:${identity.name}`);
      if (builtin) {
        if (installed || discovered.errors.some(error => basename(error.path).toLowerCase() === identity.name.toLowerCase())) throw new Error("Installed plugin selection blocks historical builtin recovery");
        const selected = options.builtins?.find(item => item.identity.name === identity.name);
        if (!selected?.package || options.enabled?.[identity.name] === false || options.enabled?.[identity.name.toLowerCase()] === false) throw new Error("Historical builtin is disabled or not selected by this host");
        if (references.some(ref => "adapter" in ref && pluginGenerationKey(ref.plugin) === pluginGenerationKey(identity)) && !options.builtinAuthority?.approved(identity)
          || references.some(ref => "channel" in ref && pluginGenerationKey(ref.plugin) === pluginGenerationKey(identity)) && !options.builtinChannelAuthority?.approved(identity)) throw new Error("Historical builtin has no matching host approval or recovery ABI");
      } else {
        if (!installed || !installed.active) throw new Error("Historical recovery requires the original plugin installation to remain enabled and trusted");
        if (!await pluginGenerationTrusted(options.trustStorePath, installed.root, identity.fingerprint)) throw new Error("Retained plugin generation is no longer trusted");
        if (!retained.origins.includes(installed.root)) throw new Error("Retained plugin installation origin changed");
      }
      if (!references.some(ref => ref.load && pluginGenerationKey(ref.plugin) === pluginGenerationKey(identity))) {
        retainedStates.push({ ...state, root: retained.plugin.root, enabled: true, trust: "trusted", status: "inactive" });
        continue;
      }
      candidates.push({ plugin: { ...retained.plugin, trust: "trusted", explicitlyEnabled: true }, recoveryOnly: true, origin: builtin ? `builtin:${identity.name}` : installed!.root, builtin,
        configuration: builtin ? options.builtins?.find(item => item.identity.name === identity.name)?.configuration : undefined });
    } catch (error) { state.error = String(error); retainedStates.push(state); }
  }
  for (const { plugin, recoveryOnly, origin, builtin, state: existingState, sourceSnapshot, configuration } of candidates) {
    if (!plugin.adapterContributions?.length && !plugin.extensionContributions?.length) continue;
    const enabled = options.enabled?.[plugin.name] !== false && options.enabled?.[plugin.name.toLowerCase()] !== false
      && (plugin.lifecycle.activation === "auto" || plugin.explicitlyEnabled);
    const state: AdapterPluginState = existingState ?? { name: plugin.name, version: plugin.version, fingerprint: plugin.fingerprint, root: plugin.root,
      generation: recoveryOnly ? "retained" : "current", references: referenceCount({ name: plugin.name, version: plugin.version!, fingerprint: plugin.fingerprint! }),
      enabled, trust: plugin.trust, status: !enabled ? "inactive" : plugin.trust !== "trusted" ? "blocked" : "loading" };
    if (!existingState) states.push(state);
    if (blocked(plugin.fingerprint!)) { state.status = "blocked"; state.error = "Plugin fingerprint is blocked by host policy"; }
    if (state.status !== "loading") continue;
    const callbacks: Array<() => void | Promise<void>> = [];
    let snapshot: string | undefined;
    const dispose = async () => {
      const errors: unknown[] = [];
      try { await disposeCallbacks(callbacks); } catch (error) { errors.push(error); }
      if (snapshot) { try { await rm(snapshot, { recursive: true, force: true }); } catch (error) { errors.push(error); } }
      if (sourceSnapshot) { try { await rm(sourceSnapshot, { recursive: true, force: true }); } catch (error) { errors.push(error); } }
      if (errors.length) throw new AggregateError(errors, "Plugin cleanup failed");
    };
    try {
      const fingerprint = plugin.fingerprint!;
      const identity = Object.freeze({ name: plugin.name, version: plugin.version!, fingerprint });
      const authorized = async () => builtin ? !recoveryOnly || (!references.some(ref => ref.load && "adapter" in ref && pluginGenerationKey(ref.plugin) === pluginGenerationKey(identity)) || options.builtinAuthority?.approved(identity) === true)
        && (!references.some(ref => ref.load && "channel" in ref && pluginGenerationKey(ref.plugin) === pluginGenerationKey(identity)) || options.builtinChannelAuthority?.approved(identity) === true) : recoveryOnly ? await pluginGenerationTrusted(options.trustStorePath, origin!, fingerprint)
        && await pluginTrustState(options.trustStorePath, origin!, await computePluginTreeSha256(origin!)) === "trusted"
        : await pluginTrustState(options.trustStorePath, plugin.root, fingerprint) === "trusted";
      if (await computePluginTreeSha256(plugin.root) !== fingerprint
        || !await authorized()) throw new Error("Plugin trust/content changed before activation");
      // Load a verified private copy, so edits or uninstall cannot change deferred module reads in this generation.
      snapshot = await mkdtemp(join(snapshotRoot ?? tmpdir(), "tnb-adapter-"));
      const copyTarget = join(snapshot, "package");
      await cp(plugin.root, copyTarget, { recursive: true, verbatimSymlinks: true,
        filter: source => ![".git", ".tnb-provenance.json"].includes(source.split(/[\\/]/).at(-1)!) });
      const target = await realpath(copyTarget);
      if (await computePluginTreeSha256(target) !== fingerprint) throw new Error("Plugin content changed while taking snapshot");
      const staged: PluginAdapterRegistration[] = [], stagedExtensions: ExtensionRegistration[] = [];
      const byEntry = new Map<string, EntryDeclaration[]>();
      const declarations: Array<EntryDeclaration & { entry: string }> = [...(plugin.adapterContributions ?? []).map(adapter => ({ ...adapter, kind: "adapter" as const })), ...(plugin.extensionContributions ?? [])];
      for (const contribution of declarations) {
        const key = resolve(target, contribution.entry);
        byEntry.set(key, [...(byEntry.get(key) ?? []), contribution]);
      }
      for (const [entry, expected] of byEntry) {
        const requested = (item: EntryDeclaration) => references.some(ref => ref.load && pluginGenerationKey(ref.plugin) === pluginGenerationKey(identity)
          && (item.kind === "adapter" && "adapter" in ref && ref.adapter.id === item.id && ref.adapter.version === item.version
            || item.kind === "channel" && "channel" in ref && ref.channel.id === item.id && ref.channel.version === item.version));
        if (recoveryOnly && !expected.some(requested)) continue;
        if (recoveryOnly && expected.some(item => item.kind === "channel" && requested(item) && item.requires.length)) throw new Error("Retained channels must be self-contained and have no contribution dependencies");
        const path = await assertPluginContributionPath({ ...plugin, root: target }, entry);
        const loaded: { default?: unknown } = await import(pathToFileURL(path).href);
        if (typeof loaded.default !== "function") throw new Error("Adapter module must export a default factory");
        const entryResult = await initializeEntry(loaded.default as HostPluginFactory, expected, identity, callbacks, stateDirectory, options.configuration?.[plugin.name] ?? configuration);
        staged.push(...entryResult.adapters.filter(row => !recoveryOnly || requested({ kind: "adapter", id: row.adapter.id, version: row.adapter.version })).map(registration => ({ ...registration,
          adapter: guardAdapter(registration.adapter, identity, recoveryOnly === true, options.workerGuard), ...(recoveryOnly ? { recoveryOnly: true } : {}) })));
        stagedExtensions.push(...entryResult.extensions.filter(row => !recoveryOnly || row.declaration.kind === "channel" && requested(row.declaration)).map(row => ({ ...row, ...(recoveryOnly ? { recoveryOnly: true } : {}) })));
      }
      if (await computePluginTreeSha256(target) !== fingerprint
        || !await authorized()) throw new Error("Plugin content/trust changed during activation");
      if (recoveryOnly && references.filter(ref => ref.load && pluginGenerationKey(ref.plugin) === pluginGenerationKey(identity))
        .some(ref => "adapter" in ref ? !staged.some(row => row.adapter.id === ref.adapter.id && row.adapter.version === ref.adapter.version)
          : !stagedExtensions.some(row => row.declaration.kind === "channel" && row.declaration.id === ref.channel.id && row.declaration.version === ref.channel.version))) throw new Error("Retained plugin does not provide the pinned contribution");
      new DomainRegistry(inline, [...registrations, ...staged]);
      new ExtensionHost([...extensionRegistrations, ...stagedExtensions], registrations, stateDirectory);
      if (!recoveryOnly && historyRoot && (staged.length || stagedExtensions.some(row => row.declaration.kind === "channel"))) {
        await retainPluginGeneration(historyRoot, identity, builtin ? `builtin:${identity.name}` : plugin.root, target);
        if (builtin && staged.length) options.builtinAuthority!.approve(identity);
        if (builtin && stagedExtensions.some(row => row.declaration.kind === "channel")) options.builtinChannelAuthority!.approve(identity);
      }
      registrations.push(...staged); extensionRegistrations.push(...stagedExtensions); // Commit only after all entries and identities validate.
      state.status = "active";
      generations.push({ state, dispose });
    } catch (error) {
      state.status = "failed";
      state.error = String(error);
      try { await dispose(); } catch (cleanup) { state.error += `; ${String(cleanup)}`; }
    }
  }
  states.push(...retainedStates);
  if (historyRoot && options.generationReferences) {
    const keep = new Set(references.map(ref => pluginGenerationKey(ref.plugin)));
    for (const state of states) if (state.generation === "current" && state.version && state.fingerprint) keep.add(pluginGenerationKey({ name: state.name, version: state.version, fingerprint: state.fingerprint }));
    try { await collectPluginGenerations(historyRoot, keep); }
    catch (error) { states.push({ name: "plugin-generations", root: historyRoot, enabled: false, trust: "untrusted", status: "failed", error: `Historical collection failed: ${String(error)}` }); }
  }
  const extensions = new ExtensionHost(extensionRegistrations, [...registrations.filter(row => !row.recoveryOnly), ...inline.map(adapter => ({ adapter }))], stateDirectory, options.channelReferences);
  let closing: Promise<void> | undefined;
  return { registrations, extensions,
    list: () => structuredClone(states.map(state => {
      const contributions = extensions.list().filter(contribution => contribution.plugin.name === state.name && contribution.plugin.fingerprint === state.fingerprint);
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
function guardAdapter(adapter: AgentDomainAdapter, plugin: AdapterPluginIdentity, recoveryOnly: boolean, guard: AgentPluginOptions["workerGuard"]): AgentDomainAdapter {
  if (!guard) return adapter;
  return bindDomainAdapter({ ...adapter, async createWorker(context) {
    const check = await guard(context, { plugin, recoveryOnly }); await check();
    const worker = await adapter.createWorker(context);
    try {
      await check();
      const protect = (tool: AgentTool): AgentTool => ({ ...tool,
        ...(tool.bindExecution ? { bindExecution: identity => protect(tool.bindExecution!(identity)) } : {}),
        async execute(input, signal, progress, identity) { await check(); signal.throwIfAborted(); return tool.execute(input, signal, progress, identity); } });
      return { ...worker, tools: worker.tools.map(protect), async authorize(tool, input, identity) { await check(); return worker.authorize(tool, input, identity); } };
    } catch (error) { await worker.close?.(); throw error; }
  } });
}
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
