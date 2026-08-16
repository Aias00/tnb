#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { arch, platform, release } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import {
  DEFAULT_SUBAGENT_MAX_TURNS,
  runAgentLoop,
  type ToolExecutionEvent,
} from "../core/agent-loop";
import type { ConversationMessage, MediaBlock, TextBlock } from "../core/message";
import {
  createPermissionChecker,
  resolvePermissionMode,
  type PermissionAskRequest,
  type PermissionPromptDecision,
  type PermissionMode,
  type PermissionChecker,
  type ToolPolicy,
} from "../core/permissions";
import { inferPlanModeState, PermissionModeState } from "../core/plan-mode";
import type { AgentTool } from "../core/tool";
import { WorkspaceState, type WorkspaceRootSource } from "../core/workspace-state";
import { buildSystemPrompt } from "../constants/prompts";
import { getAutoCompactThresholdForCapabilities } from "../providers/models";
import {
  createConfiguredTransport,
  createConfiguredTransportWithFallback,
  type ReasoningEffort,
} from "../providers/factory";
import { ProviderHttpError, ProviderStreamError } from "../providers/retry";
import type { ModelEvent, ModelTransport } from "../providers/types";
import {
  loadProviderCatalog,
  resolveProviderSelection,
  type ProviderCatalog,
  type ProviderSelection,
} from "../providers/config";
import {
  compactConversation,
  createTransportSummarizer,
  estimateConversationTokens,
} from "../services/compact/compact";
import { compactConversationPipeline } from "../services/compact/pipeline";
import { SessionMemoryStore } from "../services/compact/session-memory";
import {
  loadMcpConfig,
  loadMcpConfigInputs,
  loadRawMcpConfig,
  mergeMcpConfigs,
  updateMcpConfig,
  validateMcpServerConfig,
  type McpServerConfig,
  type McpConfig,
} from "../services/mcp/config";
import { runMcpCommand } from "../services/mcp/command";
import { connectMcpServers, type McpConnections } from "../services/mcp/manager";
import type { McpLogMessage } from "../services/mcp/logging";
import type { McpCancelledEvent, McpProgressEvent } from "../services/mcp/activity";
import { completeMcpPromptInput, expandMcpPromptInput } from "../services/mcp/prompts";
import { createMcpSamplingHandler } from "../services/mcp/sampling";
import {
  createMcpElicitationHandler,
  type McpElicitationContext,
} from "../services/mcp/elicitation";
import { SessionStore, sessionInputHistory } from "../services/session/storage";
import type { SessionState } from "../services/session/storage";
import { exportConversation } from "../services/session/export";
import { SubagentTranscript } from "../services/session/subagent-transcript";
import { ShellSessionManager } from "../services/shell/manager";
import { createSandboxRuntime } from "../services/sandbox/macos";
import { loadLspServerConfigs } from "../services/lsp/config";
import { TnbLspManager } from "../services/lsp/manager";
import { AutoMemoryStore } from "../services/memory/store";
import { runGit } from "../services/git/command";
import { TaskManager, type TaskRecord, type TaskUpdate } from "../services/tasks/manager";
import { formatTeamMessages, TeamManager } from "../services/teams/manager";
import { TeamSupervisor } from "../services/teams/supervisor";
import { GoalManager } from "../services/goals/manager";
import { nextCronRun, ScheduleManager } from "../services/scheduler/manager";
import { loadSettings } from "../services/settings/load";
import { loadPromptAttachments } from "../services/attachments/load";
import { saveClipboardImage } from "../services/clipboard/image";
import { addProjectPermissionRule } from "../services/settings/write";
import {
  HookRunner,
  type HookAgent,
  type HookEvent,
  type HookExecutionEvent,
  type HookPrompt,
} from "../services/hooks/runner";
import {
  CLI_HELP,
  collectDoctorChecks,
  runConfigCommand,
  runDoctorCommand,
  runJobsCommand,
  runProviderCommand,
  runRollbackCommand,
  runResourceListCommand,
  runStatusCommand,
} from "../services/cli/management";
import {
  isInsideGitRepository,
  loadProjectInstructionFiles,
} from "../services/project-context";
import { loadSkills, renderSkillPrompt, type LoadedSkill } from "../services/skills/loader";
import { bundledSkills } from "../services/skills/bundled";
import { createSkillTool, selectSkillTools } from "../services/skills/tool";
import { loadAgents, parseAgentsJson, type LoadedAgent } from "../services/agents/loader";
import {
  expandCommandInput,
  loadCommands,
  type LoadedCommand,
} from "../services/commands/loader";
import {
  createEditTool,
  createGlobTool,
  createGrepTool,
  createReadTool,
  createWebFetchTool,
  createWriteTool,
} from "../tools/builtins";
import { createShellTools } from "../tools/shell";
import { createLspTool } from "../tools/lsp";
import { createToolSearchTool } from "../tools/tool-search";
import { createDeferredToolCatalog } from "../core/tool-search";
import { createWebSearchTool } from "../tools/web-search";
import { createImageSearchTool } from "../tools/image-search";
import { createImageGenerateTool } from "../tools/image-generate";
import { createNotebookEditTool } from "../tools/notebook-edit";
import { createSchedulerTools } from "../tools/scheduler";
import { createTaskTools } from "../tools/tasks";
import { createTeamTools } from "../tools/team";
import { createGoalTools } from "../tools/goals";
import { createWorkflowTool } from "../tools/workflow";
import { WorkflowManager } from "../services/workflows/manager";
import { createUpdateTopicTool } from "../tools/topic";
import { createWorkspaceTools } from "../tools/worktree";
import { createStructuredOutputTool, parseStructuredOutputSchema } from "../tools/structured-output";
import { createSecurityScanTool } from "../tools/security-scan";
import { createCodebaseInvestigatorTool } from "../tools/codebase-investigator";
import { createOpenAIEmbeddingProvider } from "../services/codebase/embeddings";
import { createLspCodebaseSemanticProvider } from "../services/codebase/lsp-semantic";
import { runSecurityScanCommand } from "../services/security/command";
import { runCompletionCommand } from "../services/cli/completion";
import { runFeedbackCommand } from "../services/feedback/command";
import { runUpdateCommand } from "../services/update/command";
import { serveRemoteControlSocket } from "../services/remote-control/server";
import { formatIdeContextPrompt, IdeJsonRpcBridge, isIdeJsonRpcLine } from "../services/remote-control/ide-jsonrpc";
import { runIdeCommand } from "../services/remote-control/ide-command";
import { createSessionWorktree } from "../services/worktree/manager";
import { CheckpointManager } from "../services/checkpoint/manager";
import { addUsage, calculateCostUsd, EMPTY_USAGE } from "../services/usage/cost";
import {
  loadPlugins,
  loadPluginHooks,
  loadPluginMcpConfig,
  mergePluginHooks,
  mergePluginMcpConfig,
} from "../services/plugins/loader";
import { pluginTrustStorePath } from "../services/plugins/trust";
import { createExternalPluginTools, PluginToolRuntimeManager } from "../services/plugins/tools";
import { PluginLifecycleManager, reconcilePluginCatalog } from "../services/plugins/lifecycle";
import { configuredMarketplaceSources, loadPluginMarketplace } from "../services/plugins/marketplace";
import { scanSecurity } from "../services/security/scanner";
import {
  buildAgentProfileInstruction,
  BUILT_IN_AGENT_PROFILES,
  createAgentTool,
  selectAgentTools,
  type AgentTask,
  type AgentProfile,
} from "../tools/agent";
import { createPlanModeTools } from "../tools/plan-mode";
import {
  createAskUserQuestionTool,
  createTodoWriteTool,
  type AskUser,
  type TodoItem,
} from "../tools/interaction";
import { createTerminalPermissionPrompt, createTerminalQuestionPrompt, runRepl } from "../ui/repl";
import { formatResumeHint, runTui } from "../ui/app";
import { editPromptInExternalEditor } from "../ui/external-editor";
import { loadKeybindings } from "../ui/keybindings";
import { completeWorkspaceFiles } from "../ui/file-completion";
import { renderTerminalImage } from "../ui/terminal-image";
import { createFileStateCacheWithSizeLimit, READ_FILE_STATE_CACHE_SIZE } from "../utils/file-state-cache";
import { registerCleanup } from "../utils/cleanup-registry";
import { setShutdownResumeHint, setupGracefulShutdown } from "../utils/graceful-shutdown";
import { McpActivityController } from "../ui/mcp-activity-controller";
import { PermissionController } from "../ui/permission-controller";
import { QuestionController } from "../ui/question-controller";
import type { ManagementView, SlashCommandRequest, SlashCommandResult } from "../ui/slash-commands";
import packageJson from "../../package.json";

type Writer = { write(text: string): unknown };

const BUILT_IN_TOOL_NAMES = [
  "agent", "ask_user_question", "bash", "bash_input", "bash_kill", "bash_output", "bash_resize",
  "checkpoint_create", "checkpoint_list", "checkpoint_rollback", "codebase_investigator",
  "complete_task", "cron_create", "cron_delete", "cron_list", "edit", "enter_plan_mode",
  "enter_worktree", "exit_plan_mode", "exit_worktree", "glob", "goal_create", "goal_get",
  "goal_update", "grep", "monitor", "notebook_edit", "read", "schedule_wakeup", "send_message", "skill", "task_create", "task_get",
  "task_list", "task_output", "task_stop", "task_update", "todo_write", "update_topic", "web_fetch",
  "workflow", "write",
] as const;

export type CliOptions = {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd: string;
  stdout: Writer;
  stderr: Writer;
  transport?: ModelTransport;
  shellManager?: ShellSessionManager;
  mcpConnections?: McpConnections;
  taskManager?: TaskManager;
  teamManager?: TeamManager;
  teamSupervisor?: TeamSupervisor;
  scheduleManager?: ScheduleManager;
  hookRunner?: HookRunner;
  pluginToolRuntime?: PluginToolRuntimeManager;
  pluginCatalog?: Awaited<ReturnType<typeof loadPlugins>>["plugins"];
  promptContent?: Array<TextBlock | MediaBlock>;
  configDir?: string;
  sessionIdFactory?: () => string;
  permissionPrompt?(request: PermissionAskRequest): Promise<PermissionPromptDecision>;
  permissionSessionRules?: string[];
  askUser?: AskUser;
  interactive?: boolean;
  quiet?: boolean;
  signal?: AbortSignal;
  onEvent?(event: ModelEvent): void;
  onToolEvent?(event: ToolExecutionEvent): void;
  onPermissionModeChange?(mode: PermissionMode): void;
  teamRecoveryActive?: boolean;
  workspaceState?: WorkspaceState;
  contextWindowOverride?: number;
};

type ParsedArguments = {
  prompt: string;
  provider?: string;
  model?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  fastMode: boolean;
  permissionMode?: PermissionMode;
  sessionId?: string;
  resume?: string;
  resumePicker: boolean;
  continueLatest: boolean;
  forkSession: boolean;
  sessionName?: string;
  additionalDirectories: string[];
  mcpConfigs: string[];
  strictMcpConfig: boolean;
  tools?: string[];
  settingsInput?: string;
  agentsJson?: string;
  agent?: string;
  outputFormat: "text" | "json" | "stream-json";
  attachmentPaths: string[];
  worktree: boolean | string;
  sandbox: boolean;
  maxTurns?: number;
  allowedTools: string[];
  disallowedTools: string[];
  systemPrompt?: string;
  systemPromptFile?: string;
  appendSystemPrompt?: string;
  appendSystemPromptFile?: string;
  maxBudgetUsd?: number;
  fallbackModel?: string;
  jsonSchema?: Record<string, unknown>;
  includeHookEvents: boolean;
  includePartialMessages: boolean;
  setupTrigger?: "init" | "maintenance";
  initOnly: boolean;
};

export type ModelsCliOptions = Pick<
  CliOptions,
  "argv" | "env" | "stdout" | "stderr" | "configDir"
>;

export type StreamJsonCliOptions = Omit<CliOptions, "promptContent"> & {
  input: AsyncIterable<string>;
};

