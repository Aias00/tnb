import { realpath } from "node:fs/promises";
import { codingDomain } from "./domain";
import { acquireWorkspace, workspaceIsLocked } from "../../services/runtime/workspace";
import { digestJson } from "../../services/runtime/json";
import type { RuntimeConfiguration } from "../../services/runtime/engine-core";
import type { AgentDomainAdapter, DomainDescriptor, JsonValue } from "../../agent/domain";
import { capabilityClaims, validateCapabilitySelection, type CodingWorkerFactory } from "./capabilities";

export type CodingConfiguration = Pick<RuntimeConfiguration, "workspace" | "allowedWorkspaces" | "allowWrite" | "allowShell" | "checks" | "provider" | "model" | "skills" | "mcpTools" | "capabilityPins">;
function configuration(value: JsonValue): CodingConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid coding configuration");
  const data = value as Record<string, JsonValue>;
  if (Object.keys(data).some(key => !["workspace", "allowedWorkspaces", "allowWrite", "allowShell", "checks", "provider", "model", "skills", "mcpTools", "capabilityPins"].includes(key))
    || typeof data.workspace !== "string" || !data.workspace || typeof data.allowWrite !== "boolean" || typeof data.allowShell !== "boolean"
    || !Array.isArray(data.allowedWorkspaces) || data.allowedWorkspaces.length > 16 || data.allowedWorkspaces.some(path => typeof path !== "string" || !path)
    || !Array.isArray(data.checks) || data.checks.length > 64 || data.checks.some(command => typeof command !== "string" || !command || command.length > 4096)
    || data.provider !== undefined && typeof data.provider !== "string" || data.model !== undefined && typeof data.model !== "string") throw new Error("Invalid coding configuration");
  if (data.allowWrite && !data.checks.length) throw new Error("Coding tasks require explicit replay-safe verification commands");
  if (data.allowShell && !data.allowWrite) throw new Error("Shell execution requires explicit write authority");
  const config = structuredClone(data) as unknown as CodingConfiguration;
  validateCapabilitySelection(config);
  return config;
}
function describe(config: CodingConfiguration): DomainDescriptor {
  const resource = `workspace:${config.workspace}`;
  return { id: "coding", version: "1", config: { workspace: config.workspace, allowedWorkspaces: [...config.allowedWorkspaces],
    allowWrite: config.allowWrite, allowShell: config.allowShell, checks: [...config.checks],
    ...(config.provider !== undefined ? { provider: config.provider } : {}), ...(config.model !== undefined ? { model: config.model } : {}),
    ...(config.skills !== undefined ? { skills: [...config.skills] } : {}), ...(config.mcpTools !== undefined ? { mcpTools: [...config.mcpTools] } : {}),
    ...(config.capabilityPins !== undefined ? { capabilityPins: { ...config.capabilityPins } } : {}) },
    resources: [{ id: resource, mode: config.allowWrite || config.checks.length ? "write" : "read" }, ...capabilityClaims(config)],
    grants: [{ name: "workspace.read", resources: [resource], mode: "read" },
      ...(config.allowWrite ? [{ name: "workspace.write", resources: [resource], mode: "write" as const }] : []),
      ...(config.allowShell ? [{ name: "workspace.execute", resources: [resource], mode: "write" as const }] : []),
      ...(config.skills?.length ? [{ name: "skill.read", resources: config.skills.map(name => `skill:${name}`), mode: "read" as const }] : []),
      ...(config.mcpTools ?? []).map(name => ({ name: "mcp.call", resources: [`mcp-tool:${name}`], mode: "write" as const }))] };
}
/** Canonical paths are part of the persisted plugin contract, never inferred from model text. */
export async function codingTask(config: CodingConfiguration): Promise<DomainDescriptor> {
  const value = configuration(describe(config).config);
  value.workspace = await realpath(value.workspace);
  value.allowedWorkspaces = await Promise.all(value.allowedWorkspaces.map(path => realpath(path)));
  if (!value.allowedWorkspaces.includes(value.workspace)) value.allowedWorkspaces.push(value.workspace);
  return describe(value);
}

