import type { WorkerResources, RuntimeConfiguration } from "../services/runtime/engine-core";
import type { DurableRun, DurableTask } from "../services/runtime/types";
import type { JournalOutcome } from "../core/call-journal";
import type { ToolUseBlock } from "../core/message";
import type { AgentTool } from "../core/tool";
import type { DelegationProposal } from "../services/runtime/delegation";
import { digestJson, encodeJson, text } from "../services/runtime/json";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type ResourceClaim = { id: string; mode: "read" | "write" };
export type CapabilityGrant = { name: string; resources: string[]; mode: "read" | "write" };
/** Persisted data only. Credentials and executable adapter code remain on the host. */
export type AdapterPluginIdentity = { name: string; version: string; fingerprint: string };
export type DomainDescriptor = { id: string; version: string; config: JsonValue; resources: ResourceClaim[]; grants: CapabilityGrant[]; plugin?: AdapterPluginIdentity };
export type PluginAdapterRegistration = { adapter: AgentDomainAdapter; plugin: AdapterPluginIdentity };
export type DomainContext = { descriptor: DomainDescriptor; namespace: string; run: DurableRun; task: DurableTask; signal: AbortSignal;
  configuration: RuntimeConfiguration; stateRoot: string };
export type DomainAcceptance = { checks: Array<{ command: string; output: string }>; evidence?: JsonValue };
/** Trusted host policy. Plugins own resource admission and business configuration; the runtime owns state transitions. */
export type DomainRuntimePolicy = {
  normalize?(configuration: RuntimeConfiguration, stateRoot: string): Promise<void>;
  legacyDescriptor?(configuration: RuntimeConfiguration): DomainDescriptor;
  readOnly?(context: DomainContext): boolean;
  inputLabel?: string;
  delegationScopeLabel?: string;
  instructions?(context: DomainContext): string;
  contract?(context: DomainContext): { [key: string]: JsonValue };
  digest?(snapshot: JsonValue): string;
  acquire?(context: DomainContext): Promise<(() => void | Promise<void>) | undefined>;
  delegate?(context: DomainContext, proposal: DelegationProposal): Promise<Partial<RuntimeConfiguration> & { workspace: string }>;
  verification?: { minimumChecks: number; acceptance: string; total?(context: DomainContext): number };
};
export type DomainOperation = { operationId: string; call: ToolUseBlock; input: unknown };
export type DomainReceipt = { operationId: string; name: string; input: unknown; result: string; truncated: boolean };

export interface AgentDomainAdapter {
  readonly id: string;
  readonly version: string;
  readonly runtime?: DomainRuntimePolicy;
  validate(config: JsonValue): void;
  createWorker(context: DomainContext): Promise<WorkerResources>;
  /** Host facts, not a model summary; must change when relevant inputs change. */
  snapshot(context: DomainContext): Promise<JsonValue>;
  /** Must be read-only/replay-safe. Throw to reject a candidate. */
  accept(context: DomainContext, candidate: { report: string; inputDigest: string; receipts: DomainReceipt[] }, worker?: WorkerResources, progress?: (completed: number) => void): Promise<DomainAcceptance>;
  /** Query an external idempotency key/status; never redispatch the original effect. */
  reconcile?(context: DomainContext, operation: DomainOperation): Promise<JournalOutcome | undefined>;
}

export function validateDomainDescriptor(descriptor: DomainDescriptor): DomainDescriptor {
  // Reject non-JSON values rather than silently dropping functions/undefined during restart.
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 32) throw new Error("Adapter configuration nesting exceeds limit");
    if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return;
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
    if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) { Object.values(value).forEach(item => visit(item, depth + 1)); return; }
    throw new Error("Adapter descriptor must contain JSON data only");
  };
  visit(descriptor);
  if (!descriptor || Object.keys(descriptor).some(key => !["id", "version", "config", "resources", "grants", "plugin"].includes(key))) throw new Error("Invalid adapter descriptor");
  text(descriptor.id, "adapter ID", 128); text(descriptor.version, "adapter version", 128);
  if (descriptor.plugin !== undefined) {
    const plugin = descriptor.plugin;
    if (!plugin || typeof plugin !== "object" || Array.isArray(plugin)) throw new Error("Invalid adapter plugin identity");
    text(plugin.name, "plugin name", 64); text(plugin.version, "plugin version", 128);
    if (Object.keys(plugin).some(key => !["name", "version", "fingerprint"].includes(key)) || !/^[a-f0-9]{64}$/.test(plugin.fingerprint)) throw new Error("Invalid adapter plugin identity");
  }
  if (!Array.isArray(descriptor.resources) || !descriptor.resources.length || descriptor.resources.length > 32) throw new Error("Adapter needs one to 32 resource claims");
  if (!Array.isArray(descriptor.grants) || descriptor.grants.length > 64) throw new Error("Invalid capability grants");
  const ids = new Set<string>();
  for (const claim of descriptor.resources) {
    text(claim.id, "resource ID", 512);
    if (!["read", "write"].includes(claim.mode) || ids.has(claim.id)) throw new Error("Invalid or duplicate resource claim");
    ids.add(claim.id);
  }
  for (const grant of descriptor.grants) {
    text(grant.name, "capability name", 128);
    if (!["read", "write"].includes(grant.mode) || !Array.isArray(grant.resources) || !grant.resources.length || grant.resources.length > 32) throw new Error("Invalid capability grant");
    for (const resource of grant.resources) if (!descriptor.resources.some(claim => claim.id === resource && (grant.mode === "read" || claim.mode === "write"))) throw new Error("Capability exceeds resource claims");
  }
  if (Buffer.byteLength(encodeJson(descriptor)) > 65536) throw new Error("Adapter descriptor exceeds 64 KiB");
  return structuredClone(descriptor);
}

