import { defineTool, type AgentTool } from "../core/tool";
import { analyzeShellCommand, resolveShellInvocation } from "../core/shell-permissions";
import {
  BASH_INPUT_TOOL_PROMPT,
  BASH_KILL_TOOL_PROMPT,
  BASH_OUTPUT_TOOL_PROMPT,
  BASH_RESIZE_TOOL_PROMPT,
  BASH_TOOL_PROMPT,
} from "../constants/tool-prompts";
import {
  DEFAULT_BASH_TIMEOUT_MS,
  MAX_BASH_TIMEOUT_MS,
  ShellSessionManager,
  type PtySnapshot,
  type ShellTaskSnapshot,
} from "../services/shell/manager";

type ManagedBashInput = {
  command: string;
  timeout?: number;
  runInBackground?: boolean;
  pty?: boolean;
  cols?: number;
  rows?: number;
  waitMs?: number;
  idleMs?: number;
};

type BashOutputInput = {
  taskId?: string;
  pid?: number;
  lines?: number;
  waitMs?: number;
  idleMs?: number;
};

type BashInputInput = {
  pid: number;
  chars: string;
  submit?: boolean;
  waitMs?: number;
  idleMs?: number;
};

type BashResizeInput = {
  pid: number;
  cols: number;
  rows: number;
  waitMs?: number;
  idleMs?: number;
};

type BashKillInput = { taskId?: string; pid?: number };

export function createShellTools(
  manager: ShellSessionManager,
  env: Record<string, string | undefined>,
): AgentTool[] {
  return [
    createManagedBashTool(manager, env),
    createBashOutputTool(manager),
    createBashInputTool(manager),
    createBashResizeTool(manager),
    createBashKillTool(manager),
  ];
}

function createManagedBashTool(
  manager: ShellSessionManager,
  env: Record<string, string | undefined>,
): AgentTool {
  const defaultTimeout = bashTimeout(env.BASH_DEFAULT_TIMEOUT_MS, DEFAULT_BASH_TIMEOUT_MS);
  const maxTimeout = Math.max(
    defaultTimeout,
    bashTimeout(env.BASH_MAX_TIMEOUT_MS, MAX_BASH_TIMEOUT_MS),
  );
  const shell = resolveShellInvocation(env);
  return defineTool<ManagedBashInput>({
    name: "bash",
    description: BASH_TOOL_PROMPT,
    inputSchema: objectSchema(
      {
        command: { type: "string", description: "The shell command to execute." },
        timeout: {
          type: "number",
          description: `Foreground timeout in milliseconds. Defaults to ${defaultTimeout}; maximum ${maxTimeout}.`,
        },
        description: {
          type: "string",
          description: "A short active-voice description of what the command does.",
        },
        run_in_background: {
          type: "boolean",
          description: "Run without blocking and return a task id for bash_output or bash_kill.",
        },
        pty: {
          type: "boolean",
          description: "Open a persistent interactive terminal and return a PID for PTY follow-up tools.",
        },
        cols: { type: "number", description: "Initial PTY width in character cells. Defaults to 160." },
        rows: { type: "number", description: "Initial PTY height in character cells. Defaults to 50." },
        wait_ms: { type: "number", description: "Maximum initial PTY output wait." },
        idle_ms: { type: "number", description: "PTY output stability window." },
      },
      ["command"],
    ),
    access: "execute",
    isReadOnly: ({ command }) => analyzeShellCommand(command, {
      family: shell.family,
      cwd: manager.cwd,
    }).isReadOnly,
    permissionRuleContent: ({ command }) => command,
    validate(input) {
      const value = requireObject(input);
      const command = requireString(value.command, "bash command");
      const runInBackground = optionalBoolean(value.run_in_background, "run_in_background");
      const pty = optionalBoolean(value.pty, "pty");
      if (runInBackground && pty) throw new Error("bash pty and run_in_background are mutually exclusive");
      const timeout = optionalNumber(value.timeout, "timeout");
      if (timeout !== undefined && (!Number.isInteger(timeout) || timeout <= 0 || timeout > maxTimeout)) {
        throw new Error(`bash timeout must be an integer from 1 to ${maxTimeout}`);
      }
      return {
        command,
        ...(timeout === undefined ? {} : { timeout }),
        ...(runInBackground === undefined ? {} : { runInBackground }),
        ...(pty === undefined ? {} : { pty }),
        ...optionalNumberField(value, "cols"),
        ...optionalNumberField(value, "rows"),
        ...optionalNumberField(value, "wait_ms", "waitMs"),
        ...optionalNumberField(value, "idle_ms", "idleMs"),
      };
    },
    async execute(input, signal, onProgress) {
      if (input.pty) {
        return formatPty(await manager.startPty({
          command: input.command,
          ...(input.cols === undefined ? {} : { cols: input.cols }),
          ...(input.rows === undefined ? {} : { rows: input.rows }),
          ...(input.waitMs === undefined ? {} : { waitMs: input.waitMs }),
          ...(input.idleMs === undefined ? {} : { idleMs: input.idleMs }),
        }));
      }
      if (input.runInBackground) return formatTask(await manager.runBackground(input.command));
      return manager.runForeground(input.command, input.timeout ?? defaultTimeout, signal, onProgress);
    },
  });
}

