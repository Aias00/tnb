import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { lock } from "../utils/lockfile";
import { DurableRuntime, type RuntimeWorkerFactory } from "../services/runtime/engine";
import { RuntimeStore } from "../services/runtime/store";
import { DomainRegistry, type AgentDomainAdapter } from "./domain";

/** Local Bun host. Acquire the owner lock before opening SQLite, including on recovery. */
export async function openAgentRuntime(options: { directory: string; adapters: readonly AgentDomainAdapter[]; codingFactory?: RuntimeWorkerFactory }) {
  const domains = new DomainRegistry(options.adapters);
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const unlock = await lock(options.directory, { realpath: true, stale: 5000, update: 1000, retries: 0 });
  let released = false;
  const release = async () => { if (!released) { released = true; await unlock(); } };
  let store: RuntimeStore | undefined;
  try {
    store = new RuntimeStore(join(options.directory, "state.sqlite"));
    const runtime = new DurableRuntime(store, options.directory, options.codingFactory ?? (async () => { throw new Error("Coding adapter is not configured in this host"); }), domains);
    await runtime.start(release);
    let closed = false;
    return { runtime, store, submit: runtime.submitDomain.bind(runtime),
      async close() { if (!closed) { closed = true; try { await runtime.close(); } finally { store!.close(); } } },
    };
  } catch (error) { store?.close(); await release(); throw error; }
}
export type AgentRuntimeHost = Awaited<ReturnType<typeof openAgentRuntime>>;
export type { WorkerResources } from "../services/runtime/engine";
export type { RuntimeEvent, DurableRun, DurableTask } from "../services/runtime/types";
export { DomainRegistry } from "./domain";
export type { AgentDomainAdapter, DomainDescriptor, DomainContext, DomainAcceptance, DomainOperation, JsonValue, ResourceClaim, CapabilityGrant } from "./domain";
