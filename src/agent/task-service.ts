import type { RunPresentation, RunDetail } from "../services/runtime/presentation";
import type { RuntimeEvent } from "../services/runtime/types";

/** A user-authorized workspace view. No raw runtime, store, host settings or credentials. */
export type WorkspaceTaskService = {
  readonly workspace: string;
  info(): Promise<{ workspace: string; coding: boolean; models: Array<{ provider: string; providerName: string; id: string; name: string }>; defaults: { provider: string; model: string } }>;
  list(): RunPresentation[];
  detail(runId: string): Promise<RunDetail>;
  events(runId: string, after: number): RuntimeEvent[];
  attention(signal: AbortSignal, onClose?: () => void): Response;
  command(input: unknown, signal?: AbortSignal): Promise<unknown>;
};
export type TaskService = { open(workspace: string): Promise<WorkspaceTaskService> };
export const TASK_SERVICE = "tnb.tasks/v1";
