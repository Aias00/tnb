import type { JsonValue, AdapterPluginIdentity } from "../agent/domain";
import type { ContributionReference } from "../agent/extensions";
import type { ServiceRef } from "../agent/service-ref";

export const PROCESS_PLUGIN_PROTOCOL = "tnb.process-plugin/v1" as const;
export type ProcessRequest = { url: string; method: string; headers: Array<[string, string]>; body: string | null };
export type ProcessResponse = { status: number; headers?: Array<[string, string]>; body?: string | null };
export type ProcessStateRecord<T = JsonValue> = { id: string; revision: number; value: T };
export type ProcessStateWrite = { id: string; previousRevision: number; value: JsonValue };
type JsonServiceMethod<T> = { [K in keyof T & string]: T[K] extends (...args: infer A) => infer R
  ? A extends JsonValue[] ? Awaited<R> extends JsonValue ? K : never : never : never }[keyof T & string];
type Method<T> = Extract<T, (...args: any[]) => any>;
export type ProcessContext = {
  identity: AdapterPluginIdentity; contribution: ContributionReference; configuration: JsonValue | null;
  signal: AbortSignal;
  state: {
    get<T = JsonValue>(id: string): Promise<ProcessStateRecord<T> | null>;
    list(afterId?: string, limit?: number): Promise<ProcessStateRecord[]>;
    /** Atomically CAS all writes; identical command IDs replay the same committed receipt. */
    command(id: string, input: JsonValue, writes: ProcessStateWrite[]): Promise<ProcessStateRecord[]>;
  };
  /** JSON arguments/results only. Services returning handles, streams or callbacks require a host adapter. */
  call<T extends object, K extends JsonServiceMethod<T>>(ref: ServiceRef<T>, method: K, args: Parameters<Method<T[K]>>): Promise<Awaited<ReturnType<Method<T[K]>>>>;
  request(ref: ContributionReference, request: ProcessRequest): Promise<ProcessResponse>;
};
export type ProcessHandlers = {
  handle?(request: ProcessRequest): Promise<ProcessResponse>;
  poll?(cursor: string | undefined): Promise<{ cursor: string; events: Array<{ externalId: string; actor: string; thread: string; text: string }> }>;
  send?(message: { id: string; thread: string; text: string; ticketId?: string }): Promise<string>;
  find?(message: { id: string; thread: string; text: string; ticketId?: string }): Promise<string | undefined>;
  receive?(request: ProcessRequest): Promise<Array<{ externalId: string; actor: string; thread: string; text: string }>>;
  observe?(resource: { kind: string; id: string }): Promise<JsonValue>;
  close?(): void | Promise<void>;
};
/** This object is loaded only inside the child; the host never imports its entry. */
export type ProcessPluginDefinition = { protocol: typeof PROCESS_PLUGIN_PROTOCOL; start(context: ProcessContext): ProcessHandlers | Promise<ProcessHandlers> };
export function defineProcessPlugin(definition: ProcessPluginDefinition): ProcessPluginDefinition { return definition; }
