import type { HostPluginFactory } from "../agent/plugins";

/** Preserve contextual typing without introducing a second registration/lifecycle protocol. */
export function definePlugin(setup: HostPluginFactory): HostPluginFactory { return setup; }

export { defineTool } from "../core/tool";
export { createServiceRef } from "../agent/service-ref";
export type { HostPluginFactory, HostPluginAPI, AdapterPluginFactory, AdapterPluginAPI } from "../agent/plugins";
export type { AgentDomainAdapter, DomainDescriptor, DomainContext, DomainAcceptance, DomainOperation, DomainReceipt, DomainRuntimePolicy, AdapterPluginIdentity, JsonValue, ResourceClaim, CapabilityGrant } from "../agent/domain";
export type { PluginApplication, PluginInterface, PluginChannel, ExtensionContext, ActiveExtension, PluginStateStore, PluginStateTransaction, PluginStateMigration, PluginMigrationTransaction,
  ContributionReference, ExtensionDeclaration, ChannelPort, ChannelEvent, ChannelMessage, ChannelDescriptor } from "../agent/extensions";
export type { ServiceRef } from "../agent/services";
export type { PluginConfigurationContract, PluginStateContract, VersionedPluginConfiguration } from "../agent/plugin-data";
export type { PluginJsonSchema } from "../agent/plugin-schema";
export type { AgentTool, ToolDefinition, ToolAccess, ToolOutput, ToolExecutionContext, ToolCapability, ToolEffects, ToolProgressReporter } from "../core/tool";
export type { ModelTransport, ModelRequest, ModelEvent, TokenUsage, StopReason } from "../providers/types";
export type { ConversationMessage, ToolUseBlock, ToolResultBlock, MediaBlock } from "../core/message";
export type { WorkerResources, ExecutionConfiguration, AgentTaskInput } from "../agent/execution";
/** @deprecated Host compatibility shape; new authors use AgentContext.execution. */
export type { RuntimeConfiguration } from "../services/runtime/engine-core";
export { defineAgent } from "./agent";
export type { AgentDefinition, AgentContext } from "./agent";
export type { DurableRun, DurableTask } from "../services/runtime/types";

export type { ExecutionActivity } from "../agent/activity";

export { defineProcessPlugin, PROCESS_PLUGIN_PROTOCOL } from "./process";
export type { ProcessPluginDefinition, ProcessContext, ProcessHandlers, ProcessRequest, ProcessResponse, ProcessStateWrite, ProcessStateRecord } from "./process";
