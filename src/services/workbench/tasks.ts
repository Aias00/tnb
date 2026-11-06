import { realpath } from "node:fs/promises";
import { digestJson, text, integer } from "../runtime/json";
import type { DurableRuntime } from "../runtime/engine-core";
import type { RoutingDecision, RoutingInput } from "../runtime/routing";
import { runtimeRequest } from "../runtime/server";
import { presentRuns, presentRunDetail } from "../runtime/presentation";
import { questionAttentionResponse } from "../runtime/attention-stream";
import { parseDeadline } from "../runtime/limits";
import { loadProviderCatalog, resolveProviderSelection } from "../../providers/config";
import { validateCapabilitySelection } from "../../adapters/coding/capabilities";
import type { TaskService } from "../../agent/task-service";

const fields: Record<string, string[]> = {
  submit: ["objective", "mode", "provider", "model", "allowWrite", "allowShell", "checks", "skills", "mcpTools", "maxCostUsd", "maxTurns", "deadline"],
  followup: ["runId", "text", "resolveInputId", "expectedRevision"],
  "resolve-route": ["runId", "resolveInputId", "expectedRevision"],
  pause: ["runId", "expectedRevision"], resume: ["runId", "expectedRevision"], cancel: ["runId", "expectedRevision"],
  answer: ["runId", "waitId", "answer", "expectedVersion"],
  limits: ["runId", "expectedRevision", "deadline", "extendMs", "maxCostUsd"],
  ack: ["runId", "noticeId"], reconcile: ["runId", "taskId", "operationId", "result"],
};
/** Scope admission is host-side; browser input cannot nominate another workspace or identity. */
export function createTaskService(options: { runtime: DurableRuntime; configDir: string; env: Record<string, string | undefined>; coding: boolean; signal?: AbortSignal; track?<T>(operation: () => Promise<T>): Promise<T> }): TaskService {
  const { runtime } = options;
  const assertLive = () => options.signal?.throwIfAborted();
  const track = <T>(operation: () => Promise<T>): Promise<T> => options.track ? options.track(operation) : operation();
  return { async open(path) {
    assertLive();
    text(path, "workspace", 4096); const workspace = await realpath(path);
    assertLive();
    const sessionId = `web:${digestJson(workspace).slice(0, 32)}`;
    const assertRun = (runId: unknown) => {
      text(runId as string, "Run ID", 128);
      if (!runtime.store.getRun(runId as string) || runtime.configuration(runId as string).workspace !== workspace) throw new Error("Task is outside this workspace");
    };
    return {
      workspace,
      info: () => track(async () => {
        assertLive();
        const catalog = await loadProviderCatalog(options);
        assertLive();
        const models = Object.values(catalog.providers).flatMap(provider => provider.models.map(model => ({ provider: provider.id, providerName: provider.name, id: model.id, name: model.name })));
        const ready = Object.values(catalog.providers).find(provider => provider.apiKey || !["anthropic", "openai"].includes(provider.id));
        const first = models.find(model => model.provider === options.env.TNB_PROVIDER && (!options.env.TNB_MODEL || model.id === options.env.TNB_MODEL))
          ?? models.find(model => model.provider === ready?.id) ?? models[0];
        return { workspace, coding: options.coding, models, defaults: { provider: first?.provider ?? "", model: first?.id ?? "" } };
      }),
      list: () => { assertLive(); return presentRuns(runtime, workspace); },
      detail: runId => track(async () => { assertLive(); assertRun(runId); return presentRunDetail(runtime, runId); }),
      events(runId, after) { assertLive(); assertRun(runId); integer(after, "event cursor", 0); return runtime.store.events(runId, after, 100); },
      attention: (signal, onClose) => { assertLive(); return questionAttentionResponse(runtime, workspace, AbortSignal.any([signal, ...(options.signal ? [options.signal] : [])]), onClose); },
      command: (value, signal) => track(async () => {
        signal = AbortSignal.any([...(options.signal ? [options.signal] : []), ...(signal ? [signal] : [])]);
        signal?.throwIfAborted();
        if (await realpath(workspace) !== workspace) throw new Error("Workspace identity changed; launch a new view");
        signal.throwIfAborted();
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid task command");
        const input = value as Record<string, unknown>, action = input.action;
        if (typeof action !== "string" || !Object.hasOwn(fields, action) || Object.keys(input).some(key => !["action", "commandId", ...fields[action]!].includes(key))) throw new Error("Unsupported task action or authority field");
        text(input.commandId as string, "command ID", 128);
        const commandId = input.commandId as string;
        const source: RoutingInput = { inputId: commandId, workspace, sessionId, rawText: String(input.objective ?? input.text ?? input.answer ?? `${action} ${input.runId ?? ""}`), source: "api" };
        if (action === "submit") {
          if (!options.coding) throw new Error("The Coding plugin is unavailable");
          text(input.objective as string, "objective", 4096);
          if (input.mode !== undefined && !["single", "auto", "multi"].includes(input.mode as string)) throw new Error("Invalid execution mode");
          if ([input.allowWrite, input.allowShell].some(flag => flag !== undefined && typeof flag !== "boolean")) throw new Error("Invalid task authority");
          if (input.checks !== undefined && (!Array.isArray(input.checks) || input.checks.length > 16 || input.checks.some(check => typeof check !== "string" || !check.trim() || check.length > 4096))) throw new Error("Invalid verification commands");
          validateCapabilitySelection(input);
          if (input.provider !== undefined && typeof input.provider !== "string" || input.model !== undefined && typeof input.model !== "string") throw new Error("Invalid model selection");
          const catalog = await loadProviderCatalog(options);
          signal.throwIfAborted();
          const selection = resolveProviderSelection(catalog, input.provider as string ?? options.env.TNB_PROVIDER ?? "anthropic", input.model as string | undefined ?? options.env.TNB_MODEL);
          const configuration = { workspace, allowedWorkspaces: [workspace], provider: selection.provider.id, model: selection.model.id,
            allowWrite: input.allowWrite ?? false, allowShell: input.allowShell ?? false, checks: input.checks ?? [],
            ...(input.skills !== undefined ? { skills: input.skills } : {}), ...(input.mcpTools !== undefined ? { mcpTools: input.mcpTools } : {}),
            ...(input.maxCostUsd !== undefined ? { maxCostUsd: input.maxCostUsd } : {}), maxTurns: input.maxTurns ?? 200, maxRetries: 3, compactThreshold: 24000 };
          return runtimeRequest(options.configDir, "/command", { action, commandId, objective: input.objective, mode: input.mode ?? "auto", configuration, source,
            ...(input.deadline !== undefined ? { deadline: parseDeadline(input.deadline as string) } : {}) }, signal);
        }
        assertRun(input.runId);
        const body = { ...input, source };
        if (input.resolveInputId !== undefined) {
          text(input.resolveInputId as string, "routing input", 128);
          const decision = runtime.store.route<RoutingDecision>(input.resolveInputId as string);
          if (!decision || decision.workspace !== workspace || !decision.candidates.some(candidate => candidate.runId === input.runId)) throw new Error("Routing selection is outside this workspace");
          body.source = { inputId: decision.inputId, workspace, rawText: decision.rawText, source: decision.source, ...(decision.sessionId ? { sessionId: decision.sessionId } : {}) };
        }
        if (action === "followup") {
          if (input.text !== undefined) text(input.text as string, "followup", 16384);
          if (!input.text && !input.resolveInputId) throw new Error("Followup text is required");
          Object.assign(body, { workspace });
        }
        if (["pause", "resume", "cancel", "limits", "resolve-route"].includes(action)) integer(input.expectedRevision as number, "Run/routing revision", 1);
        if (action === "answer") { text(input.answer as string, "answer", 8000); integer(input.expectedVersion as number, "question version", 1); }
        if (action === "limits" && input.deadline !== undefined) Object.assign(body, { deadline: parseDeadline(input.deadline as string) });
        if (action === "reconcile") text(input.result as string, "confirmed external evidence", 16000);
        return runtimeRequest(options.configDir, "/command", body, signal);
      }),
    };
  } };
}
