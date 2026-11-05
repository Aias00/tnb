import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { lock } from "../utils/lockfile";
import { DurableRuntime } from "../services/runtime/engine-core";
import { RuntimeStore } from "../services/runtime/store";
import { DomainRegistry, type AgentDomainAdapter } from "./domain";
import { loadAdapterPlugins, type AgentPluginOptions } from "./plugins";

/** Local Bun host. Acquire the owner lock before opening SQLite, including on recovery. */
export async function openAgentRuntime(options: { directory: string; adapters?: readonly AgentDomainAdapter[]; plugins?: AgentPluginOptions; legacyAdapterId?: string }) {
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const unlock = await lock(options.directory, { realpath: true, stale: 5000, update: 1000, retries: 0 });
  let released = false;
  const release = async () => { if (!released) { released = true; await unlock(); } };
  let store: RuntimeStore | undefined;
  let plugins: Awaited<ReturnType<typeof loadAdapterPlugins>> | undefined;
  try {
    plugins = options.plugins ? await loadAdapterPlugins(options.plugins, options.adapters, join(options.directory, "plugin-snapshots")) : undefined;
    const domains = new DomainRegistry(options.adapters, plugins?.registrations, options.legacyAdapterId);
    store = new RuntimeStore(join(options.directory, "state.sqlite"));
    const runtime = new DurableRuntime(store, options.directory, domains);
    // The host retains ownership through plugin disposal and database close.
    await runtime.start(async () => {});
    let closing: Promise<void> | undefined;
    return { runtime, store, submit: runtime.submitDomain.bind(runtime), plugins: { list: () => plugins?.list() ?? [] },
      close() { return closing ??= (async () => { try { await runtime.close(); } finally {
        try { await plugins?.close(); } finally { try { store!.close(); } finally { await release(); } }
      } })(); },
    };
  } catch (error) {
    try { await plugins?.close(); } finally { try { store?.close(); } finally { await release(); } }
    throw error;
  }
}
export type AgentRuntimeHost = Awaited<ReturnType<typeof openAgentRuntime>>;
export type { WorkerResources } from "../services/runtime/engine-core";
export type { RuntimeEvent, DurableRun, DurableTask } from "../services/runtime/types";
export { DomainRegistry } from "./domain";
export type { AgentDomainAdapter, DomainDescriptor, DomainContext, DomainAcceptance, DomainOperation, JsonValue, ResourceClaim, CapabilityGrant, AdapterPluginIdentity, DomainRuntimePolicy } from "./domain";
export type { AgentPluginOptions, AdapterPluginAPI, AdapterPluginFactory, AdapterPluginState, BuiltinAdapterPlugin } from "./plugins";