export function bindDomainAdapter(adapter: AgentDomainAdapter): AgentDomainAdapter {
  text(adapter.id, "adapter ID", 128); text(adapter.version, "adapter version", 128);
  const policy = adapter.runtime;
  const runtime = policy ? Object.freeze({ ...policy,
    ...(policy.normalize ? { normalize: policy.normalize.bind(policy) } : {}),
    ...(policy.legacyDescriptor ? { legacyDescriptor: policy.legacyDescriptor.bind(policy) } : {}),
    ...(policy.readOnly ? { readOnly: policy.readOnly.bind(policy) } : {}),
    ...(policy.instructions ? { instructions: policy.instructions.bind(policy) } : {}),
    ...(policy.contract ? { contract: policy.contract.bind(policy) } : {}),
    ...(policy.digest ? { digest: policy.digest.bind(policy) } : {}),
    ...(policy.acquire ? { acquire: policy.acquire.bind(policy) } : {}),
    ...(policy.delegate ? { delegate: policy.delegate.bind(policy) } : {}),
    ...(policy.verification ? { verification: Object.freeze({ ...policy.verification }) } : {}),
  }) : undefined;
  return Object.freeze({ id: adapter.id, version: adapter.version, validate: adapter.validate.bind(adapter), createWorker: adapter.createWorker.bind(adapter),
    snapshot: adapter.snapshot.bind(adapter), accept: adapter.accept.bind(adapter), ...(adapter.reconcile ? { reconcile: adapter.reconcile.bind(adapter) } : {}),
    ...(runtime ? { runtime } : {}) });
}

export class DomainRegistry {
  readonly #adapters = new Map<string, AgentDomainAdapter>();
  readonly #plugins = new Map<string, AdapterPluginIdentity>();
  readonly #legacy?: AgentDomainAdapter;
  constructor(adapters: readonly AgentDomainAdapter[] = [], plugins: readonly PluginAdapterRegistration[] = [], legacyAdapterId?: string) {
    for (const { adapter, plugin } of [...adapters.map(adapter => ({ adapter, plugin: undefined })), ...plugins]) {
      text(adapter.id, "adapter ID", 128); text(adapter.version, "adapter version", 128);
      const key = digestJson({ id: adapter.id, version: adapter.version });
      if (this.#adapters.has(key)) throw new Error("Duplicate adapter identity");
      this.#adapters.set(key, bindDomainAdapter(adapter));
      if (plugin) this.#plugins.set(key, Object.freeze({ ...plugin }));
      if (legacyAdapterId === adapter.id) {
        if (this.#legacy || !adapter.runtime?.legacyDescriptor) throw new Error("Invalid or ambiguous legacy adapter");
        this.#legacy = this.#adapters.get(key);
      }
    }
  }
  descriptor(configuration: RuntimeConfiguration): DomainDescriptor {
    if (configuration.domain) return configuration.domain;
    if (!this.#legacy?.runtime?.legacyDescriptor) throw new Error("Legacy execution adapter unavailable; configure the original plugin explicitly");
    return this.prepare(this.#legacy.runtime.legacyDescriptor(configuration));
  }
  has(id: string, version: string): boolean { return this.#adapters.has(digestJson({ id, version })); }
  /** Pin new submissions. Recovery must use resolve directly and cannot acquire a new identity. */
  prepare(descriptor: DomainDescriptor): DomainDescriptor {
    const value = validateDomainDescriptor(descriptor);
    const plugin = this.#plugins.get(digestJson({ id: value.id, version: value.version }));
    if (!value.plugin && plugin) value.plugin = { ...plugin };
    this.resolve(value);
    return validateDomainDescriptor(value);
  }
  resolve(descriptor: DomainDescriptor): AgentDomainAdapter {
    const key = digestJson({ id: descriptor.id, version: descriptor.version });
    const adapter = this.#adapters.get(key);
    if (!adapter) throw new Error(`Adapter unavailable: ${descriptor.id}@${descriptor.version}; register the pinned version or migrate explicitly`);
    if (digestJson(descriptor.plugin ?? null) !== digestJson(this.#plugins.get(key) ?? null)) throw new Error(`Adapter plugin identity changed: ${descriptor.id}@${descriptor.version}; restore the pinned package or migrate explicitly`);
    const validation: unknown = adapter.validate(structuredClone(descriptor.config));
    if (validation && typeof (validation as { then?: unknown }).then === "function") {
      void Promise.resolve(validation).catch(() => undefined);
      throw new Error("Adapter config validation must be synchronous");
    }
    return adapter;
  }
}

export const RUNTIME_TOOL_NAMES = new Set(["agent", "durable_wait", "durable_recall", "assess_delegation", "review_child_result", "complete_investigation"]);
export function selectDomainTools(tools: AgentTool[], descriptor: DomainDescriptor): AgentTool[] {
  if (new Set(tools.map(tool => tool.name)).size !== tools.length || tools.some(tool => RUNTIME_TOOL_NAMES.has(tool.name))) throw new Error("Duplicate or reserved adapter tool name");
  return tools.filter(tool => {
    const capability = tool.capability;
    if (!capability) return false; // Includes unclassified MCP tools; classification belongs to the trusted host.
    if (!["read", "write"].includes(capability.mode) || !Array.isArray(capability.resources) || !capability.resources.length) throw new Error("Invalid tool capability");
    return capability.resources.every(id => descriptor.grants.some(grant => grant.name === capability.name && grant.resources.includes(id)
      && (capability.mode === "read" || grant.mode === "write")));
  });
}