/** Resource ownership lives with this plugin generation, shared by its readers until the last reader exits. */
export function createCodingAdapter(factory: CodingWorkerFactory): AgentDomainAdapter {
  const leases = new Map<string, { runId: string; readOnly: boolean; holders: Set<string>; release(): Promise<void> }>();
  const acquiring = new Map<string, Promise<unknown>>();
  const adapter: AgentDomainAdapter = { id: "coding", version: "1", validate: value => { configuration(value); },
    runtime: {
      legacyDescriptor: describe,
      async normalize(config, root) {
        if (config.domain) Object.assign(config, configuration(config.domain.config));
        await codingDomain.normalize(config, root);
        if (config.domain) {
          const expected = describe(config);
          if (digestJson(config.domain.resources) !== digestJson(expected.resources) || digestJson(config.domain.grants) !== digestJson(expected.grants)
            || digestJson(config.domain.config) !== digestJson(expected.config)) throw new Error("Coding capabilities do not match the canonical workspace configuration");
        }
        if (config.skills?.length || config.mcpTools?.length || config.capabilityPins) {
          if (!factory.prepareCapabilities) throw new Error("Coding worker does not support durable skills/MCP");
          await factory.prepareCapabilities(config);
          if (config.domain) config.domain = { ...describe(config), ...(config.domain.plugin ? { plugin: config.domain.plugin } : {}) };
        }
      },
      readOnly: context => !context.configuration.allowWrite && !context.configuration.mcpTools?.length,
      inputLabel: "Workspace",
      delegationScopeLabel: "workspace paths",
      instructions: context => codingDomain.instructions(context.configuration),
      contract: context => ({ workspace: context.configuration.workspace, verificationCommands: context.configuration.checks,
        permissions: { write: context.configuration.allowWrite, shell: context.configuration.allowShell } }),
      digest(value) { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid workspace snapshot"); return value; },
      verification: { minimumChecks: 0, acceptance: "verification-commands", total: context => context.configuration.checks.length },
      async acquire(context) {
        const config = context.configuration, workspace = config.workspace;
        await acquiring.get(workspace);
        let lease = leases.get(workspace);
        if (!(lease && lease.runId === context.run.runId && lease.readOnly && !config.allowWrite && !config.checks.length)) {
          if (await workspaceIsLocked(workspace)) return undefined;
          const pending = acquireWorkspace(workspace); acquiring.set(workspace, pending);
          let release: () => Promise<void>;
          try { release = await pending; }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ELOCKED") return undefined; throw error; }
          finally { if (acquiring.get(workspace) === pending) acquiring.delete(workspace); }
          lease = { runId: context.run.runId, readOnly: !config.allowWrite && !config.checks.length && !config.mcpTools?.length, holders: new Set(), release };
          leases.set(workspace, lease);
        }
        lease!.holders.add(context.task.taskId); const held = lease!;
        return async () => { held.holders.delete(context.task.taskId); if (!held.holders.size) { leases.delete(workspace); await held.release(); } };
      },
      async delegate(context, proposal) {
        const config = context.configuration;
        const workspace = await codingDomain.delegationWorkspace(proposal.workspace, config.workspace);
        if (!config.allowedWorkspaces.includes(workspace)) throw new Error("Delegation workspace is not authorized");
        if (config.strategyVersion === 2) await codingDomain.delegationScope(workspace, proposal.scope!);
        const child = { workspace, allowedWorkspaces: config.allowedWorkspaces, allowWrite: false, allowShell: false, checks: [], provider: config.provider, model: config.model,
          ...(config.skills || config.mcpTools || config.capabilityPins ? { skills: [], mcpTools: [], capabilityPins: {} } : {}) };
        return { ...child, ...(config.domain ? { domain: { ...describe(child), ...(context.descriptor.plugin ? { plugin: context.descriptor.plugin } : {}) } } : {}) };
      },
    },
    snapshot: context => codingDomain.snapshot(context.configuration),
    async createWorker(context) {
      const worker = await factory({ run: context.run, task: context.task, configuration: context.configuration, signal: context.signal });
      try {
        worker.tools = codingDomain.tools(worker, context.configuration).map(tool => tool.capability ? tool : ({ ...tool,
          capability: { name: tool.access === "read" ? "workspace.read" : tool.access === "write" ? "workspace.write" : "workspace.execute",
            resources: [`workspace:${context.configuration.workspace}`], mode: tool.access === "read" ? "read" as const : "write" as const },
          effects: { replay: tool.access === "read" ? "safe" as const : "never" as const },
        }));
        return worker;
      } catch (error) { await worker.close?.(); throw error; }
    },
    async accept(context, _candidate, worker, progress) {
      if (!worker) throw new Error("Coding verification needs its admitted worker");
      return codingDomain.accept(worker, context.configuration, context.signal, progress ?? (() => {}));
    },
  };
  return adapter;
}
