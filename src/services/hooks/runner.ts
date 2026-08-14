import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { HookFileWatcher } from "./file-watcher";

export const HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "PreCompact",
  "PostCompact",
  "StopFailure",
  "PermissionDenied",
  "Setup",
  "TeammateIdle",
  "TaskCreated",
  "TaskCompleted",
  "Elicitation",
  "ElicitationResult",
  "ConfigChange",
  "WorktreeCreate",
  "WorktreeRemove",
  "InstructionsLoaded",
  "CwdChanged",
  "FileChanged",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];
type HookBase = { name?: string; timeout?: number; if?: string; async?: boolean };
export type HookCommand = HookBase & { type: "command"; command: string; args?: string[] };
export type HookHttp = HookBase & { type: "http"; url: string; headers?: Record<string, string> };
export type HookPrompt = HookBase & { type: "prompt"; prompt: string };
export type HookAgent = HookBase & { type: "agent"; prompt: string; tools?: string[]; maxTurns?: number };
export type HookHandler = HookCommand | HookHttp | HookPrompt | HookAgent;
export type HookMatcher = { matcher?: string; hooks: HookHandler[]; sequential?: boolean; async?: boolean };
export type HooksConfig = Partial<Record<HookEvent, HookMatcher[]>>;
export type HookModelHandler = (
  hook: HookPrompt | HookAgent,
  input: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<string | Record<string, unknown>>;
export type ConfigChangeSource = "user_settings" | "project_settings" | "local_settings" | "policy_settings" | "skills";

export type HookExecutionEvent =
  | { type: "started"; hookId: string; hookName: string; hookEvent: HookEvent }
  | { type: "progress"; hookId: string; hookName: string; hookEvent: HookEvent; stdout: string; stderr: string; output: string }
  | { type: "response"; hookId: string; hookName: string; hookEvent: HookEvent; stdout: string; stderr: string; output: string; exitCode?: number; outcome: "success" | "error" | "cancelled" };

export type HookResult = {
  blocked: boolean;
  reason?: string;
  updatedInput?: unknown;
  permissionDecision?: "allow" | "deny" | "ask";
  elicitationResponse?: {
    action: "accept" | "decline" | "cancel";
    content?: Record<string, unknown>;
  };
  context: string[];
  messages: string[];
};

export class HookRunner {
  private started = false;
  private ended = false;
  private pendingSessionContext: string[] = [];
  private cwd: string;
  private observer: ((event: HookExecutionEvent) => void) | undefined;
  private fileWatcher: HookFileWatcher | undefined;
  private configWatcher: HookFileWatcher | undefined;
  private configSuppressions = new Map<string, ReturnType<typeof setTimeout>>();
  private promptHandler: HookModelHandler | undefined;
  private agentHandler: HookModelHandler | undefined;

  constructor(private readonly options: {
    hooks?: HooksConfig;
    cwd: string;
    sessionId: string;
    env: Record<string, string | undefined>;
    configFiles?: Array<{ path: string; source: ConfigChangeSource }>;
    onError?(message: string): void;
  }) {
    this.cwd = options.cwd;
  }

  setModelHandlers(handlers: { prompt?: HookModelHandler; agent?: HookModelHandler }): void {
    this.promptHandler = handlers.prompt;
    this.agentHandler = handlers.agent;
  }

  setCwd(cwd: string): void {
    this.cwd = cwd;
    void this.fileWatcher?.setCwd(cwd);
    void this.configWatcher?.setCwd(cwd);
  }

  setObserver(observer: ((event: HookExecutionEvent) => void) | undefined): void {
    this.observer = observer;
  }

  queueSessionContext(context: string[]): void {
    this.pendingSessionContext.push(...context);
  }

  suppressNextConfigChange(path: string): void {
    const target = resolve(this.cwd, path);
    const previous = this.configSuppressions.get(target);
    if (previous) clearTimeout(previous);
    const timeout = setTimeout(() => this.configSuppressions.delete(target), 2_000);
    timeout.unref();
    this.configSuppressions.set(target, timeout);
  }

  async start(
    source: "startup" | "resume" | "clear" | "compact",
    model?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.started && source !== "compact") return;
    if (source !== "compact") this.started = true;
    const result = await this.run("SessionStart", {
      source,
      ...(model ? { model } : {}),
    }, signal);
    this.pendingSessionContext.push(...result.context);
    if (!this.fileWatcher) {
      const matchers = (this.options.hooks?.FileChanged ?? [])
        .map(({ matcher }) => matcher)
        .filter((matcher): matcher is string => Boolean(matcher?.trim()));
      if (matchers.length) {
        this.fileWatcher = new HookFileWatcher({
          cwd: this.cwd,
          matchers,
          onChange: (filePath, event) => this.run("FileChanged", { file_path: filePath, event }).then(() => undefined),
          ...(this.options.onError ? { onError: this.options.onError } : {}),
        });
        await this.fileWatcher.start();
      }
    }
    if (!this.configWatcher && this.options.hooks?.ConfigChange?.length && this.options.configFiles?.length) {
      this.configWatcher = new HookFileWatcher({
        cwd: this.cwd,
        matchers: this.options.configFiles.map(({ path }) => path),
        onChange: (filePath) => {
          const suppressed = this.configSuppressions.get(resolve(filePath));
          if (suppressed) {
            clearTimeout(suppressed);
            this.configSuppressions.delete(resolve(filePath));
            return Promise.resolve();
          }
          const config = this.options.configFiles?.find(({ path }) => resolve(this.cwd, path) === resolve(filePath));
          if (!config) return Promise.resolve();
          return this.run("ConfigChange", {
            source: config.source,
            file_path: filePath,
          }).then(() => undefined);
        },
        ...(this.options.onError ? { onError: this.options.onError } : {}),
      });
      await this.configWatcher.start();
    }
  }

  async end(
    reason: "clear" | "resume" | "logout" | "prompt_input_exit" | "other" | "bypass_permissions_disabled",
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    try {
      await this.run("SessionEnd", { reason }, signal);
    } finally {
      this.fileWatcher?.close();
      this.fileWatcher = undefined;
      this.configWatcher?.close();
      this.configWatcher = undefined;
      for (const timeout of this.configSuppressions.values()) clearTimeout(timeout);
      this.configSuppressions.clear();
    }
  }

  takeSessionContext(): string[] {
    return this.pendingSessionContext.splice(0);
  }

  async run(
    event: HookEvent,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<HookResult> {
    const groups = (this.options.hooks?.[event] ?? []).filter((group) => event === "FileChanged"
      ? matchesFile(group.matcher, String(payload.file_path ?? ""), this.cwd)
      : matches(group.matcher, matcherValue(event, payload))
    );
    const input = {
      session_id: this.options.sessionId,
      cwd: this.cwd,
      hook_event_name: event,
      ...payload,
    };
    const runHook = (hook: HookHandler, detached = false) => {
      if (!matchesHookCondition(hook.if, input)) return Promise.resolve(undefined);
      const hookId = randomUUID();
      const hookName = hook.name ?? hookLabel(hook);
      this.observer?.({ type: "started", hookId, hookName, hookEvent: event });
      return executeHook(
        hook,
        input,
        this.cwd,
        this.options.env,
        detached ? undefined : signal,
        this.promptHandler,
        this.agentHandler,
        (stdout, stderr) => {
        this.observer?.({
          type: "progress",
          hookId,
          hookName,
          hookEvent: event,
          stdout,
          stderr,
          output: stdout || stderr,
        });
        },
      ).then((output) => {
        this.observer?.({
          type: "response",
          hookId,
          hookName,
          hookEvent: event,
          stdout: output.stdout,
          stderr: output.stderr,
          output: output.stdout || output.stderr,
          exitCode: output.exitCode,
          outcome: output.error === "Hook execution aborted" ? "cancelled" : output.exitCode === 0 ? "success" : "error",
        });
        return output;
      });
    };
    const blocking: Array<Promise<CommandOutput[]>> = [];
    for (const group of groups) {
      const synchronous = group.hooks.filter((hook) => !(group.async || hook.async));
      for (const hook of group.hooks.filter((candidate) => group.async || candidate.async)) {
        void runHook(hook, true).catch((error) => this.options.onError?.(`${event} async hook failed: ${error instanceof Error ? error.message : String(error)}`));
      }
      if (group.sequential) {
        blocking.push((async () => {
          const outputs: CommandOutput[] = [];
          for (const hook of synchronous) {
            const output = await runHook(hook);
            if (output) outputs.push(output);
            if (output?.exitCode === 2) break;
          }
          return outputs;
        })());
      } else {
        blocking.push(Promise.all(synchronous.map((hook) => runHook(hook))).then(
          (outputs) => outputs.filter((output): output is CommandOutput => output !== undefined),
        ));
      }
    }
    const outputs = (await Promise.all(blocking)).flat();
    const result: HookResult = { blocked: false, context: [], messages: [] };
    for (const output of outputs) {
      if (output.error) this.options.onError?.(output.error);
      if (output.exitCode === 2) {
        result.blocked = true;
        result.reason ??= output.stderr.trim() || output.stdout.trim() || `${event} hook blocked execution`;
        continue;
      }
      if (output.exitCode !== 0) {
        this.options.onError?.(`${event} hook exited with code ${output.exitCode}: ${output.stderr.trim()}`);
        continue;
      }
      const parsed = parseOutput(output.stdout);
      if (!parsed) continue;
      if (typeof parsed === "string") {
        result.context.push(parsed);
        continue;
      }
      if (parsed.systemMessage) result.messages.push(parsed.systemMessage);
      if (parsed.additionalContext) result.context.push(parsed.additionalContext);
      if (parsed.blocked) {
        result.blocked = true;
        if (!result.reason && parsed.reason) result.reason = parsed.reason;
      }
      if (parsed.updatedInput !== undefined) result.updatedInput = parsed.updatedInput;
      if (parsed.permissionDecision) result.permissionDecision = parsed.permissionDecision;
      if (parsed.elicitationResponse) result.elicitationResponse = parsed.elicitationResponse;
    }
    result.context.push(...result.messages);
    return result;
  }
}

type CommandOutput = { exitCode: number; stdout: string; stderr: string; error?: string };

async function executeCommand(
  hook: HookCommand,
  input: Record<string, unknown>,
  cwd: string,
  env: Record<string, string | undefined>,
  signal?: AbortSignal,
  onProgress?: (stdout: string, stderr: string) => void,
): Promise<CommandOutput> {
  const timeoutMs = (hook.timeout ?? 600) * 1000;
  return await new Promise((resolve) => {
    const child = hook.args
      ? spawn(hook.command, hook.args, {
          cwd,
          env: cleanEnvironment(env),
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        })
      : spawn(hook.command, {
      cwd,
      env: cleanEnvironment(env),
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
        });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (output: CommandOutput) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(output);
    };
    const abort = () => {
      child.kill("SIGTERM");
      finish({ exitCode: 1, stdout, stderr, error: "Hook execution aborted" });
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ exitCode: 1, stdout, stderr, error: `Hook timed out after ${hook.timeout ?? 600}s` });
    }, timeoutMs);
    timer.unref();
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      onProgress?.(stdout, stderr);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
      onProgress?.(stdout, stderr);
    });
    child.on("error", (error) => finish({ exitCode: 1, stdout, stderr, error: error.message }));
    child.on("close", (code) => finish({ exitCode: code ?? 1, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

async function executeHook(
  hook: HookHandler,
  input: Record<string, unknown>,
  cwd: string,
  env: Record<string, string | undefined>,
  signal: AbortSignal | undefined,
  promptHandler: HookModelHandler | undefined,
  agentHandler: HookModelHandler | undefined,
  onProgress?: (stdout: string, stderr: string) => void,
): Promise<CommandOutput> {
  if (hook.type === "command") return executeCommand(hook, input, cwd, env, signal, onProgress);
  if (hook.type === "http") return executeHttp(hook, input, env, signal);
  const handler = hook.type === "prompt" ? promptHandler : agentHandler;
  if (!handler) return { exitCode: 1, stdout: "", stderr: "", error: `${hook.type} hook executor is unavailable` };
  try {
    const output = await withHookTimeout(handler(hook, input, signal), hook.timeout, signal);
    const value = typeof output === "string" ? output : JSON.stringify(output);
    const parsed = typeof output === "object" && output !== null ? output : parseJsonRecord(value);
    if (parsed?.ok === false) {
      return { exitCode: 2, stdout: value, stderr: stringValue(parsed.reason) ?? `${hook.type} hook denied the event` };
    }
    return { exitCode: 0, stdout: value, stderr: "" };
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: "", error: error instanceof Error ? error.message : String(error) };
  }
}

async function executeHttp(
  hook: HookHttp,
  input: Record<string, unknown>,
  env: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<CommandOutput> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`Hook timed out after ${hook.timeout ?? 600}s`)), (hook.timeout ?? 600) * 1000);
  timer.unref();
  try {
    const response = await fetch(hook.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...expandHeaders(hook.headers, env) },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
    const text = await response.text();
    return response.ok
      ? { exitCode: 0, stdout: text, stderr: "" }
      : { exitCode: response.status === 403 ? 2 : 1, stdout: text, stderr: `HTTP hook returned ${response.status}` };
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: "", error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

function matcherValue(event: HookEvent, payload: Record<string, unknown>): string {
  if (event === "PreToolUse" || event === "PostToolUse" || event === "PostToolUseFailure" || event === "PermissionDenied") {
    return String(payload.tool_name ?? "");
  }
  if (event === "SessionStart") return String(payload.source ?? "");
  if (event === "SessionEnd") return String(payload.reason ?? "");
  if (event === "Setup") return String(payload.trigger ?? "");
  if (event === "StopFailure") return String(payload.error ?? "");
  if (event === "PreCompact" || event === "PostCompact") return String(payload.trigger ?? "");
  if (event === "PermissionRequest") return String(payload.tool_name ?? "");
  if (event === "Notification") return String(payload.notification_type ?? "");
  if (event === "SubagentStart" || event === "SubagentStop") return String(payload.agent_type ?? "");
  if (event === "Elicitation" || event === "ElicitationResult") return String(payload.mcp_server_name ?? "");
  if (event === "ConfigChange") return String(payload.source ?? "");
  if (event === "InstructionsLoaded") return String(payload.memory_type ?? "");
  return "";
}

function matches(matcher: string | undefined, value: string): boolean {
  if (!matcher || matcher === "*") return true;
  try {
    return new RegExp(matcher, "i").test(value);
  } catch (error) {
    throw new Error(`Invalid hook matcher regex: ${matcher}`, { cause: error });
  }
}

function matchesHookCondition(condition: string | undefined, input: Record<string, unknown>): boolean {
  if (!condition) return true;
  const match = /^([^()]+)(?:\((.*)\))?$/.exec(condition.trim());
  if (!match) return false;
  if (String(input.tool_name ?? "").toLowerCase() !== match[1]!.trim().toLowerCase()) return false;
  if (match[2] === undefined || match[2] === "*") return true;
  const toolInput = isObject(input.tool_input) ? input.tool_input : {};
  const candidate = stringValue(toolInput.command) ?? stringValue(toolInput.file_path) ?? stringValue(toolInput.path) ?? JSON.stringify(toolInput);
  const regex = new RegExp(`^${escapeRegex(match[2]).replaceAll("\\*", ".*")}$`, "i");
  return regex.test(candidate);
}

function hookLabel(hook: HookHandler): string {
  if (hook.type === "command") return hook.command;
  if (hook.type === "http") return hook.url;
  return `${hook.type}: ${hook.prompt.slice(0, 80)}`;
}

function expandHeaders(headers: Record<string, string> | undefined, env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers ?? {}).map(([name, value]) => [
    name,
    value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, variable: string) => {
      const resolved = env[variable];
      if (resolved === undefined) throw new Error(`Environment variable ${variable} is required by HTTP hook header`);
      return resolved;
    }),
  ]));
}

