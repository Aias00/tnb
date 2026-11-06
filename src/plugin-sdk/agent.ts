import type { AgentDomainAdapter, DomainContext, DomainDescriptor, DomainAcceptance, DomainOperation, DomainReceipt, JsonValue } from "../agent/domain";
import type { PluginJsonSchema } from "../agent/plugin-schema";
import { validatePluginConfiguration, validatePluginSchema } from "../agent/plugin-schema";
import { executionConfiguration, type ExecutionConfiguration, type WorkerResources } from "../agent/execution";
import type { JournalOutcome } from "../core/call-journal";

/** Stable author context. No Coding flags, host directories, database or credentials. */
export type AgentContext = Pick<DomainContext, "descriptor" | "namespace" | "run" | "task" | "signal"> & { execution: ExecutionConfiguration };
export type AgentDefinition = {
  id: string; version: string; configuration: PluginJsonSchema;
  validate?(config: JsonValue): void;
  createWorker(context: AgentContext): Promise<WorkerResources>;
  snapshot(context: AgentContext): Promise<JsonValue>;
  accept(context: AgentContext, candidate: { report: string; inputDigest: string; receipts: DomainReceipt[] }, worker?: WorkerResources): Promise<DomainAcceptance>;
  reconcile?(context: AgentContext, operation: DomainOperation): Promise<JournalOutcome | undefined>;
};
function context(value: DomainContext): AgentContext {
  return { descriptor: structuredClone(value.descriptor), namespace: value.namespace, run: structuredClone(value.run),
    task: structuredClone(value.task), signal: value.signal, execution: executionConfiguration(value.configuration) };
}

/** Adapt the stable author contract to the host ABI; existing adapters stay compatible. */
export function defineAgent(definition: AgentDefinition): AgentDomainAdapter {
  validatePluginSchema(definition.configuration);
  const schema = structuredClone(definition.configuration);
  return { id: definition.id, version: definition.version,
    validate(value) {
      validatePluginConfiguration(schema, value);
      const result: unknown = definition.validate?.(value);
      if (result && typeof (result as { then?: unknown }).then === "function") {
        void Promise.resolve(result).catch(() => {}); throw new Error("Agent configuration validation must be synchronous");
      }
    },
    snapshot: value => definition.snapshot(context(value)), createWorker: value => definition.createWorker(context(value)),
    accept: (value, candidate, worker) => definition.accept(context(value), candidate, worker),
    ...(definition.reconcile ? { reconcile: (value: DomainContext, operation: DomainOperation) => definition.reconcile!(context(value), operation) } : {}) };
}
