import { realpath } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { defineTool, type AgentTool } from "../../core/tool";
import type { DurableRun } from "./types";
import { digestJson, text } from "./json";
import { runtimeRequest } from "./server";
import { ensureRuntime, assertConversationOwner } from "./client";
import { parseDeadline, extensionMilliseconds } from "./limits";

export const DURABLE_CONVERSATION_INSTRUCTIONS = "When the user explicitly asks to execute a long-running task durably or in the background, use durable_task submit. Include a self-contained objective and the relevant conversation decisions in context, a stable key, explicit write/Shell grants and replay-safe checks. It creates a separate persistent Run using the current model, with its own disclosed budget; do not use it as an ordinary subagent or to escape this invocation's budget. For progress, results or control, use durable_task with the existing runId. For additional requirements use followup, not submit or answer. When followup returns clarify, ask the user to choose a candidate; resolveInputId and expectedRevision bind the original input. Do not guess a target by topic. Use routing to recover unresolved choices. Read questions to show pending decisions; use answer with the question ID and version only for the user's actual decision, never invent an answer. An answer cannot expand permissions or resume a paused Run. Use limits only for the user's explicit deadline or total-budget decision, after a fully drained pause and reading the current Run revision. Never increase limits autonomously; an update preserves all usage/reservations and stays paused until explicitly resumed. Submission is acceptance, not completion. While the durable task owns this workspace, use its controls and wait for it to release the workspace before local file operations. Never infer completion from submission or promise parallel code writes.";

type Request = {
  action: "followup" | "routing" | "submit" | "list" | "status" | "result" | "events" | "questions" | "answer" | "limits" | "pause" | "resume" | "cancel";
  text?: string; resolveInputId?: string;
  key?: string; runId?: string; objective?: string; context?: string;
  mode?: "single" | "auto" | "multi"; allowWrite?: boolean; allowShell?: boolean;
  checks?: string[]; maxCostUsd?: number; maxTurns?: number; after?: number;
  waitId?: string; expectedVersion?: number; answer?: string;
  deadline?: string; extendHours?: number; expectedRevision?: number;
};
export type ConversationRuntimeContext = {
  configDir: string; env: Record<string, string | undefined>; sessionId: string;
  sourceText?: string;
  workspace(): string; roots(): string[]; provider: string; model: string;
};
const reads = new Set(["routing", "list", "status", "result", "events", "questions"]);
const actions = [...reads, "followup", "submit", "pause", "resume", "cancel", "answer", "limits"];

