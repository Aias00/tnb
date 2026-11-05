import type { RuntimeConfiguration } from "../services/runtime/engine-core";
import type { DurableRun } from "../services/runtime/types";
import type { WaitView } from "../services/runtime/waits";
import type { ApplicationRecord, ApplicationQuery } from "../services/runtime/store";
import type { CollaborationConfig, IncomingEvent, Source } from "../services/collaboration/types";

export const COLLABORATION_SERVICE = "tnb.collaboration/v1";
export type CollaborationStateTransaction = {
  readonly now: number;
  applicationRecord<T>(namespace: string, id: string): ApplicationRecord<T> | undefined;
  saveApplicationRecord<T>(record: Omit<ApplicationRecord<T>, "revision">, previousRevision: number): ApplicationRecord<T>;
};
export type CollaborationState = {
  applicationRecord<T>(namespace: string, id: string): ApplicationRecord<T> | undefined;
  applicationRecords<T>(namespace: string, after?: string, limit?: number, filter?: ApplicationQuery): ApplicationRecord<T>[];
  command<T>(id: string, input: unknown, now: number, apply: (tx: CollaborationStateTransaction) => T): T;
  replayCommand<T>(id: string, input: unknown): T | undefined;
};
export type CollaborationServiceFactory = { open(signal: AbortSignal): CollaborationService };
export type CollaborationService = {
  close(): void;
  configuration(): CollaborationConfig;
  readonly state: CollaborationState;
  readonly tasks: {
    admit(sourceId: string, incoming: IncomingEvent): Promise<{ configuration?: RuntimeConfiguration; mode?: Source["mode"] }>;
    create(eventId: string): Promise<{ run: DurableRun }>;
    apply(eventId: string, ticketId: string): Promise<void>;
    run(runId: string): DurableRun;
    questions(runId: string): WaitView[];
    summaries(runId: string): Promise<string[]>;
  };
};