export async function runStreamJsonCli(options: StreamJsonCliOptions): Promise<number> {
  const sessionIdFactory = options.sessionIdFactory ?? randomUUID;
  const permissionSessionRules = options.permissionSessionRules ?? [];
  const configDir = options.configDir ?? options.env.TNB_HOME ?? join(homedir(), ".tnb");
  const mcpConfigPath = options.env.TNB_MCP_CONFIG ?? join(configDir, "mcp.json");
  const configuredResume = optionValueFromAliases(options.argv, ["--resume", "-r"]);
  const configuredSessionId = optionValue(options.argv, "--session-id");
  const forkSession = options.argv.includes("--fork-session");
  const continuedSession = options.argv.includes("--continue")
    ? await SessionStore.latestSessionId({ configDir, cwd: options.cwd })
    : undefined;
  if (options.argv.includes("--continue") && !continuedSession) {
    options.stdout.write(`${JSON.stringify({ type: "result", subtype: "error", error: "No previous session found for this workspace" })}\n`);
    return 1;
  }
  if (forkSession && !configuredResume && !options.argv.includes("--continue")) {
    options.stdout.write(`${JSON.stringify({ type: "result", subtype: "error", error: "--fork-session requires --resume or --continue" })}\n`);
    return 1;
  }
  if (configuredSessionId && (configuredResume || options.argv.includes("--continue")) && !forkSession) {
    options.stdout.write(`${JSON.stringify({ type: "result", subtype: "error", error: "--session-id cannot be combined with --resume or --continue" })}\n`);
    return 1;
  }
  const sourceSessionId = configuredResume ?? continuedSession;
  let sessionId: string | undefined;
  let initialResume = sourceSessionId !== undefined;
  if (forkSession) {
    const targetSessionId = configuredSessionId ?? sessionIdFactory();
    try {
      await assertSessionIdAvailable(configDir, options.cwd, targetSessionId);
      const source = new SessionStore({ configDir, cwd: options.cwd, sessionId: sourceSessionId! });
      const target = await source.forkTo(targetSessionId);
      const name = optionValueFromAliases(options.argv, ["--name", "-n"])?.trim();
      if (name) await target.setTitle(name);
      sessionId = targetSessionId;
      initialResume = true;
    } catch (error) {
      options.stdout.write(`${JSON.stringify({ type: "result", subtype: "error", error: errorMessage(error) })}\n`);
      return 1;
    }
  } else {
    sessionId = sourceSessionId ?? configuredSessionId;
  }
  if (configuredSessionId && !forkSession) {
    await assertSessionIdAvailable(configDir, options.cwd, configuredSessionId);
  }
  let hasRun = false;
  let received = false;
  let activeController: AbortController | undefined;
  let inputClosed = false;
  let selectedProvider = optionValue(options.argv, "--provider");
  let selectedModel = optionValue(options.argv, "--model");
  let selectedPermissionMode = normalizePermissionMode(optionValue(options.argv, "--permission-mode"));
  const userRecords = new AsyncRecordQueue<StreamUserInput>();
  const pendingPermissions = new Map<string, (decision: PermissionPromptDecision) => void>();
  let sharedTaskManager = options.taskManager;
  const ownsSharedTaskManager = options.taskManager === undefined;
  let protocolError: Error | undefined;

  const ensureSessionId = (): string => {
    sessionId ??= configuredSessionId ?? sourceSessionId ?? sessionIdFactory();
    return sessionId;
  };
  const ensureTaskManager = async (): Promise<TaskManager> => {
    if (sharedTaskManager) return sharedTaskManager;
    sharedTaskManager = new TaskManager(taskStatePath(configDir, ensureSessionId()));
    await sharedTaskManager.initialize();
    return sharedTaskManager;
  };
  const handleControl = async (record: StreamControlRequest): Promise<unknown> => {
    if (record.subtype === "interrupt") {
      if (activeController && !activeController.signal.aborted) {
        activeController.abort(new DOMException("Interrupted by SDK control request", "AbortError"));
      }
      return undefined;
    }
    if (record.subtype === "set_model") {
      const separator = record.model.indexOf("/");
      if (separator > 0) {
        selectedProvider = record.model.slice(0, separator);
        selectedModel = record.model.slice(separator + 1);
      } else {
        selectedModel = record.model;
      }
      return {
        provider: selectedProvider,
        model: selectedModel,
      };
    }
    if (record.subtype === "set_permission_mode") {
      selectedPermissionMode = record.mode;
      return { permissionMode: selectedPermissionMode };
    }
    if (record.subtype === "context_usage") {
      return readStreamContextUsage({
        configDir,
        cwd: options.cwd,
        env: options.env,
        sessionId: ensureSessionId(),
        provider: selectedProvider,
        model: selectedModel,
      });
    }
    if (record.subtype === "plugin_reload") {
      const settings = await loadSettings({ configDir, cwd: options.cwd });
      const plugins = await loadConfiguredPlugins(configDir, options.cwd, settings.enabledPlugins);
      return {
        plugins: plugins.plugins.map((plugin) => ({
          name: plugin.name,
          active: plugin.active,
          source: plugin.source,
        })),
        errors: plugins.errors,
      };
    }
    if (record.subtype === "mcp_add") {
      await updateMcpConfig(mcpConfigPath, (servers) => {
        if (servers[record.name]) throw new Error(`MCP server already exists: ${record.name}`);
        servers[record.name] = record.server;
      });
      return { name: record.name, action: "added" };
    }
    if (record.subtype === "mcp_remove") {
      await updateMcpConfig(mcpConfigPath, (servers) => {
        if (!servers[record.name]) throw new Error(`Unknown MCP server: ${record.name}`);
        delete servers[record.name];
      });
      return { name: record.name, action: "removed" };
    }
    if (record.subtype === "mcp_enable" || record.subtype === "mcp_disable") {
      await updateMcpConfig(mcpConfigPath, (servers) => {
        const server = servers[record.name];
        if (!server) throw new Error(`Unknown MCP server: ${record.name}`);
        server.enabled = record.subtype === "mcp_enable";
      });
      return {
        name: record.name,
        enabled: record.subtype === "mcp_enable",
      };
    }
    if (record.subtype === "mcp_reconnect") {
      const config = await loadRawMcpConfig(mcpConfigPath);
      if (record.name && !config.mcpServers[record.name]) throw new Error(`Unknown MCP server: ${record.name}`);
      return {
        reconnected: record.name ?? "all",
        note: "Changes apply on the next model turn in stream-json mode.",
      };
    }
    const taskManager = await ensureTaskManager();
    if (record.subtype === "task_create") {
      const task = await taskManager.createWorkItem({
        subject: record.subject,
        description: record.description,
        ...(record.activeForm ? { activeForm: record.activeForm } : {}),
        ...(record.metadata ? { metadata: record.metadata } : {}),
      });
      return task;
    }
    if (record.subtype === "task_get") {
      return taskManager.get(record.taskId) ?? null;
    }
    if (record.subtype === "task_list") {
      return taskManager.list();
    }
    if (record.subtype === "task_update") {
      return await taskManager.update(record.taskId, record.update) ?? null;
    }
    return await taskManager.stop(record.taskId);
  };

  const inputTask = (async () => {
    try {
      for await (const line of options.input) {
        if (!line.trim()) continue;
        const record = parseStreamInput(line);
        if (record.type === "user") {
          received = true;
          userRecords.push(record);
          continue;
        }
        if (record.type === "control_response") {
          const resolve = pendingPermissions.get(record.requestId);
          if (!resolve) {
            writeControlResponse(options.stdout, record.requestId, false, "Unknown or completed control request");
            continue;
          }
          pendingPermissions.delete(record.requestId);
          resolve(record.behavior === "allow" ? "allow" : "deny");
          continue;
        }
        try {
          const payload = await handleControl(record);
          writeControlResponse(options.stdout, record.requestId, true, undefined, payload);
        } catch (error) {
          writeControlResponse(options.stdout, record.requestId, false, errorMessage(error));
        }
      }
    } catch (error) {
      protocolError = error instanceof Error ? error : new Error(String(error));
    } finally {
      inputClosed = true;
      for (const resolve of pendingPermissions.values()) resolve("deny");
      pendingPermissions.clear();
      userRecords.close();
    }
  })();

  for await (const record of userRecords) {
    if (sessionId && record.sessionId && record.sessionId !== sessionId) {
      options.stdout.write(`${JSON.stringify({ type: "result", subtype: "error", session_id: sessionId, error: "All stream-json records must use the same session_id" })}\n`);
      return 1;
    }
    sessionId ??= record.sessionId ?? sessionIdFactory();
    if (!hasRun) {
      options.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: sessionId })}\n`);
    }
    if (options.argv.includes("--replay-user-messages")) {
      options.stdout.write(`${JSON.stringify({ type: "user", session_id: sessionId, message: { role: "user", content: record.prompt } })}\n`);
    }
    let errorOutput = "";
    const resume = hasRun || initialResume || record.resume;
    activeController = new AbortController();
    const abortFromParent = () => activeController?.abort(options.signal?.reason);
    if (options.signal?.aborted) abortFromParent();
    else options.signal?.addEventListener("abort", abortFromParent, { once: true });
    const controlledArguments = replaceCliOption(
      replaceCliOption(
        replaceCliOption(stripStructuredInputOptions(options.argv), "--provider", selectedProvider),
        "--model",
        selectedModel,
      ),
      "--permission-mode", selectedPermissionMode,
    );
    const exitCode = await runCli({
      ...options,
      argv: [
        "-p",
        record.prompt,
        ...controlledArguments,
        "--output-format",
        "stream-json",
        ...(resume ? ["--resume", sessionId] : []),
      ],
      sessionIdFactory: () => sessionId!,
      permissionSessionRules,
      ...(sharedTaskManager ? { taskManager: sharedTaskManager } : {}),
      signal: activeController.signal,
      permissionPrompt: (request) => inputClosed
        ? Promise.resolve("deny")
        : requestStreamPermission(options.stdout, pendingPermissions, request),
      stderr: { write: (text) => { errorOutput += text; } },
    });
    options.signal?.removeEventListener("abort", abortFromParent);
    const interrupted = activeController.signal.aborted;
    activeController = undefined;
    if (exitCode !== 0) {
      if (interrupted) {
        options.stdout.write(`${JSON.stringify({ type: "result", subtype: "interrupted", session_id: sessionId })}\n`);
        hasRun = true;
        continue;
      }
      options.stdout.write(`${JSON.stringify({ type: "result", subtype: "error", session_id: sessionId, error: errorOutput.trim().replace(/^tnb:\s*/, "") || "Request failed" })}\n`);
      return exitCode;
    }
    hasRun = true;
  }
  await inputTask;
  if (protocolError) {
    options.stdout.write(`${JSON.stringify({ type: "result", subtype: "error", session_id: sessionId, error: errorMessage(protocolError) })}\n`);
    return 1;
  }
  if (!received) {
    options.stdout.write(`${JSON.stringify({ type: "result", subtype: "error", error: "stream-json input ended before a user message" })}\n`);
    return 1;
  }
  if (ownsSharedTaskManager) await sharedTaskManager?.shutdown();
  return 0;
}

type StreamUserInput = {
  type: "user";
  prompt: string;
  sessionId?: string;
  resume: boolean;
};

type StreamControlRequest =
  | { type: "control_request"; requestId: string; subtype: "interrupt" }
  | { type: "control_request"; requestId: string; subtype: "set_model"; model: string }
  | { type: "control_request"; requestId: string; subtype: "set_permission_mode"; mode: PermissionMode }
  | { type: "control_request"; requestId: string; subtype: "context_usage" }
  | { type: "control_request"; requestId: string; subtype: "plugin_reload" }
  | { type: "control_request"; requestId: string; subtype: "mcp_add"; name: string; server: McpServerConfig }
  | { type: "control_request"; requestId: string; subtype: "mcp_remove"; name: string }
  | { type: "control_request"; requestId: string; subtype: "mcp_enable"; name: string }
  | { type: "control_request"; requestId: string; subtype: "mcp_disable"; name: string }
  | { type: "control_request"; requestId: string; subtype: "mcp_reconnect"; name?: string }
  | {
      type: "control_request";
      requestId: string;
      subtype: "task_create";
      subject: string;
      description: string;
      activeForm?: string;
      metadata?: Record<string, unknown>;
    }
  | { type: "control_request"; requestId: string; subtype: "task_get"; taskId: string }
  | { type: "control_request"; requestId: string; subtype: "task_list" }
  | {
      type: "control_request";
      requestId: string;
      subtype: "task_update";
      taskId: string;
      update: TaskUpdate;
    }
  | { type: "control_request"; requestId: string; subtype: "task_stop"; taskId: string };

type StreamControlResponse = {
  type: "control_response";
  requestId: string;
  behavior: "allow" | "deny";
};

type StreamInputRecord = StreamUserInput | StreamControlRequest | StreamControlResponse;

function parseStreamInput(line: string): StreamInputRecord {
  let value: unknown;
  try { value = JSON.parse(line); }
  catch (error) { throw new Error("Invalid stream-json input", { cause: error }); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("stream-json input must be an object");
  const record = value as Record<string, unknown>;
  if (record.type === "control_request") {
    const requestId = requiredStreamString(record.request_id, "control_request request_id");
    const request = streamRecord(record.request, "control_request request");
    if (request.subtype === "interrupt") return { type: "control_request", requestId, subtype: "interrupt" };
    if (request.subtype === "set_model") {
      return {
        type: "control_request",
        requestId,
        subtype: "set_model",
        model: requiredStreamString(request.model, "set_model model"),
      };
    }
    if (request.subtype === "set_permission_mode") {
      return {
        type: "control_request",
        requestId,
        subtype: "set_permission_mode",
        mode: normalizePermissionMode(requiredStreamString(request.mode, "set_permission_mode mode"))!,
      };
    }
    if (request.subtype === "context_usage" || request.subtype === "plugin_reload" || request.subtype === "task_list") {
      return { type: "control_request", requestId, subtype: request.subtype };
    }
    if (request.subtype === "mcp_add") {
      return {
        type: "control_request",
        requestId,
        subtype: "mcp_add",
        name: requiredStreamString(request.name, "mcp_add name"),
        server: validateMcpServerConfig(streamRecord(request.server, "mcp_add server") as McpServerConfig, process.env),
      };
    }
    if (
      request.subtype === "mcp_remove" || request.subtype === "mcp_enable" ||
      request.subtype === "mcp_disable"
    ) {
      return {
        type: "control_request",
        requestId,
        subtype: request.subtype,
        name: requiredStreamString(request.name, `${request.subtype} name`),
      };
    }
    if (request.subtype === "mcp_reconnect") {
      return {
        type: "control_request",
        requestId,
        subtype: "mcp_reconnect",
        ...(typeof request.name === "string" && request.name.trim()
          ? { name: request.name.trim() }
          : {}),
      };
    }
    if (request.subtype === "task_create") {
      return {
        type: "control_request",
        requestId,
        subtype: "task_create",
        subject: requiredStreamString(request.subject, "task_create subject"),
        description: requiredStreamString(request.description, "task_create description"),
        ...(request.activeForm === undefined
          ? {}
          : { activeForm: requiredStreamString(request.activeForm, "task_create activeForm") }),
        ...(request.metadata === undefined
          ? {}
          : { metadata: streamRecord(request.metadata, "task_create metadata") }),
      };
    }
    if (request.subtype === "task_get" || request.subtype === "task_stop") {
      return {
        type: "control_request",
        requestId,
        subtype: request.subtype,
        taskId: requiredStreamString(request.taskId, `${request.subtype} taskId`),
      };
    }
    if (request.subtype === "task_update") {
      return {
        type: "control_request",
        requestId,
        subtype: "task_update",
        taskId: requiredStreamString(request.taskId, "task_update taskId"),
        update: parseTaskUpdate(streamRecord(request.update, "task_update update")),
      };
    }
    throw new Error(`Unknown stream-json control request: ${String(request.subtype)}`);
  }
  if (record.type === "control_response") {
    const requestId = requiredStreamString(record.request_id, "control_response request_id");
    const response = streamRecord(record.response, "control_response response");
    if (response.behavior !== "allow" && response.behavior !== "deny") {
      throw new Error("control_response behavior must be allow or deny");
    }
    return { type: "control_response", requestId, behavior: response.behavior };
  }
  if (record.type !== "user") throw new Error("stream-json input type must be user, control_request, or control_response");
  const prompt = typeof record.prompt === "string"
    ? record.prompt
    : streamMessageText(record.message);
  if (!prompt?.trim()) throw new Error("stream-json user input must contain non-empty text");
  if (record.session_id !== undefined && (typeof record.session_id !== "string" || !record.session_id)) {
    throw new Error("stream-json session_id must be a non-empty string");
  }
  if (record.resume !== undefined && typeof record.resume !== "boolean") throw new Error("stream-json resume must be boolean");
  return {
    type: "user",
    prompt,
    ...(typeof record.session_id === "string" ? { sessionId: record.session_id } : {}),
    resume: record.resume === true,
  };
}

function streamRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requiredStreamString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requiredStreamStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return value as string[];
}

function writeControlResponse(
  stdout: Writer,
  requestId: string,
  success: boolean,
  error?: string,
  payload?: unknown,
): void {
  stdout.write(`${JSON.stringify({
    type: "control_response",
    request_id: requestId,
    response: success
      ? {
          subtype: "success",
          ...(payload === undefined ? {} : { payload }),
        }
      : { subtype: "error", error: error ?? "Control request failed" },
  })}\n`);
}

function requestStreamPermission(
  stdout: Writer,
  pending: Map<string, (decision: PermissionPromptDecision) => void>,
  request: PermissionAskRequest,
): Promise<PermissionPromptDecision> {
  const requestId = randomUUID();
  stdout.write(`${JSON.stringify({
    type: "control_request",
    request_id: requestId,
    request: {
      subtype: "can_use_tool",
      tool_name: request.tool.name,
      input: request.input,
      message: request.message,
      ...(request.suggestedRule ? { suggested_rule: request.suggestedRule } : {}),
    },
  })}\n`);
  return new Promise((resolve) => pending.set(requestId, resolve));
}

function replaceCliOption(argv: string[], option: string, value: string | undefined): string[] {
  const result: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === option) {
      index += 1;
      continue;
    }
    result.push(argv[index]!);
  }
  if (value !== undefined) result.push(option, value);
  return result;
}

class AsyncRecordQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<{ resolve(value: IteratorResult<T>): void; reject(error: unknown): void }> = [];
  #closed = false;
  #error: Error | undefined;

  push(value: T): void {
    if (this.#closed) throw new Error("Cannot push to a closed stream-json queue");
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.#values.push(value);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.#error) return Promise.reject(this.#error);
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<T>>((resolve, reject) => this.#waiters.push({ resolve, reject }));
      },
    };
  }
}

function streamMessageText(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const message = value as Record<string, unknown>;
  if (message.role !== "user") return undefined;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;
  const text = message.content.map((block) => {
    if (typeof block !== "object" || block === null || Array.isArray(block)) return "";
    const content = block as Record<string, unknown>;
    return content.type === "text" && typeof content.text === "string" ? content.text : "";
  }).filter(Boolean).join("\n");
  return text || undefined;
}

function stripStructuredInputOptions(argv: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--input-format" || argument === "--output-format" || argument === "--resume" || argument === "-r" || argument === "--session-id" || argument === "--name" || argument === "-n") {
      if (argv[index + 1] && !argv[index + 1]!.startsWith("-")) index += 1;
      continue;
    }
    if (argument === "-p" || argument === "--print" || argument === "--replay-user-messages" || argument === "--continue" || argument === "--fork-session") continue;
    result.push(argument);
  }
  return result;
}

export async function runModelsCli(options: ModelsCliOptions): Promise<number> {
  try {
    const configDir =
      options.configDir ?? options.env.TNB_HOME ?? join(homedir(), ".tnb");
    const catalog = await loadProviderCatalog({ configDir, env: options.env });
    const models = Object.values(catalog.providers).flatMap((provider) =>
      provider.models.map((model, index) => ({
        provider: provider.id,
        providerName: provider.name,
        api: provider.api,
        model: model.id,
        modelName: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        reasoning: model.reasoning,
        default: index === 0,
      })),
    );
    const outputFormat = optionValue(options.argv, "--output-format");
    if (outputFormat !== undefined && outputFormat !== "json" && outputFormat !== "text") {
      throw new Error("--output-format must be json or text");
    }
    if (options.argv.includes("--json") || outputFormat === "json") {
      options.stdout.write(`${JSON.stringify(models, null, 2)}\n`);
      return 0;
    }
    options.stdout.write("PROVIDER\tMODEL\tAPI\tCONTEXT\tMAX OUTPUT\tREASONING\n");
    for (const model of models) {
      options.stdout.write(
        `${model.provider}\t${model.model}${model.default ? " *" : ""}\t${model.api}\t${model.contextWindow}\t${model.maxTokens}\t${model.reasoning ? "yes" : "no"}\n`,
      );
    }
    return 0;
  } catch (error) {
    options.stderr.write(`tnb: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export async function runGoalLoopCli(options: CliOptions): Promise<number> {
  try {
    const configDir = options.configDir ?? options.env.TNB_HOME ?? join(homedir(), ".tnb");
    if (options.argv[0] === "goal-loop-stop") {
      const sessionId = options.argv[1] ?? optionValue(options.argv, "--session-id") ??
        await SessionStore.latestSessionId({ configDir, cwd: options.cwd });
      if (!sessionId) throw new Error("goal-loop-stop requires a session id or an existing workspace session");
      const manager = new GoalManager(goalStatePath(configDir, sessionId));
      await manager.initialize();
      const goal = manager.current();
      if (!goal) throw new Error(`Session ${sessionId} has no goal`);
      if (goal.status === "active") await manager.pause();
      options.stdout.write(`Stopped goal loop for session ${sessionId}.\n${formatGoal(manager.current())}\n`);
      return 0;
    }
    const objective = options.argv[1];
    if (!objective || objective === "--help" || objective === "-h") {
      options.stdout.write(`Usage: tnb goal-loop <objective> [--turns N] [--session-id ID] [agent options]
       tnb goal-loop-stop [session-id]

Runs the existing persistent GoalManager and Agent continuation loop in the
foreground until goal_update marks the objective complete, its turn budget is
exhausted, it is interrupted, or goal-loop-stop pauses it.
`);
      return objective ? 0 : 1;
    }
    const sessionId = optionValue(options.argv, "--session-id") ?? (options.sessionIdFactory ?? randomUUID)();
    const turnsValue = optionValue(options.argv, "--turns");
    const turns = turnsValue === undefined ? undefined : positiveInteger(turnsValue, "--turns");
    const manager = new GoalManager(goalStatePath(configDir, sessionId));
    await manager.initialize();
    const existing = manager.current();
    if (!existing) await manager.create(objective, turns ?? undefined);
    else if (existing.status === "paused") await manager.resume(true);
    else if (existing.status === "complete") throw new Error(`Session ${sessionId} goal is already complete`);
    options.stderr.write(`tnb: goal loop session ${sessionId}\n`);
    return runCli({
      ...options,
      argv: ["-p", objective, ...stripGoalLoopOptions(options.argv.slice(2))],
      sessionIdFactory: () => sessionId,
    });
  } catch (error) {
    options.stderr.write(`tnb: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function stripGoalLoopOptions(argv: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--turns" || argv[index] === "--session-id") {
      index += 1;
      continue;
    }
    result.push(argv[index]!);
  }
  return result;
}

export async function runCli(options: CliOptions): Promise<number> {
  let teamSupervisor = options.teamSupervisor;
  let ownsTeamSupervisor = false;
  let mcp: McpConnections | undefined;
  let ownsMcp = false;
  let shellManager: ShellSessionManager | undefined;
  let ownsShellManager = false;
  const lspManagers = new Map<string, TnbLspManager>();
  let ownedHooks: HookRunner | undefined;
  let settingsHooks: HookRunner | undefined;
  let pluginLifecycle: PluginLifecycleManager | undefined;
  let pluginToolRuntime: PluginToolRuntimeManager | undefined;
  let ownsPluginToolRuntime = false;
  let activePlugins: Awaited<ReturnType<typeof loadPlugins>>["plugins"] = [];
  let completed = false;
  try {
    const parsed = parseArguments(options.argv, options.env);
    await loadPromptFiles(parsed, options.cwd);
    const configDir =
      options.configDir ?? options.env.TNB_HOME ?? join(homedir(), ".tnb");
    const workspace = options.workspaceState ?? new WorkspaceState(options.cwd);
    applyAdditionalWorkspaceRoots(workspace, parsed.additionalDirectories);
    const [providerCatalog, settings] = await Promise.all([
      loadProviderCatalog({ configDir, env: options.env }),
      loadSettings({ configDir, cwd: options.cwd, ...(parsed.settingsInput ? { additional: parsed.settingsInput } : {}) }),
    ]);
    const pluginResult = options.pluginCatalog
      ? { plugins: options.pluginCatalog, errors: [] }
      : await loadConfiguredPlugins(configDir, options.cwd, settings.enabledPlugins);
    activePlugins = pluginResult.plugins;
    for (const error of pluginResult.errors) options.stderr.write(`tnb plugin: ${error.path}: ${error.error}\n`);
    for (const plugin of pluginResult.plugins.filter((item) => item.trust === "untrusted" || item.trust === "changed")) {
      options.stderr.write(`tnb plugin: ${plugin.name} is ${plugin.trust}; contributions are disabled. Review it, then run 'tnb plugins trust ${plugin.name} --yes'.\n`);
    }
    const customAgents = await loadAgents([
      { directory: join(configDir, "agents"), source: "user" },
      { directory: join(options.cwd, ".claude", "agents"), source: "claude-project" },
      { directory: join(options.cwd, ".tnb", "agents"), source: "project" },
      ...pluginResult.plugins.filter((plugin) => plugin.active).map((plugin) => ({ directory: plugin.agentsDir, source: "plugin" as const })),
    ]);
    const agentProfiles = mergeAgentProfiles([
      ...customAgents.agents,
      ...(parsed.agentsJson ? parseAgentsJson(parsed.agentsJson, options.cwd) : []),
    ]);
    const mainAgentProfile = resolveMainAgentProfile(agentProfiles, parsed.agent);
    const configuredSelection = resolveMainAgentSelection(providerCatalog, parsed, settings, mainAgentProfile);
    const effectiveFastMode = parsed.fastMode || settings.fastMode === true;
    const selection = effectiveFastMode
      ? resolveFastModeSelection(providerCatalog, configuredSelection)
      : configuredSelection;
    const [pluginHooks, pluginMcpConfig] = await Promise.all([
      loadPluginHooks(pluginResult.plugins),
      loadPluginMcpConfig(pluginResult.plugins, options.env),
    ]);
    const effectiveHooks = mergePluginHooks(settings.hooks, pluginHooks);
    const selectedModel = selection.model.id;
    const fallbackSelection = parsed.fallbackModel
      ? resolveInteractiveModel(providerCatalog, parsed.fallbackModel)
      : undefined;
    if (fallbackSelection?.provider.id === selection.provider.id && fallbackSelection.model.id === selection.model.id) {
      throw new Error("--fallback-model must differ from the primary model");
    }
    if (parsed.maxBudgetUsd !== undefined) {
      if (!selection.model.pricing) {
        throw new Error(`--max-budget-usd requires pricing for ${selection.provider.id}/${selection.model.id}`);
      }
      if (fallbackSelection && !fallbackSelection.model.pricing) {
        throw new Error(`--max-budget-usd requires pricing for fallback ${fallbackSelection.provider.id}/${fallbackSelection.model.id}`);
      }
    }
    let billingSelection = selection;
    for (const warning of settings.warnings ?? []) options.stderr.write(`tnb: ${warning}\n`);
    const requestedPermissionMode =
      parsed.permissionMode ?? mainAgentProfile?.permissionMode ?? settings.permissions?.defaultMode ?? "default";
    const permissionBaseOptions = {
      mode: requestedPermissionMode,
      ...(settings.permissions ? { rules: settings.permissions } : {}),
      disableYolo:
        settings.security?.disableYolo === true ||
        settings.permissions?.disableBypassPermissionsMode === "disable",
      cwd: options.cwd,
      ...(settings.security?.trustedFolders
        ? { trustedFolders: settings.security.trustedFolders }
        : {}),
      ...(options.permissionPrompt ? { onAsk: options.permissionPrompt } : {}),
      ...(options.permissionSessionRules ? { sessionAllowRules: options.permissionSessionRules } : {}),
      persistPermissionRule: async (rule: string) => {
        const path = join(options.cwd, ".tnb", "settings.local.json");
        if (settingsHooks) {
          await runBlockingHook(settingsHooks, "ConfigChange", {
            source: "local_settings",
            file_path: path,
          }, options.signal);
          settingsHooks.suppressNextConfigChange(path);
        }
        await addProjectPermissionRule({ cwd: options.cwd, behavior: "allow", rule });
      },
    };
    const resolvedPermissionMode = resolvePermissionMode(permissionBaseOptions);
    if (resolvedPermissionMode.reason) {
      options.stderr.write(`${resolvedPermissionMode.reason}; using default mode\n`);
    }
    const resumedSessionId = parsed.continueLatest
      ? await SessionStore.latestSessionId({ configDir, cwd: options.cwd })
      : parsed.resume;
    if (parsed.continueLatest && !resumedSessionId) {
      throw new Error("No previous session found for this workspace");
    }
    let session: SessionStore;
    if (parsed.forkSession) {
      if (!resumedSessionId) throw new Error("--fork-session requires --resume or --continue");
      const targetSessionId = parsed.sessionId ?? (options.sessionIdFactory ?? randomUUID)();
      await assertSessionIdAvailable(configDir, options.cwd, targetSessionId);
      session = await new SessionStore({ configDir, cwd: options.cwd, sessionId: resumedSessionId }).forkTo(targetSessionId);
    } else {
      session = new SessionStore({
        configDir,
        cwd: options.cwd,
        sessionId: resumedSessionId ?? parsed.sessionId ?? (options.sessionIdFactory ?? randomUUID)(),
      });
      if (parsed.sessionId) await assertSessionIdAvailable(configDir, options.cwd, parsed.sessionId);
    }
    if (parsed.sessionName) await session.setTitle(parsed.sessionName);
    pluginToolRuntime = options.pluginToolRuntime ?? new PluginToolRuntimeManager(options.env);
    ownsPluginToolRuntime = options.pluginToolRuntime === undefined;
    pluginLifecycle = new PluginLifecycleManager(
      join(configDir, "plugins", ".runtime", `${session.sessionId}.json`),
      session.sessionId,
      pluginToolRuntime,
    );
    await pluginLifecycle.initialize();
    await pluginLifecycle.start(activePlugins);
    const transport = options.transport ?? lazyModelTransport(() => createConfiguredTransportWithFallback(
      selection,
      fallbackSelection,
      parsed.thinking,
      () => { billingSelection = fallbackSelection!; },
      effectiveFastMode,
    ));
    const hooks = options.hookRunner ?? new HookRunner({
        ...(Object.keys(effectiveHooks).length ? { hooks: effectiveHooks } : {}),
        cwd: options.cwd,
        sessionId: session.sessionId,
        env: options.env,
        configFiles: hookConfigFiles(configDir),
        onError: (message) => options.stderr.write(`tnb hook: ${message}\n`),
      });
    if (!options.hookRunner) {
      hooks.setModelHandlers({
        prompt: createHookModelHandler({ transport, model: selectedModel, tools: [] }),
      });
    }
    settingsHooks = hooks;
    if (parsed.includeHookEvents && !options.quiet) {
      hooks.setObserver((event) => writeHookExecutionEvent(options.stdout, session.sessionId, event));
    }
    if (!options.hookRunner) {
      ownedHooks = hooks;
      if (parsed.setupTrigger) {
        const setup = await hooks.run("Setup", { trigger: parsed.setupTrigger }, options.signal);
        if (setup.blocked) throw new Error(setup.reason ?? "Setup hook blocked startup");
        hooks.queueSessionContext(setup.context);
      }
      await hooks.start(resumedSessionId ? "resume" : "startup", selectedModel, options.signal);
      if (parsed.initOnly) {
        completed = true;
        return 0;
      }
    }
    const taskManager = options.taskManager ?? new TaskManager(
      taskStatePath(configDir, session.sessionId),
    );
    if (!options.taskManager) await taskManager.initialize();
    const teamManager = options.teamManager ?? new TeamManager(
      teamStatePath(configDir, session.sessionId),
    );
    if (!options.teamManager) await teamManager.initialize();
    attachTaskHooks(taskManager, () => hooks, options.signal);
    const goalManager = new GoalManager(goalStatePath(configDir, session.sessionId));
    await goalManager.initialize();
    shellManager = options.shellManager ?? new ShellSessionManager({
      cwd: options.cwd,
      outputDir: join(configDir, "tasks", session.sessionId),
      env: options.env,
      sandbox: createSandboxRuntime({
        requested: parsed.sandbox,
        settings: settings.tools?.sandbox,
        env: options.env,
      }),
    });
    ownsShellManager = options.shellManager === undefined;
    const restoredSession = resumedSessionId
      ? await session.readState()
      : { messages: [] as ConversationMessage[] };
    if (parsed.worktree) {
      const worktreeName = typeof parsed.worktree === "string"
        ? parsed.worktree
        : `job-${session.sessionId.slice(0, 8)}`;
      const currentWorktree = workspace.worktree;
      if (currentWorktree && currentWorktree.worktreeName !== worktreeName) {
        throw new Error(
          `This runtime is already using worktree ${currentWorktree.worktreeName}; cannot switch to ${worktreeName}`,
        );
      }
      if (!currentWorktree) {
        await runBlockingHook(hooks, "WorktreeCreate", { name: worktreeName }, options.signal);
        const state = await createSessionWorktree(options.cwd, worktreeName);
        workspace.enter(state);
        await session.appendWorktreeState(state);
        hooks.setCwd(state.worktreePath);
        await hooks.run("CwdChanged", {
          old_cwd: options.cwd,
          new_cwd: state.worktreePath,
        }, options.signal);
      }
      shellManager.setCwd(workspace.current());
    } else if (restoredSession.worktree) {
      const info = await stat(restoredSession.worktree.worktreePath).catch(() => undefined);
      if (!info?.isDirectory()) {
        throw new Error(`Saved worktree no longer exists: ${restoredSession.worktree.worktreePath}`);
      }
      workspace.restore(restoredSession.worktree);
      shellManager.setCwd(workspace.current());
      hooks.setCwd(workspace.current());
    }
    const history = restoredSession.messages;
    const permissionRequestHook = (request: PermissionAskRequest, signal?: AbortSignal) =>
      requestPermissionThroughHooks(hooks, request, signal);
    const hookedAskUser: AskUser | undefined = options.askUser
      ? (question, signal) => askUserWithNotifications(hooks, options.askUser!, question, signal)
      : undefined;
    const inferredPlanMode = inferPlanModeState(
      history,
      restoredSession.permissionMode ?? resolvedPermissionMode.mode,
      restoredSession.prePlanMode,
    );
    const permissionModeState = new PermissionModeState(
      inferredPlanMode.mode,
      options.onPermissionModeChange,
      inferredPlanMode.prePlanMode,
    );
    if (inferredPlanMode.mode !== resolvedPermissionMode.mode) {
      options.onPermissionModeChange?.(inferredPlanMode.mode);
    }
    const checkPermission = createPermissionChecker({
      ...permissionBaseOptions,
      mode: resolvedPermissionMode.mode,
      getMode: () => permissionModeState.current,
      onPermissionRequest: permissionRequestHook,
    });
    const hookedPermission = withPermissionDeniedHooks(checkPermission, () => hooks);
    if (options.mcpConnections) {
      mcp = options.mcpConnections;
    } else {
      const mcpConfig = await resolveRuntimeMcpConfig({
        parsed,
        configDir,
        cwd: options.cwd,
        env: options.env,
        plugin: pluginMcpConfig,
      });
      mcp = await connectMcpServers(mcpConfig, {
        cwd: options.cwd,
        workspaceRoot: workspace.current,
        configDir,
        sampling: (serverName) => createMcpSamplingHandler({
          serverName,
          transport,
          model: selectedModel,
          authorize: hookedPermission,
        }),
        elicitation: (serverName) => createHookedMcpElicitationHandler({
          hooks: () => hooks,
          serverName,
          authorize: checkPermission,
          ...(options.askUser ? { askUser: options.askUser } : {}),
        }),
        elicitationComplete: async (serverName, elicitationId) => {
          await notifyElicitationComplete(hooks, serverName, elicitationId, options.signal);
          if (parsed.outputFormat === "stream-json" && !options.quiet) {
            options.stdout.write(`${JSON.stringify({
              type: "system",
              subtype: "elicitation_complete",
              mcp_server_name: serverName,
              elicitation_id: elicitationId,
              uuid: randomUUID(),
              session_id: session.sessionId,
            })}\n`);
          }
        },
        logging: (message) => {
          if (parsed.outputFormat === "stream-json" && !options.quiet) {
            options.stdout.write(`${JSON.stringify({
              type: "system",
              subtype: "mcp_log",
              mcp_server_name: message.serverName,
              level: message.level,
              ...(message.logger === undefined ? {} : { logger: message.logger }),
              data: message.data,
              uuid: randomUUID(),
              session_id: session.sessionId,
            })}\n`);
          } else if (!options.quiet) {
            options.stderr.write(`${formatMcpLogMessage(message)}\n`);
          }
        },
        progress: (event) => {
          if (parsed.outputFormat === "stream-json" && !options.quiet) {
            options.stdout.write(`${JSON.stringify({
              type: "system",
              subtype: "mcp_progress",
              mcp_server_name: event.serverName,
              progress_token: event.progressToken,
              progress: event.progress,
              ...(event.total === undefined ? {} : { total: event.total }),
              ...(event.message === undefined ? {} : { message: event.message }),
              uuid: randomUUID(),
              session_id: session.sessionId,
            })}\n`);
          } else if (!options.quiet) {
            options.stderr.write(`${formatMcpProgressEvent(event)}\n`);
          }
        },
        cancelled: (event) => {
          if (parsed.outputFormat === "stream-json" && !options.quiet) {
            options.stdout.write(`${JSON.stringify({
              type: "system",
              subtype: "mcp_cancelled",
              mcp_server_name: event.serverName,
              ...(event.requestId === undefined ? {} : { request_id: event.requestId }),
              ...(event.reason === undefined ? {} : { reason: event.reason }),
              uuid: randomUUID(),
              session_id: session.sessionId,
            })}\n`);
          } else if (!options.quiet) {
            options.stderr.write(`${formatMcpCancelledEvent(event)}\n`);
          }
        },
      });
      ownsMcp = true;
    }
    const memory = await AutoMemoryStore.create({
      configDir,
      cwd: options.cwd,
      enabled: settings.autoMemoryEnabled,
      directory: settings.autoMemoryDirectory,
      env: options.env,
    });
    const sessionMemory = new SessionMemoryStore(
      join(session.projectDir, "session-memory", `${session.sessionId}.json`),
    );
    await sessionMemory.initialize();
    const checkpointManager = new CheckpointManager(configDir);
    const lspServerConfigs = await loadLspServerConfigs({
      configDir,
      cwd: options.cwd,
      env: options.env,
    });
    const lspManagerForRoot = (root: string) => {
      const existing = lspManagers.get(root);
      if (existing) return existing;
      const manager = new TnbLspManager(root, lspServerConfigs);
      lspManagers.set(root, manager);
      return manager;
    };
    const externalPluginTools = await createExternalPluginTools(
      pluginResult.plugins.filter((plugin) => pluginLifecycle!.isActive(plugin)),
      options.env,
      pluginToolRuntime,
    );
    const baseTools = [
      ...createTools(
        workspace.current,
        options.env,
        shellManager,
        {
          supportsVision: selection.model.supportsVision,
          supportsPdf: selection.model.supportsPdf,
        },
        taskManager,
        goalManager,
        options.scheduleManager,
        providerCatalog,
        selection.provider.id,
        hookedAskUser,
        latestTodos(history),
        memory,
        new Set(pluginResult.plugins.filter((plugin) => plugin.active).flatMap((plugin) => plugin.tools ?? [])),
        join(configDir, "cache", "codebase"),
        workspace.additionalRoots,
        (root) => createLspCodebaseSemanticProvider(lspManagerForRoot(root)),
      ),
      ...(lspServerConfigs.length ? [createLspTool({
        workspaceRoot: workspace.current,
        additionalRoots: workspace.additionalRoots,
        managerForRoot: lspManagerForRoot,
      })] : []),
      createUpdateTopicTool(session),
      ...createWorkspaceTools({
        workspace,
        shell: shellManager,
        checkpoints: checkpointManager,
        onWorktreeChange: (state) => session.appendWorktreeState(state),
        beforeWorktreeCreate: (name) =>
          runBlockingHook(hooks, "WorktreeCreate", { name }, options.signal),
        beforeWorktreeRemove: (state) =>
          runBlockingHook(hooks, "WorktreeRemove", { worktree_path: state.worktreePath }, options.signal),
        onCwdChanged: async (oldCwd, newCwd) => {
          hooks.setCwd(newCwd);
          await hooks.run("CwdChanged", { old_cwd: oldCwd, new_cwd: newCwd }, options.signal);
          await mcp?.notifyRootsChanged();
        },
      }),
      ...createTeamTools({
        manager: teamManager,
        tasks: taskManager,
        teamName: () => teamManager.current()?.name,
        sender: () => "main",
      }),
      ...externalPluginTools,
      ...mcp.tools,
    ];
    const [skills, customCommands] = await Promise.all([
      loadSkills([
        { directory: join(configDir, "skills"), source: "user" },
        { directory: join(options.cwd, ".tnb", "skills"), source: "project" },
        ...pluginResult.plugins.filter((plugin) => plugin.active).map((plugin) => ({ directory: plugin.skillsDir, source: "plugin" as const })),
      ], bundledSkills()),
      loadCommands([
        { directory: join(configDir, "commands"), source: "user" },
        { directory: join(options.cwd, ".claude", "commands"), source: "compat-project" },
        { directory: join(options.cwd, ".tnb", "commands"), source: "project" },
        ...pluginResult.plugins.filter((plugin) => plugin.active).map((plugin) => ({ directory: plugin.commandsDir, source: "plugin" as const })),
      ]),
    ]);
    const [projectInstructionFiles, isGitRepository] = await Promise.all([
      loadProjectInstructionFiles(options.cwd),
      isInsideGitRepository(options.cwd),
    ]);
    const projectInstructions = projectInstructionFiles
      .map(({ filePath, content }) => `## Instructions from ${filePath}\n\n${content}`)
      .join("\n\n");
    for (const instruction of projectInstructionFiles) {
      await hooks.run("InstructionsLoaded", {
        file_path: instruction.filePath,
        memory_type: instruction.memoryType,
        load_reason: "session_start",
      }, options.signal);
    }
    const systemPromptFor = (enabledTools: AgentTool[], model = selectedModel) => {
      const defaultPrompt = buildSystemPrompt({
        cwd: workspace.current(),
        model,
        toolNames: enabledTools.map((tool) => tool.name),
        platform: `${platform()} ${release()} ${arch()}`,
        isGitRepository,
        ...(projectInstructions ? { projectInstructions } : {}),
        additionalWorkspaceRoots: workspace.additionalRoots(),
      });
      const prompt = parsed.systemPrompt ?? mainAgentProfile?.prompt ?? defaultPrompt;
      const goalReminder = goalManager.reminder();
      return [prompt, parsed.appendSystemPrompt, memory.prompt(), sessionMemory.prompt(), goalReminder].filter(Boolean).join("\n\n");
    };
    const runAgentTask = async ({
      prompt, description, profile, model, runInBackground, name, teamName, taskId, resume, signal, existingRuntimeTaskId, existingAgentId, restoreTranscript,
    }: AgentTask): Promise<string> => {
        const resumedTask = resume
          ? taskManager.restartableAgent(resume) ?? taskManager.list().find((task) => task.type === "agent" && task.metadata?.agentId === resume)
          : undefined;
        if (resume && !resumedTask) throw new Error(`Agent resume target not found: ${resume}`);
        if (resumedTask?.status === "running") throw new Error(`Agent resume target is already running: ${resumedTask.id}`);
        const runtimeTaskId = existingRuntimeTaskId ?? resumedTask?.id;
        const shouldRestoreTranscript = restoreTranscript === true || Boolean(resumedTask);
        let agentId = existingAgentId ?? (typeof resumedTask?.metadata?.agentId === "string" ? resumedTask.metadata.agentId : undefined) ?? randomUUID();
        let teammateName: string | undefined;
        if (teamName) {
          await teamManager.ensureTeam(teamName, session.sessionId);
          if (taskId) {
            const assigned = taskManager.get(taskId);
            if (!assigned || assigned.type !== "work-item") {
              throw new Error(`Agent Team task #${taskId} must be an existing persistent work item`);
            }
            if (assigned.status === "completed") throw new Error(`Agent Team task #${taskId} is already completed`);
          }
          const member = await teamManager.reserveMember({
            teamName,
            name: name ?? description,
            agentId,
            agentType: profile.name,
            ownerAgentId: session.sessionId,
            ...(taskId ? { assignedTaskId: taskId } : {}),
          });
          teammateName = member.name;
          agentId = member.agentId;
          if (taskId) await taskManager.update(taskId, { status: "in_progress", owner: teammateName });
        }
        const ordinaryTools = selectAgentTools(baseTools.filter((tool) => !isTeamTool(tool.name)), profile);
        const nestedTools = teamName && teammateName
          ? [
              ...ordinaryTools,
              ...createTeamTools({
                manager: teamManager,
                tasks: taskManager,
                teamName: () => teamName,
                sender: () => teammateName!,
                ...(taskId ? { defaultTaskId: () => taskId } : {}),
              }),
            ]
          : ordinaryTools;
        const nestedModel = model ?? (profile.model === "inherit" ? undefined : profile.model) ?? selectedModel;
        const requestedAgentMode = permissionModeState.current === "plan"
          ? "plan"
          : profile.permissionMode ?? permissionModeState.current;
        const resolvedAgentMode = resolvePermissionMode({
          ...permissionBaseOptions,
          mode: requestedAgentMode,
        });
        const authorizeAgent = createPermissionChecker({
          ...permissionBaseOptions,
          mode: resolvedAgentMode.mode,
          onPermissionRequest: permissionRequestHook,
        });
        const executeAgent = async (agentSignal: AbortSignal) => {
          const transcript = new SubagentTranscript({
            projectDir: session.projectDir,
            sessionId: session.sessionId,
            agentId,
          });
          const restoredMessages = shouldRestoreTranscript || runtimeTaskId ? await transcript.read() : [];
          const start = await hooks.run("SubagentStart", {
            agent_id: agentId,
            agent_type: profile.name,
          }, agentSignal);
          try {
            const result = await runAgentLoop({
              transport,
              model: nestedModel,
              prompt: shouldRestoreTranscript || runtimeTaskId
                ? [
                    "Resume the interrupted task from the restored transcript. Re-check current workspace state before continuing.",
                    ...start.context,
                  ].join("\n\n")
                : start.context.length
                  ? `${prompt}\n\n<subagent-hook-context>\n${start.context.join("\n\n")}\n</subagent-hook-context>`
                  : prompt,
              ...(restoredMessages.length ? { messages: restoredMessages } : {}),
              systemPrompt: `${systemPromptFor(nestedTools, nestedModel)}\n\n${buildAgentProfileInstruction(profile, description)}`,
              tools: nestedTools,
              ...(teamName && teammateName ? {
                beforeTurn: async () => ({
                  context: await drainTeamContext(teamManager, teamName, teammateName),
                }),
              } : {}),
              onMessage: (message) => transcript.append(message),
              onStop: async ({ stopHookActive: active, lastAssistantMessage }) => {
                if (teamName && teammateName) {
                  const inbox = await drainTeamContext(teamManager, teamName, teammateName);
                  if (inbox.length) return { feedback: inbox.join("\n\n") };
                }
                const stopped = await hooks.run("SubagentStop", {
                  agent_id: agentId,
                  agent_type: profile.name,
                  agent_transcript_path: transcript.filePath,
                  stop_hook_active: active,
                  ...(lastAssistantMessage ? { last_assistant_message: lastAssistantMessage } : {}),
                }, agentSignal);
                if (stopped.blocked) {
                  return { feedback: stopped.reason ?? "A SubagentStop hook requested that the subagent continue." };
                }
                if (taskId && taskManager.get(taskId)?.status !== "completed") {
                  return { feedback: `Assigned task #${taskId} is not complete. Finish and verify it, then call complete_task before stopping.` };
                }
                return {};
              },
              authorize: (tool, input, { toolUseId }) =>
                authorizeToolWithDeniedHook(authorizeAgent, hooks, tool, input, toolUseId, agentSignal),
              signal: agentSignal,
              maxTurns: profile.maxTurns ?? DEFAULT_SUBAGENT_MAX_TURNS,
            });
            if (teamName && teammateName) {
              const protocolStatus = teamManager.member(teamName, teammateName).status;
              const status = protocolStatus === "stopped" ? "stopped" : taskId ? "completed" : "idle";
              await teamManager.setStatus(teamName, agentId, status);
              if (status === "idle") {
                await teamManager.send({
                  teamName,
                  from: teammateName,
                  to: "main",
                  kind: "idle_notification",
                  text: `Teammate ${teammateName} is idle and available for more work.`,
                });
                await hooks.run("TeammateIdle", { teammate_name: teammateName, team_name: teamName }, agentSignal);
              }
            }
            return finalAssistantText(result.messages);
          } catch (error) {
            if (teamName && teammateName) {
              const stopped = agentSignal.aborted;
              await teamManager.setStatus(teamName, agentId, stopped ? "stopped" : "failed");
              if (stopped) {
                await teamManager.send({
                  teamName,
                  from: teammateName,
                  to: "main",
                  kind: "teammate_terminated",
                  text: `Teammate ${teammateName} was terminated.`,
                });
              }
            }
            throw error;
          }
        };
        if (runtimeTaskId) {
          if (teamName && teammateName) await teamManager.attachTask(teamName, agentId, runtimeTaskId);
          return executeAgent(signal);
        }
        if (runInBackground) {
          if (!options.taskManager) {
            throw new Error("Background agents require an interactive or SDK-managed task runtime");
          }
          const task = await taskManager.startAgent({
            subject: description,
            description: prompt,
            profile: profile.name,
            ...(teammateName ? { owner: teammateName } : {}),
            metadata: {
              agentId,
              ...(teamName ? { teamName, teammateName, assignedTaskId: taskId } : {}),
            },
            run: executeAgent,
          });
          if (teamName && teammateName) {
            await teamManager.attachTask(teamName, agentId, task.id);
            return `Teammate '${teammateName}' started in team '${teamName}' with agent ID ${agentId} and runtime task ${task.id}.`;
          }
          return `Background agent started with task ID ${task.id}. Use task_output to inspect it or task_stop to cancel it.`;
        }
        return executeAgent(signal);
    };
    const agentTool = createAgentTool({
      profiles: agentProfiles,
      runAgent: runAgentTask,
    });
    const skillTool = skills.length
      ? createSkillTool({
          skills,
          async runSkill({ skill, prompt, signal }) {
            if (skill.context === "inline") {
              return [
                "Apply the following skill instructions in the current agent context.",
                "Do not treat the tool result as a completed answer; continue the user's task using these instructions.",
                "",
                prompt,
              ].join("\n");
            }
            const requestedProfile = skill.agent
              ? agentProfiles.find((profile) => profile.name.toLowerCase() === skill.agent!.toLowerCase())
              : undefined;
            if (skill.agent && !requestedProfile) throw new Error(`Skill ${skill.name} requests unknown agent profile: ${skill.agent}`);
            const nestedTools = requestedProfile
              ? selectAgentTools(selectSkillTools(baseTools, skill.allowedTools), requestedProfile)
              : selectSkillTools(baseTools, skill.allowedTools);
            const skillSelection = skill.model
              ? resolveInteractiveModel(providerCatalog, skill.model)
              : selection;
            const skillEffort = normalizeSkillEffort(skill.effort, parsed.thinking);
            const skillTransport = skillSelection.provider.id === selection.provider.id && skillEffort === parsed.thinking
              ? transport
              : createConfiguredTransport(skillSelection, skillEffort);
            const agentId = randomUUID();
            const agentType = requestedProfile?.name ?? `skill:${skill.name}`;
            const transcript = new SubagentTranscript({
              projectDir: session.projectDir,
              sessionId: session.sessionId,
              agentId,
            });
            const skillHooks = skill.hooks
              ? new HookRunner({
                  hooks: skill.hooks,
                  cwd: workspace.current(),
                  sessionId: session.sessionId,
                  env: options.env,
                  onError: (message) => options.stderr.write(`tnb skill hook: ${message}\n`),
                })
              : undefined;
            skillHooks?.setModelHandlers({
              prompt: createHookModelHandler({
                transport: skillTransport,
                model: skillSelection.model.id,
                tools: nestedTools,
              }),
              agent: createHookModelHandler({
                transport: skillTransport,
                model: skillSelection.model.id,
                tools: nestedTools,
              }),
            });
            await skillHooks?.start("startup", skillSelection.model.id, signal);
            const skillPermission = skillHooks
              ? createPermissionChecker({
                  ...permissionBaseOptions,
                  mode: resolvedPermissionMode.mode,
                  getMode: () => permissionModeState.current,
                  onPermissionRequest: async (request, hookSignal) => {
                    const skillDecision = await requestPermissionThroughHooks(skillHooks, request, hookSignal);
                    return skillDecision.behavior === "ask"
                      ? permissionRequestHook(request, hookSignal)
                      : skillDecision;
                  },
                })
              : checkPermission;
            const start = await hooks.run("SubagentStart", {
              agent_id: agentId,
              agent_type: agentType,
            }, signal);
            try {
              const result = await runAgentLoop({
                transport: skillTransport,
                model: skillSelection.model.id,
                prompt: start.context.length
                  ? `${prompt}\n\n<subagent-hook-context>\n${start.context.join("\n\n")}\n</subagent-hook-context>`
                  : prompt,
                systemPrompt: [
                  systemPromptFor(nestedTools, skillSelection.model.id),
                  requestedProfile ? buildAgentProfileInstruction(requestedProfile, skill.description) : "",
                  "# Active skill\n\nFollow the selected skill instructions and return its result to the parent Agent. Supporting resources remain on disk and should be read only when needed.",
                ].filter(Boolean).join("\n\n"),
                tools: nestedTools,
                onMessage: (message) => transcript.append(message),
                ...(skillHooks ? { beforePrompt: async (submittedPrompt: string | Array<TextBlock | MediaBlock>) => {
                      const text = typeof submittedPrompt === "string"
                        ? submittedPrompt
                        : submittedPrompt.filter((block): block is TextBlock => block.type === "text").map((block) => block.text).join("\n");
                      const result = await skillHooks.run("UserPromptSubmit", { prompt: text }, signal);
                      if (result.blocked) throw new Error(result.reason ?? `Skill ${skill.name} prompt blocked by hook`);
                      return { context: [...skillHooks.takeSessionContext(), ...result.context] };
                    } } : {}),
                ...(skillHooks ? { beforeTool: async ({ id, name, input }: { id: string; name: string; input: unknown }) => {
                      const result = await skillHooks.run("PreToolUse", { tool_name: name, tool_input: input, tool_use_id: id }, signal);
                      return {
                        ...(result.updatedInput !== undefined ? { input: result.updatedInput } : {}),
                        ...(result.blocked || result.permissionDecision === "deny"
                          ? { decision: { behavior: "deny" as const, message: result.reason ?? "Skill hook blocked tool use" } }
                          : result.permissionDecision === "allow"
                            ? { decision: { behavior: "allow" as const } }
                            : {}),
                        context: result.context,
                      };
                    } } : {}),
                ...(skillHooks ? { afterTool: async ({ id, name, input, output, isError }: { id: string; name: string; input: unknown; output: string; isError: boolean }) => {
                      const result = await skillHooks.run(isError ? "PostToolUseFailure" : "PostToolUse", {
                        tool_name: name,
                        tool_input: input,
                        tool_use_id: id,
                        ...(isError ? { error: output, is_interrupt: false } : { tool_response: output }),
                      }, signal);
                      return { context: result.context };
                    } } : {}),
                onStop: async ({ stopHookActive, lastAssistantMessage }) => {
                  const payload = {
                    agent_id: agentId,
                    agent_type: agentType,
                    agent_transcript_path: transcript.filePath,
                    stop_hook_active: stopHookActive,
                    ...(lastAssistantMessage ? { last_assistant_message: lastAssistantMessage } : {}),
                  };
                  const [stopped, skillStopped] = await Promise.all([
                    hooks.run("SubagentStop", payload, signal),
                    skillHooks?.run("SubagentStop", payload, signal),
                  ]);
                  const blocked = stopped.blocked ? stopped : skillStopped?.blocked ? skillStopped : undefined;
                  return blocked
                    ? { feedback: blocked.reason ?? "A SubagentStop hook requested that the skill agent continue." }
                    : {};
                },
                authorize: (tool, input, { toolUseId }) =>
                  authorizeToolWithDeniedHooks(
                    skillPermission,
                    skillHooks ? [skillHooks, hooks] : [hooks],
                    tool,
                    input,
                    toolUseId,
                    signal,
                  ),
                signal,
                maxTurns: requestedProfile?.maxTurns ?? DEFAULT_SUBAGENT_MAX_TURNS,
              });
              return finalAssistantText(result.messages);
            } finally {
              await skillHooks?.end("other", signal);
            }
          },
        })
      : undefined;
    const workflowTool = createWorkflowTool(agentTool);
    const planModeTools = createPlanModeTools(permissionModeState);
    const availableTools = skillTool
      ? [...baseTools, agentTool, workflowTool, ...planModeTools, skillTool]
      : [...baseTools, agentTool, workflowTool, ...planModeTools];
    if (options.taskManager && !options.teamRecoveryActive) {
      const recoverTask = async (task: TaskRecord, cause: "recovery" | "message") => {
        const metadata = task.metadata ?? {};
        const teamName = typeof metadata.teamName === "string" ? metadata.teamName : undefined;
        const teammateName = typeof metadata.teammateName === "string" ? metadata.teammateName : task.owner;
        const assignedTaskId = typeof metadata.assignedTaskId === "string" ? metadata.assignedTaskId : undefined;
        const profile = agentProfiles.find((candidate) => candidate.name === task.profile);
        const existingAgentId = typeof metadata.agentId === "string" ? metadata.agentId : undefined;
        if (!profile) {
          await taskManager.recoverAgent(task.id, async () => {
            throw new Error(`Cannot recover Agent task ${task.id}: profile '${task.profile ?? "unknown"}' is unavailable`);
          });
          return;
        }
        if (Boolean(teamName) !== Boolean(teammateName)) {
          await taskManager.recoverAgent(task.id, async () => {
            throw new Error(`Cannot recover Agent Team task ${task.id}: persisted team identity is incomplete`);
          });
          return;
        }
        await taskManager.recoverAgent(task.id, (signal) => runAgentTask({
          description: task.subject,
          prompt: task.description,
          subagentType: profile.name,
          profile,
          runInBackground: false,
          ...(teammateName ? { name: teammateName } : {}),
          ...(teamName ? { teamName } : {}),
          ...(assignedTaskId ? { taskId: assignedTaskId } : {}),
          existingRuntimeTaskId: task.id,
          ...(existingAgentId ? { existingAgentId } : {}),
          restoreTranscript: true,
          signal,
        }));
      };
      if (!teamSupervisor) {
        teamSupervisor = new TeamSupervisor(
          teamManager,
          () => taskManager.current(),
          (error) => options.stderr.write(`tnb team supervisor: ${error.message}\n`),
        );
        teamSupervisor.start();
        ownsTeamSupervisor = true;
      }
      teamSupervisor.setResumeHandler(async ({ task, cause }) => {
          if (cause === "recovery") await recoverTask(task, cause);
          else {
            await taskManager.restartAgent(task.id, (signal) => runAgentTask({
              description: task.subject,
              prompt: task.description,
              subagentType: task.profile ?? "general-purpose",
              profile: agentProfiles.find((candidate) => candidate.name === task.profile) ?? BUILT_IN_AGENT_PROFILES[0]!,
              runInBackground: false,
              name: String(task.metadata?.teammateName ?? task.owner ?? task.subject),
              teamName: String(task.metadata?.teamName),
              ...(typeof task.metadata?.assignedTaskId === "string" ? { taskId: task.metadata.assignedTaskId } : {}),
              existingRuntimeTaskId: task.id,
              ...(typeof task.metadata?.agentId === "string" ? { existingAgentId: task.metadata.agentId } : {}),
              restoreTranscript: true,
              signal,
            }));
          }
      });
      for (const task of taskManager.recoverableAgents().filter((item) => !item.metadata?.teamName)) {
        await recoverTask(task, "recovery");
      }
    }
    let structuredOutput: unknown;
    const profileTools = mainAgentProfile && parsed.tools === undefined
      ? selectAgentTools(availableTools, mainAgentProfile, { mainThread: true })
      : availableTools;
    const selectedTools = selectCliTools(profileTools, parsed.tools);
    const filteredTools = filterCliTools(selectedTools, parsed.allowedTools, parsed.disallowedTools);
    const tools = parsed.jsonSchema
      ? [
          ...filteredTools,
          createStructuredOutputTool(parsed.jsonSchema, (value) => {
            if (structuredOutput !== undefined) {
              throw new Error("structured_output may only be called once");
            }
            structuredOutput = value;
          }),
        ]
      : filteredTools;
    const deferredThreshold = parsed.tools === undefined
      ? resolveDeferredToolThreshold(options.env, tools.length)
      : undefined;
    const toolCatalog = deferredThreshold === undefined
      ? undefined
      : createDeferredToolCatalog(tools, {
          threshold: deferredThreshold,
          eagerNames: ["agent", "skill", "workflow", "enter_plan_mode", "exit_plan_mode", "structured_output"],
        });
    if (toolCatalog) {
      toolCatalog.setAuxiliaryTools([createToolSearchTool(toolCatalog)]);
    }
    const exposedTools = toolCatalog?.listTools() ?? tools;
    hooks.setModelHandlers({
      prompt: createHookModelHandler({ transport, model: selectedModel, tools: [] }),
      agent: createHookModelHandler({
        transport,
        model: selectedModel,
        tools,
        authorize: hookedPermission,
        systemPrompt: () => systemPromptFor(tools),
      }),
    });
    const compactThresholdTokens = positiveInteger(
      options.env.TNB_COMPACT_THRESHOLD_TOKENS,
      "TNB_COMPACT_THRESHOLD_TOKENS",
    ) ?? getAutoCompactThresholdForCapabilities({
      contextWindowTokens: options.contextWindowOverride ?? selection.model.contextWindow,
      maxOutputTokens: selection.model.maxTokens,
    });
    const summarize = createTransportSummarizer({
      transport,
      model: options.env.TNB_COMPACT_MODEL ?? selectedModel,
    });

    const attachmentPrompt = parsed.attachmentPaths.length
      ? await loadPromptAttachments({
          cwd: options.cwd,
          prompt: parsed.prompt,
          paths: parsed.attachmentPaths,
          capabilities: {
            supportsVision: selection.model.supportsVision,
            supportsPdf: selection.model.supportsPdf,
          },
          signal: options.signal ?? new AbortController().signal,
        })
      : undefined;
    const explicitPromptContent = options.promptContent
      ? parsed.attachmentPaths.length
        ? [...options.promptContent, ...attachmentPrompt!.slice(1)]
        : options.promptContent
      : attachmentPrompt;
    const expandedCommand = explicitPromptContent
      ? undefined
      : expandCommandInput(parsed.prompt, customCommands.commands);
    const goalWasActive = goalManager.current()?.status === "active";
    let goalLoopObservedActive = goalWasActive;
    let completedGoalTurnRecorded = false;
    let invocationCostUsd = 0;
    let structuredOutputRetries = 0;
    const maxStructuredOutputRetries = positiveInteger(
      options.env.MAX_STRUCTURED_OUTPUT_RETRIES,
      "MAX_STRUCTURED_OUTPUT_RETRIES",
    ) ?? 5;
    if (isGitRepository) {
      await checkpointManager.createTurnCheckpoint({
        cwd: workspace.current(),
        sessionId: session.sessionId,
        sessionCwd: options.cwd,
        messageCount: history.length,
      });
    }
    const mainMaxTurns = parsed.maxTurns ?? mainAgentProfile?.maxTurns;
    const result = await runAgentLoop({
      transport,
      model: selectedModel,
      prompt: explicitPromptContent ?? expandedCommand?.prompt ?? parsed.prompt,
      systemPrompt: () => systemPromptFor(toolCatalog?.listTools() ?? exposedTools),
      messages: history,
      tools: exposedTools,
      ...(toolCatalog ? { toolCatalog } : {}),
      beforePrompt: async (prompt) => {
        const promptText = typeof prompt === "string"
          ? prompt
          : prompt.filter((block): block is TextBlock => block.type === "text").map((block) => block.text).join("\n");
        const result = await hooks.run("UserPromptSubmit", { prompt: promptText }, options.signal);
        if (result.blocked) throw new Error(result.reason ?? "User prompt blocked by hook");
        return { context: [...hooks.takeSessionContext(), ...result.context] };
      },
      beforeTurn: async () => {
        const teamName = teamManager.current()?.name;
        return {
          context: teamName ? await drainTeamContext(teamManager, teamName, "main") : [],
        };
      },
      beforeTool: async ({ id, name, input }) => {
        const result = await hooks.run("PreToolUse", {
          tool_name: name,
          tool_input: input,
          tool_use_id: id,
        }, options.signal);
        const decision = result.blocked || result.permissionDecision === "deny"
          ? { behavior: "deny" as const, message: result.reason ?? "Tool use blocked by hook" }
          : result.permissionDecision === "allow"
            ? { behavior: "allow" as const }
            : undefined;
        return {
          ...(result.updatedInput !== undefined ? { input: result.updatedInput } : {}),
          ...(decision ? { decision } : {}),
          context: result.context,
        };
      },
      afterTool: async ({ id, name, input, output, isError }) => {
        const result = await hooks.run(isError ? "PostToolUseFailure" : "PostToolUse", {
          tool_name: name,
          tool_input: input,
          tool_use_id: id,
          ...(isError ? { error: output, is_interrupt: false } : { tool_response: output }),
        }, options.signal);
        return { context: result.context };
      },
      onStop: async ({ stopReason, stopHookActive, lastAssistantMessage }) => {
        const teamName = teamManager.current()?.name;
        if (teamName) {
          const inbox = await drainTeamContext(teamManager, teamName, "main");
          if (inbox.length) return { feedback: inbox.join("\n\n") };
        }
        if (parsed.jsonSchema && structuredOutput === undefined) {
          structuredOutputRetries += 1;
          if (structuredOutputRetries > maxStructuredOutputRetries) {
            throw new Error(`Model did not provide structured output after ${maxStructuredOutputRetries} retries`);
          }
          return {
            feedback: "The response is not complete until you call structured_output exactly once with an object matching its schema. Call it now without additional prose.",
          };
        }
        const hookResult = await hooks.run("Stop", {
          stop_hook_active: stopHookActive,
          ...(lastAssistantMessage ? { last_assistant_message: lastAssistantMessage } : {}),
        }, options.signal);
        if (hookResult.blocked) {
          return { feedback: hookResult.reason ?? "A Stop hook requested that the agent continue." };
        }
        await goalManager.refresh();
        const goal = goalManager.current();
        if (goal?.status === "active") {
          goalLoopObservedActive = true;
          const updated = await goalManager.recordTurn();
          const feedback = updated?.status === "active" ? goalManager.continuationPrompt() : undefined;
          return feedback ? { feedback } : {};
        }
        if (goal?.status === "complete" && goalLoopObservedActive && !completedGoalTurnRecorded) {
          completedGoalTurnRecorded = true;
          await goalManager.recordTurn(true);
        }
        return {};
      },
      onMessage: (message) => session.append([message]),
      compactMessages: async (messages, signal, context) => {
        const result = await compactConversationPipeline({
          messages,
          thresholdTokens: compactThresholdTokens,
          sessionMemory,
          summarize: async (summaryMessages, summarySignal) => {
            await hooks.run("PreCompact", {
              trigger: "auto",
              custom_instructions: null,
            }, summarySignal);
            const summary = await summarize(summaryMessages, summarySignal);
            await hooks.run("PostCompact", {
              trigger: "auto",
              compact_summary: summary,
            }, summarySignal);
            await hooks.start("compact", selectedModel, summarySignal);
            return summary;
          },
          signal,
          force: context?.reason === "context-overflow",
        });
        const compactContext = hooks.takeSessionContext();
        if (result.compacted && result.strategy === "full" && compactContext.length) {
          const summary = result.messages[0]?.content[0];
          if (summary?.type === "text") {
            summary.text += `\n\nSession hook context:\n${compactContext.join("\n\n")}`;
            result.postTokens = estimateConversationTokens(result.messages);
          }
        } else if (compactContext.length) {
          hooks.queueSessionContext(compactContext);
        }
        return result;
      },
      onCompact: ({ messages, preTokens, postTokens }) => {
        const mode = permissionModeState.snapshot();
        return session.appendCompactBoundary({
          messages,
          preTokens,
          postTokens,
          permissionMode: mode.mode,
          ...(mode.prePlanMode ? { prePlanMode: mode.prePlanMode } : {}),
        });
      },
      authorize: (tool, input, { toolUseId }) =>
        authorizeToolWithDeniedHook(checkPermission, hooks, tool, input, toolUseId, options.signal),
      ...(mainMaxTurns ? { maxTurns: mainMaxTurns } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      onToolEvent(event) {
        options.onToolEvent?.(event);
        if (parsed.outputFormat === "stream-json" && !options.quiet) {
          options.stdout.write(`${JSON.stringify({ type: "tool_event", session_id: session.sessionId, event })}\n`);
        }
      },
      onEvent(event) {
        const reportedEvent = event.type === "usage"
          ? { ...event, usage: { ...event.usage, costUsd: calculateCostUsd(event.usage, billingSelection.model.pricing) } }
          : event;
        if (reportedEvent.type === "usage" && parsed.maxBudgetUsd !== undefined) {
          invocationCostUsd += reportedEvent.usage.costUsd ?? 0;
          if (invocationCostUsd > parsed.maxBudgetUsd) {
            throw new Error(
              `Maximum budget of $${parsed.maxBudgetUsd.toFixed(2)} exceeded (current: $${invocationCostUsd.toFixed(4)})`,
            );
          }
        }
        options.onEvent?.(reportedEvent);
        if (parsed.outputFormat === "stream-json" && !options.quiet && (
          parsed.includePartialMessages || !isPartialModelEvent(reportedEvent)
        )) {
          options.stdout.write(`${JSON.stringify({ type: "model_event", session_id: session.sessionId, event: reportedEvent })}\n`);
          return;
        }
        if (!options.quiet && options.interactive && event.type === "tool-start") {
          options.stdout.write(`\n[tool] ${event.name}\n`);
        }
        if (!options.quiet && parsed.outputFormat === "text" && event.type === "text") options.stdout.write(event.text);
      },
    }).catch(async (error) => {
      if (isProviderFailure(error)) {
        await hooks.run("StopFailure", {
          error: classifyStopFailure(error),
          error_details: errorMessage(error),
          ...(lastAssistantText(history) ? { last_assistant_message: lastAssistantText(history) } : {}),
        }, options.signal).catch((hookError) => {
          options.stderr.write(`tnb hook: ${errorMessage(hookError)}\n`);
        });
      }
      throw error;
    });
    const currentCostUsd = calculateCostUsd(result.usage, billingSelection.model.pricing);
    await session.appendUsage({
      provider: billingSelection.provider.id,
      model: billingSelection.model.id,
      usage: result.usage,
      costUsd: currentCostUsd,
    });
    const totalTokens = addUsage(restoredSession.usage ?? EMPTY_USAGE, result.usage);
    const totalUsage = {
      ...totalTokens,
      costUsd: (restoredSession.usage?.costUsd ?? 0) + currentCostUsd,
    };
    if (!options.quiet && parsed.outputFormat === "json") {
      options.stdout.write(`${JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: session.sessionId,
        stop_reason: result.stopReason,
        result: lastAssistantText(result.messages),
        ...(structuredOutput !== undefined ? { structured_output: structuredOutput } : {}),
        usage: { ...result.usage, costUsd: currentCostUsd },
        total_usage: totalUsage,
        total_cost_usd: totalUsage.costUsd,
      })}\n`);
    } else if (!options.quiet && parsed.outputFormat === "stream-json") {
      options.stdout.write(`${JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: session.sessionId,
        stop_reason: result.stopReason,
        result: lastAssistantText(result.messages),
        ...(structuredOutput !== undefined ? { structured_output: structuredOutput } : {}),
        usage: { ...result.usage, costUsd: currentCostUsd },
        total_usage: totalUsage,
        total_cost_usd: totalUsage.costUsd,
      })}\n`);
    } else if (!options.quiet) {
      if (structuredOutput !== undefined) options.stdout.write(`${JSON.stringify(structuredOutput)}\n`);
      else options.stdout.write("\n");
    }
    completed = true;
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.stderr.write(`tnb: ${message}\n`);
    return 1;
  } finally {
    if (ownsTeamSupervisor) await teamSupervisor?.close();
    if (pluginLifecycle) {
      try {
        await pluginLifecycle.stop(activePlugins, ownsPluginToolRuntime);
      } catch (error) {
        options.stderr.write(`tnb plugin lifecycle: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    if (ownedHooks) {
      try {
        await ownedHooks.end(completed ? "prompt_input_exit" : "other");
      } catch (error) {
        options.stderr.write(`tnb hook: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    if (ownsMcp) await mcp?.close();
    await Promise.all([...lspManagers.values()].map((manager) => manager.close()));
    if (ownsShellManager) await shellManager?.close();
  }
}

export type InteractiveCliOptions = Omit<CliOptions, "permissionPrompt" | "interactive"> & {
  question(prompt: string): Promise<string>;
};

export async function runInteractiveCli(options: InteractiveCliOptions): Promise<number> {
  const parsed = parseArguments(["-p", "__interactive__", ...options.argv], options.env);
  await loadPromptFiles(parsed, options.cwd);
  if (parsed.jsonSchema) throw new Error("--json-schema is only available in print mode");
  if (parsed.includeHookEvents || parsed.includePartialMessages) {
    throw new Error("--include-hook-events and --include-partial-messages are only available in print mode");
  }
  const sessionIdFactory = options.sessionIdFactory ?? randomUUID;
  const configDir =
    options.configDir ?? options.env.TNB_HOME ?? join(homedir(), ".tnb");
  const preparedSession = await prepareInteractiveSession({
    parsed,
    configDir,
    cwd: options.cwd,
    sessionIdFactory,
  });
  const sessionId = preparedSession.sessionId;
  const permissionPrompt = createTerminalPermissionPrompt({
    question: options.question,
    write: (text) => void options.stdout.write(text),
  });
  const permissionSessionRules: string[] = [];
  const [providerCatalog, settings] = await Promise.all([
    loadProviderCatalog({ configDir, env: options.env }),
    loadSettings({ configDir, cwd: options.cwd, ...(parsed.settingsInput ? { additional: parsed.settingsInput } : {}) }),
  ]);
  const plugins = await loadConfiguredPlugins(configDir, options.cwd, settings.enabledPlugins);
  for (const plugin of plugins.plugins.filter((item) => item.trust === "untrusted" || item.trust === "changed")) {
    options.stderr.write(`tnb plugin: ${plugin.name} is ${plugin.trust}; open /plugins to review and trust its current content.\n`);
  }
  const [pluginHooks, pluginMcpConfig] = await Promise.all([
    loadPluginHooks(plugins.plugins),
    loadPluginMcpConfig(plugins.plugins, options.env),
  ]);
  const effectiveHooks = mergePluginHooks(settings.hooks, pluginHooks);
  const interactiveAgents = await loadAgents([
    { directory: join(configDir, "agents"), source: "user" },
    { directory: join(options.cwd, ".claude", "agents"), source: "claude-project" },
    { directory: join(options.cwd, ".tnb", "agents"), source: "project" },
    ...plugins.plugins.filter((plugin) => plugin.active).map((plugin) => ({ directory: plugin.agentsDir, source: "plugin" as const })),
  ]);
  const mainAgentProfile = resolveMainAgentProfile(mergeAgentProfiles([
    ...interactiveAgents.agents,
    ...(parsed.agentsJson ? parseAgentsJson(parsed.agentsJson, options.cwd) : []),
  ]), parsed.agent);
  const configuredSelection = resolveMainAgentSelection(providerCatalog, parsed, settings, mainAgentProfile);
  const effectiveFastMode = parsed.fastMode || settings.fastMode === true;
  const selection = effectiveFastMode
    ? resolveFastModeSelection(providerCatalog, configuredSelection)
    : configuredSelection;
  const fallbackSelection = parsed.fallbackModel
    ? resolveInteractiveModel(providerCatalog, parsed.fallbackModel)
    : undefined;
  const transport = options.transport ?? createConfiguredTransportWithFallback(
    selection,
    fallbackSelection,
    parsed.thinking,
    undefined,
    effectiveFastMode,
  );
  const interactiveHooks = new HookRunner({
    ...(Object.keys(effectiveHooks).length ? { hooks: effectiveHooks } : {}),
    cwd: options.cwd,
    sessionId,
    env: options.env,
    configFiles: hookConfigFiles(configDir),
    onError: (message) => options.stderr.write(`tnb hook: ${message}\n`),
  });
  if (parsed.setupTrigger) {
    const setup = await interactiveHooks.run("Setup", { trigger: parsed.setupTrigger });
    if (setup.blocked) throw new Error(setup.reason ?? "Setup hook blocked startup");
    interactiveHooks.queueSessionContext(setup.context);
  }
  await interactiveHooks.start(preparedSession.resume ? "resume" : "startup", selection.model.id);
  if (parsed.initOnly) {
    await interactiveHooks.end("prompt_input_exit");
    return 0;
  }
  const samplingPermission = createPermissionChecker({
    mode: resolvePermissionMode({
      mode: parsed.permissionMode ?? mainAgentProfile?.permissionMode ?? settings.permissions?.defaultMode ?? "default",
      disableYolo:
        settings.security?.disableYolo === true ||
        settings.permissions?.disableBypassPermissionsMode === "disable",
      cwd: options.cwd,
      ...(settings.security?.trustedFolders
        ? { trustedFolders: settings.security.trustedFolders }
        : {}),
    }).mode,
    ...(settings.permissions ? { rules: settings.permissions } : {}),
    onPermissionRequest: (request, signal) =>
      requestPermissionThroughHooks(interactiveHooks, request, signal),
    onAsk: permissionPrompt,
    sessionAllowRules: permissionSessionRules,
  });
  const askUser = createTerminalQuestionPrompt({
    question: options.question,
    write: (text) => void options.stdout.write(text),
  });
  const shellManager = new ShellSessionManager({
    cwd: options.cwd,
    outputDir: join(configDir, "tasks", sessionId),
    env: options.env,
    sandbox: createSandboxRuntime({
      requested: parsed.sandbox,
      settings: settings.tools?.sandbox,
      env: options.env,
    }),
  });
  const workspaceState = new WorkspaceState(options.cwd);
  applyAdditionalWorkspaceRoots(workspaceState, parsed.additionalDirectories);
  const sharedPluginToolRuntime = new PluginToolRuntimeManager(options.env);
  let interactiveMcp: McpConnections | undefined;
  try {
    const mcpConfig = await resolveRuntimeMcpConfig({
      parsed,
      configDir,
      cwd: options.cwd,
      env: options.env,
      plugin: pluginMcpConfig,
    });
    interactiveMcp = await connectMcpServers(mcpConfig, {
      cwd: options.cwd,
      workspaceRoot: workspaceState.current,
      configDir,
      sampling: (serverName) => createMcpSamplingHandler({
        serverName,
        transport,
        model: selection.model.id,
        authorize: samplingPermission,
      }),
      elicitation: (serverName) => createHookedMcpElicitationHandler({
        hooks: () => interactiveHooks,
        serverName,
        authorize: samplingPermission,
        askUser,
      }),
      elicitationComplete: (serverName, elicitationId) =>
        notifyElicitationComplete(interactiveHooks, serverName, elicitationId),
      logging: (message) => {
        void options.stderr.write(`${formatMcpLogMessage(message)}\n`);
      },
      progress: (event) => {
        void options.stderr.write(`${formatMcpProgressEvent(event)}\n`);
      },
      cancelled: (event) => {
        void options.stderr.write(`${formatMcpCancelledEvent(event)}\n`);
      },
    });
    const mcp = interactiveMcp;
    return await runRepl({
      question: options.question,
      write: (text) => void options.stdout.write(text),
      sessionIdFactory: () => sessionId,
      async runTurn(turn) {
        try {
          const promptContent = await expandMcpPromptInput(
            turn.prompt,
            mcp.prompts,
            mcp.clients,
          );
          const resumeArgs = preparedSession.resume || turn.resume
            ? ["--resume", turn.sessionId]
            : [];
          return runCli({
            ...options,
            argv: ["-p", turn.prompt, ...stripSessionBootstrapOptions(options.argv), ...resumeArgs],
            sessionIdFactory: () => turn.sessionId,
            shellManager,
            workspaceState,
            transport,
            mcpConnections: mcp,
            hookRunner: interactiveHooks,
            pluginToolRuntime: sharedPluginToolRuntime,
            pluginCatalog: plugins.plugins,
            ...(promptContent ? { promptContent } : {}),
            permissionPrompt,
            permissionSessionRules,
            askUser,
            interactive: true,
          });
        } catch (error) {
          options.stderr.write(`tnb: ${error instanceof Error ? error.message : String(error)}\n`);
          return 1;
        }
      },
    });
  } finally {
    await interactiveHooks.end("prompt_input_exit");
    await interactiveMcp?.close();
    await sharedPluginToolRuntime.close();
    await shellManager.close();
  }
}

export type InkCliOptions = Omit<
  CliOptions,
  "stdout" | "stderr" | "permissionPrompt" | "interactive" | "quiet" | "signal" | "onEvent" | "onToolEvent" | "onPermissionModeChange"
> & {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
};

export async function runInkCli(options: InkCliOptions): Promise<number> {
  let shellManager: ShellSessionManager | undefined;
  let interactiveMcp: McpConnections | undefined;
  let interactiveTaskManager: TaskManager | undefined;
  let teamSupervisor: TeamSupervisor | undefined;
  let activeHooks: HookRunner | undefined;
  let scheduleManager: ScheduleManager | undefined;
  let extensionRefreshTimer: ReturnType<typeof setInterval> | undefined;
  const sharedPluginToolRuntime = new PluginToolRuntimeManager(options.env);
  let cleanupPromise: Promise<void> | undefined;
  let clearResumeHint: () => void = () => undefined;
  const cleanup = () => cleanupPromise ??= (async () => {
    if (extensionRefreshTimer) clearInterval(extensionRefreshTimer);
    extensionRefreshTimer = undefined;
    await Promise.allSettled([
      activeHooks?.end("prompt_input_exit"),
      interactiveMcp?.close(),
      interactiveTaskManager?.shutdown(),
      teamSupervisor?.close(),
      sharedPluginToolRuntime.close(),
      scheduleManager?.close(),
      shellManager?.close(),
    ].filter((operation): operation is Promise<void> => operation !== undefined));
  })();
  const unregisterCleanup = registerCleanup(cleanup);
  try {
    const parsed = parseArguments(
      ["-p", "__interactive__", ...options.argv],
      options.env,
      { allowBareResume: true },
    );
    await loadPromptFiles(parsed, options.cwd);
    if (parsed.jsonSchema) throw new Error("--json-schema is only available in print mode");
    if (parsed.includeHookEvents || parsed.includePartialMessages) {
      throw new Error("--include-hook-events and --include-partial-messages are only available in print mode");
    }
    const configDir =
      options.configDir ?? options.env.TNB_HOME ?? join(homedir(), ".tnb");
    const [providerCatalog, settings] = await Promise.all([
      loadProviderCatalog({ configDir, env: options.env }),
      loadSettings({ configDir, cwd: options.cwd, ...(parsed.settingsInput ? { additional: parsed.settingsInput } : {}) }),
    ]);
    const loadInteractiveResources = async (pluginOverride?: Awaited<ReturnType<typeof loadPlugins>>["plugins"]) => {
      const currentSettings = await loadSettings({ configDir, cwd: options.cwd, ...(parsed.settingsInput ? { additional: parsed.settingsInput } : {}) });
      const discoveredPlugins = await loadConfiguredPlugins(configDir, options.cwd, currentSettings.enabledPlugins);
      const plugins = pluginOverride ?? discoveredPlugins.plugins;
      const [agents, commands, skills] = await Promise.all([
        loadAgents([
          { directory: join(configDir, "agents"), source: "user" },
          { directory: join(options.cwd, ".claude", "agents"), source: "claude-project" },
          { directory: join(options.cwd, ".tnb", "agents"), source: "project" },
          ...plugins.filter((plugin) => plugin.active).map((plugin) => ({ directory: plugin.agentsDir, source: "plugin" as const })),
        ]),
        loadCommands([
          { directory: join(configDir, "commands"), source: "user" },
          { directory: join(options.cwd, ".claude", "commands"), source: "compat-project" },
          { directory: join(options.cwd, ".tnb", "commands"), source: "project" },
          ...plugins.filter((plugin) => plugin.active).map((plugin) => ({ directory: plugin.commandsDir, source: "plugin" as const })),
        ]),
        loadSkills([
          { directory: join(configDir, "skills"), source: "user" },
          { directory: join(options.cwd, ".tnb", "skills"), source: "project" },
          ...plugins.filter((plugin) => plugin.active).map((plugin) => ({ directory: plugin.skillsDir, source: "plugin" as const })),
        ], bundledSkills()),
      ]);
      const signature = JSON.stringify({ plugins, agents, commands, skills });
      return {
        plugins,
        agents,
        commands,
        skills,
        agentProfiles: mergeAgentProfiles([
          ...agents.agents,
          ...(parsed.agentsJson ? parseAgentsJson(parsed.agentsJson, options.cwd) : []),
        ]),
        signature,
      };
    };
    let interactiveResources = await loadInteractiveResources();
    const pluginHooks = await loadPluginHooks(interactiveResources.plugins);
    const effectiveHooks = mergePluginHooks(settings.hooks, pluginHooks);
    let extensionRefresh: Promise<void> | undefined;
    const refreshInteractiveResources = (force = false): Promise<void> => {
      if (extensionRefresh) return extensionRefresh;
      extensionRefresh = (async () => {
        const discovered = await loadInteractiveResources();
        if (!force && discovered.signature === interactiveResources.signature) return;
        if (activeHooks) {
          const result = await activeHooks.run("ConfigChange", { source: "skills" });
          if (result.blocked) {
            options.stderr.write(`tnb hook: ${result.reason ?? "Extension reload blocked"}\n`);
            return;
          }
        }
        const reconciled = reconcilePluginCatalog(interactiveResources.plugins, discovered.plugins, force);
        for (const plugin of reconciled.stop) await sharedPluginToolRuntime.stopPlugin(plugin);
        for (const item of reconciled.deferred) {
          options.stderr.write(`tnb plugin: ${item.plugin.name} update deferred until ${item.policy === "session" ? "the next session" : "tnb restarts"}\n`);
        }
        interactiveResources = reconciled.deferred.length || reconciled.plugins.length !== discovered.plugins.length
          ? await loadInteractiveResources(reconciled.plugins)
          : discovered;
      })().catch((error) => {
        options.stderr.write(`tnb extensions: ${error instanceof Error ? error.message : String(error)}\n`);
      }).finally(() => {
        extensionRefresh = undefined;
      });
      return extensionRefresh;
    };
    const mainAgentProfile = resolveMainAgentProfile(interactiveResources.agentProfiles, parsed.agent);
    const configuredSelection = resolveMainAgentSelection(providerCatalog, parsed, settings, mainAgentProfile);
    let activeFastMode = parsed.fastMode || settings.fastMode === true;
    let activeSelection = activeFastMode
      ? resolveFastModeSelection(providerCatalog, configuredSelection)
      : configuredSelection;
    const fallbackSelection = parsed.fallbackModel
      ? resolveInteractiveModel(providerCatalog, parsed.fallbackModel)
      : undefined;
    let activeReasoningEffort = parsed.thinking;
    let activeContextWindow = activeSelection.model.contextWindow;
    let activeTransport = options.transport ?? createConfiguredTransportWithFallback(
      activeSelection,
      fallbackSelection,
      activeReasoningEffort,
      () => { activeSelection = fallbackSelection!; },
      activeFastMode,
    );
    let activeDisableYolo = settings.security?.disableYolo === true ||
      settings.permissions?.disableBypassPermissionsMode === "disable";
    let activeTrustedFolders = [...(settings.security?.trustedFolders ?? [])];
    const requestedMode = parsed.permissionMode ?? mainAgentProfile?.permissionMode ?? settings.permissions?.defaultMode ?? "default";
    const resolvedMode = resolvePermissionMode({
      mode: requestedMode,
      disableYolo: activeDisableYolo,
      cwd: options.cwd,
      ...(activeTrustedFolders.length
        ? { trustedFolders: activeTrustedFolders }
        : {}),
    });
    let activePermissionMode = resolvedMode.mode;
    const sessionIdFactory = options.sessionIdFactory ?? randomUUID;
    const preparedSession = await prepareInteractiveSession({
      parsed,
      configDir,
      cwd: options.cwd,
      sessionIdFactory,
    });
    const initialSessionId = preparedSession.sessionId;
    let activeInteractiveSessionId = initialSessionId;
    clearResumeHint = setShutdownResumeHint(() => {
      const session = new SessionStore({ configDir, cwd: options.cwd, sessionId: activeInteractiveSessionId });
      return existsSync(session.filePath) ? formatResumeHint(activeInteractiveSessionId) : undefined;
    });
    const initialSessionNeedsResume = preparedSession.resume;
    if (preparedSession.state?.permissionMode) {
      activePermissionMode = preparedSession.state.permissionMode;
    }
    const interactiveArgs = stripInteractiveRuntimeOptions(options.argv);
    let activeShellManager = new ShellSessionManager({
      cwd: options.cwd,
      outputDir: join(configDir, "tasks", initialSessionId),
      env: options.env,
      sandbox: createSandboxRuntime({
        requested: parsed.sandbox,
        settings: settings.tools?.sandbox,
        env: options.env,
      }),
    });
    let activeWorkspaceState = new WorkspaceState(options.cwd);
    applyAdditionalWorkspaceRoots(activeWorkspaceState, parsed.additionalDirectories);
    shellManager = activeShellManager;
    const taskManager = new TaskManager(taskStatePath(configDir, initialSessionId));
    await taskManager.initialize();
    interactiveTaskManager = taskManager;
    const teamManager = new TeamManager(teamStatePath(configDir, initialSessionId));
    await teamManager.initialize();
    teamSupervisor = new TeamSupervisor(
      teamManager,
      () => taskManager.current(),
      (error) => options.stderr.write(`tnb team supervisor: ${error.message}\n`),
    );
    teamSupervisor.start();
    scheduleManager = new ScheduleManager(join(options.cwd, ".tnb", "scheduled_tasks.json"));
    await scheduleManager.initialize();
    scheduleManager.start();
    const newHookRunner = (sessionId: string) => new HookRunner({
      ...(Object.keys(effectiveHooks).length ? { hooks: effectiveHooks } : {}),
      cwd: options.cwd,
      sessionId,
      env: options.env,
      configFiles: hookConfigFiles(configDir),
      onError: (message) => options.stderr.write(`tnb hook: ${message}\n`),
    });
    activeHooks = newHookRunner(initialSessionId);
    if (parsed.setupTrigger) {
      const setup = await activeHooks.run("Setup", { trigger: parsed.setupTrigger });
      if (setup.blocked) throw new Error(setup.reason ?? "Setup hook blocked startup");
      activeHooks.queueSessionContext(setup.context);
    }
    await activeHooks.start(initialSessionNeedsResume ? "resume" : "startup", activeSelection.model.id);
    extensionRefreshTimer = setInterval(() => void refreshInteractiveResources(), 1_000);
    extensionRefreshTimer.unref();
    if (parsed.initOnly) return 0;
    const permissionController = new PermissionController();
    const keybindings = await loadKeybindings(configDir);
    const permissionSessionRules: string[] = [];
    let activeVimMode = settings.general?.vimMode === true;
    let activeTheme = settings.ui?.theme ?? "magenta";
    const questionController = new QuestionController();
    const mcpActivityController = new McpActivityController();
    const samplingPermission = createPermissionChecker({
      mode: activePermissionMode,
      getMode: () => activePermissionMode,
      ...(settings.permissions ? { rules: settings.permissions } : {}),
      onPermissionRequest: (request, signal) =>
        requestPermissionThroughHooks(activeHooks!, request, signal),
      onAsk: permissionController.request,
      sessionAllowRules: permissionSessionRules,
    });
    const connectInteractiveMcp = async () => connectMcpServers(
      await resolveRuntimeMcpConfig({
        parsed,
        configDir,
        cwd: options.cwd,
        env: options.env,
        plugin: await loadPluginMcpConfig(interactiveResources.plugins, options.env),
      }),
      {
        cwd: options.cwd,
        workspaceRoot: activeWorkspaceState.roots,
        configDir,
        sampling: (serverName) => (params, signal) => createMcpSamplingHandler({
          serverName,
          transport: activeTransport,
          model: activeSelection.model.id,
          authorize: samplingPermission,
        })(params, signal),
        elicitation: (serverName) => createHookedMcpElicitationHandler({
          hooks: () => activeHooks!,
          serverName,
          authorize: samplingPermission,
          askUser: questionController.request,
        }),
        elicitationComplete: (serverName, elicitationId) =>
          notifyElicitationComplete(activeHooks!, serverName, elicitationId),
        logging: (message) => {
          void options.stderr.write(`${formatMcpLogMessage(message)}\n`);
        },
        progress: (event) => mcpActivityController.progress(event),
        cancelled: (event) => mcpActivityController.cancelled(event),
      },
    );
    interactiveMcp = await connectInteractiveMcp();
    let mcp = interactiveMcp;
    const pendingClipboardImages: string[] = [];

    const initialManagement = parsed.resumePicker
      ? await createResumeManagement(configDir, options.cwd)
      : undefined;
    const tuiExitCode = await runTui({
      model: activeSelection.model.id,
      contextWindowTokens: activeContextWindow,
      permissionMode: activePermissionMode,
      sessionIdFactory: (() => {
        let first = true;
        return () => {
          if (first) {
            first = false;
            return initialSessionId;
          }
          return sessionIdFactory();
        };
      })(),
      stdin: options.stdin,
      stdout: options.stdout,
      stderr: options.stderr,
      fullscreen: options.env.TNB_TUI_FULLSCREEN !== "0",
      vimMode: activeVimMode,
      theme: activeTheme,
      keybindings,
      initialResume: initialSessionNeedsResume,
      ...(preparedSession.state
        ? {
            initialTranscript: conversationDisplayTranscript(preparedSession.state.messages),
            initialInputHistory: sessionInputHistory(preparedSession.state.messages),
            ...(preparedSession.state.usage ? { initialUsage: preparedSession.state.usage } : {}),
          }
        : {}),
      async resumeHint() {
        const session = new SessionStore({
          configDir,
          cwd: options.cwd,
          sessionId: activeInteractiveSessionId,
        });
        return await pathExists(session.filePath)
          ? formatResumeHint(activeInteractiveSessionId)
          : undefined;
      },
      ...(initialManagement ? { initialManagement } : {}),
      permissionController,
      questionController,
      mcpActivityController,
      taskManager,
      shellManager: activeShellManager,
      scheduleManager,
      async pasteImage() {
        const path = await saveClipboardImage(options.cwd);
        if (path) pendingClipboardImages.push(path);
        return path;
      },
      async displayImage(path) {
        const sequence = await renderTerminalImage(resolve(options.cwd, path), options.env);
        if (sequence) options.stdout.write(sequence);
      },
      async editInput(value) {
        const currentSettings = await loadSettings({ configDir, cwd: options.cwd });
        return editPromptInExternalEditor({
          value,
          editor: currentSettings.general?.editor ?? options.env.VISUAL ?? options.env.EDITOR,
          stdout: options.stdout,
        });
      },
      externalCommands: () => [
        ...interactiveResources.commands.commands.map((command) => ({
          name: command.name,
          usage: `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`,
          description: command.description,
        })),
        ...interactiveResources.skills.filter((skill) => skill.userInvocable !== false).flatMap((skill) => [
          {
            name: skill.name,
            usage: `/${skill.name}${skill.argumentHint ? ` ${skill.argumentHint}` : ""}`,
            description: skill.description,
          },
          ...(skill.aliases ?? []).map((alias) => ({
            name: alias,
            usage: `/${alias}${skill.argumentHint ? ` ${skill.argumentHint}` : ""}`,
            description: skill.description,
          })),
        ]),
        ...mcp.prompts.map((prompt) => ({
          name: prompt.name,
          usage: `/${prompt.name}${prompt.definition.arguments?.length ? ` ${prompt.definition.arguments.map((argument) => `<${argument.name}>`).join(" ")}` : ""}`,
          description: prompt.definition.description ?? `MCP prompt from ${prompt.serverName}`,
        })),
      ],
      async completeInput(input, signal) {
        try {
          const mcpValues = (await completeMcpPromptInput(input, mcp.prompts, mcp.clients, signal))?.values ?? [];
          return mcpValues.length ? mcpValues : completeWorkspaceFiles(input, activeWorkspaceState.current(), signal);
        } catch (error) {
          if (error instanceof Error && error.message.includes("does not support argument completions")) {
            return completeWorkspaceFiles(input, activeWorkspaceState.current(), signal);
          }
          throw error;
        }
      },
      async runCommand(command) {
        await refreshInteractiveResources();
        const result = await runInteractiveSlashCommand(command, {
          configDir,
          cwd: options.cwd,
          env: options.env,
          providerCatalog,
          agentProfiles: interactiveResources.agentProfiles,
          agentLoadErrors: interactiveResources.agents.errors,
          customCommands: interactiveResources.commands.commands,
          commandLoadErrors: interactiveResources.commands.errors,
          currentSelection: () => activeSelection,
          currentPermissionMode: () => activePermissionMode,
          currentVimMode: () => activeVimMode,
          currentTheme: () => activeTheme,
          currentTransport: () => activeTransport,
          currentReasoningEffort: () => activeReasoningEffort,
          currentFastMode: () => activeFastMode,
          currentContextWindow: () => activeContextWindow,
          currentHooks: () => activeHooks!,
          currentPlugins: () => interactiveResources.plugins,
          currentMcpTools: () => mcp.tools.map((tool) => tool.name),
          currentMcpClients: () => mcp.clients,
          currentWorkspaceRoots: () => activeWorkspaceState.roots(),
          teamManager,
          taskManager,
          scheduleManager: scheduleManager!,
          switchSelection(selection) {
            if (options.transport) {
              throw new Error("Model switching is unavailable when an SDK transport is injected");
            }
            activeFastMode = false;
            const transport = createConfiguredTransportWithFallback(
              selection,
              fallbackSelection,
              activeReasoningEffort,
              () => { activeSelection = fallbackSelection ?? selection; },
            );
            activeSelection = selection;
            activeContextWindow = selection.model.contextWindow;
            activeTransport = transport;
          },
          switchReasoningEffort(effort) {
            if (options.transport) {
              throw new Error("Reasoning effort switching is unavailable when an SDK transport is injected");
            }
            activeReasoningEffort = effort;
            activeTransport = createConfiguredTransportWithFallback(
              activeSelection,
              fallbackSelection,
              activeReasoningEffort,
              () => { activeSelection = fallbackSelection ?? activeSelection; },
              activeFastMode,
            );
          },
          async switchFastMode(enabled) {
            if (options.transport) {
              throw new Error("Fast mode switching is unavailable when an SDK transport is injected");
            }
            const nextSelection = enabled
              ? resolveFastModeSelection(providerCatalog, activeSelection)
              : activeSelection;
            const replacement = createConfiguredTransportWithFallback(
              nextSelection,
              fallbackSelection,
              activeReasoningEffort,
              () => { activeSelection = fallbackSelection ?? activeSelection; },
              enabled,
            );
            let stderr = "";
            const code = await runConfigCommand({
              argv: ["config", "set", "fastMode", JSON.stringify(enabled)],
              env: options.env,
              cwd: options.cwd,
              configDir,
              stdout: { write: () => undefined },
              stderr: { write: (text) => void (stderr += text) },
            });
            if (code !== 0) throw new Error(stderr.trim().replace(/^tnb:\s*/, "") || "Unable to save fast mode preference");
            activeSelection = nextSelection;
            activeContextWindow = nextSelection.model.contextWindow;
            activeTransport = replacement;
            activeFastMode = enabled;
          },
          switchContextWindow(tokens) {
            activeContextWindow = tokens ?? activeSelection.model.contextWindow;
          },
          async addWorkspaceRoot(path) {
            const added = activeWorkspaceState.addRoot(path);
            await mcp.notifyRootsChanged();
            return added;
          },
          switchPermissionMode(mode) {
            const resolved = resolvePermissionMode({
              mode,
              disableYolo: activeDisableYolo,
              cwd: options.cwd,
              ...(activeTrustedFolders.length
                ? { trustedFolders: activeTrustedFolders }
                : {}),
            });
            activePermissionMode = resolved.mode;
            return resolved;
          },
          updateSecurityPolicy(update) {
            if (update.disableYolo !== undefined) {
              activeDisableYolo = update.disableYolo || settings.permissions?.disableBypassPermissionsMode === "disable";
            }
            if (update.trustedFolders) activeTrustedFolders = [...update.trustedFolders];
            if (activePermissionMode === "bypassPermissions") {
              const resolved = resolvePermissionMode({
                mode: activePermissionMode,
                disableYolo: activeDisableYolo,
                cwd: options.cwd,
                ...(activeTrustedFolders.length ? { trustedFolders: activeTrustedFolders } : {}),
              });
              activePermissionMode = resolved.mode;
            }
          },
          async updateUiSettings(update) {
            const entries: Array<[string, boolean | string]> = [];
            if (update.vimMode !== undefined) entries.push(["general.vimMode", update.vimMode]);
            if (update.theme !== undefined) entries.push(["ui.theme", update.theme]);
            for (const [key, value] of entries) {
              let error = "";
              const code = await runConfigCommand({
                argv: ["config", "set", key, JSON.stringify(value)],
                env: options.env,
                cwd: options.cwd,
                configDir,
                stdout: { write: () => undefined },
                stderr: { write: (text) => void (error += text) },
              });
              if (code !== 0) throw new Error(error.trim().replace(/^tnb:\s*/, "") || `Unable to update ${key}`);
            }
            if (update.vimMode !== undefined) activeVimMode = update.vimMode;
            if (update.theme !== undefined) activeTheme = update.theme;
          },
          async reloadMcp() {
            const replacement = await connectInteractiveMcp();
            const previous = mcp;
            mcp = replacement;
            interactiveMcp = replacement;
            await previous.close();
          },
          refreshExtensions: refreshInteractiveResources,
          async resetSession(nextSessionId, source) {
            await activeHooks?.end(source === "clear" ? "clear" : "resume");
            await activeShellManager.close();
            activeWorkspaceState = new WorkspaceState(options.cwd);
            applyAdditionalWorkspaceRoots(activeWorkspaceState, parsed.additionalDirectories);
            await taskManager.switchStorage(taskStatePath(configDir, nextSessionId));
            await teamManager.switchStorage(teamStatePath(configDir, nextSessionId));
            scheduleManager?.clearSession();
            activeShellManager = new ShellSessionManager({
              cwd: options.cwd,
              outputDir: join(configDir, "tasks", nextSessionId),
              env: options.env,
              sandbox: createSandboxRuntime({
                requested: parsed.sandbox,
                settings: settings.tools?.sandbox,
                env: options.env,
              }),
            });
            shellManager = activeShellManager;
            activeHooks = newHookRunner(nextSessionId);
            await activeHooks.start(source, activeSelection.model.id);
            activeInteractiveSessionId = nextSessionId;
          },
        });
        return result;
      },
      async runTurn(turn) {
        await refreshInteractiveResources();
        const clipboardAttachments = pendingClipboardImages.splice(0);
        const expandedCommand = expandCommandInput(turn.prompt, interactiveResources.commands.commands);
        const expandedSkill = expandSkillInvocation(turn.prompt, interactiveResources.skills);
        const promptContent = await expandMcpPromptInput(
          expandedCommand?.prompt ?? expandedSkill ?? turn.prompt,
          mcp.prompts,
          mcp.clients,
          turn.signal,
        );
        const shouldResume = turn.resume ||
          (initialSessionNeedsResume && turn.sessionId === initialSessionId);
        const resumeArgs = shouldResume ? ["--resume", turn.sessionId] : [];
        const runtimeArgs = [
          "--provider",
          activeSelection.provider.id,
          "--model",
          activeSelection.model.id,
          "--permission-mode",
          activePermissionMode,
          ...clipboardAttachments.flatMap((path) => ["--attachment", path]),
          ...(activeReasoningEffort ? ["--thinking", activeReasoningEffort] : []),
          ...(activeFastMode ? ["--fast"] : []),
        ];
        let errorOutput = "";
        let exitCode: number;
        try {
          exitCode = await runCli({
            ...options,
            argv: ["-p", turn.prompt, ...interactiveArgs, ...runtimeArgs, ...resumeArgs],
            stdout: { write: () => undefined },
            stderr: { write: (text) => void (errorOutput += text) },
            sessionIdFactory: () => turn.sessionId,
            shellManager: activeShellManager,
            workspaceState: activeWorkspaceState,
            taskManager,
            teamManager,
            ...(teamSupervisor ? { teamSupervisor } : {}),
            ...(scheduleManager ? { scheduleManager } : {}),
            transport: activeTransport,
            contextWindowOverride: activeContextWindow,
            mcpConnections: mcp,
            hookRunner: activeHooks!,
            pluginToolRuntime: sharedPluginToolRuntime,
            pluginCatalog: interactiveResources.plugins,
            ...(promptContent ? { promptContent } : {}),
            permissionPrompt: turn.permissionPrompt,
            permissionSessionRules,
            askUser: turn.questionPrompt,
            quiet: true,
            signal: turn.signal,
            onEvent: turn.onModelEvent,
            onToolEvent: turn.onToolEvent,
            onPermissionModeChange(mode) {
              activePermissionMode = mode;
              turn.onPermissionModeChange(mode);
            },
          });
        } finally {
          await Promise.all(clipboardAttachments.map((path) =>
            unlink(join(options.cwd, path)).catch(() => undefined)
          ));
        }
        if (exitCode !== 0) {
          throw new Error(errorOutput.trim().replace(/^tnb:\s*/, "") || "Request failed");
        }
      },
    });
    return tuiExitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.stderr.write(`tnb: ${message}\n`);
    return 1;
  } finally {
    await cleanup();
    unregisterCleanup();
    clearResumeHint();
  }
}

type InteractiveSlashCommandContext = {
  configDir: string;
  cwd: string;
  env: Record<string, string | undefined>;
  providerCatalog: ProviderCatalog;
  agentProfiles: AgentProfile[];
  agentLoadErrors: Array<{ path: string; error: string }>;
  customCommands: LoadedCommand[];
  commandLoadErrors: Array<{ path: string; error: string }>;
  currentSelection(): ProviderSelection;
  currentPermissionMode(): PermissionMode;
  currentVimMode(): boolean;
  currentTheme(): "magenta" | "cyan" | "blue" | "green";
  currentTransport(): ModelTransport;
  currentReasoningEffort(): ReasoningEffort | undefined;
  currentFastMode(): boolean;
  currentContextWindow(): number;
  currentHooks(): HookRunner;
  currentPlugins(): Awaited<ReturnType<typeof loadPlugins>>["plugins"];
  currentMcpTools(): string[];
  currentMcpClients(): Readonly<Record<string, import("../services/mcp/client").McpClient>>;
  currentWorkspaceRoots(): string[];
  teamManager: TeamManager;
  taskManager: TaskManager;
  scheduleManager: ScheduleManager;
  switchSelection(selection: ProviderSelection): void;
  switchReasoningEffort(effort: ReasoningEffort): void;
  switchFastMode(enabled: boolean): Promise<void>;
  switchContextWindow(tokens: number | undefined): void;
  addWorkspaceRoot(path: string): Promise<string>;
  switchPermissionMode(mode: PermissionMode): { mode: PermissionMode; reason?: string };
  updateSecurityPolicy(update: { disableYolo?: boolean; trustedFolders?: string[] }): void;
  updateUiSettings(update: { vimMode?: boolean; theme?: "magenta" | "cyan" | "blue" | "green" }): Promise<void>;
  reloadMcp(): Promise<void>;
  refreshExtensions(force?: boolean): Promise<void>;
  resetSession(nextSessionId: string, source: "clear" | "resume"): Promise<void>;
};

function mergeAgentProfiles(customAgents: LoadedAgent[]): AgentProfile[] {
  const profiles = new Map(
    BUILT_IN_AGENT_PROFILES.map((profile) => [profile.name.toLowerCase(), profile]),
  );
  for (const agent of customAgents) {
    profiles.set(agent.name.toLowerCase(), {
      name: agent.name,
      description: agent.description,
      prompt: agent.prompt,
      source: agent.source,
      filePath: agent.filePath,
      baseDir: agent.baseDir,
      ...(agent.tools ? { tools: agent.tools } : {}),
      ...(agent.disallowedTools ? { disallowedTools: agent.disallowedTools } : {}),
      ...(agent.model ? { model: agent.model } : {}),
      ...(agent.permissionMode ? { permissionMode: agent.permissionMode } : {}),
      ...(agent.maxTurns ? { maxTurns: agent.maxTurns } : {}),
    });
  }
  return [...profiles.values()];
}

function resolveMainAgentProfile(
  profiles: AgentProfile[],
  requestedName: string | undefined,
): AgentProfile | undefined {
  if (!requestedName) return undefined;
  const profile = profiles.find(({ name }) => name.toLowerCase() === requestedName.toLowerCase());
  if (profile) return profile;
  throw new Error(`Unknown Agent profile '${requestedName}'. Available profiles: ${profiles.map(({ name }) => name).join(", ")}`);
}

function resolveMainAgentSelection(
  catalog: ProviderCatalog,
  parsed: ParsedArguments,
  settings: Awaited<ReturnType<typeof loadSettings>>,
  profile: AgentProfile | undefined,
): ProviderSelection {
  const provider = parsed.provider ?? settings.provider;
  if (parsed.model) {
    return resolveProviderSelection(catalog, provider ?? "anthropic", parsed.model);
  }
  if (profile?.model && profile.model !== "inherit") {
    if (parsed.provider) return resolveProviderSelection(catalog, parsed.provider, profile.model);
    const qualifiedProvider = Object.keys(catalog.providers).find((id) => profile.model!.startsWith(`${id}/`));
    return qualifiedProvider
      ? resolveInteractiveModel(catalog, profile.model)
      : resolveProviderSelection(catalog, provider ?? "anthropic", profile.model);
  }
  return resolveProviderSelection(catalog, provider ?? "anthropic", settings.model);
}

async function runInteractiveSlashCommand(
  command: SlashCommandRequest,
  context: InteractiveSlashCommandContext,
): Promise<SlashCommandResult> {
  if (command.name === "about") {
    requireNoCommandArgument(command);
    const current = context.currentSelection();
    return { message: [
      `tnb ${packageJson.version}`,
      `Runtime: Bun ${Bun.version} · ${platform()} ${arch()}`,
      `Model: ${current.provider.id}/${current.model.id}`,
      `Workspace: ${context.cwd}`,
    ].join("\n") };
  }
  if (command.name === "reload") {
    requireNoCommandArgument(command);
    await context.refreshExtensions(true);
    await context.reloadMcp();
    return { message: "Reloaded Skills, Agents, commands, Plugins, and MCP servers." };
  }
  if (command.name === "doctor") {
    requireNoCommandArgument(command);
    const checks = await collectDoctorChecks({
      argv: ["doctor"],
      env: context.env,
      cwd: context.cwd,
      configDir: context.configDir,
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
    });
    return { management: {
      kind: "doctor",
      title: "Doctor",
      description: checks.some(({ status }) => status === "error")
        ? "One or more diagnostics require attention. Enter or R reruns the checks."
        : "Local runtime diagnostics passed. Enter or R reruns the checks.",
      items: checks.map((check) => ({
        id: check.name,
        label: check.name,
        description: check.detail,
        command: "/doctor",
        badges: [check.status],
        details: [check.detail],
      })),
    } };
  }
  if (command.name === "feedback") {
    const comment = unquoteCommandArgument(command.argument).trim();
    if (!comment) throw new Error("Usage: /feedback <comment>");
    let stdout = "";
    let stderr = "";
    const code = await runFeedbackCommand({
      argv: ["feedback", "--comment", comment, "--session", command.sessionId],
      env: context.env,
      cwd: context.cwd,
      stdout: { write: (text) => void (stdout += text) },
      stderr: { write: (text) => void (stderr += text) },
      version: packageJson.version,
    });
    if (code !== 0) throw new Error(stderr.trim().replace(/^tnb:\s*/, "") || "Feedback submission failed");
    return { message: stdout.trim() || "Feedback submitted." };
  }
  if (command.name === "effort") {
    if (!command.argument) {
      return { message: `Current reasoning effort: ${context.currentReasoningEffort() ?? "provider default"}` };
    }
    const effort = normalizeThinking(command.argument);
    if (!effort) throw new Error("Usage: /effort off|minimal|low|medium|high|xhigh");
    context.switchReasoningEffort(effort);
    return { message: `Reasoning effort changed to ${effort}.` };
  }
  if (command.name === "fast") {
    const argument = command.argument.trim().toLowerCase();
    if (!argument) return { message: `Fast mode is ${context.currentFastMode() ? "ON" : "OFF"}.` };
    if (argument !== "on" && argument !== "off") throw new Error("Usage: /fast [on|off]");
    const enabled = argument === "on";
    await context.switchFastMode(enabled);
    const current = context.currentSelection();
    return {
      model: current.model.id,
      contextWindowTokens: context.currentContextWindow(),
      message: `Fast mode ${enabled ? "ON" : "OFF"}${enabled ? " · same model, Anthropic fast inference" : ""}.`,
    };
  }
  if (command.name === "btw") {
    const question = unquoteCommandArgument(command.argument).trim();
    if (!question) throw new Error("Usage: /btw <question>");
    const state = await readInteractiveSessionState(context, command.sessionId);
    const instructions = (await loadProjectInstructionFiles(context.cwd))
      .map(({ filePath, content }) => `## Instructions from ${filePath}\n\n${content}`)
      .join("\n\n");
    const result = await runAgentLoop({
      transport: context.currentTransport(),
      model: context.currentSelection().model.id,
      messages: state.messages,
      prompt: [
        "Answer this side question directly in one response.",
        "You are a separate one-turn assistant sharing the current conversation context.",
        "You have no tools and cannot take actions. Do not promise to inspect, edit, search, or run anything.",
        "If the available conversation does not establish the answer, say so plainly.",
        "",
        question,
      ].join("\n"),
      systemPrompt: buildSystemPrompt({
        cwd: context.cwd,
        model: context.currentSelection().model.id,
        toolNames: [],
        platform: `${platform()} ${release()} ${arch()}`,
        ...(instructions ? { projectInstructions: instructions } : {}),
        additionalWorkspaceRoots: context.currentWorkspaceRoots().slice(1),
      }),
      tools: [],
      authorize: async () => ({ behavior: "deny", message: "Side questions cannot use tools" }),
      maxTurns: 1,
    });
    const answer = finalAssistantText(result.messages).trim();
    if (!answer) throw new Error("The side-question model returned no text response");
    return { message: answer };
  }
  if (command.name === "plan") {
    const argument = command.argument.toLowerCase();
    if (argument && argument !== "on" && argument !== "off") throw new Error("Usage: /plan [on|off]");
    const enable = argument === "on" || (!argument && context.currentPermissionMode() !== "plan");
    const requested: PermissionMode = enable ? "plan" : "default";
    const resolved = context.switchPermissionMode(requested);
    return {
      permissionMode: resolved.mode,
      message: enable ? "Entered Plan Mode. Mutating and external tools are disabled." : "Exited Plan Mode; permission mode is default.",
    };
  }
  if (command.name === "settings") {
    const words = splitCommandWords(command.argument);
    if (!words.length) {
      return { message: JSON.stringify(await loadSettings({ configDir: context.configDir, cwd: context.cwd }), null, 2) };
    }
    const [action, key, ...valueParts] = words;
    if (!action || !["get", "set", "unset", "path"].includes(action)) {
      throw new Error("Usage: /settings [get <key>|set <key> <json>|unset <key>|path]");
    }
    const argv = ["config", action, ...(key ? [key] : []), ...(valueParts.length ? [valueParts.join(" ")] : [])];
    let stdout = "";
    let stderr = "";
    const code = await runConfigCommand({
      argv,
      env: context.env,
      cwd: context.cwd,
      configDir: context.configDir,
      stdout: { write: (text) => void (stdout += text) },
      stderr: { write: (text) => void (stderr += text) },
    });
    if (code !== 0) throw new Error(stderr.trim().replace(/^tnb:\s*/, "") || `Setting ${action} failed`);
    return { message: stdout.trim() || `Setting ${action} completed.` };
  }
  if (command.name === "context-window") {
    if (!command.argument) {
      return { message: `Active context window: ${context.currentContextWindow().toLocaleString()} tokens\nModel default: ${context.currentSelection().model.contextWindow.toLocaleString()} tokens` };
    }
    if (command.argument === "default") {
      context.switchContextWindow(undefined);
      return {
        contextWindowTokens: context.currentContextWindow(),
        message: `Context window restored to model default: ${context.currentContextWindow().toLocaleString()} tokens.`,
      };
    }
    const tokens = Number(command.argument.replaceAll(",", ""));
    const maximum = context.currentSelection().model.contextWindow;
    if (!Number.isSafeInteger(tokens) || tokens < 16_000 || tokens > maximum) {
      throw new Error(`/context-window requires an integer from 16000 to ${maximum}`);
    }
    context.switchContextWindow(tokens);
    return { contextWindowTokens: tokens, message: `Active context window changed to ${tokens.toLocaleString()} tokens.` };
  }
  if (command.name === "editor") {
    const configured = unquoteCommandArgument(command.argument).trim();
    if (!configured) {
      const settings = await loadSettings({ configDir: context.configDir, cwd: context.cwd });
      return { message: `Preferred editor: ${settings.general?.editor ?? context.env.VISUAL ?? context.env.EDITOR ?? "not configured"}` };
    }
    let stdout = "";
    let stderr = "";
    const code = await runConfigCommand({
      argv: ["config", "set", "general.editor", JSON.stringify(configured)],
      env: context.env,
      cwd: context.cwd,
      configDir: context.configDir,
      stdout: { write: (text) => void (stdout += text) },
      stderr: { write: (text) => void (stderr += text) },
    });
    if (code !== 0) throw new Error(stderr.trim().replace(/^tnb:\s*/, "") || "Unable to save editor preference");
    return { message: `Preferred editor changed to: ${configured}` };
  }
  if (command.name === "docs") {
    requireNoCommandArgument(command);
    return { message: context.env.TNB_DOCS_URL ?? `Documentation: ${join(context.cwd, "docs")}` };
  }
  if (command.name === "release-notes") {
    requireNoCommandArgument(command);
    const notes = context.env.TNB_RELEASE_NOTES?.trim();
    return { message: notes || `tnb ${packageJson.version}\nNo release notes are bundled with this development build. Run tnb update --check against the configured release channel.` };
  }
  if (command.name === "add-dir") {
    const path = unquoteCommandArgument(command.argument).trim();
    if (!path) throw new Error("Usage: /add-dir <directory>");
    return { message: `Added workspace directory: ${await context.addWorkspaceRoot(path)}` };
  }
  if (command.name === "directories") {
    requireNoCommandArgument(command);
    return { message: ["Workspace directories", "", ...context.currentWorkspaceRoots().map((path, index) => `${index === 0 ? "*" : "-"} ${path}`)].join("\n") };
  }
  if (command.name === "profile") {
    requireNoCommandArgument(command);
    const selection = context.currentSelection();
    const settings = await loadSettings({ configDir: context.configDir, cwd: context.cwd });
    return { message: [
      `Provider: ${selection.provider.id} (${selection.provider.api})`,
      `Model: ${selection.model.id}`,
      `Reasoning effort: ${context.currentReasoningEffort() ?? "provider default"}`,
      `Fast mode: ${context.currentFastMode() ? "on" : "off"}`,
      `Context window: ${context.currentContextWindow().toLocaleString()}`,
      `Permission mode: ${context.currentPermissionMode()}`,
      `Sandbox: ${settings.tools?.sandbox ? "configured" : "off"}`,
      `Auto memory: ${settings.autoMemoryEnabled === false ? "off" : "on"}`,
      `Workspace roots: ${context.currentWorkspaceRoots().length}`,
      `Active plugins: ${context.currentPlugins().filter((plugin) => plugin.active).length}`,
      `Connected MCP servers: ${Object.keys(context.currentMcpClients()).length}`,
    ].join("\n") };
  }
  if (command.name === "privacy") {
    requireNoCommandArgument(command);
    return { message: [
      "Privacy boundaries",
      "",
      "- Workspace files are read locally and sent to the selected model Provider only when included in prompts or tool results.",
      "- MCP servers, Web tools, image services, feedback endpoints, Hooks, and external Plugin tools are separate external boundaries when configured or invoked.",
      "- Sessions, memory, tasks, indexes, credentials, and plugin runtime state are stored under the configured tnb home directory.",
      "- tnb does not enable product telemetry or a Qoder account gateway.",
      "- Use /tools, /mcp, /plugins, /hooks, and /settings to inspect the active capabilities and policy.",
    ].join("\n") };
  }
  if (command.name === "shortcuts") {
    requireNoCommandArgument(command);
    return { message: [
      "Keyboard shortcuts",
      "",
      "Enter          Submit",
      "Shift+Enter    Insert newline",
      "Tab            Complete slash commands or MCP prompt arguments",
      "Up/Down        Prompt history or dialog selection",
      "Mouse wheel    Scroll transcript rows",
      "PageUp/Down    Scroll one transcript viewport",
      "Ctrl+U/D       Scroll half a viewport (Ctrl+D deletes at bottom)",
      "Shift+Up/Down  Transcript page aliases",
      "Ctrl+Home/End  Oldest/latest transcript output",
      "Ctrl+O         Toggle compact/full transcript and tool output",
      "Ctrl+F         Search the transcript; Enter/Up/Down move between matches",
      "Ctrl+R         Reverse-search prompt history; repeat for older matches",
      "Ctrl+G         Edit the current prompt in /editor, $VISUAL, or $EDITOR",
      "Ctrl+Shift+C   Copy the selected transcript entry",
      "Ctrl+T         Open background task and PTY controls",
      "Esc            Close dialog, leave Vim insert mode, or interrupt a running turn",
      "Ctrl+C         Interrupt a turn; exit when idle",
      "Ctrl+V         Attach a PNG image from the clipboard",
      "Tab            Complete slash/MCP arguments and workspace file paths",
      "Vim mode       i/I/a/A, h/l, b/w, x/X, D/C, 0/$",
      "",
      `Customize:     ${join(context.configDir, "keybindings.json")}`,
    ].join("\n") };
  }
  if (command.name === "tools") {
    requireNoCommandArgument(command);
    const activePlugins = context.currentPlugins().filter((plugin) => plugin.active);
    const pluginTools = activePlugins.flatMap((plugin) =>
      plugin.toolContributions.map((tool) => tool.type === "builtin" ? tool.toolName : tool.id)
    );
    const conditionalTools = [
      ...(context.env.BRAVE_SEARCH_API_KEY ? ["web_search", "image_search"] : []),
      ...(interactiveImageGenerationAvailable(context) ? ["image_generate"] : []),
      ...(activePlugins.some((plugin) => plugin.tools?.includes("builtin:security_scan")) ? ["security_scan"] : []),
    ];
    const tools = [...new Set([...BUILT_IN_TOOL_NAMES, ...conditionalTools, ...context.currentMcpTools(), ...pluginTools])].sort();
    return { message: ["Available tools", "", ...tools.map((tool) => `- ${tool}`)].join("\n") };
  }
  if (command.name === "workflows") {
    const manager = new WorkflowManager({ configDir: context.configDir, cwd: context.cwd });
    const [action = "list", id] = splitCommandWords(command.argument);
    if (action === "list") {
      const [definitions, runs] = await Promise.all([manager.listDefinitions(), manager.listRuns()]);
      return { management: {
        kind: "workflows",
        title: "Workflows",
        description: `${definitions.length} saved definition(s) · ${runs.length} persisted run(s).`,
        items: [
          ...definitions.map((definition) => ({
            id: `definition:${definition.name}`,
            label: definition.name,
            description: `${definition.stepCount} steps · ${definition.parameterCount} parameters${definition.description ? ` · ${definition.description}` : ""}`,
            command: `/workflows definition ${definition.name}`,
          })),
          ...runs.map((run) => ({
            id: `run:${run.id}`,
            label: `${run.id} · ${run.status}`,
            description: `${run.completedSteps}/${run.stepCount} completed · ${run.failedSteps} failed${run.workflowName ? ` · ${run.workflowName}` : ""}`,
            command: `/workflows run ${run.id}`,
            active: run.status === "running",
          })),
        ],
      } };
    }
    if (!id || (action !== "definition" && action !== "run")) {
      throw new Error("Usage: /workflows [list|definition <name>|run <run-id>]");
    }
    return { message: JSON.stringify(
      action === "definition" ? await manager.getDefinition(id) : await manager.getRun(id),
      null,
      2,
    ) };
  }
  if (command.name === "models") {
    requireNoCommandArgument(command);
    const current = context.currentSelection();
    return {
      management: {
        kind: "models",
        title: "Models",
        description: "Select the model used for the next turn.",
        items: Object.values(context.providerCatalog.providers).flatMap((provider) =>
          provider.models.map((model) => ({
            id: `${provider.id}/${model.id}`,
            label: `${provider.name} · ${model.name}`,
            description: `${provider.id}/${model.id} · ${model.contextWindow.toLocaleString()} context · ${model.maxTokens.toLocaleString()} output`,
            command: `/model ${provider.id}/${model.id}`,
            active: provider.id === current.provider.id && model.id === current.model.id,
          }))
        ),
      },
    };
  }
  if (command.name === "commands") {
    requireNoCommandArgument(command);
    const lines = context.customCommands.length
      ? context.customCommands.map((item) =>
          `/${item.name}${item.argumentHint ? ` ${item.argumentHint}` : ""} — ${item.description} (${item.source})`
        )
      : ["No custom commands found."];
    if (context.commandLoadErrors.length) {
      lines.push("", "Load errors", ...context.commandLoadErrors.map((item) => `${item.path}: ${item.error}`));
    }
    return { message: lines.join("\n") };
  }
  if (command.name === "model") {
    if (!command.argument) {
      const { provider, model } = context.currentSelection();
      return {
        message: `Current model: ${provider.id}/${model.id}\nRun /models to list configured models.`,
      };
    }
    const selection = resolveInteractiveModel(context.providerCatalog, command.argument);
    context.switchSelection(selection);
    return {
      model: selection.model.id,
      contextWindowTokens: selection.model.contextWindow,
      message: `Switched to ${selection.provider.id}/${selection.model.id}.`,
    };
  }
  if (command.name === "permissions") {
    if (!command.argument) {
      return {
        management: {
          kind: "permissions",
          title: "Permission mode",
          description: "Select the policy applied to future tool calls.",
          items: ([
            ["default", "Ask before writes, commands, and network access."],
            ["acceptEdits", "Allow workspace edits; ask for commands and network access."],
            ["auto", "Approve a conservative set of safe workspace operations; ask for everything else."],
            ["dontAsk", "Allow reads and deny operations that would require a prompt."],
            ["plan", "Read-only analysis; deny mutating and external tools."],
            ["yolo", "Bypass prompts when project security policy permits it."],
          ] as const).map(([mode, description]) => ({
            id: mode,
            label: mode,
            description,
            command: `/permissions ${mode}`,
            active: normalizePermissionMode(mode) === context.currentPermissionMode(),
          })),
        },
      };
    }
    const requested = normalizePermissionMode(command.argument);
    if (!requested) throw new Error("Permission mode is required");
    const resolved = context.switchPermissionMode(requested);
    return {
      permissionMode: resolved.mode,
      message: resolved.reason
        ? `${resolved.reason}; using ${resolved.mode}.`
        : `Permission mode changed to ${resolved.mode}.`,
    };
  }
  if (command.name === "goal") {
    const manager = new GoalManager(goalStatePath(context.configDir, command.sessionId));
    await manager.initialize();
    const [action = "status", ...rest] = splitCommandWords(command.argument);
    if (action === "status") {
      if (rest.length) throw new Error("Usage: /goal status");
      return { message: formatGoal(manager.current()) };
    }
    if (action === "set") {
      const parsedGoal = parseGoalSetArguments(rest);
      const goal = await manager.create(parsedGoal.objective, parsedGoal.maxTurns);
      return { message: `Goal created.\n${formatGoal(goal)}` };
    }
    if (action === "pause") {
      if (rest.length) throw new Error("Usage: /goal pause");
      return { message: `Goal paused.\n${formatGoal(await manager.pause())}` };
    }
    if (action === "resume") {
      if (rest.length) throw new Error("Usage: /goal resume");
      return { message: `Goal resumed.\n${formatGoal(await manager.resume(true))}` };
    }
    if (action === "clear") {
      if (rest.length) throw new Error("Usage: /goal clear");
      return { message: await manager.clear() ? "Goal cleared." : "No goal exists for this session." };
    }
    throw new Error("Usage: /goal [set <objective> [--turns N]|status|pause|resume|clear]");
  }
  if (command.name === "status") {
    requireNoCommandArgument(command);
    const { provider, model } = context.currentSelection();
    return {
      message: [
        `Session: ${command.sessionId}`,
        `Provider: ${provider.id} (${provider.api})`,
        `Model: ${model.id}`,
        `Context: ${model.contextWindow.toLocaleString()} tokens`,
        `Permission mode: ${context.currentPermissionMode()}`,
        `Workspace: ${context.cwd}`,
      ].join("\n"),
    };
  }
  if (command.name === "team") {
    requireNoCommandArgument(command);
    const team = context.teamManager.current();
    if (!team) return { message: "No Agent Team exists for this session." };
    return {
      management: {
        kind: "team",
        title: `Agent Team · ${team.name}`,
        description: "Teammates exchange durable messages through send_message; assigned work is finalized with complete_task.",
        items: team.members.map((member) => ({
          id: member.agentId,
          label: member.name,
          description: [
            member.agentType,
            member.status,
            member.assignedTaskId ? `task #${member.assignedTaskId}` : undefined,
            member.runtimeTaskId ? `runtime ${member.runtimeTaskId}` : undefined,
          ].filter(Boolean).join(" · "),
          command: "/team",
          active: member.status === "running" || member.status === "idle",
        })),
      },
    };
  }
  if (command.name === "tasks") {
    requireNoCommandArgument(command);
    return { management: {
      kind: "tasks",
      title: "Tasks",
      description: "Persistent work items and background Agent runtimes for this session.",
      items: context.taskManager.current().map((task) => ({
        id: task.id,
        label: `${task.id} · ${task.subject}`,
        description: `${task.type} · ${task.status}${task.owner ? ` · ${task.owner}` : ""}${task.error ? ` · ${task.error}` : ""}`,
        command: "/tasks",
        active: task.status === "running" || task.status === "in_progress",
      })),
    } };
  }
  if (command.name === "checkpoints") {
    requireNoCommandArgument(command);
    const records = await new CheckpointManager(context.configDir).list(context.cwd);
    return { management: {
      kind: "checkpoints",
      title: "Checkpoints",
      description: "Select a checkpoint to restore workspace and linked conversation state.",
      items: records.map((record) => ({
        id: record.id,
        label: record.label,
        description: `${record.createdAt} · ${record.id}`,
        command: `/rollback ${record.id}`,
      })),
    } };
  }
  if (command.name === "memory") {
    const settings = await loadSettings({ configDir: context.configDir, cwd: context.cwd });
    const memory = await AutoMemoryStore.create({
      configDir: context.configDir,
      cwd: context.cwd,
      enabled: settings.autoMemoryEnabled,
      directory: settings.autoMemoryDirectory,
      env: context.env,
    });
    const action = command.argument.trim().toLowerCase();
    if (!action || action === "show" || action === "status") return { message: memory.summary() };
    if (action === "on" || action === "enable") {
      await runBlockingHook(context.currentHooks(), "ConfigChange", {
        source: "user_settings",
        file_path: join(context.configDir, "settings.json"),
      });
      context.currentHooks().suppressNextConfigChange(join(context.configDir, "settings.json"));
      await memory.setEnabled(true);
      return { message: `Auto memory enabled.\nPath: ${memory.directory}` };
    }
    if (action === "off" || action === "disable") {
      await runBlockingHook(context.currentHooks(), "ConfigChange", {
        source: "user_settings",
        file_path: join(context.configDir, "settings.json"),
      });
      context.currentHooks().suppressNextConfigChange(join(context.configDir, "settings.json"));
      await memory.setEnabled(false);
      return { message: `Auto memory disabled. Existing files were preserved at ${memory.directory}` };
    }
    throw new Error("Usage: /memory [show|on|off]");
  }
  if (command.name === "mcp") {
    const words = splitCommandWords(command.argument);
    if (words.length === 1 && words[0] === "reload") {
      await context.reloadMcp();
      return { message: "Reloaded MCP configuration and connections." };
    }
    if (words.length === 0) {
      const path = context.env.TNB_MCP_CONFIG ?? join(context.configDir, "mcp.json");
      const config = await loadRawMcpConfig(path);
      const oauthStorage = await loadMcpOAuthServers(join(context.configDir, "mcp-oauth.json"));
      return {
        management: {
          kind: "mcp",
          title: "MCP servers",
          description: "Enter toggles a configured server and reconnects the active MCP catalog.",
          items: Object.entries(config.mcpServers).map(([name, server]) => {
            const enabled = server.enabled !== false;
            const target = "command" in server
              ? `${server.command} ${(server.args ?? []).join(" ")}`.trim()
              : server.url;
            const oauthConfigured = Boolean("url" in server && server.oauth);
            const oauthRecord = "url" in server ? oauthStorage.get(mcpOAuthStorageKey(name, server.url)) : undefined;
            return {
              id: name,
              label: name,
              description: `${server.type ?? "stdio"} · ${enabled ? "enabled" : "disabled"} · ${target}`,
              command: `/mcp ${enabled ? "disable" : "enable"} ${name}`,
              active: enabled,
              ...(oauthConfigured
                ? {
                    badges: ["oauth", oauthRecord ? "authorized" : "not-authorized"],
                    details: [
                      `Transport: ${server.type ?? "stdio"}`,
                      `Target: ${target}`,
                      `OAuth: ${oauthRecord ? "authorized" : "authorization required"}`,
                      ...(oauthRecord?.authorizationServerUrl ? [`Issuer: ${oauthRecord.authorizationServerUrl}`] : []),
                      ...(oauthRecord?.scope ? [`Scopes: ${oauthRecord.scope}`] : []),
                    ],
                    inspectCommand: oauthRecord
                      ? `/mcp logout ${name}`
                      : `/mcp auth ${name}`,
                    inspectLabel: oauthRecord ? `/mcp logout ${name}` : `/mcp auth ${name}`,
                  }
                : {}),
            };
          }),
        },
      };
    }
    const [requestedAction, ...arguments_] = words;
    const action = requestedAction === "show" ? "get" : requestedAction;
    if (!action || !["get", "add", "remove", "enable", "disable", "auth", "logout"].includes(action)) {
      throw new Error("Usage: /mcp [show|add|remove|enable|disable|auth|logout|reload] [server]");
    }
    let output = "";
    let error = "";
    const exitCode = await runMcpCommand({
      argv: ["mcp", action, ...arguments_],
      env: context.env,
      cwd: context.cwd,
      configDir: context.configDir,
      stdout: { write: (text) => void (output += text) },
      stderr: { write: (text) => void (error += text) },
    });
    if (exitCode !== 0) throw new Error(error.trim().replace(/^tnb:\s*/, "") || `MCP ${action} failed`);
    if (["add", "remove", "enable", "disable"].includes(action)) await context.reloadMcp();
    return { message: output.trim() || `MCP ${action} completed.` };
  }
  if (command.name === "usage") {
    requireNoCommandArgument(command);
    const usage = (await readInteractiveSessionState(context, command.sessionId)).usage ?? EMPTY_USAGE;
    return { message: [
      `Input tokens: ${usage.inputTokens.toLocaleString()}`,
      `Output tokens: ${usage.outputTokens.toLocaleString()}`,
      `Cache read tokens: ${usage.cacheReadInputTokens.toLocaleString()}`,
      `Cache creation tokens: ${usage.cacheCreationInputTokens.toLocaleString()}`,
      `Estimated cost: $${usage.costUsd.toFixed(6)}`,
    ].join("\n") };
  }
  if (command.name === "insights") {
    requireNoCommandArgument(command);
    const sessions = await SessionStore.list({ configDir: context.configDir, cwd: context.cwd });
    const readable = sessions.filter((session) => !session.error);
    const states = await Promise.all(readable.map((session) =>
      new SessionStore({
        configDir: context.configDir,
        cwd: context.cwd,
        sessionId: session.sessionId,
      }).readState()
    ));
    const totals = states.reduce((result, state) => {
      const usage = state.usage ?? EMPTY_USAGE;
      result.inputTokens += usage.inputTokens;
      result.outputTokens += usage.outputTokens;
      result.cacheReadInputTokens += usage.cacheReadInputTokens;
      result.cacheCreationInputTokens += usage.cacheCreationInputTokens;
      result.costUsd += usage.costUsd;
      return result;
    }, { ...EMPTY_USAGE });
    const messageCount = readable.reduce((sum, session) => sum + session.messageCount, 0);
    const diskBytes = readable.reduce((sum, session) => sum + session.fileSize, 0);
    const activeDays = new Set(readable.map((session) => new Date(session.lastModified).toISOString().slice(0, 10))).size;
    const newest = readable[0];
    return { message: [
      "Local workspace insights",
      "",
      `Sessions: ${readable.length.toLocaleString()}${sessions.length !== readable.length ? ` (${sessions.length - readable.length} unreadable)` : ""}`,
      `Messages: ${messageCount.toLocaleString()}`,
      `Active days: ${activeDays.toLocaleString()}`,
      `Transcript storage: ${formatByteCount(diskBytes)}`,
      `Input tokens: ${totals.inputTokens.toLocaleString()}`,
      `Output tokens: ${totals.outputTokens.toLocaleString()}`,
      `Cache read tokens: ${totals.cacheReadInputTokens.toLocaleString()}`,
      `Cache creation tokens: ${totals.cacheCreationInputTokens.toLocaleString()}`,
      `Estimated cost: $${totals.costUsd.toFixed(6)}`,
      ...(newest ? [`Most recent: ${newest.title || newest.firstPrompt || newest.sessionId} · ${new Date(newest.lastModified).toLocaleString()}`] : []),
    ].join("\n") };
  }
  if (command.name === "crontab") {
    const [action, id] = splitCommandWords(command.argument);
    if (action) {
      if (action !== "remove" || !id) throw new Error("Usage: /crontab [remove <id>]");
      if (!await context.scheduleManager.remove(id)) throw new Error(`Unknown scheduled job: ${id}`);
      return { message: `Removed scheduled job ${id}.` };
    }
    const jobs = context.scheduleManager.list();
    const wakeup = context.scheduleManager.currentWakeup();
    return { management: {
      kind: "crontab",
      title: "Scheduled prompts",
      description: `${jobs.length} cron job(s)${wakeup ? ` · wakeup ${wakeup.id} at ${new Date(wakeup.scheduledAt).toLocaleString()}` : ""}. Enter removes the selected job.`,
      items: jobs.map((job) => {
        const next = nextCronRun(job.cron, Math.max(Date.now(), job.lastFiredAt ?? job.createdAt));
        return {
          id: job.id,
          label: `${job.id} · ${job.cron}`,
          description: `${job.durable ? "durable" : "session"} · ${job.recurring ? "recurring" : "once"} · next ${next === null ? "unavailable" : new Date(next).toLocaleString()} · ${job.prompt}`,
          command: `/crontab remove ${job.id}`,
          active: true,
        };
      }),
    } };
  }
  if (command.name === "upgrade") {
    requireNoCommandArgument(command);
    let stdout = "";
    let stderr = "";
    const exitCode = await runUpdateCommand({
      argv: ["update", "--check"],
      env: context.env,
      stdout: { write: (text) => void (stdout += text) },
      stderr: { write: (text) => void (stderr += text) },
      currentVersion: packageJson.version,
      executable: process.execPath,
    });
    if (exitCode !== 0) throw new Error(stderr.trim().replace(/^tnb:\s*/, "") || "Update check failed");
    return { message: stdout.trim() };
  }
  if (command.name === "context") {
    requireNoCommandArgument(command);
    const state = await readInteractiveSessionState(context, command.sessionId);
    const estimated = estimateConversationTokens(state.messages);
    const limit = context.currentContextWindow();
    const percent = limit > 0 ? Math.min(100, estimated / limit * 100) : 0;
    return { message: [
      `Conversation: ~${estimated.toLocaleString()} tokens`,
      `Model context: ${limit.toLocaleString()} tokens`,
      `Estimated use: ${percent.toFixed(1)}%`,
      "System prompt and the next model output reserve are not included in this estimate.",
    ].join("\n") };
  }
  if (command.name === "diff") {
    requireNoCommandArgument(command);
    const [status, diff] = await Promise.all([
      runGit(context.cwd, ["status", "--short"], { allowFailure: true }),
      runGit(context.cwd, ["diff", "HEAD", "--"], { allowFailure: true }),
    ]);
    if (status.exitCode !== 0 || diff.exitCode !== 0) {
      throw new Error(status.stderr.trim() || diff.stderr.trim() || "Unable to inspect Git changes");
    }
    const content = [status.stdout.trim() ? `Status\n${status.stdout.trimEnd()}` : "", diff.stdout.trimEnd()]
      .filter(Boolean).join("\n\n");
    const limit = 100_000;
    return { message: content ? `${content.slice(0, limit)}${content.length > limit ? "\n\n[diff truncated]" : ""}` : "No working-tree changes." };
  }
  if (command.name === "rewind") {
    const turns = command.argument ? Number(command.argument) : 1;
    if (!Number.isInteger(turns) || turns < 1) throw new Error("Usage: /rewind [positive-turn-count]");
    const session = new SessionStore({ configDir: context.configDir, cwd: context.cwd, sessionId: command.sessionId });
    const state = await session.readState();
    const promptIndexes = state.messages.flatMap((message, index) =>
      message.role === "user" && message.content.some((block) => block.type !== "tool-result") ? [index] : []
    );
    if (turns > promptIndexes.length) throw new Error(`Session contains only ${promptIndexes.length} user turn(s)`);
    const messages = state.messages.slice(0, promptIndexes[promptIndexes.length - turns]!);
    await session.appendRewindBoundary(messages);
    await context.resetSession(command.sessionId, "resume");
    return {
      resetSession: true,
      resumeSession: messages.length > 0,
      sessionId: command.sessionId,
      restoredTranscript: conversationDisplayTranscript(messages),
      restoredInputHistory: sessionInputHistory(messages),
      permissionMode: context.currentPermissionMode(),
      message: `Rewound ${turns} conversation turn${turns === 1 ? "" : "s"}. Workspace files were not changed.`,
    };
  }
  if (command.name === "rollback") {
    const manager = new CheckpointManager(context.configDir);
    const words = splitCommandWords(command.argument);
    if (!words.length) {
      const records = (await manager.list(context.cwd)).filter(
        (record) => !record.automatic || record.sessionId === command.sessionId,
      );
      return {
        management: {
          kind: "checkpoints",
          title: "Rollback checkpoint",
          description: "Enter restores workspace files and the linked conversation boundary.",
          items: records.map((record) => ({
            id: record.id,
            label: record.label,
            description: `${new Date(record.createdAt).toLocaleString()} · ${record.automatic ? "automatic turn" : "manual"}`,
            command: `/rollback ${record.id}`,
          })),
        },
      };
    }
    const id = words.find((word) => !word.startsWith("-"));
    if (!id) throw new Error("Usage: /rollback <checkpoint-id> [--files-only] [--force]");
    const record = await manager.rollback(context.cwd, id, words.includes("--force"));
    if (words.includes("--files-only") || record.sessionId !== command.sessionId || record.messageCount === undefined) {
      return { message: `Restored workspace checkpoint ${record.id}: ${record.label}` };
    }
    const session = new SessionStore({ configDir: context.configDir, cwd: context.cwd, sessionId: command.sessionId });
    const state = await session.readState();
    if (record.messageCount > state.messages.length) throw new Error("Checkpoint conversation boundary is newer than the session transcript");
    const messages = state.messages.slice(0, record.messageCount);
    await session.appendRewindBoundary(messages);
    await context.resetSession(command.sessionId, "resume");
    return {
      resetSession: true,
      resumeSession: messages.length > 0,
      sessionId: command.sessionId,
      restoredTranscript: conversationDisplayTranscript(messages),
      restoredInputHistory: sessionInputHistory(messages),
      permissionMode: context.currentPermissionMode(),
      message: `Restored checkpoint ${record.id}: ${record.label}. Workspace and conversation were rewound together.`,
    };
  }
  if (command.name === "copy") {
    requireNoCommandArgument(command);
    const state = await readInteractiveSessionState(context, command.sessionId);
    const text = [...state.messages].reverse().find((message) => message.role === "assistant")?.content
      .filter((block) => block.type === "text").map((block) => block.text).join("");
    if (!text) return { message: "No assistant response is available to copy." };
    return { message: "Copied the latest assistant response.", clipboardText: text };
  }
  if (command.name === "vim") {
    const argument = command.argument.trim().toLowerCase();
    if (!argument) {
      return { message: `Vim input mode is ${context.currentVimMode() ? "enabled" : "disabled"}.` };
    }
    if (argument !== "on" && argument !== "off") throw new Error("Usage: /vim [on|off]");
    const enabled = argument === "on";
    await context.updateUiSettings({ vimMode: enabled });
    return { vimMode: enabled, message: `Vim input mode ${enabled ? "enabled" : "disabled"}.` };
  }
  if (command.name === "theme") {
    const argument = command.argument.trim().toLowerCase();
    if (!argument) return { message: `Current theme: ${context.currentTheme()}.` };
    if (argument !== "magenta" && argument !== "cyan" && argument !== "blue" && argument !== "green") {
      throw new Error("Usage: /theme [magenta|cyan|blue|green]");
    }
    await context.updateUiSettings({ theme: argument });
    return { theme: argument, message: `Theme changed to ${argument}.` };
  }
  if (command.name === "skills") {
    if (command.argument.trim().toLowerCase() === "reload") {
      await context.refreshExtensions(true);
      return { message: "Reloaded Skills, Agents, commands, and Plugin contributions." };
    }
    const settings = await loadSettings({ configDir: context.configDir, cwd: context.cwd });
    const plugins = await loadConfiguredPlugins(context.configDir, context.cwd, settings.enabledPlugins);
    const skills = await loadSkills([
      { directory: join(context.configDir, "skills"), source: "user" },
      { directory: join(context.cwd, ".tnb", "skills"), source: "project" },
      ...plugins.plugins.filter((plugin) => plugin.active).map((plugin) => ({ directory: plugin.skillsDir, source: "plugin" as const })),
    ], bundledSkills());
    if (command.argument) {
      const skill = skills.find((item) => item.name.toLowerCase() === command.argument.toLowerCase());
      if (!skill) throw new Error(`Unknown skill: ${command.argument}`);
      return { message: [
        `${skill.name} (${skill.source})`,
        skill.description,
        `Allowed tools: ${skill.allowedTools?.join(", ") ?? "inherit"}`,
        `Keywords: ${skill.keywords?.join(", ") ?? "none"}`,
        `Directory: ${skill.baseDir}`,
      ].join("\n") };
    }
    return { management: {
      kind: "skills",
      title: "Skills",
      description: "Select a Skill to inspect its source and tool policy.",
      items: skills.map((skill) => ({
        id: skill.name,
        label: skill.name,
        description: `${skill.source} · ${skill.description}`,
        command: `/skills ${skill.name}`,
      })),
    } };
  }
  if (command.name === "plugins") {
    const [action, name] = splitCommandWords(command.argument);
    if (action === "reload") {
      if (name) throw new Error("Usage: /plugins reload");
      await context.refreshExtensions(true);
      await context.reloadMcp();
      return { message: "Reloaded plugin contributions and MCP connections." };
    }
    if (action === "enable" || action === "disable" || action === "update" || action === "remove" || action === "trust" || action === "untrust") {
      if (!name) throw new Error(`Usage: /plugins ${action} <name>`);
      const settings = await loadSettings({ configDir: context.configDir, cwd: context.cwd });
      const all = await loadConfiguredPlugins(context.configDir, context.cwd, {});
      const plugin = all.plugins.find((item) => item.name.toLowerCase() === name.toLowerCase());
      if (!plugin) throw new Error(`Unknown plugin: ${name}`);
      let output = "";
      let error = "";
      const code = await runResourceListCommand({
        argv: [
          "plugins", action, plugin.name,
          ...(action === "remove" || action === "trust" || action === "untrust" ? ["--yes"] : []),
          ...(plugin.source === "project" ? ["--project"] : []),
        ],
        env: context.env,
        cwd: context.cwd,
        configDir: context.configDir,
        stdout: { write: (text) => void (output += text) },
        stderr: { write: (text) => void (error += text) },
      });
      if (code !== 0) throw new Error(error.trim().replace(/^tnb:\s*/, "") || `Plugin ${action} failed`);
      await context.refreshExtensions();
      await context.reloadMcp();
      return { message: output.trim() };
    }
    if (action) throw new Error("Usage: /plugins [enable|disable|trust|untrust|update|remove <name>|reload]");
    const settings = await loadSettings({ configDir: context.configDir, cwd: context.cwd });
    const all = await loadConfiguredPlugins(context.configDir, context.cwd, {});
    return { management: {
      kind: "plugins",
      title: "Plugins",
      description: "Enter trusts changed/untrusted content, otherwise toggles persisted enablement.",
      items: all.plugins.map((plugin) => {
        const configured = settings.enabledPlugins?.[plugin.name] ?? settings.enabledPlugins?.[plugin.name.toLowerCase()];
        const active = plugin.active;
        const requiresTrust = plugin.trust === "untrusted" || plugin.trust === "changed";
        return {
          id: plugin.name,
          label: plugin.name,
          description: `${plugin.version ?? "unversioned"} · ${plugin.source} · ${plugin.trust} · ${active ? "active" : "inactive"} · ${plugin.lifecycle.activation}/${plugin.lifecycle.start}/${plugin.lifecycle.reload} · ${plugin.description ?? plugin.root}`,
          command: `/plugins ${requiresTrust ? "trust" : active ? "disable" : "enable"} ${plugin.name}`,
          active,
          badges: [plugin.trust, configured === false ? "disabled" : "enabled"],
        };
      }),
    } };
  }
  if (command.name === "marketplace") {
    const [action, value] = splitCommandWords(command.argument);
    if (action === "install") {
      if (!value) throw new Error("Usage: /marketplace install <name>");
      let output = "";
      let error = "";
      const code = await runResourceListCommand({
        argv: ["plugins", "install", value, "--marketplace"],
        env: context.env,
        cwd: context.cwd,
        configDir: context.configDir,
        stdout: { write: (text) => void (output += text) },
        stderr: { write: (text) => void (error += text) },
      });
      if (code !== 0) throw new Error(error.trim().replace(/^tnb:\s*/, "") || "Plugin installation failed");
      await context.refreshExtensions();
      return { message: output.trim() };
    }
    const query = action === "search" ? value?.toLowerCase() : command.argument.trim().toLowerCase();
    const sources = await configuredMarketplaceSources(context.configDir, context.env);
    if (!sources.length) return { message: "No plugin marketplace configured. Set TNB_PLUGIN_MARKETPLACE or ~/.tnb/marketplaces.json." };
    const result = await loadPluginMarketplace(sources);
    const plugins = query
      ? result.plugins.filter((plugin) => `${plugin.name} ${plugin.description ?? ""}`.toLowerCase().includes(query))
      : result.plugins;
    return { management: {
      kind: "marketplace",
      title: "Plugin Marketplace",
      description: result.errors.length ? `${result.errors.length} catalog source(s) failed; Enter installs the selected plugin.` : "Enter installs the selected plugin.",
      items: plugins.map((plugin) => ({
        id: `${plugin.marketplace}:${plugin.name}`,
        label: `${plugin.name} · ${plugin.version}`,
        description: `${plugin.marketplace} · ${plugin.description ?? plugin.repository}`,
        command: `/marketplace install ${plugin.name}`,
        badges: [
          ...(plugin.tags ?? []),
          ...((plugin.capabilities ?? []).map((capability) => `cap:${capability}`)),
        ],
        details: [
          ...(plugin.whenToUse ? [`When to use: ${plugin.whenToUse}`] : []),
          ...(plugin.tags?.length ? [`Tags: ${plugin.tags.join(", ")}`] : []),
          ...(plugin.capabilities?.length ? [`Capabilities: ${plugin.capabilities.join(", ")}`] : []),
          `Repository: ${plugin.repository}`,
          ...(plugin.documentationUrl ? [`Docs: ${plugin.documentationUrl}`] : []),
        ],
      })),
    } };
  }
  if (command.name === "security") {
    const mode = command.argument.trim().toLowerCase();
    if (mode && mode !== "all" && mode !== "staged") throw new Error("Usage: /security [all|staged]");
    const result = await scanSecurity({
      cwd: context.cwd,
      ...(mode === "all" ? { all: true } : {}),
      ...(mode === "staged" ? { staged: true } : {}),
    });
    return { management: {
      kind: "security",
      title: `Security Review · ${result.findings.length} finding(s)`,
      description: `${result.scannedFiles} file(s) · ${result.scope.mode} · ${result.rules.total} rule(s)`,
      items: result.findings.map((finding, index) => ({
        id: `${finding.rule}:${finding.path}:${finding.line}:${index}`,
        label: `[${finding.severity}/${finding.confidence}] ${finding.rule}`,
        description: `${finding.path}:${finding.line} · ${finding.message} Fix: ${finding.remediation}`,
        command: `/security ${mode}`.trim(),
      })),
    } };
  }
  if (command.name === "security-settings") {
    const words = splitCommandWords(command.argument);
    const settings = await loadSettings({ configDir: context.configDir, cwd: context.cwd });
    if (!words.length) {
      const trusted = settings.security?.trustedFolders ?? [];
      return { message: [
        "Security settings",
        "",
        `YOLO disabled: ${settings.security?.disableYolo === true || settings.permissions?.disableBypassPermissionsMode === "disable" ? "yes" : "no"}`,
        `Current workspace trusted: ${trusted.some((folder) => resolve(folder) === resolve(context.cwd)) ? "yes" : "no"}`,
        "Trusted folders:",
        ...(trusted.length ? trusted.map((folder) => `- ${folder}`) : ["- none"]),
        `Sandbox: ${settings.tools?.sandbox ? JSON.stringify(settings.tools.sandbox) : "off"}`,
      ].join("\n") };
    }
    const [action, value, ...pathParts] = words;
    if (action !== "yolo" || !value) {
      throw new Error("Usage: /security-settings [yolo on|off|trust <directory>|untrust <directory>]");
    }
    let key: string;
    let jsonValue: string;
    let confirmation: string;
    if (value === "on" || value === "off") {
      key = "security.disableYolo";
      jsonValue = value === "on" ? "false" : "true";
      confirmation = `YOLO mode is now ${value === "on" ? "available when explicitly selected" : "disabled by user policy"}.`;
    } else if (value === "trust" || value === "untrust") {
      if (!pathParts.length) throw new Error(`Usage: /security-settings yolo ${value} <directory>`);
      const target = resolve(context.cwd, unquoteCommandArgument(pathParts.join(" ")));
      const trusted = settings.security?.trustedFolders ?? [];
      const next = value === "trust"
        ? [...new Set([...trusted, target])]
        : trusted.filter((folder) => resolve(folder) !== target);
      key = "security.trustedFolders";
      jsonValue = JSON.stringify(next);
      confirmation = `${value === "trust" ? "Trusted" : "Untrusted"} workspace: ${target}`;
    } else {
      throw new Error("Usage: /security-settings [yolo on|off|trust <directory>|untrust <directory>]");
    }
    let stdout = "";
    let stderr = "";
    const code = await runConfigCommand({
      argv: ["config", "set", key, jsonValue],
      env: context.env,
      cwd: context.cwd,
      configDir: context.configDir,
      stdout: { write: (text) => void (stdout += text) },
      stderr: { write: (text) => void (stderr += text) },
    });
    if (code !== 0) throw new Error(stderr.trim().replace(/^tnb:\s*/, "") || "Security setting update failed");
    if (key === "security.disableYolo") context.updateSecurityPolicy({ disableYolo: JSON.parse(jsonValue) as boolean });
    else context.updateSecurityPolicy({ trustedFolders: JSON.parse(jsonValue) as string[] });
    return { message: confirmation };
  }
  if (command.name === "ide") {
    requireNoCommandArgument(command);
    const descriptors = await readIdeDescriptors(join(context.configDir, "ide"));
    return { management: {
      kind: "ide",
      title: "IDE Bridges",
      description: "Local Unix-socket discovery descriptors; start one with tnb remote-control --socket ~/.tnb/ide/editor.sock.",
      items: descriptors.map((descriptor) => ({
        id: descriptor.path,
        label: `${descriptor.active ? "active" : "stale"} · PID ${descriptor.pid ?? "?"}`,
        description: `${descriptor.workspace ?? "unknown workspace"} · ${descriptor.socketPath ?? descriptor.path}`,
        command: "/ide",
        active: descriptor.active,
      })),
    } };
  }
  if (command.name === "hooks") {
    const settings = await loadSettings({ configDir: context.configDir, cwd: context.cwd });
    const plugins = await loadConfiguredPlugins(context.configDir, context.cwd, settings.enabledPlugins);
    const hooks = mergePluginHooks(settings.hooks, await loadPluginHooks(plugins.plugins));
    const rows = Object.entries(hooks).flatMap(([event, groups]) => (groups ?? []).flatMap((group, groupIndex) =>
      group.hooks.map((hook, hookIndex) => ({ event, group, groupIndex, hook, hookIndex }))
    ));
    if (command.argument) {
      const [event, groupIndex, hookIndex] = command.argument.split(":");
      const row = rows.find((item) => item.event === event && item.groupIndex === Number(groupIndex) && item.hookIndex === Number(hookIndex));
      if (!row) throw new Error(`Unknown Hook entry: ${command.argument}`);
      return { message: JSON.stringify({ event: row.event, matcher: row.group.matcher ?? "*", sequential: row.group.sequential ?? false, async: row.group.async ?? false, handler: row.hook }, null, 2) };
    }
    return { management: {
      kind: "hooks",
      title: "Hooks",
      description: "Select a handler to inspect its effective merged configuration.",
      items: rows.map((row) => ({
        id: `${row.event}:${row.groupIndex}:${row.hookIndex}`,
        label: `${row.event} · ${row.hook.type}`,
        description: `${row.group.matcher ?? "*"} · ${row.hook.name ?? (row.hook.type === "command" ? row.hook.command : row.hook.type === "http" ? row.hook.url : row.hook.prompt.slice(0, 80))}`,
        command: `/hooks ${row.event}:${row.groupIndex}:${row.hookIndex}`,
      })),
    } };
  }
  if (command.name === "agents") {
    const query = command.argument.toLowerCase();
    if (query) {
      const profile = context.agentProfiles.find(({ name }) => name.toLowerCase() === query);
      if (!profile) throw new Error(`Unknown agent: ${command.argument}`);
      return {
        message: [
          `${profile.name} (${profile.source})`,
          profile.description,
          `Tools: ${profile.tools?.join(", ") ?? "all available tools"}`,
          ...(profile.disallowedTools?.length
            ? [`Disallowed tools: ${profile.disallowedTools.join(", ")}`]
            : []),
          `Model: ${profile.model ?? "inherit"}`,
          `Permission mode: ${profile.permissionMode ?? "inherit"}`,
          `Max turns: ${profile.maxTurns ?? DEFAULT_SUBAGENT_MAX_TURNS}`,
          ...(profile.filePath ? [`Definition: ${profile.filePath}`] : []),
        ].join("\n"),
      };
    }
    return { management: {
      kind: "agents",
      title: "Agents",
      description: context.agentLoadErrors.length ? `${context.agentLoadErrors.length} definition error(s); inspect stderr with tnb agents.` : "Select an Agent profile to inspect its policy.",
      items: context.agentProfiles.map((profile) => ({
        id: profile.name,
        label: profile.name,
        description: `${profile.source} · ${profile.description}`,
        command: `/agents ${profile.name}`,
      })),
    } };
  }
  if (command.name === "sessions") {
    const sessions = await SessionStore.list({
      configDir: context.configDir,
      cwd: context.cwd,
    });
    const query = command.argument.toLowerCase();
    const filtered = query
      ? sessions.filter((session) =>
          session.sessionId.toLowerCase().includes(query) ||
          session.title?.toLowerCase().includes(query) ||
          session.summary?.toLowerCase().includes(query) ||
          session.strategicIntent?.toLowerCase().includes(query) ||
          session.firstPrompt?.toLowerCase().includes(query) ||
          session.lastPrompt?.toLowerCase().includes(query)
        )
      : sessions;
    return {
      management: {
        kind: "sessions",
        title: query ? `Sessions matching “${command.argument}”` : "Recent sessions",
        description: "Select a conversation to resume. Rename and fork commands operate on the active session.",
        items: await Promise.all(filtered.slice(0, 20).filter((session) => !session.error).map(async (session) => ({
          id: session.sessionId,
          label: session.title || session.firstPrompt || session.sessionId,
          description: `${session.sessionId} · ${session.messageCount} messages · ${new Date(session.lastModified).toLocaleString()}${session.summary ? ` · ${session.summary}` : session.lastPrompt && session.lastPrompt !== session.firstPrompt ? ` · ${session.lastPrompt}` : ""}`,
          ...(session.userInputs?.length ? { preview: sessionInputPreview(session.userInputs) } : {}),
          transcriptPreview: conversationDisplayTranscript((await new SessionStore({ configDir: context.configDir, cwd: context.cwd, sessionId: session.sessionId }).readState()).messages),
          command: `/resume ${session.sessionId}`,
          active: session.sessionId === command.sessionId,
        }))),
      },
      ...(filtered.some((session) => session.error)
        ? { message: formatSessionList(filtered.filter((session) => session.error), command.sessionId, query) }
        : {}),
    };
  }
  if (command.name === "rename") {
    const title = unquoteCommandArgument(command.argument).trim();
    if (!title) throw new Error("Usage: /rename <title>");
    const session = new SessionStore({
      configDir: context.configDir,
      cwd: context.cwd,
      sessionId: command.sessionId,
    });
    await session.setTitle(title);
    return { message: `Session renamed to: ${title}` };
  }
  if (command.name === "fork") {
    const source = new SessionStore({
      configDir: context.configDir,
      cwd: context.cwd,
      sessionId: command.sessionId,
    });
    const state = await source.readState();
    if (!state.messages.length) throw new Error("Cannot fork an empty session");
    const fork = await source.forkTo(command.nextSessionId);
    const title = unquoteCommandArgument(command.argument).trim();
    if (title) await fork.setTitle(title);
    await context.resetSession(command.nextSessionId, "resume");
    return {
      resetSession: true,
      resumeSession: true,
      sessionId: command.nextSessionId,
      restoredTranscript: conversationDisplayTranscript(state.messages),
      restoredInputHistory: sessionInputHistory(state.messages),
      permissionMode: context.currentPermissionMode(),
      message: `Forked session ${command.sessionId} to ${command.nextSessionId}${title ? ` as ${title}` : ""}.`,
    };
  }
  if (command.name === "session-rename") {
    const { sessionId, rest } = parseSessionManagementArgument(command.argument, "/session-rename <session-id> <title>");
    const title = unquoteCommandArgument(rest).trim();
    if (!title) throw new Error("Usage: /session-rename <session-id> <title>");
    await new SessionStore({ configDir: context.configDir, cwd: context.cwd, sessionId }).setTitle(title);
    return { message: `Session ${sessionId} renamed to: ${title}` };
  }
  if (command.name === "session-fork") {
    const { sessionId: sourceId, rest } = parseSessionManagementArgument(command.argument, "/session-fork <session-id> [title]");
    const source = new SessionStore({ configDir: context.configDir, cwd: context.cwd, sessionId: sourceId });
    const state = await source.readState();
    if (!state.messages.length) throw new Error("Cannot fork an empty session");
    const fork = await source.forkTo(command.nextSessionId);
    const title = unquoteCommandArgument(rest).trim();
    if (title) await fork.setTitle(title);
    await context.resetSession(command.nextSessionId, "resume");
    return {
      resetSession: true, resumeSession: true, sessionId: command.nextSessionId,
      restoredTranscript: conversationDisplayTranscript(state.messages),
      restoredInputHistory: sessionInputHistory(state.messages),
      permissionMode: context.currentPermissionMode(),
      message: `Forked session ${sourceId} to ${command.nextSessionId}${title ? ` as ${title}` : ""}.`,
    };
  }
  if (command.name === "session-delete") {
    const { sessionId, rest } = parseSessionManagementArgument(command.argument, "/session-delete <session-id> --confirm");
    if (sessionId === command.sessionId) throw new Error("Cannot delete the active session");
    if (rest.trim() !== "--confirm") throw new Error("Deleting a session requires --confirm");
    await new SessionStore({ configDir: context.configDir, cwd: context.cwd, sessionId }).delete();
    return { message: `Deleted session ${sessionId}.` };
  }
  if (command.name === "resume") {
    if (!command.argument) {
      const sessions = await SessionStore.list({
        configDir: context.configDir,
        cwd: context.cwd,
        limit: 20,
      });
      return {
        management: {
          kind: "sessions",
          title: "Resume session",
          description: "Select a conversation or run /resume with an exact ID or unambiguous prefix.",
          items: sessions.filter((session) => !session.error).map((session) => ({
            id: session.sessionId,
            label: session.title || session.firstPrompt || session.sessionId,
            description: `${session.sessionId} · ${session.messageCount} messages · ${new Date(session.lastModified).toLocaleString()}`,
            ...(session.userInputs?.length ? { preview: sessionInputPreview(session.userInputs) } : {}),
            command: `/resume ${session.sessionId}`,
            active: session.sessionId === command.sessionId,
          })),
        },
      };
    }
    const sessionId = await resolveSessionId(context, command.argument);
    if (sessionId === command.sessionId) {
      return { message: `Session ${sessionId} is already active.` };
    }
    return resumeInteractiveSession(sessionId, context);
  }
  if (command.name === "continue") {
    requireNoCommandArgument(command);
    const sessions = await SessionStore.list({
      configDir: context.configDir,
      cwd: context.cwd,
    });
    const latest = sessions.find((session) => !session.error && session.sessionId !== command.sessionId);
    if (!latest) return { message: "No other session is available to continue." };
    return resumeInteractiveSession(latest.sessionId, context);
  }
  if (command.name === "export") {
    const session = new SessionStore({
      configDir: context.configDir,
      cwd: context.cwd,
      sessionId: command.sessionId,
    });
    let state: Awaited<ReturnType<SessionStore["readState"]>>;
    try {
      state = await session.readState();
    } catch (error) {
      if (isMissingFileError(error)) {
        return { message: "The current session has no conversation to export." };
      }
      throw error;
    }
    const path = await exportConversation({
      cwd: context.cwd,
      messages: state.messages,
      ...(command.argument ? { filename: unquoteCommandArgument(command.argument) } : {}),
    });
    return { message: `Conversation exported to ${path}.` };
  }
  if (command.name === "compact") {
    requireNoCommandArgument(command);
    const session = new SessionStore({
      configDir: context.configDir,
      cwd: context.cwd,
      sessionId: command.sessionId,
    });
    let state: Awaited<ReturnType<SessionStore["readState"]>>;
    try {
      state = await session.readState();
    } catch (error) {
      if (isMissingFileError(error)) {
        return { message: "The current session has no conversation to compact." };
      }
      throw error;
    }
    const { model } = context.currentSelection();
    const summarize = createTransportSummarizer({
      transport: context.currentTransport(),
      model: model.id,
    });
    const result = await compactConversation({
      messages: state.messages,
      thresholdTokens: 1,
      summarize: async (messages, signal) => {
        await context.currentHooks().run("PreCompact", {
          trigger: "manual",
          custom_instructions: null,
        }, signal);
        const summary = await summarize(messages, signal);
        await context.currentHooks().run("PostCompact", {
          trigger: "manual",
          compact_summary: summary,
        }, signal);
        await context.currentHooks().start("compact", model.id, signal);
        return summary;
      },
    });
    if (!result.compacted) {
      return { message: "The current session is too short to compact." };
    }
    await session.appendCompactBoundary({
      messages: result.messages,
      preTokens: result.preTokens,
      postTokens: result.postTokens,
      permissionMode: context.currentPermissionMode(),
    });
    return {
      message: `Compacted ${result.preTokens.toLocaleString()} estimated tokens to ${result.postTokens.toLocaleString()}.`,
    };
  }
  if (command.name === "clear") {
    requireNoCommandArgument(command);
    await context.resetSession(command.nextSessionId, "clear");
    return {
      resetSession: true,
      message: `Started new session ${command.nextSessionId}.`,
    };
  }
  throw new Error(`Command /${command.name} is handled by the interface`);
}

function formatInteractiveModels(
  catalog: ProviderCatalog,
  current: ProviderSelection,
): string {
  return Object.values(catalog.providers).flatMap((provider) => [
    `${provider.name} (${provider.id})`,
    ...provider.models.map((model) =>
      `  ${provider.id}/${model.id}${
        provider.id === current.provider.id && model.id === current.model.id ? "  ← current" : ""
      }`
    ),
  ]).join("\n");
}

async function resolveSessionId(
  context: InteractiveSlashCommandContext,
  argument: string,
): Promise<string> {
  const query = argument.trim();
  if (!query || /\s/.test(query)) throw new Error("Usage: /resume <session-id or prefix>");
  const sessions = await SessionStore.list({
    configDir: context.configDir,
    cwd: context.cwd,
  });
  const exact = sessions.find((session) => session.sessionId === query);
  if (exact) return exact.sessionId;
  const matches = sessions.filter((session) => session.sessionId.startsWith(query));
  if (matches.length === 0) throw new Error(`Session '${query}' was not found in this workspace`);
  if (matches.length > 1) {
    throw new Error(`Session prefix '${query}' matches ${matches.length} sessions; enter more characters`);
  }
  return matches[0]!.sessionId;
}

export async function createResumeManagement(
  configDir: string,
  cwd: string,
): Promise<ManagementView> {
  const sessions = await SessionStore.list({ configDir, cwd, limit: 20 });
  return {
    kind: "sessions",
    title: "Resume session",
    description: sessions.some((session) => !session.error)
      ? "Select a conversation to resume. Press Esc to start a new session instead."
      : "No resumable sessions were found. Press Esc to start a new session.",
    items: sessions.filter((session) => !session.error).map((session) => ({
      id: session.sessionId,
      label: session.title || session.firstPrompt || session.sessionId,
      description: `${session.sessionId} · ${session.messageCount} messages · ${new Date(session.lastModified).toLocaleString()}`,
      ...(session.userInputs?.length ? { preview: sessionInputPreview(session.userInputs) } : {}),
      command: `/resume ${session.sessionId}`,
    })),
  };
}

function parseSessionManagementArgument(argument: string, usage: string): { sessionId: string; rest: string } {
  const trimmed = argument.trim();
  const separator = trimmed.search(/\s/);
  const sessionId = separator < 0 ? trimmed : trimmed.slice(0, separator);
  if (!sessionId) throw new Error(`Usage: ${usage}`);
  return { sessionId, rest: separator < 0 ? "" : trimmed.slice(separator).trim() };
}

function sessionInputPreview(inputs: string[]): string[] {
  return inputs.slice(-5).map((input) => input.length > 240 ? `${input.slice(0, 239)}…` : input);
}

async function resumeInteractiveSession(
  sessionId: string,
  context: InteractiveSlashCommandContext,
): Promise<SlashCommandResult> {
  const session = new SessionStore({
    configDir: context.configDir,
    cwd: context.cwd,
    sessionId,
  });
  const state = await session.readState();
  if (state.messages.length === 0) throw new Error(`Session ${sessionId} has no conversation`);
  if (state.permissionMode) context.switchPermissionMode(state.permissionMode);
  await context.resetSession(sessionId, "resume");
  return {
    resetSession: true,
    resumeSession: true,
    sessionId,
    restoredTranscript: conversationDisplayTranscript(state.messages),
    restoredInputHistory: sessionInputHistory(state.messages),
    permissionMode: context.currentPermissionMode(),
    message: `Resumed session ${sessionId}${state.title ? ` (${state.title})` : ""}.`,
  };
}

function conversationDisplayTranscript(
  messages: ConversationMessage[],
): NonNullable<SlashCommandResult["restoredTranscript"]> {
  const transcript: NonNullable<SlashCommandResult["restoredTranscript"]> = [];
  const tools = new Map<string, number>();
  let sequence = 0;
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "text" && block.text) {
        transcript.push(message.role === "assistant"
          ? { id: `restored-${sequence}`, sequence, revision: 0, kind: "assistant", text: block.text, streaming: false }
          : { id: `restored-${sequence}`, sequence, revision: 0, kind: "user", text: block.text });
        sequence += 1;
      } else if (message.role === "assistant" && block.type === "tool-use") {
        tools.set(block.id, transcript.length);
        transcript.push({
          id: `tool-${block.id}`,
          sequence,
          revision: 0,
          kind: "tool",
          toolUseId: block.id,
          name: block.name,
          input: block.input,
          status: "running",
        });
        sequence += 1;
      } else if (message.role === "user" && block.type === "tool-result") {
        const index = tools.get(block.toolUseId);
        const entry = index === undefined ? undefined : transcript[index];
        if (index !== undefined && entry?.kind === "tool") {
          transcript[index] = {
            ...entry,
            revision: entry.revision + 1,
            status: block.isError ? "failed" : "completed",
            output: block.content,
          };
        }
      }
    }
  }
  return transcript;
}

function formatSessionList(
  sessions: Awaited<ReturnType<typeof SessionStore.list>>,
  currentSessionId: string,
  query = "",
): string {
  if (sessions.length === 0) {
    return query ? `No sessions match '${query}'.` : "No sessions found for this workspace.";
  }
  return [
    "Recent sessions",
    "",
    ...sessions.map((session) => {
      const marker = session.sessionId === currentSessionId ? "*" : " ";
      const date = new Date(session.lastModified).toLocaleString();
      const summary = session.error
        ? `[unreadable: ${session.error}]`
        : truncateSessionSummary(session.title ?? session.summary ?? session.lastPrompt ?? session.firstPrompt ?? "Empty conversation");
      return `${marker} ${session.sessionId}  ${date}  ${summary}`;
    }),
  ].join("\n");
}

function truncateSessionSummary(value: string): string {
  return value.length > 80 ? `${value.slice(0, 79)}…` : value;
}

function formatByteCount(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"] as const;
  let value = bytes / 1_024;
  let unit: (typeof units)[number] = units[0];
  for (let index = 1; index < units.length && value >= 1_024; index += 1) {
    value /= 1_024;
    unit = units[index]!;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

type StoredMcpOAuthRecord = {
  serverName: string;
  serverUrl: string;
  authorizationServerUrl: string;
  clientId: string;
  clientSecret?: string;
  redirectUri?: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope?: string;
};

async function loadMcpOAuthServers(path: string): Promise<Map<string, StoredMcpOAuthRecord>> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return new Map();
    const servers = (value as { servers?: unknown }).servers;
    if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return new Map();
    return new Map(
      Object.entries(servers).flatMap(([key, record]) =>
        typeof record === "object" && record !== null && !Array.isArray(record)
          ? [[key, record as StoredMcpOAuthRecord]]
          : []
      ),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return new Map();
    }
    throw error;
  }
}

function mcpOAuthStorageKey(serverName: string, serverUrl: string): string {
  return createHash("sha256").update(`${serverName}\0${serverUrl}`).digest("hex");
}

function parseTaskUpdate(value: Record<string, unknown>): TaskUpdate {
  const update: TaskUpdate = {};
  if (value.subject !== undefined) update.subject = requiredStreamString(value.subject, "task_update subject");
  if (value.description !== undefined) update.description = requiredStreamString(value.description, "task_update description");
  if (value.activeForm !== undefined) update.activeForm = requiredStreamString(value.activeForm, "task_update activeForm");
  if (value.owner !== undefined) update.owner = requiredStreamString(value.owner, "task_update owner");
  if (value.status !== undefined) {
    const status = requiredStreamString(value.status, "task_update status");
    if (!["pending", "in_progress", "completed", "deleted"].includes(status)) {
      throw new Error("task_update status must be pending, in_progress, completed, or deleted");
    }
    update.status = status as TaskUpdate["status"];
  }
  if (value.addBlocks !== undefined) update.addBlocks = requiredStreamStringArray(value.addBlocks, "task_update addBlocks");
  if (value.addBlockedBy !== undefined) update.addBlockedBy = requiredStreamStringArray(value.addBlockedBy, "task_update addBlockedBy");
  if (value.metadata !== undefined) update.metadata = streamRecord(value.metadata, "task_update metadata");
  if (Object.keys(update).length === 0) throw new Error("task_update requires at least one field to update");
  return update;
}

function unquoteCommandArgument(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function resolveInteractiveModel(
  catalog: ProviderCatalog,
  input: string,
): ProviderSelection {
  const requested = input.trim();
  if (!requested || /\s/.test(requested)) {
    throw new Error("Usage: /model [provider/model | model]");
  }
  const directMatches = Object.values(catalog.providers).flatMap((provider) =>
    provider.models
      .filter((model) => model.id === requested)
      .map((model) => ({ provider, model })),
  );
  if (directMatches.length === 1) return directMatches[0]!;
  if (directMatches.length > 1) {
    throw new Error(`Model '${requested}' exists in multiple providers; use provider/model`);
  }
  for (const provider of Object.values(catalog.providers)) {
    const prefix = `${provider.id}/`;
    if (!requested.startsWith(prefix)) continue;
    return resolveProviderSelection(catalog, provider.id, requested.slice(prefix.length));
  }
  const provider = catalog.providers[requested];
  if (provider) return resolveProviderSelection(catalog, provider.id);
  throw new Error(`Unknown configured model: ${requested}`);
}

function resolveFastModeSelection(
  catalog: ProviderCatalog,
  current: ProviderSelection,
): ProviderSelection {
  if (
    current.provider.api === "anthropic-messages" &&
    current.model.id.toLowerCase().replace(/\[1m\]$/, "").includes("opus-4-6")
  ) return current;
  const sameProvider = current.provider.api === "anthropic-messages"
    ? current.provider.models.find((model) => model.id.toLowerCase().replace(/\[1m\]$/, "").includes("opus-4-6"))
    : undefined;
  if (sameProvider) return { provider: current.provider, model: sameProvider };
  return resolveProviderSelection(catalog, "anthropic", "claude-opus-4-6");
}

function interactiveImageGenerationAvailable(context: InteractiveSlashCommandContext): boolean {
  const selection = context.currentSelection();
  const providerId = context.env.TNB_IMAGE_PROVIDER ?? (
    selection.provider.api.startsWith("openai-") ? selection.provider.id : "openai"
  );
  const provider = context.providerCatalog.providers[providerId];
  if (!provider?.api.startsWith("openai-")) return false;
  return Boolean(
    context.env.TNB_IMAGE_API_KEY || provider.apiKey ||
    context.env.TNB_IMAGE_PROVIDER !== undefined || providerId === selection.provider.id
  );
}

function requireNoCommandArgument(command: SlashCommandRequest): void {
  if (command.argument) throw new Error(`/${command.name} does not accept arguments`);
}

async function readInteractiveSessionState(
  context: InteractiveSlashCommandContext,
  sessionId: string,
) {
  try {
    return await new SessionStore({
      configDir: context.configDir,
      cwd: context.cwd,
      sessionId,
    }).readState();
  } catch (error) {
    if (isMissingFileError(error)) return { messages: [] as ConversationMessage[] };
    throw error;
  }
}

function stripInteractiveRuntimeOptions(argv: string[]): string[] {
  const optionsWithValues = new Set([
    "--provider",
    "--model",
    "--thinking",
    "--permission-mode",
    "--resume",
    "-r",
    "--session-id",
    "--name",
    "-n",
    "--fallback-model",
    "--attachment",
    "-a",
  ]);
  const optionsWithMultipleValues = new Set(["--add-dir", "--mcp-config", "--tools"]);
  const flags = new Set(["--continue", "--fork-session", "--yolo", "--dangerously-skip-permissions", "--strict-mcp-config", "-p", "--print"]);
  flags.add("--fast");
  const result: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (optionsWithValues.has(argument)) {
      if (argv[index + 1] && !argv[index + 1]!.startsWith("-")) index += 1;
      continue;
    }
    if (optionsWithMultipleValues.has(argument)) {
      while (index + 1 < argv.length && !argv[index + 1]!.startsWith("-")) index += 1;
      continue;
    }
    if (flags.has(argument)) {
      if ((argument === "-p" || argument === "--print") && argv[index + 1]) index += 1;
      continue;
    }
    result.push(argument);
  }
  return result;
}

function taskStatePath(configDir: string, sessionId: string): string {
  return join(configDir, "tasks", sessionId, "task-state.json");
}

async function readStreamContextUsage(options: {
  configDir: string;
  cwd: string;
  env: Record<string, string | undefined>;
  sessionId: string;
  provider?: string;
  model?: string;
}) {
  const state: SessionState = await new SessionStore({
    configDir: options.configDir,
    cwd: options.cwd,
    sessionId: options.sessionId,
  }).readState().catch((error) => {
    if (isMissingFileError(error)) return { messages: [] as ConversationMessage[] };
    throw error;
  });
  const catalog = await loadProviderCatalog({ configDir: options.configDir, env: options.env });
  const selection = resolveProviderSelection(catalog, options.provider ?? "anthropic", options.model);
  const estimatedTokens = estimateConversationTokens(state.messages);
  return {
    sessionId: options.sessionId,
    provider: selection.provider.id,
    model: selection.model.id,
    estimatedTokens,
    contextWindow: selection.model.contextWindow,
    remainingTokens: Math.max(0, selection.model.contextWindow - estimatedTokens),
    usage: state.usage ?? EMPTY_USAGE,
  };
}

function teamStatePath(configDir: string, sessionId: string): string {
  return join(configDir, "teams", `${sessionId}.json`);
}

function hookConfigFiles(configDir: string) {
  return [
    { path: join(configDir, "settings.json"), source: "user_settings" as const },
    { path: join(".tnb", "settings.json"), source: "project_settings" as const },
    { path: join(".tnb", "settings.local.json"), source: "local_settings" as const },
  ];
}

function goalStatePath(configDir: string, sessionId: string): string {
  return join(configDir, "goals", `${sessionId}.json`);
}

function splitCommandWords(input: string): string[] {
  return input.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map(unquoteCommandArgument) ?? [];
}

function parseGoalSetArguments(words: string[]): { objective: string; maxTurns?: number } {
  const objectiveParts: string[] = [];
  let maxTurns: number | undefined;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    if (word === "--turns") {
      const raw = words[index + 1];
      if (!raw || !/^\d+$/.test(raw) || Number(raw) <= 0) {
        throw new Error("/goal set --turns requires a positive integer");
      }
      maxTurns = Number(raw);
      index += 1;
      continue;
    }
    objectiveParts.push(word);
  }
  const objective = objectiveParts.join(" ").trim();
  if (!objective) throw new Error("Usage: /goal set <objective> [--turns N]");
  return { objective, ...(maxTurns === undefined ? {} : { maxTurns }) };
}

function formatGoal(goal: ReturnType<GoalManager["current"]>): string {
  if (!goal) return "No goal exists for this session.";
  return [
    `Goal: ${goal.objective}`,
    `Status: ${goal.status}`,
    `Turns: ${goal.turnsUsed}/${goal.maxTurns}`,
    `Time: ${goal.timeUsedSeconds}s`,
  ].join("\n");
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function requestPermissionThroughHooks(
  hooks: HookRunner,
  request: PermissionAskRequest,
  signal?: AbortSignal,
): Promise<
  | { behavior: "allow"; updatedInput?: unknown }
  | { behavior: "deny"; message: string }
  | { behavior: "ask" }
> {
  await notifyHooks(hooks, request.message, "Permission required", "permission_prompt", signal);
  const result = await hooks.run("PermissionRequest", {
    tool_name: request.tool.name,
    tool_input: request.input,
    permission_suggestions: [],
  }, signal);
  if (result.permissionDecision === "allow") {
    return {
      behavior: "allow",
      ...(result.updatedInput !== undefined ? { updatedInput: result.updatedInput } : {}),
    };
  }
  if (result.permissionDecision === "deny" || result.blocked) {
    return { behavior: "deny", message: result.reason ?? "Permission denied by hook" };
  }
  return { behavior: "ask" };
}

async function notifyHooks(
  hooks: HookRunner,
  message: string,
  title: string,
  notificationType:
    | "permission_prompt"
    | "elicitation_dialog"
    | "elicitation_response"
    | "elicitation_complete",
  signal?: AbortSignal,
): Promise<void> {
  await hooks.run("Notification", {
    message,
    title,
    notification_type: notificationType,
  }, signal);
}

async function notifyElicitationComplete(
  hooks: HookRunner,
  serverName: string,
  elicitationId: string,
  signal?: AbortSignal,
): Promise<void> {
  await notifyHooks(
    hooks,
    `MCP server "${serverName}" confirmed elicitation ${elicitationId} complete`,
    "Elicitation complete",
    "elicitation_complete",
    signal,
  );
}

async function askUserWithNotifications(
  hooks: HookRunner,
  askUser: AskUser,
  question: Parameters<AskUser>[0],
  signal: AbortSignal,
): Promise<string> {
  await notifyHooks(hooks, question.question, question.header, "elicitation_dialog", signal);
  const answer = await askUser(question, signal);
  await notifyHooks(
    hooks,
    "Question response: accept",
    "Elicitation response",
    "elicitation_response",
    signal,
  );
  return answer;
}

function createHookedMcpElicitationHandler(options: {
  hooks(): HookRunner;
  serverName: string;
  authorize: PermissionChecker;
  askUser?: AskUser;
}) {
  return createMcpElicitationHandler({
    serverName: options.serverName,
    authorize: options.authorize,
    ...(options.askUser ? { askUser: options.askUser } : {}),
    async onRequest(context, signal) {
      const hooks = options.hooks();
      await notifyHooks(
        hooks,
        context.message,
        `MCP input from ${context.serverName}`,
        "elicitation_dialog",
        signal,
      );
      const result = await hooks.run("Elicitation", elicitationRequestPayload(context), signal);
      if (result.elicitationResponse) return result.elicitationResponse;
      if (result.blocked) return { action: "decline" };
      return undefined;
    },
    async onResult(context, response, signal) {
      const hooks = options.hooks();
      const result = await hooks.run("ElicitationResult", {
        mcp_server_name: context.serverName,
        ...(context.elicitationId ? { elicitation_id: context.elicitationId } : {}),
        mode: context.mode,
        action: response.action,
        ...(response.action === "accept" && response.content ? { content: response.content } : {}),
      }, signal);
      const resolved = result.elicitationResponse ?? (result.blocked ? { action: "decline" as const } : response);
      await notifyHooks(
        hooks,
        `Elicitation response for server "${context.serverName}": ${resolved.action}`,
        "Elicitation response",
        "elicitation_response",
        signal,
      );
      return resolved;
    },
  });
}

function elicitationRequestPayload(context: McpElicitationContext): Record<string, unknown> {
  return {
    mcp_server_name: context.serverName,
    message: context.message,
    mode: context.mode,
    ...(context.url ? { url: context.url } : {}),
    ...(context.elicitationId ? { elicitation_id: context.elicitationId } : {}),
    ...(context.requestedSchema ? { requested_schema: context.requestedSchema } : {}),
  };
}

function createTools(
  cwd: WorkspaceRootSource,
  env: Record<string, string | undefined>,
  shellManager: ShellSessionManager,
  mediaCapabilities: { supportsVision: boolean; supportsPdf: boolean },
  taskManager: TaskManager,
  goalManager: GoalManager,
  scheduleManager: ScheduleManager | undefined,
  providerCatalog: ProviderCatalog,
  selectedProviderId: string,
  askUser?: AskUser,
  initialTodos: TodoItem[] = [],
  memory?: AutoMemoryStore,
  pluginTools: ReadonlySet<string> = new Set(),
  codebaseCacheDirectory?: string,
  additionalWorkspaceRoots: () => string[] = () => [],
  semanticProviderForRoot?: Parameters<typeof createCodebaseInvestigatorTool>[4],
): AgentTool[] {
  const approvedRoots = () => [...additionalWorkspaceRoots(), ...(memory?.enabled ? [memory.directory] : [])];
  const readFileState = createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE);
  const tools: AgentTool[] = [
    createReadTool(cwd, mediaCapabilities, approvedRoots, readFileState),
    createWriteTool(cwd, approvedRoots, readFileState),
    createEditTool(cwd, approvedRoots, readFileState),
    createNotebookEditTool(cwd, additionalWorkspaceRoots),
    ...createShellTools(shellManager, env),
    createGrepTool(cwd, {}, additionalWorkspaceRoots),
    createGlobTool(cwd, {}, additionalWorkspaceRoots),
    createCodebaseInvestigatorTool(
      cwd,
      codebaseCacheDirectory,
      createCodebaseEmbeddings(env, providerCatalog, selectedProviderId),
      additionalWorkspaceRoots,
      semanticProviderForRoot,
    ),
    createWebFetchTool(),
    createTodoWriteTool({ initialTodos }),
    createAskUserQuestionTool({ ...(askUser ? { askUser } : {}) }),
    ...createTaskTools(taskManager),
    ...createGoalTools(goalManager),
    ...(pluginTools.has("builtin:security_scan") ? [createSecurityScanTool(cwd)] : []),
    ...(scheduleManager ? createSchedulerTools(scheduleManager, shellManager) : []),
  ];
  if (env.BRAVE_SEARCH_API_KEY) {
    tools.push(
      createWebSearchTool({
        apiKey: env.BRAVE_SEARCH_API_KEY,
        ...(env.BRAVE_SEARCH_BASE_URL ? { baseUrl: env.BRAVE_SEARCH_BASE_URL } : {}),
      }),
      createImageSearchTool({
        apiKey: env.BRAVE_SEARCH_API_KEY,
        ...(env.BRAVE_IMAGE_SEARCH_BASE_URL
          ? { baseUrl: env.BRAVE_IMAGE_SEARCH_BASE_URL }
          : {}),
      }),
    );
  }
  const imageProviderId = env.TNB_IMAGE_PROVIDER ?? (
    providerCatalog.providers[selectedProviderId]?.api.startsWith("openai-")
      ? selectedProviderId
      : "openai"
  );
  const imageProvider = providerCatalog.providers[imageProviderId];
  const imageProviderExplicitlySelected = env.TNB_IMAGE_PROVIDER !== undefined;
  if (
    imageProvider?.api.startsWith("openai-") &&
    (imageProvider.apiKey || imageProviderExplicitlySelected || imageProviderId === selectedProviderId)
  ) {
    tools.push(createImageGenerateTool(cwd, {
      ...(env.TNB_IMAGE_API_KEY || imageProvider.apiKey
        ? { apiKey: env.TNB_IMAGE_API_KEY ?? imageProvider.apiKey }
        : {}),
      baseUrl: env.TNB_IMAGE_BASE_URL ?? imageProvider.baseUrl,
      model: env.TNB_IMAGE_MODEL ?? "gpt-image-2",
      headers: imageProvider.headers,
    }, additionalWorkspaceRoots));
  }
  return tools;
}

function createCodebaseEmbeddings(
  env: Record<string, string | undefined>,
  providerCatalog: ProviderCatalog,
  selectedProviderId: string,
) {
  const model = env.TNB_CODEBASE_EMBEDDING_MODEL;
  if (!model) return undefined;
  const providerId = env.TNB_CODEBASE_EMBEDDING_PROVIDER ?? selectedProviderId;
  const provider = providerCatalog.providers[providerId];
  if (!provider) throw new Error(`Unknown codebase embedding provider: ${providerId}`);
  if (!provider.api.startsWith("openai-")) {
    throw new Error(`Codebase embeddings require an OpenAI-compatible provider: ${providerId}`);
  }
  return createOpenAIEmbeddingProvider({
    id: providerId,
    baseUrl: env.TNB_CODEBASE_EMBEDDING_BASE_URL ?? provider.baseUrl,
    model,
    ...(env.TNB_CODEBASE_EMBEDDING_API_KEY || provider.apiKey
      ? { apiKey: env.TNB_CODEBASE_EMBEDDING_API_KEY ?? provider.apiKey }
      : {}),
    headers: provider.headers,
  });
}

async function readIdeDescriptors(directory: string): Promise<Array<{
  path: string;
  socketPath?: string;
  pid?: number;
  workspace?: string;
  active: boolean;
}>> {
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const descriptors = [];
  for (const name of names.sort()) {
    const path = join(directory, name);
    try {
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      const socketPath = typeof record.socketPath === "string" ? record.socketPath : undefined;
      const pid = typeof record.pid === "number" && Number.isInteger(record.pid) ? record.pid : undefined;
      const socketActive = socketPath ? (await stat(socketPath).catch(() => undefined))?.isSocket() === true : false;
      let processActive = false;
      if (pid) {
        try {
          process.kill(pid, 0);
          processActive = true;
        } catch {
          processActive = false;
        }
      }
      descriptors.push({
        path,
        ...(socketPath ? { socketPath } : {}),
        ...(pid ? { pid } : {}),
        ...(typeof record.cwd === "string" ? { workspace: record.cwd } : {}),
        active: socketActive && processActive,
      });
    } catch {
      // IDE discovery files are runtime-owned, derived descriptors. Malformed
      // entries are excluded from the management view without mutating them.
    }
  }
  return descriptors;
}

function latestTodos(messages: ConversationMessage[]): TodoItem[] {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (message?.role !== "assistant") continue;
    for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = message.content[blockIndex];
      if (block?.type !== "tool-use" || block.name !== "todo_write") continue;
      try {
        const validated = createTodoWriteTool().validate(block.input) as { todos: TodoItem[] };
        return validated.todos.every(({ status }) => status === "completed") ? [] : validated.todos;
      } catch {
        // Assistant tool inputs are persisted before execution. An invalid call never
        // became active todo state, so there is no session state to restore from it.
        return [];
      }
    }
  }
  return [];
}

