import { realpath } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { defineTool, type AgentTool } from "../../core/tool";
import type { DurableRun } from "./types";
import { digestJson, text } from "./json";
import { runtimeRequest } from "./server";
import { ensureRuntime, assertConversationOwner } from "./client";

export const DURABLE_CONVERSATION_INSTRUCTIONS = "When the user explicitly asks to execute a long-running task durably or in the background, use durable_task submit. Include a self-contained objective and the relevant conversation decisions in context, a stable key, explicit write/Shell grants and replay-safe checks. It creates a separate persistent Run using the current model, with its own disclosed budget; do not use it as an ordinary subagent or to escape this invocation's budget. For progress, results or control, use durable_task with the existing runId. Submission is acceptance, not completion. While the durable task owns this workspace, use its controls and wait for it to release the workspace before local file operations. Never infer completion from submission or promise parallel code writes.";

type Request = {
  action: "submit" | "list" | "status" | "result" | "events" | "pause" | "resume" | "cancel";
  key?: string; runId?: string; objective?: string; context?: string;
  mode?: "single" | "auto" | "multi"; allowWrite?: boolean; allowShell?: boolean;
  checks?: string[]; maxCostUsd?: number; maxTurns?: number; after?: number;
};
export type ConversationRuntimeContext = {
  configDir: string; env: Record<string, string | undefined>; sessionId: string;
  workspace(): string; roots(): string[]; provider: string; model: string;
};
const reads = new Set(["list", "status", "result", "events"]);
const actions = [...reads, "submit", "pause", "resume", "cancel"];

/** User-facing main-conversation capability. It is deliberately excluded from child/Skill/Hook tools. */
export function createDurableTaskTool(context: ConversationRuntimeContext): AgentTool {
  return defineTool<Request>({
    name: "durable_task", access: "execute", isReadOnly: (input) => reads.has(input.action),
    isConcurrencySafe: () => false, requiresApproval: (input) => !reads.has(input.action),
    permissionRuleContent: (input) => input.action,
    description: "Submit and control a persistent long task when explicitly requested by the user. A submitted Run survives chat/terminal closure. Use the same key and identical submit inputs to retry a handoff; include previous decisions in context. Default auto starts one Agent and admits bounded read-only delegation. Writing requires allowWrite and explicit replay-safe checks; Shell additionally requires allowShell. This is a separate Run and budget, not a general child-agent tool. Read status/results without changing permissions. Scope is the current conversation workspace; omitted runId selects this conversation's latest Run, then the workspace's latest Run. Requires approval for submission and control.",
    inputSchema: { type: "object", additionalProperties: false, required: ["action"], properties: {
      action: { type: "string", enum: actions }, key: { type: "string", description: "Stable handoff key, required for submit." },
      runId: { type: "string" }, objective: { type: "string", maxLength: 4096 }, context: { type: "string", maxLength: 16384 },
      mode: { type: "string", enum: ["single", "auto", "multi"] }, allowWrite: { type: "boolean" }, allowShell: { type: "boolean" },
      checks: { type: "array", items: { type: "string" }, maxItems: 16 }, maxCostUsd: { type: "number", exclusiveMinimum: 0 },
      maxTurns: { type: "integer", minimum: 1, maximum: 2000 }, after: { type: "integer", minimum: 0 },
    } },
    validate(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid durable task request");
      const input = value as Request;
      if (!actions.includes(input.action) || Object.keys(input).some((key) => !["action", "key", "runId", "objective", "context", "mode", "allowWrite", "allowShell", "checks", "maxCostUsd", "maxTurns", "after"].includes(key))) throw new Error("Unsupported durable task action or capability");
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
        if (input.runId !== undefined || input.after !== undefined) throw new Error("Submit cannot target an existing Run");
      } else {
        if (input.runId !== undefined) text(input.runId, "Run ID", 128);
        if (Object.keys(input).some((key) => !["action", "runId", "after"].includes(key))) throw new Error("Control cannot expand an existing Run's authority");
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
      if (input.action === "submit") {
        const allowedWorkspaces = [...new Set(await Promise.all([workspace, ...context.roots()].map((root) => realpath(root))))];
        await ensureRuntime(context.configDir, context.env, true); signal.throwIfAborted();
        const result = await runtimeRequest(context.configDir, "/command", { action: "submit",
          commandId: `chat:${digestJson({ sessionId: context.sessionId, key: input.key })}`, objective: input.objective, mode: input.mode ?? "auto",
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
      const runId = input.runId ?? own?.at(-1)?.runId ?? runs.at(-1)?.runId;
      if (!runId || !runs.some((run) => run.runId === runId)) throw new Error("No matching durable Run in this conversation workspace");
      signal.throwIfAborted();
      if (reads.has(input.action)) return JSON.stringify(await runtimeRequest(context.configDir, `/${input.action}?runId=${encodeURIComponent(runId)}&after=${input.after ?? 0}`));
      return JSON.stringify(await runtimeRequest(context.configDir, "/command", { action: input.action, runId,
        commandId: `chat:${digestJson({ sessionId: context.sessionId, action: input.action, runId, nonce: crypto.randomUUID() })}` }));
    },
  });
}
