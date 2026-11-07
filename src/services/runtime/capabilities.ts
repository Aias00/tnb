import type { CreateRunInput } from "./commands";
import { randomUUID } from "node:crypto";
import type { CapabilityDefinition, CapabilityRef, CapabilityPublication, CapabilityConsumer, CapabilityAuthorization, CapabilityRequest, ExecutionService, ExecutionReceipt } from "../../agent/execution-service";
import { validateDomainDescriptor } from "../../agent/domain";
import { validateAgentTaskInput } from "../../agent/execution";
import { validatePluginSchema, validatePluginJsonValue } from "../../agent/plugin-schema";
import type { ServiceFactoryContext } from "../../agent/services";
import type { DurableRuntime, RuntimeConfiguration } from "./engine-core";
import { digestJson, encodeJson, integer, text } from "./json";

const PUBLICATIONS = "host.capabilities/v1", AUTHORIZATIONS = "host.capability-grants/v1";
type Published = Omit<CapabilityPublication, "revision">;
type Authorized = Omit<CapabilityAuthorization, "revision"> & { sourceId: string };
const key = (ref: CapabilityRef) => digestJson({ id: ref.id, version: ref.version });
function object(value: unknown, fields: string[]): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some(name => !fields.includes(name))) throw new Error("Invalid capability object or unknown field");
  return value as Record<string, any>;
}
export function capabilityRef(value: unknown): CapabilityRef {
  const ref = object(value, ["id", "version"]);
  return { id: text(ref.id, "capability ID", 128), version: text(ref.version, "capability version", 128) };
}
export function capabilityConsumer(value: unknown): CapabilityConsumer {
  const v = object(value, ["plugin", "contribution"]), c = object(v.contribution, ["kind", "id", "version"]);
  if (!["application", "interface", "channel"].includes(c.kind)) throw new Error("Invalid capability consumer kind");
  const plugin = validateDomainDescriptor({ id: "validate", version: "1", config: null, resources: [{ id: "validate", mode: "read" }], grants: [], plugin: v.plugin }).plugin;
  if (!plugin) throw new Error("Capability authorization requires an exact plugin identity");
  return { plugin, contribution: { kind: c.kind, id: text(c.id, "consumer ID", 128), version: text(c.version, "consumer version", 128) } };
}
/** Stable across explicitly authorized package upgrades; never across contribution identities. */
function actor(consumer?: CapabilityConsumer): string { return consumer ? digestJson({ name: consumer.plugin.name, contribution: consumer.contribution }) : "owner"; }
const authorizationKey = (consumer: CapabilityConsumer, ref: CapabilityRef) => digestJson({ actor: actor(consumer), capability: ref });
export function validateCapabilityDefinition(value: unknown): CapabilityDefinition {
  const v = object(value, ["protocol", "id", "version", "namespace", "objective", "adapter", "inputSchema", "resources", "grants", "execution"]);
  if (v.protocol !== "tnb.capability/v1") throw new Error("Unsupported capability protocol");
  const ref = capabilityRef({ id: v.id, version: v.version }), adapter = capabilityRef(v.adapter);
  validatePluginSchema(v.inputSchema);
  const execution = object(v.execution, ["mode", "maxDurationMs", "maxTurns", "maxRetries", "compactThreshold", "maxModelRequests", "maxCostUsd", "provider", "model"]);
  if (execution.maxDurationMs !== undefined) integer(execution.maxDurationMs, "capability duration", 1, 30 * 24 * 60 * 60_000);
  const { maxDurationMs: _, ...limits } = execution;
  const checked = validateAgentTaskInput({ commandId: "check", objective: v.objective, namespace: v.namespace,
    adapter: { ...adapter, config: null, resources: v.resources, grants: v.grants }, ...limits });
  const definition = { protocol: v.protocol, ...ref, namespace: checked.namespace, objective: checked.objective, adapter,
    inputSchema: v.inputSchema, resources: checked.adapter.resources, grants: checked.adapter.grants, execution } as CapabilityDefinition;
  // Leave room in the 128 KiB publication row for identity, digest and metadata.
  encodeJson(definition, 48 * 1024); return structuredClone(definition);
}
export function validateCapabilityRequest(value: unknown): CapabilityRequest {
  const v = object(value, ["commandId", "capability", "input"]);
  text(v.commandId, "business command ID", 128); encodeJson(v.input, 48 * 1024);
  return { commandId: v.commandId, capability: capabilityRef(v.capability), input: structuredClone(v.input) };
}
export type CapabilityCommand =
  | { action: "list" | "grants"; after?: string; limit?: number }
  | { action: "get"; capability: CapabilityRef }
  | { action: "check" | "publish"; definition: CapabilityDefinition }
  | { action: "state"; commandId: string; capability: CapabilityRef; enabled: boolean; expectedRevision: number }
  | { action: "grant"; commandId: string; capability: CapabilityRef; consumer: CapabilityConsumer; enabled: boolean; expectedRevision: number };
