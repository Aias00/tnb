import { defineTool, type AgentTool } from "../core/tool";
import { TaskManager, type TaskRecord, type TaskUpdate } from "../services/tasks/manager";

const TASK_STATUSES = ["pending", "in_progress", "completed", "deleted"] as const;

export function createTaskTools(manager: TaskManager): AgentTool[] {
  return [
    createTaskCreateTool(manager),
    createTaskGetTool(manager),
    createTaskUpdateTool(manager),
    createTaskListTool(manager),
    createTaskOutputTool(manager),
    createTaskStopTool(manager),
  ];
}

function createTaskCreateTool(manager: TaskManager): AgentTool {
  return defineTool({
    name: "task_create",
    description: "Create a persistent work item for a multi-step task. Use task_update to claim, complete, delete, or link it to dependencies.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["subject", "description"],
      properties: {
        subject: { type: "string", description: "Brief imperative task title." },
        description: { type: "string", description: "Detailed completion requirements." },
        activeForm: { type: "string", description: "Present-continuous progress label." },
        metadata: { type: "object", additionalProperties: true },
      },
    },
    validate(input) {
      const value = objectInput(input, "task_create input");
      return {
        subject: requiredString(value.subject, "task_create subject"),
        description: requiredString(value.description, "task_create description"),
        ...(value.activeForm === undefined
          ? {}
          : { activeForm: requiredString(value.activeForm, "task_create activeForm") }),
        ...(value.metadata === undefined
          ? {}
          : { metadata: objectInput(value.metadata, "task_create metadata") }),
      };
    },
    async execute(input) {
      const task = await manager.createWorkItem(input);
      return `Task #${task.id} created successfully: ${task.subject}`;
    },
    access: "read",
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
  });
}

function createTaskGetTool(manager: TaskManager): AgentTool {
  return defineTool({
    name: "task_get",
    description: "Retrieve one persistent work item or background runtime task by ID, including dependencies and current output.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["taskId"],
      properties: { taskId: { type: "string" } },
    },
    validate(input) {
      return { taskId: requiredString(objectInput(input, "task_get input").taskId, "task_get taskId") };
    },
    async execute({ taskId }) {
      const task = manager.get(taskId);
      return task ? formatTask(task) : `Task #${taskId} not found`;
    },
    access: "read",
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
  });
}

function createTaskUpdateTool(manager: TaskManager): AgentTool {
  return defineTool({
    name: "task_update",
    description: "Update a persistent work item. Status may be pending, in_progress, completed, or deleted. Dependency links update both tasks.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["taskId"],
      properties: {
        taskId: { type: "string" },
        subject: { type: "string" },
        description: { type: "string" },
        activeForm: { type: "string" },
        status: { type: "string", enum: TASK_STATUSES },
        owner: { type: "string" },
        addBlocks: { type: "array", items: { type: "string" } },
        addBlockedBy: { type: "array", items: { type: "string" } },
        metadata: { type: "object", additionalProperties: true },
      },
    },
    validate(input) {
      const value = objectInput(input, "task_update input");
      const update: TaskUpdate = {};
      if (value.subject !== undefined) update.subject = requiredString(value.subject, "task_update subject");
      if (value.description !== undefined) update.description = requiredString(value.description, "task_update description");
      if (value.activeForm !== undefined) update.activeForm = requiredString(value.activeForm, "task_update activeForm");
      if (value.owner !== undefined) update.owner = requiredString(value.owner, "task_update owner");
      if (value.status !== undefined) {
        if (!TASK_STATUSES.includes(value.status as typeof TASK_STATUSES[number])) {
          throw new Error(`task_update status must be one of: ${TASK_STATUSES.join(", ")}`);
        }
        update.status = value.status as typeof TASK_STATUSES[number];
      }
      if (value.addBlocks !== undefined) update.addBlocks = stringArray(value.addBlocks, "task_update addBlocks");
      if (value.addBlockedBy !== undefined) update.addBlockedBy = stringArray(value.addBlockedBy, "task_update addBlockedBy");
      if (value.metadata !== undefined) update.metadata = objectInput(value.metadata, "task_update metadata");
      if (Object.keys(update).length === 0) throw new Error("task_update requires at least one field to update");
      return {
        taskId: requiredString(value.taskId, "task_update taskId"),
        update,
      };
    },
    async execute({ taskId, update }) {
      const before = manager.get(taskId);
      if (!before) return `Task #${taskId} not found`;
      const task = await manager.update(taskId, update);
      return update.status === "deleted"
        ? `Task #${taskId} deleted`
        : task
          ? `Updated task #${taskId}\n${formatTask(task)}`
          : `Task #${taskId} not found`;
    },
    access: "read",
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
  });
}

function createTaskListTool(manager: TaskManager): AgentTool {
  return defineTool({
    name: "task_list",
    description: "List persistent work items and background runtime tasks in the current session.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    validate(input) {
      objectInput(input, "task_list input");
      return {};
    },
    async execute() {
      const tasks = manager.list();
      if (!tasks.length) return "No tasks found";
      const completed = new Set(tasks.filter(({ status }) => status === "completed").map(({ id }) => id));
      return tasks.map((task) => {
        const unresolved = task.blockedBy.filter((id) => !completed.has(id));
        const owner = task.owner ? ` (${task.owner})` : "";
        const blocked = unresolved.length ? ` [blocked by ${unresolved.map((id) => `#${id}`).join(", ")}]` : "";
        return `#${task.id} [${task.status}] ${task.subject}${owner}${blocked}`;
      }).join("\n");
    },
    access: "read",
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
  });
}

function createTaskOutputTool(manager: TaskManager): AgentTool {
  return defineTool({
    name: "task_output",
    description: "Read the current status and available output of a background Agent task without blocking.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["task_id"],
      properties: { task_id: { type: "string" } },
    },
    validate(input) {
      return { taskId: requiredString(objectInput(input, "task_output input").task_id, "task_output task_id") };
    },
    async execute({ taskId }) {
      const task = manager.get(taskId);
      if (!task) throw new Error(`No task found with ID: ${taskId}`);
      return formatTask(task);
    },
    access: "read",
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
  });
}

function createTaskStopTool(manager: TaskManager): AgentTool {
  return defineTool({
    name: "task_stop",
    description: "Stop a running background Agent task by ID.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["task_id"],
      properties: { task_id: { type: "string" } },
    },
    validate(input) {
      return { taskId: requiredString(objectInput(input, "task_stop input").task_id, "task_stop task_id") };
    },
    async execute({ taskId }) {
      const task = await manager.stop(taskId);
      return `Stop requested for task ${task.id} (${task.subject})`;
    },
    access: "read",
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
  });
}

function formatTask(task: TaskRecord): string {
  return [
    `Task #${task.id}: ${task.subject}`,
    `Type: ${task.type}`,
    `Status: ${task.status}`,
    `Description: ${task.description}`,
    ...(task.profile ? [`Agent profile: ${task.profile}`] : []),
    ...(task.owner ? [`Owner: ${task.owner}`] : []),
    ...(task.blockedBy.length ? [`Blocked by: ${task.blockedBy.map((id) => `#${id}`).join(", ")}`] : []),
    ...(task.blocks.length ? [`Blocks: ${task.blocks.map((id) => `#${id}`).join(", ")}`] : []),
    ...(task.output ? [`Output:\n${task.output}`] : []),
    ...(task.error ? [`Error: ${task.error}`] : []),
  ].join("\n");
}

function objectInput(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} must be an object`);
  }
  return input as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => requiredString(item, `${label}[${index}]`));
}
