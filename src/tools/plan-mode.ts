import {
  ENTER_PLAN_MODE_TOOL_PROMPT,
  EXIT_PLAN_MODE_TOOL_PROMPT,
} from "../constants/tool-prompts";
import type { PermissionModeState } from "../core/plan-mode";
import { defineTool, type AgentTool } from "../core/tool";

export function createPlanModeTools(state: PermissionModeState): [AgentTool, AgentTool] {
  const enter = defineTool({
    name: "enter_plan_mode",
    description: ENTER_PLAN_MODE_TOOL_PROMPT,
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    validate(input) {
      const value = objectInput(input, "enter_plan_mode input");
      if (Object.keys(value).length) throw new Error("enter_plan_mode does not accept parameters");
      return {};
    },
    async execute() {
      state.enterPlan();
      return `Entered plan mode. Explore the codebase, clarify material choices with ask_user_question, and design a concrete implementation approach. Do not modify files or run mutating commands. When the plan is complete, call exit_plan_mode with the full plan for user approval.`;
    },
    access: "read",
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
  });

  const exit = defineTool({
    name: "exit_plan_mode",
    description: EXIT_PLAN_MODE_TOOL_PROMPT,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["plan"],
      properties: {
        plan: {
          type: "string",
          description: "Complete implementation plan presented to the user for approval.",
        },
      },
    },
    validate(input) {
      const value = objectInput(input, "exit_plan_mode input");
      if (typeof value.plan !== "string" || !value.plan.trim()) {
        throw new Error("exit_plan_mode plan must be a non-empty string");
      }
      return { plan: value.plan };
    },
    async execute({ plan }) {
      state.exitPlan();
      return `User approved the plan. You can now proceed with implementation and verification.\n\n## Approved Plan\n${plan}`;
    },
    access: "read",
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    requiresApproval: () => state.current === "plan",
    permissionRuleContent: () => "exit",
  });

  return [enter, exit];
}

function objectInput(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} must be an object`);
  }
  return input as Record<string, unknown>;
}