export function validateCapabilityCommand(value: unknown): CapabilityCommand {
  const action = (value as any)?.action;
  const fields: Record<string, string[]> = { list: ["after", "limit"], grants: ["after", "limit"], get: ["capability"], check: ["definition"], publish: ["definition"],
    state: ["commandId", "capability", "enabled", "expectedRevision"], grant: ["commandId", "capability", "consumer", "enabled", "expectedRevision"] };
  if (typeof action !== "string" || !Object.hasOwn(fields, action)) throw new Error("Unknown capability command");
  const v = object(value, ["action", ...fields[action]!]);
  if (["list", "grants"].includes(action)) { page(v); return structuredClone(v) as CapabilityCommand; }
  if (["check", "publish"].includes(action)) return { action, definition: validateCapabilityDefinition(v.definition) } as CapabilityCommand;
  const capability = capabilityRef(v.capability);
  if (action === "get") return { action, capability };
  text(v.commandId, "capability command ID", 128); integer(v.expectedRevision, "expected revision");
  if (typeof v.enabled !== "boolean") throw new Error("Capability enabled must be boolean");
  return { ...v, capability, ...(action === "grant" ? { consumer: capabilityConsumer(v.consumer) } : {}) } as CapabilityCommand;
}
function page(input: { after?: string; limit?: number }) {
  if (input.after !== undefined && !/^[a-f0-9]{64}$/.test(input.after)) throw new Error("Invalid capability page cursor");
  return { after: input.after ?? "", limit: integer(input.limit ?? 16, "capability page size", 1, 32) };
}

