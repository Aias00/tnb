import { defineTool, type AgentTool } from "../core/tool";
import type { TaskManager } from "../services/tasks/manager";
import type { TeamManager } from "../services/teams/manager";

export function createTeamTools(options: {
  manager: TeamManager;
  tasks: TaskManager;
  teamName(): string | undefined;
  sender(): string;
  defaultTaskId?(): string | undefined;
}): AgentTool[] {
  return [createSendMessageTool(options), createCompleteTaskTool(options)];
}

function createSendMessageTool(options: Parameters<typeof createTeamTools>[0]): AgentTool {
  return defineTool({
    name: "send_message",
    description: "Send a durable message to the team lead or a named teammate. Messages are delivered into the recipient Agent's context at its next turn.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["recipient", "message"],
      properties: {
        recipient: { type: "string", description: "Teammate name, agent id, or main for the team lead." },
        message: { type: "string", description: "Actionable message to deliver." },
        summary: { type: "string", description: "Optional short message summary." },
        type: {
          type: "string",
          enum: ["message", "broadcast", "idle_notification", "shutdown_request", "shutdown_approved", "shutdown_rejected"],
          description: "Structured team protocol event. Use broadcast with recipient '*'.",
        },
        request_id: { type: "string", description: "Shutdown request id when approving or rejecting a request." },
      },
    },
    validate(input) {
      const value = objectInput(input, "send_message input");
      return {
        recipient: requiredString(value.recipient, "send_message recipient"),
        message: requiredString(value.message, "send_message message"),
        ...(value.summary === undefined ? {} : { summary: requiredString(value.summary, "send_message summary") }),
        ...(value.type === undefined ? {} : { type: protocolType(value.type) }),
        ...(value.request_id === undefined ? {} : { requestId: requiredString(value.request_id, "send_message request_id") }),
      };
    },
    async execute(input) {
      const teamName = options.teamName();
      if (!teamName) throw new Error("send_message is available only inside an active Agent Team");
      if (input.type === "shutdown_approved" || input.type === "shutdown_rejected") {
        if (!input.requestId) throw new Error(`${input.type} requires request_id`);
        const response = await options.manager.respondToShutdown({
          teamName,
          from: options.sender(),
          requestId: input.requestId,
          approved: input.type === "shutdown_approved",
          reason: input.message,
        });
        return `Shutdown response ${response.id} delivered to ${response.to}`;
      }
      const message = await options.manager.send({
        teamName,
        from: options.sender(),
        to: input.type === "broadcast" ? "*" : input.recipient,
        text: input.message,
        ...(input.summary ? { summary: input.summary } : {}),
        ...(input.type ? { kind: input.type } : {}),
      });
      return `Message ${message.id} delivered to ${message.to}`;
    },
    access: "read",
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    permissionRuleContent: ({ recipient }) => recipient,
  });
}

function createCompleteTaskTool(options: Parameters<typeof createTeamTools>[0]): AgentTool {
  return defineTool({
    name: "complete_task",
    description: "Mark an assigned persistent task complete after its deliverables are verified. A teammate may omit task_id to complete its own assigned task.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        task_id: { type: "string", description: "Persistent task id. Defaults to the teammate's assigned task." },
        result: { type: "string", description: "Concise verified completion result stored in task metadata." },
      },
    },
    validate(input) {
      const value = objectInput(input, "complete_task input");
      return {
        ...(value.task_id === undefined ? {} : { taskId: requiredString(value.task_id, "complete_task task_id") }),
        ...(value.result === undefined ? {} : { result: requiredString(value.result, "complete_task result") }),
      };
    },
    async execute(input) {
      const taskId = input.taskId ?? options.defaultTaskId?.();
      if (!taskId) throw new Error("complete_task requires task_id when no team task is assigned");
      const task = options.tasks.get(taskId);
      if (!task) throw new Error(`Task #${taskId} not found`);
      if (task.type !== "work-item") throw new Error(`Task #${taskId} is a runtime task and cannot be completed directly`);
      const updated = await options.tasks.update(taskId, {
        status: "completed",
        ...(input.result ? { metadata: { completionResult: input.result } } : {}),
      });
      if (!updated) throw new Error(`Task #${taskId} not found`);
      const teamName = options.teamName();
      if (teamName && options.sender() !== "main") {
        await options.manager.send({
          teamName,
          from: options.sender(),
          to: "main",
          kind: "task_completed",
          text: input.result ?? `Completed task #${taskId}: ${updated.subject}`,
          payload: { task_id: taskId },
        });
      }
      return `Task #${taskId} completed: ${updated.subject}`;
    },
    access: "read",
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    permissionRuleContent: ({ taskId }) => taskId,
  });
}

function objectInput(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`${label} must be an object`);
  return input as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function protocolType(value: unknown): "message" | "broadcast" | "idle_notification" | "shutdown_request" | "shutdown_approved" | "shutdown_rejected" {
  if (!["message", "broadcast", "idle_notification", "shutdown_request", "shutdown_approved", "shutdown_rejected"].includes(String(value))) {
    throw new Error("send_message type is invalid");
  }
  return value as ReturnType<typeof protocolType>;
}
