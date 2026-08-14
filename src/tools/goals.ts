import { defineTool, type AgentTool } from "../core/tool";
import { GoalManager } from "../services/goals/manager";

export function createGoalTools(manager: GoalManager): AgentTool[] {
  return [createGoalGetTool(manager), createGoalCreateTool(manager), createGoalUpdateTool(manager)];
}

function createGoalGetTool(manager: GoalManager): AgentTool {
  return defineTool({
    name: "goal_get",
    description: "Retrieve the current session goal, including objective, status, elapsed time, and turn budget.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    validate(input) {
      objectInput(input, "goal_get input");
      return {};
    },
    async execute() {
      const goal = manager.current();
      return goal ? JSON.stringify(goal) : "No goal exists for this session.";
    },
    access: "read",
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
  });
}

function createGoalCreateTool(manager: GoalManager): AgentTool {
  return defineTool({
    name: "goal_create",
    description: "Create one persistent session goal. Fails while a non-completed goal already exists.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["objective"],
      properties: {
        objective: { type: "string", description: "The concrete objective to achieve." },
        max_turns: { type: "integer", minimum: 1, description: "Optional interaction-turn budget; defaults to 20." },
      },
    },
    validate(input) {
      const value = objectInput(input, "goal_create input");
      const objective = requiredString(value.objective, "goal_create objective");
      if (value.max_turns === undefined) return { objective };
      if (!Number.isInteger(value.max_turns) || Number(value.max_turns) <= 0) {
        throw new Error("goal_create max_turns must be a positive integer");
      }
      return { objective, maxTurns: Number(value.max_turns) };
    },
    async execute({ objective, maxTurns }) {
      return JSON.stringify(await manager.create(objective, maxTurns));
    },
    access: "write",
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
  });
}

function createGoalUpdateTool(manager: GoalManager): AgentTool {
  return defineTool({
    name: "goal_update",
    description: "Mark the current goal complete, or resume a paused goal that still has remaining turns.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: { status: { type: "string", enum: ["complete", "active"] } },
    },
    validate(input) {
      const status = objectInput(input, "goal_update input").status;
      if (status !== "complete" && status !== "active") {
        throw new Error('goal_update status must be "complete" or "active"');
      }
      return { status: status as "complete" | "active" };
    },
    async execute({ status }) {
      return JSON.stringify(await manager.updateStatus(status));
    },
    access: "write",
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
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