function policyForTool(tool: AgentTool): ToolPolicy {
  return {
    name: tool.name,
    risk: tool.access,
    isReadOnly: tool.isReadOnly,
    ...(tool.requiresApproval ? { requiresApproval: tool.requiresApproval } : {}),
    ...(tool.permissionRuleContent
      ? { permissionRuleContent: tool.permissionRuleContent }
      : {}),
  };
}

export function parseArguments(
  argv: string[],
  env: Record<string, string | undefined>,
  options: { allowBareResume?: boolean } = {},
): ParsedArguments {
  const printIndex = argv.findIndex((argument) => argument === "-p" || argument === "--print");
  const prompt = printIndex >= 0 ? argv[printIndex + 1] : undefined;
  if (!prompt) throw new Error('print mode requires -p "<prompt>"');

  const providerValue = optionValue(argv, "--provider") ?? env.TNB_PROVIDER;
  const model =
    optionValue(argv, "--model") ??
    env.TNB_MODEL;
  const thinking = normalizeThinking(
    optionValue(argv, "--thinking") ?? env.TNB_THINKING,
  );
  const fastMode = argv.includes("--fast") || isTruthyEnvironmentValue(env.TNB_FAST_MODE);

  const permissionModeValue = optionValue(argv, "--permission-mode");
  const yolo = argv.includes("--yolo") || argv.includes("--dangerously-skip-permissions");
  if (yolo && permissionModeValue && permissionModeValue !== "yolo" && permissionModeValue !== "bypassPermissions" && permissionModeValue !== "bypass") {
    throw new Error("--yolo/--dangerously-skip-permissions cannot be combined with another permission mode");
  }
  const permissionMode = normalizePermissionMode(yolo ? "yolo" : permissionModeValue);
  const resumeNames = ["--resume", "-r"];
  const resumeMatches = resumeNames.filter((name) => argv.includes(name));
  if (resumeMatches.length > 1) throw new Error("--resume and -r cannot be used together");
  const resumeName = resumeMatches[0];
  const resumePicker = options.allowBareResume === true && resumeName !== undefined && optionHasNoValue(argv, resumeName);
  const resume = resumePicker || !resumeName ? undefined : optionValue(argv, resumeName);
  const continueLatest = argv.includes("--continue");
  const sessionId = optionValue(argv, "--session-id");
  const forkSession = argv.includes("--fork-session");
  if ((resume || resumePicker) && continueLatest) {
    throw new Error("--resume and --continue cannot be used together");
  }
  if (forkSession && resumePicker) {
    throw new Error("--fork-session requires an explicit --resume <session-id>");
  }
  if (forkSession && !resume && !continueLatest) {
    throw new Error("--fork-session requires --resume or --continue");
  }
  if (sessionId && (resume || continueLatest) && !forkSession) {
    throw new Error("--session-id can only be combined with --resume or --continue when --fork-session is used");
  }
  const outputFormatValue = optionValue(argv, "--output-format") ?? "text";
  if (outputFormatValue !== "text" && outputFormatValue !== "json" && outputFormatValue !== "stream-json") {
    throw new Error("--output-format must be one of: text, json, stream-json");
  }
  const worktree = parseWorktreeArgument(argv);
  const maxTurns = positiveInteger(optionValue(argv, "--max-turns"), "--max-turns");
  const maxBudgetUsd = positiveNumber(
    optionValue(argv, "--max-budget-usd") ?? env.TNB_MAX_BUDGET_USD,
    "--max-budget-usd",
  );
  const fallbackModel = optionValue(argv, "--fallback-model") ?? env.TNB_FALLBACK_MODEL;
  const jsonSchemaValue = optionValue(argv, "--json-schema");
  const includeHookEvents = argv.includes("--include-hook-events");
  const includePartialMessages = argv.includes("--include-partial-messages");
  if ((includeHookEvents || includePartialMessages) && outputFormatValue !== "stream-json") {
    throw new Error(`${includeHookEvents ? "--include-hook-events" : "--include-partial-messages"} requires --output-format stream-json`);
  }
  const init = argv.includes("--init") || argv.includes("--init-only");
  const maintenance = argv.includes("--maintenance");
  if (init && maintenance) throw new Error("--init and --maintenance cannot be combined");
  const systemPrompt = optionValue(argv, "--system-prompt");
  const systemPromptFile = optionValue(argv, "--system-prompt-file");
  const appendSystemPrompt = optionValue(argv, "--append-system-prompt");
  const appendSystemPromptFile = optionValue(argv, "--append-system-prompt-file");
  if (systemPrompt && systemPromptFile) throw new Error("--system-prompt and --system-prompt-file cannot be combined");
  if (appendSystemPrompt && appendSystemPromptFile) {
    throw new Error("--append-system-prompt and --append-system-prompt-file cannot be combined");
  }
  const sessionName = optionValueFromAliases(argv, ["--name", "-n"])?.trim();
  const settingsInput = optionValue(argv, "--settings");
  const agentsJson = optionValue(argv, "--agents");
  const agent = optionValue(argv, "--agent")?.trim();
  if (hasOption(argv, "--agent") && !agent) throw new Error("--agent requires a non-empty name");
  if (hasOption(argv, "--name") || hasOption(argv, "-n")) {
    if (!sessionName) throw new Error("--name requires a non-empty value");
  }
  const toolSelection = hasOption(argv, "--tools")
    ? normalizeToolSelection(optionValuesVariadic(argv, ["--tools"], true))
    : undefined;
  return {
    prompt,
    ...(providerValue ? { provider: providerValue } : {}),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    fastMode,
    ...(permissionMode ? { permissionMode } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(resume ? { resume } : {}),
    resumePicker,
    continueLatest,
    forkSession,
    ...(sessionName ? { sessionName } : {}),
    additionalDirectories: optionValuesVariadic(argv, ["--add-dir"]),
    mcpConfigs: optionValuesVariadic(argv, ["--mcp-config"]),
    strictMcpConfig: argv.includes("--strict-mcp-config"),
    ...(toolSelection !== undefined ? { tools: toolSelection } : {}),
    ...(settingsInput ? { settingsInput } : {}),
    ...(agentsJson ? { agentsJson } : {}),
    ...(agent ? { agent } : {}),
    outputFormat: outputFormatValue,
    attachmentPaths: optionValues(argv, ["--attachment", "-a"]),
    worktree,
    sandbox: argv.includes("--sandbox") || argv.includes("-s"),
    ...(maxTurns ? { maxTurns } : {}),
    ...(maxBudgetUsd ? { maxBudgetUsd } : {}),
    ...(fallbackModel ? { fallbackModel } : {}),
    ...(jsonSchemaValue ? { jsonSchema: parseStructuredOutputSchema(jsonSchemaValue) } : {}),
    includeHookEvents,
    includePartialMessages,
    ...(init ? { setupTrigger: "init" as const } : maintenance ? { setupTrigger: "maintenance" as const } : {}),
    initOnly: argv.includes("--init-only"),
    allowedTools: splitOptionValues(optionValues(argv, ["--allowed-tools", "--allowedTools"])),
    disallowedTools: splitOptionValues(optionValues(argv, ["--disallowed-tools", "--disallowedTools"])),
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(systemPromptFile ? { systemPromptFile } : {}),
    ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
    ...(appendSystemPromptFile ? { appendSystemPromptFile } : {}),
  };
}

async function loadPromptFiles(parsed: ParsedArguments, cwd: string): Promise<void> {
  if (parsed.systemPromptFile) parsed.systemPrompt = await readFile(resolve(cwd, parsed.systemPromptFile), "utf8");
  if (parsed.appendSystemPromptFile) {
    parsed.appendSystemPrompt = await readFile(resolve(cwd, parsed.appendSystemPromptFile), "utf8");
  }
}

function applyAdditionalWorkspaceRoots(workspace: WorkspaceState, directories: readonly string[]): void {
  for (const directory of directories) workspace.addRoot(directory);
}

function normalizeToolSelection(values: string[]): string[] | undefined {
  const tools = splitOptionValues(values);
  if (tools.length === 1 && tools[0]?.toLowerCase() === "default") return undefined;
  if (tools.some((tool) => tool.toLowerCase() === "default")) {
    throw new Error('--tools "default" cannot be combined with named tools');
  }
  return tools;
}

function selectCliTools(tools: AgentTool[], selected: string[] | undefined): AgentTool[] {
  if (selected === undefined) return tools;
  const requested = new Set(selected.map((name) => name.toLowerCase()));
  const known = new Set(tools.map((tool) => tool.name.toLowerCase()));
  for (const name of requested) {
    if (!known.has(name)) throw new Error(`Unknown tool in --tools: ${name}`);
  }
  return tools.filter((tool) => requested.has(tool.name.toLowerCase()));
}

async function resolveRuntimeMcpConfig(options: {
  parsed: Pick<ParsedArguments, "mcpConfigs" | "strictMcpConfig">;
  configDir: string;
  cwd: string;
  env: Record<string, string | undefined>;
  plugin: McpConfig;
}): Promise<McpConfig> {
  if (options.parsed.strictMcpConfig && options.parsed.mcpConfigs.length === 0) {
    throw new Error("--strict-mcp-config requires --mcp-config");
  }
  const dynamic = await loadMcpConfigInputs(options.parsed.mcpConfigs, options.cwd, options.env);
  if (options.parsed.strictMcpConfig) return dynamic;
  const configured = await loadMcpConfig(
    options.env.TNB_MCP_CONFIG ?? join(options.configDir, "mcp.json"),
    options.env,
  );
  return mergePluginMcpConfig(mergeMcpConfigs(configured, dynamic), options.plugin);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function assertSessionIdAvailable(configDir: string, cwd: string, sessionId: string): Promise<void> {
  const session = new SessionStore({ configDir, cwd, sessionId });
  if (await pathExists(session.filePath)) throw new Error(`Session ID ${sessionId} is already in use`);
}

export async function prepareInteractiveSession(options: {
  parsed: ParsedArguments;
  configDir: string;
  cwd: string;
  sessionIdFactory: () => string;
}): Promise<{ sessionId: string; resume: boolean; state?: SessionState }> {
  const sourceSessionId = options.parsed.continueLatest
    ? await SessionStore.latestSessionId({ configDir: options.configDir, cwd: options.cwd })
    : options.parsed.resume;
  if (options.parsed.continueLatest && !sourceSessionId) {
    throw new Error("No previous session found for this workspace");
  }
  if (options.parsed.forkSession) {
    const targetSessionId = options.parsed.sessionId ?? options.sessionIdFactory();
    await assertSessionIdAvailable(options.configDir, options.cwd, targetSessionId);
    const source = new SessionStore({ configDir: options.configDir, cwd: options.cwd, sessionId: sourceSessionId! });
    const target = await source.forkTo(targetSessionId);
    if (options.parsed.sessionName) await target.setTitle(options.parsed.sessionName);
    return { sessionId: targetSessionId, resume: true, state: await target.readState() };
  }
  if (sourceSessionId) {
    const source = new SessionStore({
      configDir: options.configDir,
      cwd: options.cwd,
      sessionId: sourceSessionId,
    });
    return { sessionId: sourceSessionId, resume: true, state: await source.readState() };
  }
  const sessionId = options.parsed.sessionId ?? options.sessionIdFactory();
  if (options.parsed.sessionId) await assertSessionIdAvailable(options.configDir, options.cwd, sessionId);
  return { sessionId, resume: false };
}

function stripSessionBootstrapOptions(argv: string[]): string[] {
  const result: string[] = [];
  const valueOptions = new Set(["--resume", "-r", "--session-id", "--name", "-n"]);
  const flags = new Set(["--continue", "--fork-session"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (valueOptions.has(argument)) {
      if (argv[index + 1] && !argv[index + 1]!.startsWith("-")) index += 1;
      continue;
    }
    if (flags.has(argument)) continue;
    result.push(argument);
  }
  return result;
}

function filterCliTools(tools: AgentTool[], allowed: string[], disallowed: string[]): AgentTool[] {
  const allow = new Set(allowed.map((name) => name.toLowerCase()));
  const deny = new Set(disallowed.map((name) => name.toLowerCase()));
  const known = new Set(tools.map((tool) => tool.name.toLowerCase()));
  for (const name of [...allow, ...deny]) {
    if (!known.has(name)) throw new Error(`Unknown tool in CLI filter: ${name}`);
  }
  return tools.filter((tool) => (allow.size === 0 || allow.has(tool.name.toLowerCase())) && !deny.has(tool.name.toLowerCase()));
}

function resolveDeferredToolThreshold(
  env: Record<string, string | undefined>,
  toolCount: number,
): number | undefined {
  const configured = env.TNB_DEFERRED_TOOL_THRESHOLD;
  if (configured !== undefined) {
    if (configured.toLowerCase() === "off" || configured === "0") return undefined;
    return positiveInteger(configured, "TNB_DEFERRED_TOOL_THRESHOLD");
  }
  return toolCount > 48 ? 32 : undefined;
}

function createHookModelHandler(options: {
  transport: ModelTransport;
  model: string;
  tools: AgentTool[];
  authorize?: PermissionChecker;
  systemPrompt?: string | (() => string);
}) {
  return async (hook: HookPrompt | HookAgent, input: Record<string, unknown>, signal?: AbortSignal) => {
    const requested = hook.type === "agent"
      ? hook.tools ?? ["read", "grep", "glob"]
      : [];
    const requestedNames = new Set(requested.map((name) => name.toLowerCase()));
    const tools = hook.type === "agent"
      ? options.tools.filter((tool) => requestedNames.has(tool.name.toLowerCase()))
      : [];
    const missing = requested.filter((name) => !tools.some((tool) => tool.name.toLowerCase() === name.toLowerCase()));
    if (missing.length) throw new Error(`Hook requested unavailable tools: ${missing.join(", ")}`);
    const eventJson = JSON.stringify(input, null, 2);
    const prompt = `${hook.prompt.replaceAll("$ARGUMENTS", eventJson)}\n\nHook event JSON:\n${eventJson}\n\nReturn one JSON object: {"ok":true} or {"ok":false,"reason":"..."}.`;
    const result = await runAgentLoop({
      transport: options.transport,
      model: options.model,
      prompt,
      ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
      tools,
      authorize: (tool, toolInput) => options.authorize
        ? options.authorize(policyForTool(tool), toolInput, signal)
        : Promise.resolve({ behavior: "deny" as const, message: "Hook evaluator tools are unavailable during startup" }),
      ...(hook.type === "agent" && hook.maxTurns ? { maxTurns: hook.maxTurns } : { maxTurns: 4 }),
      ...(signal ? { signal } : {}),
    });
    return lastAssistantText(result.messages);
  };
}

function lazyModelTransport(factory: () => ModelTransport): ModelTransport {
  let transport: ModelTransport | undefined;
  return {
    stream(request, signal) {
      transport ??= factory();
      return transport.stream(request, signal);
    },
  };
}

function splitOptionValues(values: string[]): string[] {
  return [...new Set(values.flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean))];
}

function parseWorktreeArgument(argv: string[]): boolean | string {
  const worktreeIndex = argv.findIndex((argument) => argument === "--worktree" || argument === "-w");
  const branch = optionValue(argv, "--branch");
  if (worktreeIndex < 0) {
    if (branch) throw new Error("--branch requires --worktree");
    return false;
  }
  const following = argv[worktreeIndex + 1];
  const inlineName = following && !following.startsWith("-") ? following : undefined;
  if (inlineName && branch && inlineName !== branch) {
    throw new Error("--worktree name and --branch must match when both are provided");
  }
  return inlineName ?? branch ?? true;
}

function normalizeThinking(
  value: string | undefined,
): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
  if (value === undefined) return undefined;
  if (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }
  throw new Error("--thinking must be one of: off, minimal, low, medium, high, xhigh");
}

function isTruthyEnvironmentValue(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function normalizeSkillEffort(
  effort: import("../services/skills/loader").SkillEffort | undefined,
  inherited: ReasoningEffort | undefined,
): ReasoningEffort | undefined {
  if (effort === undefined || effort === "auto") return inherited;
  if (effort === "max") return "xhigh";
  if (typeof effort === "number") {
    if (effort <= 1) return "low";
    if (effort <= 3) return "medium";
    if (effort <= 6) return "high";
    return "xhigh";
  }
  return effort;
}

function expandSkillInvocation(input: string, skills: readonly LoadedSkill[]): string | undefined {
  const match = input.trim().match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) return undefined;
  const skill = skills.find((candidate) =>
    candidate.userInvocable !== false && (
      candidate.name.toLowerCase() === match[1]!.toLowerCase() ||
      candidate.aliases?.some((alias) => alias.toLowerCase() === match[1]!.toLowerCase())
    )
  );
  if (!skill) return undefined;
  const argumentsText = match[2]?.trim() ?? "";
  if (skill.context !== "fork") return renderSkillPrompt(skill, argumentsText);
  return [
    `Invoke the \`${skill.name}\` skill now through the skill tool.`,
    `Pass these arguments exactly: ${JSON.stringify(argumentsText)}`,
    "Return the skill agent's result as the response to the user.",
  ].join("\n");
}

function normalizePermissionMode(value: string | undefined): PermissionMode | undefined {
  if (value === undefined) return undefined;
  if (value === "yolo" || value === "bypass" || value === "bypassPermissions") {
    return "bypassPermissions";
  }
  if (
    value === "default" ||
    value === "acceptEdits" ||
    value === "auto" ||
    value === "dontAsk" ||
    value === "plan"
  ) {
    return value;
  }
  throw new Error(
    "--permission-mode must be one of: default, acceptEdits, auto, dontAsk, plan, yolo, bypassPermissions",
  );
}

function optionValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) throw new Error(`${name} requires a value`);
  return value;
}