function createBashOutputTool(manager: ShellSessionManager): AgentTool {
  return defineTool<BashOutputInput>({
    name: "bash_output",
    description: BASH_OUTPUT_TOOL_PROMPT,
    inputSchema: objectSchema(
      {
        task_id: { type: "string", description: "Background task id returned by bash." },
        pid: { type: "number", description: "PTY PID returned by bash with pty=true." },
        lines: { type: "number", description: "Maximum rendered PTY lines to return." },
        wait_ms: { type: "number", description: "Maximum time to wait for PTY output." },
        idle_ms: { type: "number", description: "PTY output stability window." },
      },
      [],
    ),
    access: "read",
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    permissionRuleContent: (input) => input.taskId ?? String(input.pid),
    validate(input) {
      const value = requireObject(input);
      const taskId = optionalString(value.task_id, "task_id");
      const pid = optionalPositiveInteger(value.pid, "pid");
      if ((taskId ? 1 : 0) + (pid ? 1 : 0) !== 1) {
        throw new Error("bash_output requires exactly one of task_id or pid");
      }
      return {
        ...(taskId ? { taskId } : {}),
        ...(pid ? { pid } : {}),
        ...optionalNumberField(value, "lines"),
        ...optionalNumberField(value, "wait_ms", "waitMs"),
        ...optionalNumberField(value, "idle_ms", "idleMs"),
      };
    },
    async execute(input) {
      if (input.taskId) return formatTask(manager.task(input.taskId));
      return formatPty(await manager.readPty({
        pid: input.pid!,
        ...(input.lines === undefined ? {} : { lines: input.lines }),
        ...(input.waitMs === undefined ? {} : { waitMs: input.waitMs }),
        ...(input.idleMs === undefined ? {} : { idleMs: input.idleMs }),
      }));
    },
  });
}

function createBashInputTool(manager: ShellSessionManager): AgentTool {
  return defineTool<BashInputInput>({
    name: "bash_input",
    description: BASH_INPUT_TOOL_PROMPT,
    inputSchema: objectSchema(
      {
        pid: { type: "number", description: "PTY PID returned by bash with pty=true." },
        chars: { type: "string", description: "Text or escaped control sequence to write." },
        submit: { type: "boolean", description: "Send Enter after chars in the same transaction." },
        wait_ms: { type: "number", description: "Maximum output wait after input." },
        idle_ms: { type: "number", description: "Output stability window after input." },
      },
      ["pid", "chars"],
    ),
    access: "execute",
    permissionRuleContent: ({ pid }) => String(pid),
    validate(input) {
      const value = requireObject(input);
      const submit = optionalBoolean(value.submit, "submit");
      return {
        pid: requirePositiveInteger(value.pid, "pid"),
        chars: requireStringAllowEmpty(value.chars, "chars"),
        ...(submit === undefined ? {} : { submit }),
        ...optionalNumberField(value, "wait_ms", "waitMs"),
        ...optionalNumberField(value, "idle_ms", "idleMs"),
      };
    },
    async execute(input) {
      return formatPty(await manager.writePty(input));
    },
  });
}