/** Owner-only administration and least-authority contribution facades share the same durable facts. */
export class PublishedCapabilities {
  constructor(readonly runtime: DurableRuntime) {}
  get(ref: CapabilityRef): CapabilityPublication {
    const row = this.runtime.store.applicationRecord<Published>(PUBLICATIONS, key(capabilityRef(ref)));
    if (!row) throw new Error("Capability publication not found");
    return { ...row.value, revision: row.revision };
  }
  check(definition: CapabilityDefinition): CapabilityPublication {
    definition = validateCapabilityDefinition(definition);
    const adapter = this.runtime.domains.catalog().find(item => item.id === definition.adapter.id && item.version === definition.adapter.version);
    if (!adapter || adapter.submission !== "domain" || !adapter.plugin) throw new Error("Publication requires a current plugin-backed domain Adapter");
    const pinned = { definition, plugin: adapter.plugin };
    return { ...structuredClone(pinned), digest: digestJson(pinned), enabled: true, revision: 0 };
  }
  command(input: unknown): unknown {
    const v = validateCapabilityCommand(input), store = this.runtime.store;
    if (v.action === "get") return this.get(v.capability);
    if (v.action === "list" || v.action === "grants") {
      const { after, limit } = page(v), rows = store.applicationRecords<any>(v.action === "list" ? PUBLICATIONS : AUTHORIZATIONS, after, limit + 1);
      const items = rows.slice(0, limit).map(row => ({ ...row.value, revision: row.revision }));
      return { items, ...(rows.length > limit ? { next: rows[limit - 1]!.id } : {}) };
    }
    if (v.action === "check") return this.check(v.definition);
    if (v.action === "publish") {
      const checked = this.check(v.definition), { revision: _, ...value } = checked;
      return store.command(`cap.pub.${randomUUID()}`, v, Date.now(), tx => {
        const previous = tx.applicationRecord<Published>(PUBLICATIONS, key(v.definition));
        if (previous) {
          if (previous.value.digest !== value.digest) throw new Error("Published capability versions are immutable; publish a new version");
          return { ...previous.value, revision: previous.revision };
        }
        const row = tx.saveApplicationRecord({ namespace: PUBLICATIONS, id: key(v.definition), value }, 0);
        return { ...row.value, revision: row.revision };
      });
    }
    if (v.action === "state") return store.command(`cap.admin.${digestJson(v.commandId)}`, v, Date.now(), tx => {
      const row = tx.applicationRecord<Published>(PUBLICATIONS, key(v.capability));
      if (!row) throw new Error("Capability publication not found");
      const saved = tx.saveApplicationRecord({ ...row, value: { ...row.value, enabled: v.enabled } }, v.expectedRevision);
      return { ...saved.value, revision: saved.revision };
    });
    if (v.action !== "grant") throw new Error("Unknown capability command");
    this.get(v.capability);
    return store.command(`cap.admin.${digestJson(v.commandId)}`, v, Date.now(), tx => {
      const row = tx.saveApplicationRecord<Authorized>({ namespace: AUTHORIZATIONS, id: authorizationKey(v.consumer, v.capability),
        value: { consumer: v.consumer, capability: v.capability, enabled: v.enabled, sourceId: actor(v.consumer) } }, v.expectedRevision);
      return { ...row.value, revision: row.revision };
    });
  }
  private authorize(consumer: CapabilityConsumer | undefined, ref: CapabilityRef) {
    if (!consumer) return; // Private Owner administration, not an anonymous public principal.
    const row = this.runtime.store.applicationRecord<Authorized>(AUTHORIZATIONS, authorizationKey(consumer, ref));
    if (!row?.value.enabled || digestJson(row.value.consumer) !== digestJson(consumer)) throw new Error("CAPABILITY_ACCESS_DENIED");
  }
  private current(publication: CapabilityPublication) {
    if (!publication.enabled) throw new Error("Capability publication is disabled");
    const current = this.runtime.domains.catalog().find(item => item.id === publication.definition.adapter.id && item.version === publication.definition.adapter.version);
    if (current?.submission !== "domain" || digestJson(current.plugin ?? null) !== digestJson(publication.plugin ?? null)) throw new Error("Published Adapter code unavailable or changed; restore the package or publish a new capability version");
  }
  async submit(value: unknown, consumer?: CapabilityConsumer, assertActive = () => {}): Promise<ExecutionReceipt> {
    consumer = consumer ? capabilityConsumer(consumer) : undefined;
    const input = validateCapabilityRequest(value), identity = actor(consumer), requestHash = digestJson(input);
    const commandId = `cap.exec.${digestJson({ actor: identity, commandId: input.commandId })}`;
    const authorized = () => { assertActive(); this.authorize(consumer, input.capability); };
    const replay = (): ExecutionReceipt | undefined => {
      authorized();
      const runId = this.runtime.store.commandRunIdHint(commandId);
      if (!runId) return;
      const binding = this.runtime.store.record<RuntimeConfiguration>("configuration", runId)?.value.executionBinding;
      if (!binding) throw new Error("Execution evidence unavailable; do not retry as a new task");
      if (binding.actor !== identity || binding.requestHash !== requestHash) throw new Error("Business command ID was already used with different input");
      const submission = this.runtime.store.record<{ command: CreateRunInput }>("submission", commandId)?.value;
      if (!submission || !this.runtime.commands.replayCreateRun(submission.command)) throw new Error("Execution receipt evidence unavailable");
      return { runId, capability: binding.capability, publicationDigest: binding.publicationDigest };
    };
    const previous = replay(); if (previous) return previous;
    const publication = this.get(input.capability); this.current(publication);
    const d = publication.definition, config = validatePluginJsonValue(d.inputSchema, input.input, 48 * 1024);
    const { mode = "single", maxDurationMs = 24 * 60 * 60_000, ...execution } = d.execution;
    const adapter = { ...d.adapter, config, resources: d.resources, grants: d.grants, plugin: publication.plugin };
    const binding = { actor: identity, ...(consumer ? { consumer } : {}), requestHash, capability: input.capability, publicationDigest: publication.digest };
    const task = { commandId, objective: d.objective, namespace: d.namespace, mode, adapter, ...execution, deadline: Date.now() + maxDurationMs };
    try {
      const receipt = await this.runtime.submitDomain(task, { domainOnly: true, executionBinding: binding, beforeCreate: configuration => {
        authorized(); this.current(this.get(input.capability));
        const expected = { domain: adapter, executionBinding: binding, maxTurns: execution.maxTurns ?? 50, maxRetries: execution.maxRetries ?? 1,
          maxModelRequests: execution.maxModelRequests ?? 256, compactThreshold: execution.compactThreshold ?? 10000, maxCostUsd: execution.maxCostUsd, provider: execution.provider, model: execution.model };
        const actual = Object.fromEntries(Object.keys(expected).map(name => [name, (configuration as any)[name]]));
        if (digestJson(expected) !== digestJson(actual)) throw new Error("Adapter normalization changed the published execution contract");
      } });
      authorized();
      return { runId: receipt.run.runId, capability: input.capability, publicationDigest: publication.digest };
    } catch (error) {
      // Concurrent exact requests may prepare different absolute deadlines. The committed business hash wins.
      const accepted = replay(); if (accepted) return accepted;
      throw error;
    }
  }
  service(scope: ServiceFactoryContext): ExecutionService {
    if (!scope.consumer) throw new Error("Execution service requires contribution identity");
    const consumer = capabilityConsumer(scope.consumer);
    const run = (runId: string) => {
      scope.assertActive(); text(runId, "execution Run ID", 128);
      const value = this.runtime.store.record<RuntimeConfiguration>("configuration", runId)?.value.executionBinding;
      if (!value || value.actor !== actor(consumer)) throw new Error("CAPABILITY_ACCESS_DENIED");
      this.authorize(consumer, value.capability);
      const current = this.runtime.store.getRun(runId); if (!current) throw new Error("Execution Run not found"); return current;
    };
    return {
      catalog: (input = {}) => {
        scope.assertActive(); object(input, ["after", "limit"]); const { after, limit } = page(input);
        // Page grants rather than all publications: bounded work even when most capabilities are denied.
        const rows = this.runtime.store.applicationRecords<Authorized>(AUTHORIZATIONS, after, limit + 1, { sourceId: actor(consumer) });
        const items = rows.slice(0, limit).filter(row => row.value.enabled && digestJson(row.value.consumer) === digestJson(consumer)).map(row => {
          const p = this.get(row.value.capability); return { capability: row.value.capability, namespace: p.definition.namespace, digest: p.digest, enabled: p.enabled };
        });
        return { items, ...(rows.length > limit ? { next: rows[limit - 1]!.id } : {}) };
      },
      submit: input => this.submit(input, consumer, scope.assertActive),
      status: input => {
        object(input, ["runId", "after", "limit"]); const current = run(input.runId);
        if (input.after !== undefined) text(input.after, "task cursor", 128);
        const limit = integer(input.limit ?? 32, "task page size", 1, 64);
        const tasks = this.runtime.store.tasks(input.runId).sort((a, b) => a.taskId.localeCompare(b.taskId)).filter(t => !input.after || t.taskId > input.after).slice(0, limit + 1);
        return { runId: current.runId, status: current.status, revision: current.revision,
          tasks: tasks.slice(0, limit).map(t => ({ taskId: t.taskId, status: t.status, hasResult: !!t.resultRef })), ...(tasks.length > limit ? { next: tasks[limit - 1]!.taskId } : {}) };
      },
      result: async input => {
        object(input, ["runId", "taskId", "offset", "limit"]); run(input.runId); text(input.taskId, "result task ID", 128);
        const task = this.runtime.store.getTask(input.taskId);
        if (!task || task.runId !== input.runId || !task.resultRef || task.status !== "succeeded") throw new Error("Accepted execution result unavailable");
        const offset = integer(input.offset ?? 0, "result offset"), limit = integer(input.limit ?? 8192, "result page size", 1, 16384);
        const content = encodeJson(await this.runtime.artifacts.get(task.resultRef), 1024 * 1024); run(input.runId); // revocation during IO
        if (offset > content.length) throw new Error("Result offset exceeds result length");
        const end = Math.min(offset + limit, content.length);
        return { taskId: task.taskId, text: content.slice(offset, end), offset, total: content.length, ...(end < content.length ? { next: end } : {}) };
      },
    };
  }
}
