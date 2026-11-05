import { homedir } from "node:os";
import { join } from "node:path";
import type { CliOptions, ParsedArguments } from "../../entrypoints/cli";
import { runAgentLoop } from "../../core/agent-loop";
import { createPermissionChecker } from "../../core/permissions";
import { inferPlanModeState } from "../../core/plan-mode";
import { loadProviderCatalog, resolveProviderSelection } from "../../providers/config";
import { createConfiguredTransport, resolveBillingRoute } from "../../providers/factory";
import { loadSettings } from "../settings/load";
import { SessionStore, type SessionState } from "../session/storage";
import { UsageBudget } from "../usage/budget";
import { EMPTY_USAGE } from "../usage/cost";
import { compactConversation, createTransportSummarizer } from "../compact/compact";
import { createDurableTaskTool, DURABLE_CONVERSATION_INSTRUCTIONS } from "./conversation-tool";
import { runtimeRequest } from "./server";
import type { HookModelHandler } from "../hooks/runner";
import { assertConversationOwner } from "./client";

/** Keep the existing conversation usable while a durable worker owns its files. No workspace tools/lifecycle are opened. */
export async function runRuntimeControlTurn(options: CliOptions, parsed: ParsedArguments, context: {
  workspace: string; roots: string[];
  prepare(): Promise<{ sessionId: string; resume: boolean; state?: SessionState }>;
}): Promise<number> {
  const configDir = options.configDir ?? options.env.TNB_HOME ?? join(homedir(), ".tnb");
  const health = await runtimeRequest(configDir, "/health") as { ready: boolean; capabilities?: { conversationHandoff?: boolean } };
  assertConversationOwner(health);
  if (!health.ready) throw new Error("Runtime dispatch stopped; restart the owner");
  if (parsed.agent || parsed.jsonSchema || parsed.setupTrigger || parsed.initOnly || parsed.attachmentPaths.length) throw new Error("This workspace is busy; the conversation currently supports durable task controls and text only");
  const [catalog, settings] = await Promise.all([loadProviderCatalog({ configDir, env: options.env }),
    loadSettings({ configDir, cwd: options.cwd, ...(parsed.settingsInput ? { additional: parsed.settingsInput } : {}) })]);
  if (!options.hookRunner && settings.hooks && Object.keys(settings.hooks).length) throw new Error("Workspace is busy; use the existing interactive conversation or explicit runtime commands so configured lifecycle hooks are preserved");
  const selection = resolveProviderSelection(catalog, parsed.provider ?? settings.provider ?? options.env.TNB_PROVIDER ?? "anthropic", parsed.model ?? settings.model ?? options.env.TNB_MODEL);
  const prepared = await context.prepare();
  const session = new SessionStore({ configDir, cwd: options.cwd, sessionId: prepared.sessionId });
  const release = await session.acquireRun();
  let budget: UsageBudget | undefined;
  try {
    const state = prepared.resume ? await session.readState() : { messages: [] };
    const mode = inferPlanModeState(state.messages, parsed.permissionMode ?? state.permissionMode ?? settings.permissions?.defaultMode ?? "default", state.prePlanMode).mode;
    if (parsed.sessionName) await session.setTitle(parsed.sessionName);
    const hooks = options.hookRunner?.fork();
    const permission = createPermissionChecker({ mode, cwd: context.workspace, rules: settings.permissions,
      disableYolo: settings.security?.disableYolo || settings.permissions?.disableBypassPermissionsMode === "disable",
      trustedFolders: settings.security?.trustedFolders, sessionAllowRules: options.permissionSessionRules, onAsk: options.permissionPrompt,
      onPermissionRequest: hooks ? async (request, signal) => {
        const result = await hooks!.run("PermissionRequest", { tool_name: request.tool.name, tool_input: request.input }, signal);
        if (result.blocked || result.permissionDecision === "deny") return { behavior: "deny", message: result.reason ?? "Permission hook denied durable control" };
        if (result.permissionDecision === "allow") return { behavior: "allow", ...(result.updatedInput !== undefined ? { updatedInput: result.updatedInput } : {}) };
        return { behavior: "ask" };
      } : undefined,
    });
    budget = new UsageBudget({ maxCostUsd: parsed.maxBudgetUsd, onUsage: (record) => session.appendUsage(record) });
    const signal = options.signal ? AbortSignal.any([options.signal, budget.signal]) : budget.signal;
    const transport = budget.wrap(options.transport ?? createConfiguredTransport(selection, parsed.thinking, parsed.fastMode), (request) => resolveBillingRoute(selection, request.model), { workspace: context.workspace });
    options.onInvocationTransport?.(transport);
    const evaluateHook: HookModelHandler = async (hook, input, hookSignal) => {
      if (hook.type === "agent" && (hook.tools ?? ["read", "grep", "glob"]).length) return { ok: false, reason: "Hook workspace tools are unavailable while a durable worker owns the workspace" };
      const evaluation = await runAgentLoop({ transport, model: selection.model.id, tools: [],
        signal: hookSignal ? AbortSignal.any([signal, hookSignal]) : signal, maxTurns: 4,
        prompt: `${hook.prompt}\n\nHook event JSON:\n${JSON.stringify(input)}\nReturn {"ok":true} or {"ok":false,"reason":"..."}.`,
        systemPrompt: "Evaluate this control hook from the supplied data only. No file access, commands, delegation or durable task creation is available.",
        authorize: async () => ({ behavior: "deny", message: "Control hooks have no business tools" }),
      });
      return evaluation.messages.at(-1)?.content.filter((block) => block.type === "text").map((block) => (block as { text: string }).text).join("\n") ?? "";
    };
    hooks?.setModelHandlers({ prompt: evaluateHook, agent: evaluateHook });
    const tool = createDurableTaskTool({ configDir, env: options.env, sessionId: session.sessionId, sourceText: typeof options.promptContent === "string" ? options.promptContent : parsed.prompt,
      workspace: () => context.workspace, roots: () => context.roots, provider: selection.provider.id, model: selection.model.id });
    const eligible = parsed.tools === undefined || parsed.tools.some((name) => name.toLowerCase() === "durable_task");
    const allowed = !parsed.allowedTools.length || parsed.allowedTools.some((name) => name.toLowerCase() === "durable_task");
    const tools = eligible && allowed && !parsed.disallowedTools.some((name) => name.toLowerCase() === "durable_task") ? [tool] : [];
    const history = await session.calls.recover(state.messages, (message) => session.append([message]));
    const summary = createTransportSummarizer({ transport, model: selection.model.id });
    const result = await runAgentLoop({ transport, model: selection.model.id, tools, signal, messages: history,
      prompt: options.promptContent ?? parsed.prompt, promptInput: options.promptInput,
      systemPrompt: [parsed.systemPrompt, "A durable task or another invocation currently owns this workspace. Continue the user's conversation using existing conversation context and durable_task only. Do not read/edit files or run commands concurrently. State that file work can resume after the owner releases the workspace.", DURABLE_CONVERSATION_INSTRUCTIONS, parsed.appendSystemPrompt].filter(Boolean).join("\n\n"),
      maxTurns: parsed.maxTurns ?? 20, callJournal: session.calls,
      executionContext: () => ({ workspace: context.workspace, mode, tools: tools.map((tool) => tool.name) }),
      beforePrompt: hooks ? async (prompt) => {
        const result = await hooks!.run("UserPromptSubmit", { prompt: typeof prompt === "string" ? prompt : JSON.stringify(prompt) }, signal);
        if (result.blocked) throw new Error(result.reason ?? "User prompt blocked by hook"); return { context: [...(options.hookRunner?.takeSessionContext() ?? []), ...result.context] };
      } : undefined,
      beforeTool: hooks ? async ({ id, name, input }) => {
        const result = await hooks!.run("PreToolUse", { tool_name: name, tool_input: input, tool_use_id: id }, signal);
        return { ...(result.updatedInput !== undefined ? { input: result.updatedInput } : {}),
          ...(result.blocked || result.permissionDecision === "deny" ? { decision: { behavior: "deny" as const, message: result.reason ?? "Hook denied durable control" } } : {}), context: result.context };
      } : undefined,
      afterTool: hooks ? async ({ id, name, input, output, isError }) => {
        const result = await hooks.run(isError ? "PostToolUseFailure" : "PostToolUse", { tool_name: name, tool_input: input, tool_use_id: id,
          ...(isError ? { error: output, is_interrupt: false } : { tool_response: output }) }, signal);
        return { context: result.context };
      } : undefined,
      onStop: hooks ? async ({ stopHookActive, lastAssistantMessage }) => {
        const result = await hooks.run("Stop", { stop_hook_active: stopHookActive, last_assistant_message: lastAssistantMessage }, signal);
        return result.blocked ? { feedback: result.reason ?? "Stop hook requested further task control" } : {};
      } : undefined,
      authorize: (candidate, input, approval) => permission({ ...candidate, risk: candidate.access }, input, signal, approval),
      onMessage: (message) => session.append([message]), onToolEvent: options.onToolEvent,
      compactMessages: (messages, compactSignal, reason) => compactConversation({ messages, signal: compactSignal, thresholdTokens: 24000,
        keepRecentMessages: 6, summarize: summary, force: reason?.reason === "context-overflow" }),
      onCompact: (value) => session.appendCompactBoundary({ ...value, permissionMode: mode }),
      onEvent(event) {
        options.onEvent?.(event);
        if (!options.quiet && parsed.outputFormat === "stream-json") options.stdout.write(`${JSON.stringify({ type: "model_event", session_id: session.sessionId, event })}\n`);
        else if (!options.quiet && parsed.outputFormat === "text" && event.type === "text") options.stdout.write(event.text);
      },
    });
    const text = result.messages.at(-1)?.content.filter((block) => block.type === "text").map((block) => (block as { text: string }).text).join("\n") ?? "";
    if (!options.quiet) {
      if (parsed.outputFormat === "text") options.stdout.write("\n");
      else options.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", session_id: session.sessionId, stop_reason: result.stopReason,
        result: text, usage: budget.totals, total_usage: (await session.readState()).usage ?? EMPTY_USAGE,
        total_cost_usd: (await session.readState()).usage?.costUsd ?? 0 })}\n`);
    }
    return 0;
  } finally { options.onInvocationTransport?.(undefined); try { await budget?.close(); } finally { await release(); } }
}
