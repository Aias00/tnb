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
export type { WorkerResources, RuntimeConfiguration } from "../services/runtime/engine-core";
export type { DurableRun, DurableTask } from "../services/runtime/types";