function optionHasNoValue(argv: string[], name: string): boolean {
  const index = argv.indexOf(name);
  if (index < 0) return false;
  const value = argv[index + 1];
  return value === undefined || value.startsWith("-");
}

function optionValueFromAliases(argv: string[], names: string[]): string | undefined {
  const matches = names.filter((name) => argv.includes(name));
  if (matches.length > 1) throw new Error(`${names.join(" and ")} cannot be used together`);
  return matches[0] ? optionValue(argv, matches[0]) : undefined;
}

function optionValues(argv: string[], names: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (!names.includes(argv[index]!)) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argv[index]} requires a value`);
    values.push(value);
    index += 1;
  }
  return values;
}

function optionValuesVariadic(argv: string[], names: string[], allowEmpty = false): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (!names.includes(argv[index]!)) continue;
    let found = false;
    while (index + 1 < argv.length && !argv[index + 1]!.startsWith("-")) {
      const value = argv[index + 1]!;
      if (!allowEmpty && value.length === 0) throw new Error(`${argv[index]} requires a value`);
      values.push(value);
      found = true;
      index += 1;
    }
    if (!found) throw new Error(`${argv[index]} requires a value`);
  }
  return values;
}

function hasOption(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function positiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function positiveNumber(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

async function runBlockingHook(
  hooks: HookRunner,
  event: HookEvent,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<void> {
  const result = await hooks.run(event, payload, signal);
  if (result.blocked) throw new Error(result.reason ?? `${event} hook blocked the operation`);
}

function attachTaskHooks(
  taskManager: TaskManager,
  hooks: () => HookRunner,
  signal?: AbortSignal,
): void {
  const runTaskHook = (event: "TaskCreated" | "TaskCompleted", task: TaskRecord) =>
    runBlockingHook(hooks(), event, {
      task_id: task.id,
      task_subject: task.subject,
      ...(task.description ? { task_description: task.description } : {}),
    }, signal);
  taskManager.setLifecycleHooks({
    beforeCreate: (task) => runTaskHook("TaskCreated", task),
    beforeComplete: (task) => runTaskHook("TaskCompleted", task),
  });
}

function isTeamTool(name: string): boolean {
  return name === "send_message" || name === "complete_task";
}

async function drainTeamContext(
  manager: TeamManager,
  teamName: string,
  recipient: string,
): Promise<string[]> {
  const content = formatTeamMessages(await manager.drain(teamName, recipient));
  return content ? [content] : [];
}

function withPermissionDeniedHooks(
  checker: PermissionChecker,
  hooks: () => HookRunner,
): PermissionChecker {
  return async (tool, input, signal) => {
    const decision = await checker(tool, input, signal);
    if (decision.behavior === "deny") {
      await hooks().run("PermissionDenied", {
        tool_name: tool.name,
        tool_input: input,
        tool_use_id: randomUUID(),
        reason: decision.message,
      }, signal);
    }
    return decision;
  };
}

async function authorizeToolWithDeniedHook(
  checker: PermissionChecker,
  hooks: HookRunner,
  tool: AgentTool,
  input: unknown,
  toolUseId: string,
  signal?: AbortSignal,
) {
  const policy = policyForTool(tool);
  const decision = await checker(policy, input, signal);
  if (decision.behavior === "deny") {
    await hooks.run("PermissionDenied", {
      tool_name: tool.name,
      tool_input: input,
      tool_use_id: toolUseId,
      reason: decision.message,
    }, signal);
  }
  return decision;
}

async function authorizeToolWithDeniedHooks(
  checker: PermissionChecker,
  hookRunners: HookRunner[],
  tool: AgentTool,
  input: unknown,
  toolUseId: string,
  signal?: AbortSignal,
) {
  const policy = policyForTool(tool);
  const decision = await checker(policy, input, signal);
  if (decision.behavior === "deny") {
    await Promise.all(hookRunners.map((runner) => runner.run("PermissionDenied", {
      tool_name: tool.name,
      tool_input: input,
      tool_use_id: toolUseId,
      reason: decision.message,
    }, signal)));
  }
  return decision;
}

function finalAssistantText(messages: ConversationMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (text) return text;
  }
  throw new Error("Subagent completed without a text result");
}

function lastAssistantText(messages: ConversationMessage[]): string {
  try {
    return finalAssistantText(messages);
  } catch {
    return "";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatMcpLogMessage(message: McpLogMessage): string {
  const logger = message.logger ? `:${message.logger}` : "";
  const data = typeof message.data === "string"
    ? message.data
    : JSON.stringify(message.data) ?? String(message.data);
  return `tnb mcp [${message.serverName}:${message.level}${logger}] ${data}`;
}

function formatMcpProgressEvent(event: McpProgressEvent): string {
  const amount = event.total === undefined ? `${event.progress}` : `${event.progress}/${event.total}`;
  return `tnb mcp [${event.serverName}:progress] ${amount}${event.message ? ` · ${event.message}` : ""}`;
}

function formatMcpCancelledEvent(event: McpCancelledEvent): string {
  const request = event.requestId === undefined ? "" : ` request ${event.requestId}`;
  return `tnb mcp [${event.serverName}:cancelled]${request}${event.reason ? ` · ${event.reason}` : ""}`;
}

function isPartialModelEvent(event: ModelEvent): boolean {
  return event.type === "text" ||
    event.type === "thinking" ||
    event.type === "thinking-signature" ||
    event.type === "tool-input";
}

function classifyStopFailure(error: unknown):
  | "authentication_failed"
  | "billing_error"
  | "rate_limit"
  | "invalid_request"
  | "server_error"
  | "unknown"
  | "max_output_tokens" {
  if (error instanceof ProviderStreamError) return error.category;
  if (!(error instanceof ProviderHttpError)) return "unknown";
  if (error.status === 401 || error.status === 403) return "authentication_failed";
  if (error.status === 402) return "billing_error";
  if (error.status === 429) return "rate_limit";
  if (error.status >= 500) return "server_error";
  if (error.status >= 400) return "invalid_request";
  return "unknown";
}

function isProviderFailure(error: unknown): boolean {
  return error instanceof ProviderHttpError ||
    error instanceof ProviderStreamError ||
    error instanceof TypeError;
}

function writeHookExecutionEvent(
  writer: Writer,
  sessionId: string,
  event: HookExecutionEvent,
): void {
  const base = {
    type: "system",
    subtype: event.type === "started"
      ? "hook_started"
      : event.type === "progress"
        ? "hook_progress"
        : "hook_response",
    hook_id: event.hookId,
    hook_name: event.hookName,
    hook_event: event.hookEvent,
    uuid: randomUUID(),
    session_id: sessionId,
  };
  writer.write(`${JSON.stringify(event.type === "started" ? base : { ...base, ...(
    event.type === "progress"
      ? { stdout: event.stdout, stderr: event.stderr, output: event.output }
      : {
          stdout: event.stdout,
          stderr: event.stderr,
          output: event.output,
          ...(event.exitCode !== undefined ? { exit_code: event.exitCode } : {}),
          outcome: event.outcome,
        }
  ) })}\n`);
}

if (import.meta.main) {
  setupGracefulShutdown();
  const suppliedArgv = Bun.argv.slice(2);
  const remoteControlSocket = suppliedArgv[0] === "remote-control"
    ? optionValue(suppliedArgv, "--socket")
    : undefined;
  const argv = suppliedArgv[0] === "remote-control" && !remoteControlSocket
    ? ["-p", "remote-control", "--input-format", "stream-json", "--output-format", "stream-json", ...suppliedArgv.slice(1)]
    : suppliedArgv;
  if (argv.includes("--version") || argv.includes("-V")) {
    process.stdout.write(`${packageJson.version}\n`);
  } else if (suppliedArgv[0] === "remote-control" && (suppliedArgv.includes("--help") || suppliedArgv.includes("-h"))) {
    process.stdout.write(`Usage: tnb remote-control [--socket <path>] [--server-file <path>] [runtime options]\n\nWithout --socket, runs the bidirectional stream-json protocol over stdin/stdout.\nWith --socket, serves the same protocol to local Unix socket clients and writes a 0600 discovery descriptor beside the socket.\n`);
  } else if (suppliedArgv[0] === "remote-control" && remoteControlSocket) {
    const controller = new AbortController();
    const abort = () => controller.abort(new DOMException("Remote-control server stopped", "AbortError"));
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    const runtimeArguments = stripOptions(suppliedArgv.slice(1), new Set(["--socket", "--server-file"]));
    try {
      process.exitCode = await runRemoteControlSocketCli({
        socketPath: remoteControlSocket,
        ...(optionValue(suppliedArgv, "--server-file")
          ? { descriptorPath: optionValue(suppliedArgv, "--server-file")! }
          : {}),
        runtimeArguments,
        signal: controller.signal,
      });
    } finally {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    }
  } else if (argv.length === 0 ? false : argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    process.stdout.write(CLI_HELP);
  } else if (argv[0] === "config") {
    process.exitCode = await runConfigCommand({ argv, env: process.env, cwd: process.cwd(), stdout: process.stdout, stderr: process.stderr });
  } else if (argv[0] === "status") {
    process.exitCode = await runStatusCommand({ argv, env: process.env, cwd: process.cwd(), stdout: process.stdout, stderr: process.stderr });
  } else if (argv[0] === "doctor") {
    process.exitCode = await runDoctorCommand({ argv, env: process.env, cwd: process.cwd(), stdout: process.stdout, stderr: process.stderr });
  } else if (argv[0] === "jobs" || argv[0] === "rm") {
    process.exitCode = await runJobsCommand({ argv, env: process.env, cwd: process.cwd(), stdout: process.stdout, stderr: process.stderr });
  } else if (argv[0] === "rollback") {
    process.exitCode = await runRollbackCommand({ argv, env: process.env, cwd: process.cwd(), stdout: process.stdout, stderr: process.stderr });
  } else if (argv[0] === "goal-loop" || argv[0] === "goal-loop-stop") {
    process.exitCode = await runGoalLoopCli({ argv, env: process.env, cwd: process.cwd(), stdout: process.stdout, stderr: process.stderr });
  } else if (argv[0] === "security-scan") {
    process.exitCode = await runSecurityScanCommand({ argv, cwd: process.cwd(), stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });
  } else if (argv[0] === "feedback") {
    process.exitCode = await runFeedbackCommand({ argv, env: process.env, cwd: process.cwd(), stdout: process.stdout, stderr: process.stderr, version: packageJson.version });
  } else if (argv[0] === "update") {
    process.exitCode = await runUpdateCommand({ argv, env: process.env, stdout: process.stdout, stderr: process.stderr, currentVersion: packageJson.version, executable: process.execPath });
  } else if (argv[0] === "completion") {
    process.exitCode = runCompletionCommand({ argv, stdout: process.stdout, stderr: process.stderr });
  } else if (argv[0] === "ide") {
    const controller = new AbortController();
    const abort = () => controller.abort(new DOMException("Interrupted", "AbortError"));
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    try {
      process.exitCode = await runIdeCommand({
        argv,
        env: process.env,
        cwd: process.cwd(),
        stdout: process.stdout,
        stderr: process.stderr,
        signal: controller.signal,
      });
    } finally {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    }
  } else if (argv[0] === "provider" || argv[0] === "providers") {
    process.exitCode = await runProviderCommand({ argv, env: process.env, cwd: process.cwd(), stdout: process.stdout, stderr: process.stderr });
  } else if (["sessions", "skills", "agents", "hooks", "plugins"].includes(argv[0] ?? "")) {
    process.exitCode = await runResourceListCommand({ argv, env: process.env, cwd: process.cwd(), stdout: process.stdout, stderr: process.stderr });
  } else if (argv[0] === "mcp") {
    const controller = new AbortController();
    const abort = () => controller.abort(new DOMException("Interrupted", "AbortError"));
    process.once("SIGINT", abort);
    try {
      process.exitCode = await runMcpCommand({
        argv,
        env: process.env,
        stdout: process.stdout,
        stderr: process.stderr,
        cwd: process.cwd(),
        signal: controller.signal,
      });
    } finally {
      process.off("SIGINT", abort);
    }
  } else if (argv[0] === "models" || argv.includes("--list-models")) {
    process.exitCode = await runModelsCli({
      argv,
      env: process.env,
      stdout: process.stdout,
      stderr: process.stderr,
    });
  } else if (optionValue(argv, "--input-format") === "stream-json") {
    if (!argv.includes("-p") && !argv.includes("--print")) {
      process.stderr.write("tnb: --input-format stream-json requires --print\n");
      process.exitCode = 1;
    } else if (optionValue(argv, "--output-format") !== "stream-json") {
      process.stderr.write("tnb: --input-format stream-json requires --output-format stream-json\n");
      process.exitCode = 1;
    } else {
      const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
      try {
        process.exitCode = await runStreamJsonCli({
          argv,
          env: process.env,
          cwd: process.cwd(),
          stdout: process.stdout,
          stderr: process.stderr,
          input: lines,
        });
      } finally {
        lines.close();
      }
    }
  } else if (argv.includes("-p") || argv.includes("--print")) {
    process.exitCode = await runCli({
      argv,
      env: process.env,
      cwd: process.cwd(),
      stdout: process.stdout,
      stderr: process.stderr,
    });
  } else {
    if (argv.includes("--output-format")) {
      process.stderr.write("tnb: --output-format requires --print\n");
      process.exitCode = 1;
    } else
    if (process.stdin.isTTY && process.stdout.isTTY) {
      process.exitCode = await runInkCli({
        argv,
        env: process.env,
        cwd: process.cwd(),
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
      });
    } else {
      const readline = createInterface({ input: process.stdin, output: process.stdout });
      try {
        process.exitCode = await runInteractiveCli({
          argv,
          env: process.env,
          cwd: process.cwd(),
          stdout: process.stdout,
          stderr: process.stderr,
          question: (prompt) => readline.question(prompt),
        });
      } finally {
        readline.close();
      }
    }
  }
}

async function runRemoteControlSocketCli(options: {
  socketPath: string;
  descriptorPath?: string;
  runtimeArguments: string[];
  signal: AbortSignal;
}): Promise<number> {
  await serveRemoteControlSocket({
    socketPath: options.socketPath,
    ...(options.descriptorPath ? { descriptorPath: options.descriptorPath } : {}),
    cwd: process.cwd(),
    version: packageJson.version,
    signal: options.signal,
    onReady: (descriptor) => process.stderr.write(`tnb remote-control: ${descriptor.socketPath}\n`),
    async handleConnection(socket, descriptor) {
      const lines = createInterface({ input: socket, crlfDelay: Infinity });
      try {
        const iterator = lines[Symbol.asyncIterator]();
        const first = await iterator.next();
        if (first.done) return;
        if (isIdeJsonRpcLine(first.value)) {
          const bridge = new IdeJsonRpcBridge({
            cwd: process.cwd(),
            ownerToken: descriptor.ownerToken,
            async query(prompt, context, sessionId) {
              let output = "";
              let errorOutput = "";
              const ideContext = formatIdeContextPrompt(context, process.cwd());
              const exitCode = await runCli({
                argv: [
                  "-p",
                  ideContext ? `${prompt}\n\n${ideContext}` : prompt,
                  "--output-format", "json",
                  ...(sessionId ? ["--resume", sessionId] : []),
                  ...stripOptions(options.runtimeArguments, new Set(["--output-format", "--input-format"])),
                ],
                env: process.env,
                cwd: process.cwd(),
                stdout: { write: (text) => { output += text; } },
                stderr: { write: (text) => { errorOutput += text; } },
                signal: options.signal,
              });
              if (exitCode !== 0) throw new Error(errorOutput.trim().replace(/^tnb:\s*/, "") || "IDE agent query failed");
              return JSON.parse(output.trim());
            },
          });
          await bridge.serve(socket, prependAsync(first.value, iterator));
          return;
        }
        await runStreamJsonCli({
          argv: [
            "-p",
            "remote-control",
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            ...options.runtimeArguments,
          ],
          env: process.env,
          cwd: process.cwd(),
          stdout: { write: (text) => socket.write(text) },
          stderr: process.stderr,
          input: prependAsync(first.value, iterator),
          signal: options.signal,
        });
      } finally {
        lines.close();
      }
    },
  });
  return 0;
}

async function* prependAsync<T>(first: T, iterator: AsyncIterator<T>): AsyncGenerator<T> {
  yield first;
  for (;;) {
    const next = await iterator.next();
    if (next.done) return;
    yield next.value;
  }
}

function stripOptions(argv: string[], names: Set<string>): string[] {
  const output: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (names.has(argument)) {
      index += 1;
      continue;
    }
    output.push(argument);
  }
  return output;
}

function loadConfiguredPlugins(
  configDir: string,
  cwd: string,
  enabled: Record<string, boolean> | undefined,
) {
  return loadPlugins([
    { directory: join(configDir, "plugins"), source: "user" },
    { directory: join(cwd, ".tnb", "plugins"), source: "project" },
  ], enabled, { trustStorePath: pluginTrustStorePath(configDir) });
}
