import { createServiceRef } from "./service-ref";
import type { AdapterPluginIdentity, CapabilityGrant, JsonValue, ResourceClaim } from "./domain";
import type { ExecutionConfiguration } from "./execution";
import type { PluginJsonSchema } from "./plugin-schema";

export type CapabilityRef = { id: string; version: string };
export type CapabilityDefinition = CapabilityRef & {
  protocol: "tnb.capability/v1"; namespace: string; objective: string;
  adapter: CapabilityRef; inputSchema: PluginJsonSchema;
  resources: ResourceClaim[]; grants: CapabilityGrant[];
  execution: Partial<ExecutionConfiguration> & { mode?: "single" | "auto" | "multi"; maxDurationMs?: number };
};
export type CapabilityPublication = { definition: CapabilityDefinition; plugin?: AdapterPluginIdentity; digest: string; enabled: boolean; revision: number };
export type CapabilityConsumer = { plugin: AdapterPluginIdentity; contribution: { kind: "application" | "interface" | "channel"; id: string; version: string } };
export type CapabilityAuthorization = { consumer: CapabilityConsumer; capability: CapabilityRef; enabled: boolean; revision: number };
export type CapabilityRequest = { commandId: string; capability: CapabilityRef; input: JsonValue };
export type ExecutionReceipt = { runId: string; capability: CapabilityRef; publicationDigest: string };
export type ExecutionStatus = { runId: string; status: string; revision: number; tasks: Array<{ taskId: string; status: string; hasResult: boolean }>; next?: string };
export type ExecutionResult = { taskId: string; text: string; offset: number; next?: number; total: number };
export type ExecutionService = {
  catalog(input: { after?: string; limit?: number }): { items: Array<{ capability: CapabilityRef; namespace: string; digest: string; enabled: boolean }>; next?: string };
  submit(input: CapabilityRequest): Promise<ExecutionReceipt>;
  status(input: { runId: string; after?: string; limit?: number }): ExecutionStatus;
  result(input: { runId: string; taskId: string; offset?: number; limit?: number }): Promise<ExecutionResult>;
};
/** JSON-only contribution contract; equally usable by in-process and process plugins. */
export const EXECUTION_SERVICE_REF = createServiceRef<ExecutionService>({ id: "tnb.executions", version: 1, scope: "contribution",
  methods: { catalog: true, submit: true, status: true, result: true } });
export const EXECUTION_SERVICE = EXECUTION_SERVICE_REF.name;