async function withHookTimeout<T>(promise: Promise<T>, seconds = 600, signal?: AbortSignal): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal?.reason ?? new DOMException("Hook execution aborted", "AbortError"));
    const timer = setTimeout(() => reject(new Error(`Hook timed out after ${seconds}s`)), seconds * 1000);
    timer.unref();
    signal?.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    });
  });
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesFile(matcher: string | undefined, filePath: string, cwd: string): boolean {
  if (!matcher || !filePath) return false;
  const target = resolve(filePath);
  return matcher.split("|").some((candidate) => {
    const path = candidate.trim();
    return Boolean(path) && resolve(cwd, path) === target;
  });
}

function parseOutput(value: string): string | {
  blocked: boolean;
  reason?: string;
  systemMessage?: string;
  additionalContext?: string;
  updatedInput?: unknown;
  permissionDecision?: "allow" | "deny" | "ask";
  elicitationResponse?: {
    action: "accept" | "decline" | "cancel";
    content?: Record<string, unknown>;
  };
} | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  let valueObject: unknown;
  try {
    valueObject = JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
  if (!isObject(valueObject)) return trimmed;
  const specific = isObject(valueObject.hookSpecificOutput) ? valueObject.hookSpecificOutput : {};
  const permissionDecision = ["allow", "deny", "ask"].includes(String(specific.permissionDecision))
    ? specific.permissionDecision as "allow" | "deny" | "ask"
    : undefined;
  const requestDecision = isObject(specific.decision) && ["allow", "deny"].includes(String(specific.decision.behavior))
    ? specific.decision
    : undefined;
  const resolvedPermissionDecision = requestDecision
    ? requestDecision.behavior as "allow" | "deny"
    : permissionDecision;
  const blocked = valueObject.continue === false || valueObject.decision === "block" || resolvedPermissionDecision === "deny";
  const reason = stringValue(valueObject.stopReason) ?? stringValue(valueObject.reason) ??
    stringValue(specific.permissionDecisionReason) ?? stringValue(requestDecision?.message);
  const elicitationAction = ["accept", "decline", "cancel"].includes(String(specific.action))
    ? specific.action as "accept" | "decline" | "cancel"
    : undefined;
  const elicitationContent = isObject(specific.content) ? specific.content : undefined;
  return {
    blocked,
    ...(reason ? { reason } : {}),
    ...(stringValue(valueObject.systemMessage) ? { systemMessage: stringValue(valueObject.systemMessage)! } : {}),
    ...(stringValue(specific.additionalContext) ? { additionalContext: stringValue(specific.additionalContext)! } : {}),
    ...(requestDecision?.updatedInput !== undefined
      ? { updatedInput: requestDecision.updatedInput }
      : specific.updatedInput !== undefined
        ? { updatedInput: specific.updatedInput }
        : {}),
    ...(resolvedPermissionDecision ? { permissionDecision: resolvedPermissionDecision } : {}),
    ...(elicitationAction
      ? { elicitationResponse: { action: elicitationAction, ...(elicitationContent ? { content: elicitationContent } : {}) } }
      : {}),
  };
}

function cleanEnvironment(env: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
