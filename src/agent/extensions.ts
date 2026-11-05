import type { AdapterPluginIdentity, JsonValue } from "./domain";
import type { RuntimeStore, ApplicationRecord } from "../services/runtime/store";

export type ExtensionKind = "application" | "interface" | "channel";
export type ContributionReference = { kind: ExtensionKind | "adapter"; id: string; version: string };
export type ExtensionDeclaration = ContributionReference & { kind: ExtensionKind; entry: string; services: string[]; requires: ContributionReference[] };
export type ExtensionState = ContributionReference & { plugin: AdapterPluginIdentity; status: "registered" | "starting" | "active" | "failed" | "draining" | "stopped"; error?: string };
export type PluginStateTransaction = {
  get<T>(id: string): ApplicationRecord<T> | undefined;
  save<T>(id: string, value: T, previousRevision: number): ApplicationRecord<T>;
};
export type PluginStateStore = {
  get<T>(id: string): ApplicationRecord<T> | undefined;
  list<T>(afterId?: string, limit?: number): ApplicationRecord<T>[];
  command<T>(commandId: string, input: unknown, apply: (tx: PluginStateTransaction) => T): T;
};
export type ExtensionContext = {
  readonly identity: Readonly<AdapterPluginIdentity>;
  readonly signal: AbortSignal;
  readonly stateDirectory?: string;
  readonly state: PluginStateStore;
  /** Only names declared by this contribution AND granted by its host are available. */
  service<T>(name: string): T;
  request(ref: ContributionReference, request: Request): Promise<Response>;
  onDispose(callback: () => void | Promise<void>): void;
};
export type ActiveExtension = { handle?(request: Request): Response | Promise<Response>; status?(): JsonValue };
export type PluginApplication = { id: string; version: string; start(context: ExtensionContext): ActiveExtension | void | Promise<ActiveExtension | void> };
export type PluginInterface = PluginApplication;
export type ChannelEvent = { externalId: string; actor: string; thread: string; text: string };
export type ChannelMessage = { id: string; thread: string; text: string; ticketId?: string };
export class ChannelIngressError extends Error { constructor(message: string, readonly status: number) { super(message); } }
export type ChannelPort = {
  receive?(request: Request, signal: AbortSignal): Promise<ChannelEvent[]>;
  poll?(cursor: string | undefined, signal: AbortSignal): Promise<{ events: ChannelEvent[]; cursor: string }>;
  send(message: ChannelMessage, signal: AbortSignal): Promise<string>;
  find?(message: ChannelMessage, signal: AbortSignal): Promise<string | undefined>;
  observe?(resource: { kind: string; id: string }, signal: AbortSignal): Promise<JsonValue>;
  close?(): void | Promise<void>;
};
export type PluginChannel = { id: string; version: string; connect(configuration: JsonValue, context: ExtensionContext): ChannelPort | Promise<ChannelPort> };
export type ChannelDescriptor = { id: string; version: string; plugin?: AdapterPluginIdentity };
export type ChannelConnection = { descriptor: ChannelDescriptor; port: ChannelPort; close(): Promise<void> };
export type ChannelRegistry = { descriptor(input: ChannelDescriptor): ChannelDescriptor; connect(input: ChannelDescriptor, configuration: JsonValue): Promise<ChannelConnection> };
export type ExtensionRegistration = { declaration: ExtensionDeclaration; plugin: AdapterPluginIdentity; definition: PluginApplication | PluginChannel };
export type ExtensionHostOptions = { store: RuntimeStore; services?: ReadonlyMap<string, unknown>; grants?: Record<string, string[]> };