function createBashResizeTool(manager: ShellSessionManager): AgentTool {
  return defineTool<BashResizeInput>({
    name: "bash_resize",
    description: BASH_RESIZE_TOOL_PROMPT,
    inputSchema: objectSchema(
      {
        pid: { type: "number", description: "PTY PID returned by bash with pty=true." },
        cols: { type: "number", description: "New PTY width in character cells." },
        rows: { type: "number", description: "New PTY height in character cells." },
        wait_ms: { type: "number", description: "Maximum output wait after resizing." },
        idle_ms: { type: "number", description: "Output stability window after resizing." },
      },
      ["pid", "cols", "rows"],
    ),
    access: "execute",
    permissionRuleContent: ({ pid }) => String(pid),
    validate(input) {
      const value = requireObject(input);
      return {
        pid: requirePositiveInteger(value.pid, "pid"),
        cols: requirePositiveInteger(value.cols, "cols"),
        rows: requirePositiveInteger(value.rows, "rows"),
        ...optionalNumberField(value, "wait_ms", "waitMs"),
        ...optionalNumberField(value, "idle_ms", "idleMs"),
      };
    },
    async execute(input) {
      return formatPty(await manager.resizePty(input));
    },
  });
}

function createBashKillTool(manager: ShellSessionManager): AgentTool {
  return defineTool<BashKillInput>({
    name: "bash_kill",
    description: BASH_KILL_TOOL_PROMPT,
    inputSchema: objectSchema(
      {
        task_id: { type: "string", description: "Background task id returned by bash." },
        pid: { type: "number", description: "PTY PID returned by bash with pty=true." },
      },
      [],
    ),
    access: "execute",
    permissionRuleContent: (input) => input.taskId ?? String(input.pid),
    validate(input) {
      const value = requireObject(input);
      const taskId = optionalString(value.task_id, "task_id");
      const pid = optionalPositiveInteger(value.pid, "pid");
      if ((taskId ? 1 : 0) + (pid ? 1 : 0) !== 1) {
        throw new Error("bash_kill requires exactly one of task_id or pid");
      }
      return { ...(taskId ? { taskId } : {}), ...(pid ? { pid } : {}) };
    },
    async execute(input) {
      return manager.kill(input.taskId ?? input.pid!);
    },
  });
}

function formatTask(task: ShellTaskSnapshot): string {
  const header = [
    `task_id: ${task.taskId}`,
    `pid: ${task.pid}`,
    `status: ${task.status}`,
    ...(task.exitCode === undefined ? [] : [`exit_code: ${task.exitCode}`]),
    `output_file: ${task.outputPath}`,
  ];
  return `${header.join("\n")}\n\n${task.output.trim() || "(no output yet)"}`;
}

function formatPty(session: PtySnapshot): string {
  const header = [
    `pid: ${session.pid}`,
    `status: ${session.alive ? "running" : "exited"}`,
    ...(session.exitCode === undefined ? [] : [`exit_code: ${session.exitCode}`]),
    `size: ${session.cols}x${session.rows}`,
  ];
  return `${header.join("\n")}\n\n${session.screen || "(screen is empty)"}`;
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return { type: "object", additionalProperties: false, properties, required };
}

function requireObject(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("tool input must be an object");
  }
  return input as Record<string, unknown>;
}

function requireString(input: unknown, label: string): string {
  if (typeof input !== "string" || !input.trim()) throw new Error(`${label} must be a non-empty string`);
  return input;
}

function requireStringAllowEmpty(input: unknown, label: string): string {
  if (typeof input !== "string") throw new Error(`${label} must be a string`);
  return input;
}

function optionalString(input: unknown, label: string): string | undefined {
  return input === undefined ? undefined : requireString(input, label);
}

function optionalBoolean(input: unknown, label: string): boolean | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "boolean") throw new Error(`${label} must be a boolean`);
  return input;
}

function optionalNumber(input: unknown, label: string): number | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "number" || !Number.isFinite(input)) throw new Error(`${label} must be a number`);
  return input;
}

function requirePositiveInteger(input: unknown, label: string): number {
  const value = optionalNumber(input, label);
  if (!Number.isInteger(value) || (value ?? 0) <= 0) throw new Error(`${label} must be a positive integer`);
  return value as number;
}

function optionalPositiveInteger(input: unknown, label: string): number | undefined {
  return input === undefined ? undefined : requirePositiveInteger(input, label);
}

function optionalNumberField(
  value: Record<string, unknown>,
  source: string,
  target = source,
): Record<string, number> {
  const parsed = optionalNumber(value[source], source);
  return parsed === undefined ? {} : { [target]: parsed };
}

function bashTimeout(input: string | undefined, fallback: number): number {
  if (!input) return fallback;
  const value = Number.parseInt(input, 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
