import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { lock } from "../utils/lockfile";
import { DurableRuntime } from "../services/runtime/engine-core";
import { RuntimeStore } from "../services/runtime/store";
import { DomainRegistry, type AgentDomainAdapter } from "./domain";
import type { ExtensionHostOptions, ContributionReference } from "./extensions";
import { loadAdapterPlugins, type AgentPluginOptions } from "./plugins";
import { pluginGenerationReferences } from "./plugin-generations";
import { builtinGenerationAuthority, builtinChannelGenerationAuthority } from "./builtin-generations";
import { channelGenerationReferences } from "./channel-bindings";

/** Local Bun host. Acquire the owner lock before opening SQLite, including on recovery. */
export async function openAgentRuntime(options: { directory: string; adapters?: readonly AgentDomainAdapter[]; plugins?: AgentPluginOptions; legacyAdapterId?: string; signal?: AbortSignal; services?: ExtensionHostOptions["services"]; serviceProviders?: ExtensionHostOptions["serviceProviders"]; serviceGrants?: ExtensionHostOptions["grants"] }) {
  options.signal?.throwIfAborted();
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const unlock = await lock(options.directory, { realpath: true, stale: 5000, update: 1000, retries: 0 });
  let released = false;
  const release = async () => { if (!released) { released = true; await unlock(); } };
  let store: RuntimeStore | undefined;
  let running: DurableRuntime | undefined;
  let plugins: Awaited<ReturnType<typeof loadAdapterPlugins>> | undefined;
  try {
    store = new RuntimeStore(join(options.directory, "state.sqlite"));
    plugins = options.plugins ? await loadAdapterPlugins({ ...options.plugins, generationReferences: pluginGenerationReferences(store),
      channelReferences: [...channelGenerationReferences(store), ...(options.plugins.channelReferences ?? [])], builtinAuthority: builtinGenerationAuthority(store), builtinChannelAuthority: builtinChannelGenerationAuthority(store) }, options.adapters, join(options.directory, "plugin-snapshots")) : undefined;
    const domains = new DomainRegistry(options.adapters, plugins?.registrations, options.legacyAdapterId);
    const runtime = running = new DurableRuntime(store, options.directory, domains);
    // The host retains ownership through plugin disposal and database close.
    await runtime.start(async () => {});
    await plugins?.extensions.start({ store, signal: options.signal, services: options.services, serviceProviders: options.serviceProviders, grants: options.serviceGrants });
    options.signal?.throwIfAborted();
    let closing: Promise<void> | undefined;
    const abort = () => { void close().catch(() => undefined); };
    function close(): Promise<void> {
      return closing ??= (async () => { options.signal?.removeEventListener("abort", abort);
        try { try { await plugins?.extensions.stop(); } finally { await runtime.close(); } } finally {
          try { await plugins?.close(); } finally { try { store!.close(); } finally { await release(); } }
        }
      })();
    }
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) { await close(); options.signal.throwIfAborted(); }
    return { runtime, store, submit: runtime.submitDomain.bind(runtime), plugins: { list: () => plugins?.list() ?? [], extensions: () => plugins?.extensions.list() ?? [],
        request: (ref: ContributionReference, request: Request) => { if (!plugins) throw new Error("No host plugins are loaded"); return plugins.extensions.handle(ref, request); }, channels: plugins?.extensions.channels }, close };

  } catch (error) {
    try { try { await plugins?.extensions.stop(); } finally { await running?.close(); } } finally {
      try { await plugins?.close(); } finally { try { store?.close(); } finally { await release(); } }
    }
    throw error;
  }
}
export type AgentRuntimeHost = Awaited<ReturnType<typeof openAgentRuntime>>;
export type { WorkerResources } from "../services/runtime/engine-core";
export type { RuntimeEvent, DurableRun, DurableTask } from "../services/runtime/types";
export { DomainRegistry } from "./domain";
export type { AgentDomainAdapter, DomainDescriptor, DomainContext, DomainAcceptance, DomainOperation, JsonValue, ResourceClaim, CapabilityGrant, AdapterPluginIdentity, DomainRuntimePolicy } from "./domain";
export type { AgentPluginOptions, AdapterPluginAPI, AdapterPluginFactory, AdapterPluginState, BuiltinAdapterPlugin } from "./plugins";

export { loadHostPlugins } from "./plugins";
export type { TaskService, WorkspaceTaskService } from "./task-service";
export { TASK_SERVICE, TASK_SERVICE_REF } from "./task-service";
export type { HostPluginAPI, HostPluginFactory, BuiltinHostPlugin, HostPluginOptions, HostPluginState } from "./plugins";
export type { PluginGenerationReference } from "./plugin-generations";
export { builtinGenerationAuthority, builtinChannelGenerationAuthority } from "./builtin-generations";
export { channelGenerationReferences, resolveChannelBinding } from "./channel-bindings";
export type { ChannelBinding, ChannelGenerationReference } from "./channel-bindings";
export type { BuiltinGenerationAuthority } from "./builtin-generations";
export type { PackedPlugin } from "./packed-plugin";
export type { PluginApplication, PluginInterface, PluginChannel, ExtensionContext, ActiveExtension, ChannelPort, ChannelDescriptor, ChannelRegistry, PluginStateStore, ContributionReference, ExtensionState } from "./extensions";

export { COLLABORATION_SERVICE, COLLABORATION_SERVICE_REF } from "./collaboration-service";
export type { CollaborationService, CollaborationServiceFactory, CollaborationState, CollaborationStateTransaction } from "./collaboration-service";
export { createServiceRef, provideService, PluginServiceError } from "./services";
export type { ServiceRef, ServiceProvider, ServiceFactoryContext, ServiceConsumer, ServiceScope } from "./services";
export { CHANNEL_SERVICE, CHANNEL_SERVICE_REF } from "./channel-service";
export { RUNTIME_READ_SERVICE, RUNTIME_READ_SERVICE_REF } from "./runtime-read-service";
export type { RuntimeReadService } from "./runtime-read-service";
