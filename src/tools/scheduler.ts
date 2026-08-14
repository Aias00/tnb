import { defineTool, type AgentTool } from "../core/tool";
import { ScheduleManager, nextCronRun } from "../services/scheduler/manager";
import type { ShellSessionManager } from "../services/shell/manager";

export function createSchedulerTools(manager: ScheduleManager, shell: ShellSessionManager): AgentTool[] {
  return [
    defineTool<{ cron: string; prompt: string; recurring?: boolean; durable?: boolean }>({
      name: "cron_create",
      description: "Schedule a prompt using a standard five-field cron expression in local time. Jobs are session-only by default; durable jobs persist across tnb restarts. Recurring jobs auto-expire after seven days unless recreated.",
      inputSchema: {
        type: "object",
        properties: {
          cron: { type: "string", description: "Five fields: minute hour day-of-month month day-of-week." },
          prompt: { type: "string", description: "Prompt to enqueue when the schedule fires." },
          recurring: { type: "boolean", description: "Defaults to true. False fires once and deletes the job." },
          durable: { type: "boolean", description: "Persist across restarts. Use only when explicitly requested." },
        },
        required: ["cron", "prompt"],
        additionalProperties: false,
      },
      access: "write",
      permissionRuleContent: (input: { cron: string }) => input.cron,
      validate(input) {
        const value = object(input, "cron_create");
        return {
          cron: text(value.cron, "cron"),
          prompt: text(value.prompt, "prompt"),
          ...optionalBoolean(value, "recurring"),
          ...optionalBoolean(value, "durable"),
        };
      },
      async execute(input) {
        const task = await manager.create(input);
        const next = nextCronRun(task.cron, task.createdAt);
        return `Scheduled ${task.recurring ? "recurring" : "one-shot"} job ${task.id} for ${next ? new Date(next).toLocaleString() : task.cron} (${task.durable ? "durable" : "session-only"}).`;
      },
    }),
    defineTool<Record<string, never>>({
      name: "cron_list",
      description: "List active session-only and durable scheduled prompts.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      access: "read",
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      validate(input) { object(input, "cron_list"); return {}; },
      async execute() {
        const tasks = manager.list();
        return tasks.length ? tasks.map((task) => `${task.id} — ${task.cron} — ${task.recurring ? "recurring" : "one-shot"} — ${task.durable ? "durable" : "session-only"}: ${task.prompt}`).join("\n") : "No scheduled jobs.";
      },
    }),
    defineTool<{ id: string }>({
      name: "cron_delete",
      description: "Cancel one scheduled prompt by the ID returned from cron_create.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
      access: "write",
      permissionRuleContent: (input: { id: string }) => input.id,
      validate(input) { const value = object(input, "cron_delete"); return { id: text(value.id, "id") }; },
      async execute({ id }) {
        if (!await manager.remove(id)) throw new Error(`No scheduled job with id '${id}'`);
        return `Cancelled job ${id}.`;
      },
    }),
    defineTool<{ delaySeconds: number; prompt: string }>({
      name: "schedule_wakeup",
      description: "Set or replace the single session wakeup timer. When it fires, its prompt is automatically submitted after the current turn becomes idle.",
      inputSchema: {
        type: "object",
        properties: {
          delay_seconds: { type: "integer", minimum: 1, maximum: 86400 },
          prompt: { type: "string" },
        },
        required: ["delay_seconds", "prompt"],
        additionalProperties: false,
      },
      access: "write",
      permissionRuleContent: (input: { prompt: string }) => input.prompt,
      validate(input) {
        const value = object(input, "schedule_wakeup");
        if (!Number.isSafeInteger(value.delay_seconds)) throw new Error("delay_seconds must be an integer");
        return { delaySeconds: value.delay_seconds as number, prompt: text(value.prompt, "prompt") };
      },
      async execute(input) {
        const wakeup = manager.scheduleWakeup(input);
        return `Wakeup ${wakeup.id} scheduled for ${new Date(wakeup.scheduledAt).toLocaleString()}.`;
      },
    }),
    defineTool<{ command: string; description: string }>({
      name: "monitor",
      description: "Start a background command whose non-empty stdout lines become scheduled notifications. Use for streaming logs, file watchers, and polling scripts; use bash run_in_background for a one-shot command where only completion matters.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Long-running command that emits one notification per stdout line." },
          description: { type: "string", description: "Short description included with each notification." },
        },
        required: ["command", "description"],
        additionalProperties: false,
      },
      access: "execute",
      permissionRuleContent: ({ command }) => command,
      validate(input) {
        const value = object(input, "monitor");
        return { command: text(value.command, "command"), description: text(value.description, "description") };
      },
      async execute({ command, description }) {
        const snapshot = await shell.runBackground(command, {
          kind: "monitor",
          onStdoutLine: (line) => manager.enqueue(`Monitor “${description}” emitted:\n${line}`, "monitor"),
          onExit: (status, exitCode) => manager.enqueue(
            `Monitor “${description}” stream ended with status ${status} and exit code ${exitCode}.`,
            "monitor",
          ),
        });
        return `Started monitor ${snapshot.taskId} (pid ${snapshot.pid}). Each stdout line will wake the Agent when it is idle. Use bash_output or bash_kill with this task ID.`;
      },
    }),
  ];
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} input must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}
function optionalBoolean(value: Record<string, unknown>, name: "recurring" | "durable"): Partial<Record<"recurring" | "durable", boolean>> {
  if (value[name] === undefined) return {};
  if (typeof value[name] !== "boolean") throw new Error(`${name} must be a boolean`);
  return { [name]: value[name] };
}
