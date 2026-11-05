/** Compatibility composition for callers supplying the historical coding worker factory. */
import { DurableRuntime as Runtime } from "./engine-core";
import { DomainRegistry } from "../../agent/domain";
import { createCodingAdapter } from "../../adapters/coding/adapter";
import type { RuntimeWorkerFactory } from "./engine-core";
import type { RuntimeStore } from "./store";

export class DurableRuntime extends Runtime {
  constructor(store: RuntimeStore, root: string, readonly factory: RuntimeWorkerFactory, domains?: DomainRegistry) {
    super(store, root, domains ?? new DomainRegistry([createCodingAdapter(factory)], [], "coding"));
  }
}
export type { RuntimeConfiguration, RuntimeWorkerFactory, WorkerResources } from "./engine-core";