/** User-facing main-conversation capability. It is deliberately excluded from child/Skill/Hook tools. */
export function createDurableTaskTool(context: ConversationRuntimeContext): AgentTool {
  return defineTool<Request>({
    name: "durable_task", access: "execute", isReadOnly: (input) => reads.has(input.action),
    isConcurrencySafe: () => false, requiresApproval: (input) => !reads.has(input.action),
    permissionRuleContent: (input) => input.action,
    description: "Submit and control a persistent long task when explicitly requested by the user. A submitted Run survives chat/terminal closure. Use the same key and identical submit inputs to retry a handoff; include previous decisions in context. Default auto starts one Agent and admits bounded read-only delegation. Writing requires allowWrite and explicit replay-safe checks; Shell additionally requires allowShell. This is a separate Run and budget, not a general child-agent tool. Read status/results without changing permissions. Scope is the current conversation workspace. For followup use the original user request, never create a duplicate Run. Ambiguous targets require user selection; routing lists persisted decisions. Requires approval for submission and control.",
    inputSchema: { type: "object", additionalProperties: false, required: ["action"], properties: {
      text: { type: "string", maxLength: 16384 }, resolveInputId: { type: "string" },
      action: { type: "string", enum: actions }, key: { type: "string", description: "Stable handoff key, required for submit." },
      runId: { type: "string" }, objective: { type: "string", maxLength: 4096 }, context: { type: "string", maxLength: 16384 },
      mode: { type: "string", enum: ["single", "auto", "multi"] }, allowWrite: { type: "boolean" }, allowShell: { type: "boolean" },
      checks: { type: "array", items: { type: "string" }, maxItems: 16 }, maxCostUsd: { type: "number", exclusiveMinimum: 0 },
      maxTurns: { type: "integer", minimum: 1, maximum: 2000 }, after: { type: "integer", minimum: 0 },
      waitId: { type: "string", description: "Question ID from questions." }, expectedVersion: { type: "integer", minimum: 1 },
      answer: { type: "string", maxLength: 8000, description: "The user's actual answer; never infer a decision." },
      deadline: { type: "string", description: "An explicitly authorized future ISO deadline with timezone." },
      extendHours: { type: "number", exclusiveMinimum: 0, description: "Explicitly authorized extension, only for a paused Run." },
      expectedRevision: { type: "integer", minimum: 1, description: "Current Run revision from status, required for limits." },
    } },
    validate(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid durable task request");
      const input = value as Request;
      if (!actions.includes(input.action) || Object.keys(input).some((key) => !["action", "text", "resolveInputId", "key", "runId", "objective", "context", "mode", "allowWrite", "allowShell", "checks", "maxCostUsd", "maxTurns", "after", "waitId", "expectedVersion", "answer", "deadline", "extendHours", "expectedRevision"].includes(key))) throw new Error("Unsupported durable task action or capability");
      if (input.action === "followup") {
        for (const key of Object.keys(input)) if (!["action", "key", "runId", "text", "resolveInputId", "expectedRevision"].includes(key)) throw new Error("Followup cannot expand authority");
        text(input.key!, "followup key", 128);
        if (input.text !== undefined) text(input.text, "followup text", 16384);
        if (!input.text && !input.resolveInputId) throw new Error("Followup needs text or a routing question ID");
        return structuredClone(input);
      }
      if (input.action === "submit") {
        text(input.key!, "handoff key", 128); text(input.objective!, "durable objective");
        if (input.context !== undefined) text(input.context, "conversation context", 16384);
        if (input.mode !== undefined && !["single", "auto", "multi"].includes(input.mode)) throw new Error("Invalid execution mode");
        if ([input.allowWrite, input.allowShell].some((value) => value !== undefined && typeof value !== "boolean")) throw new Error("Invalid durable authority");
        if (input.checks !== undefined && (!Array.isArray(input.checks) || input.checks.length > 16)) throw new Error("Invalid checks");
        for (const command of input.checks ?? []) text(command, "verification command");
        if (input.allowWrite && !input.checks?.length) throw new Error("Writing requires explicit replay-safe verification commands");
        if (input.allowShell && !input.allowWrite) throw new Error("Shell requires explicit write authority");
        if (input.maxCostUsd !== undefined && (!Number.isFinite(input.maxCostUsd) || input.maxCostUsd <= 0)) throw new Error("Invalid durable budget");
        if (input.maxTurns !== undefined && (!Number.isSafeInteger(input.maxTurns) || input.maxTurns < 1 || input.maxTurns > 2000)) throw new Error("Invalid turn limit");
        if (input.deadline !== undefined) parseDeadline(input.deadline);
        if (input.extendHours !== undefined || input.expectedRevision !== undefined) throw new Error("Submit cannot extend an existing Run");
        if ([input.runId, input.after, input.waitId, input.expectedVersion, input.answer].some((value) => value !== undefined)) throw new Error("Submit cannot target an existing Run or question");
      } else {
        if (input.runId !== undefined) text(input.runId, "Run ID", 128);
        const controlFields = input.action === "answer" ? ["action", "runId", "waitId", "expectedVersion", "answer"]
          : input.action === "limits" ? ["action", "runId", "deadline", "extendHours", "maxCostUsd", "expectedRevision"] : ["action", "runId", "after"];
        if (Object.keys(input).some((key) => !controlFields.includes(key))) throw new Error("Control cannot expand an existing Run's authority");
        if (input.action === "answer") {
          text(input.waitId!, "question ID", 128); text(input.answer!, "question answer", 8000);
          if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion! < 1) throw new Error("Answer requires the current question version");
        }
        if (input.action === "limits") {
          if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision! < 1) throw new Error("Limits require the current Run revision");
          if (input.deadline === undefined && input.extendHours === undefined && input.maxCostUsd === undefined) throw new Error("No limit update supplied");
          if (input.deadline !== undefined && input.extendHours !== undefined) throw new Error("Choose deadline or extension");
          if (input.deadline !== undefined) parseDeadline(input.deadline);
          if (input.extendHours !== undefined) extensionMilliseconds(input.extendHours);
          if (input.maxCostUsd !== undefined && (!Number.isFinite(input.maxCostUsd) || input.maxCostUsd <= 0)) throw new Error("Invalid budget ceiling");
        }
        if (input.after !== undefined && (!Number.isSafeInteger(input.after) || input.after < 0 || input.action !== "events")) throw new Error("Invalid event cursor");
      }
      return structuredClone(input);
    },
    bindExecution() {
      const workspace = realpathSync(context.workspace()); const roots = context.roots().map((root) => realpathSync(root));
      return createDurableTaskTool({ ...context, workspace: () => workspace, roots: () => roots });
    },
    async execute(input, signal) {
      signal.throwIfAborted();
      const workspace = await realpath(context.workspace());
      if (input.action === "routing") return JSON.stringify(await runtimeRequest(context.configDir, `/routing?workspace=${encodeURIComponent(workspace)}`));
      if (input.action === "followup") {
        const commandId = `chat:${digestJson({ sessionId: context.sessionId, key: input.key })}`;
        return JSON.stringify(await runtimeRequest(context.configDir, "/command", { action: "followup", commandId, runId: input.runId,
          resolveInputId: input.resolveInputId, expectedRevision: input.expectedRevision,
          source: { inputId: commandId, workspace, rawText: context.sourceText ?? input.text ?? "Resolve original input", source: "conversation", sessionId: context.sessionId } }));
      }
      if (input.action === "submit") {
        const allowedWorkspaces = [...new Set(await Promise.all([workspace, ...context.roots()].map((root) => realpath(root))))];
        await ensureRuntime(context.configDir, context.env, true); signal.throwIfAborted();
        const result = await runtimeRequest(context.configDir, "/command", { action: "submit",
          commandId: `chat:${digestJson({ sessionId: context.sessionId, key: input.key })}`, objective: input.objective, mode: input.mode ?? "auto",
          source: { inputId: `chat:${digestJson({ sessionId: context.sessionId, key: input.key })}`, workspace, rawText: context.sourceText ?? input.objective, source: "conversation", sessionId: context.sessionId },
          deadline: input.deadline === undefined ? undefined : parseDeadline(input.deadline),
          configuration: { workspace, allowedWorkspaces, provider: context.provider, model: context.model,
            allowWrite: input.allowWrite ?? false, allowShell: input.allowShell ?? false, checks: input.checks ?? [], maxCostUsd: input.maxCostUsd,
            maxTurns: input.maxTurns ?? 200, maxRetries: 3, compactThreshold: 24000,
            originSessionId: context.sessionId, conversationContext: input.context },
        });
        return JSON.stringify({ accepted: true, execution: "background", message: "The Run is persisted. Its worker waits while the foreground invocation owns the workspace. Query status/result; do not report it complete yet.", ...result as object });
      }
      assertConversationOwner(await runtimeRequest(context.configDir, "/health") as Parameters<typeof assertConversationOwner>[0]);
      const runs = await runtimeRequest(context.configDir, `/runs?workspace=${encodeURIComponent(workspace)}`) as DurableRun[];
      if (input.action === "list") return JSON.stringify(runs);
      const own = input.runId ? undefined : await runtimeRequest(context.configDir, `/runs?workspace=${encodeURIComponent(workspace)}&sessionId=${encodeURIComponent(context.sessionId)}`) as DurableRun[];
      const candidates = own?.length ? own : runs;
      if (!input.runId && candidates.length > 1 && !reads.has(input.action)) {
        if (["pause", "cancel", "resume"].includes(input.action)) {
          const commandId = `chat-route:${digestJson({ sessionId: context.sessionId, input, original: context.sourceText })}`;
          return JSON.stringify(await runtimeRequest(context.configDir, "/command", { action: "route-control", commandId, routeAction: input.action,
            source: { inputId: commandId, workspace, rawText: context.sourceText ?? `${input.action} existing task`, source: "conversation", sessionId: context.sessionId } }));
        }
        return JSON.stringify({ clarificationRequired: true, action: input.action, message: "Select an explicit runId before changing limits or answering a task question.", candidates });
      }
      const runId = input.runId ?? candidates.at(-1)?.runId;
      if (!runId || !runs.some((run) => run.runId === runId)) throw new Error("No matching durable Run in this conversation workspace");
      signal.throwIfAborted();
      if (reads.has(input.action)) return JSON.stringify(await runtimeRequest(context.configDir, `/${input.action}?runId=${encodeURIComponent(runId)}&after=${input.after ?? 0}`));
      const commandId = `chat:${digestJson(input.action === "answer" || input.action === "limits"
        ? { sessionId: context.sessionId, runId, input } : { sessionId: context.sessionId, action: input.action, runId, nonce: crypto.randomUUID() })}`;
      const source = { inputId: commandId, workspace, rawText: context.sourceText ?? input.answer ?? `${input.action} ${runId}`,
        source: "conversation", sessionId: context.sessionId };
      if (input.action === "answer") return JSON.stringify(await runtimeRequest(context.configDir, "/command", { action: "answer", runId,
        waitId: input.waitId, expectedVersion: input.expectedVersion, answer: input.answer, commandId, source }));
      if (input.action === "limits") return JSON.stringify(await runtimeRequest(context.configDir, "/command", { action: "limits", runId,
        deadline: input.deadline === undefined ? undefined : parseDeadline(input.deadline),
        extendMs: input.extendHours === undefined ? undefined : extensionMilliseconds(input.extendHours), maxCostUsd: input.maxCostUsd,
        expectedRevision: input.expectedRevision, commandId, source }));
      return JSON.stringify(await runtimeRequest(context.configDir, "/command", { action: input.action, runId, commandId, source }));
    },
  });
}
