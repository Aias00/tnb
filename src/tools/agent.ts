import { AGENT_TOOL_PROMPT } from "../constants/tool-prompts";
import { defineTool, type AgentTool } from "../core/tool";
import type { PermissionMode } from "../core/permissions";

export const SUBAGENT_TYPES = ["general-purpose", "explore", "plan"] as const;
export type SubagentType = (typeof SUBAGENT_TYPES)[number];

export type AgentProfile = {
  name: string;
  description: string;
  prompt?: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  permissionMode?: PermissionMode;
  maxTurns?: number;
  source: "built-in" | "user" | "claude-project" | "project" | "plugin" | "cli";
  filePath?: string;
  baseDir?: string;
};

export const BUILT_IN_AGENT_PROFILES: AgentProfile[] = [
  {
    name: "general-purpose",
    description: "Investigates, edits, and verifies a focused implementation task.",
    source: "built-in",
  },
  {
    name: "explore",
    description: "Performs fast read-only repository investigation.",
    tools: ["read", "grep", "glob", "web_fetch", "web_search", "image_search"],
    source: "built-in",
  },
  {
    name: "plan",
    description: "Analyzes the repository and returns an implementation plan without editing.",
    tools: ["read", "grep", "glob", "web_fetch", "web_search", "image_search"],
    permissionMode: "plan",
    source: "built-in",
  },
];

export type AgentTask = {
  description: string;
  prompt: string;
  subagentType: string;
  profile: AgentProfile;
  model?: string;
  runInBackground: boolean;
  name?: string;
  teamName?: string;
  taskId?: string;
  resume?: string;
  signal: AbortSignal;
  existingRuntimeTaskId?: string;
  existingAgentId?: string;
  restoreTranscript?: boolean;
};

export function createAgentTool(options: {
  profiles?: AgentProfile[];
  runAgent(task: AgentTask): Promise<string>;
}): AgentTool {
  const profiles = options.profiles ?? BUILT_IN_AGENT_PROFILES;
  const profilesByName = new Map(profiles.map((profile) => [profile.name.toLowerCase(), profile]));
  return defineTool({
    name: "agent",
    description: [
      AGENT_TOOL_PROMPT,
      "\nAvailable agent profiles:",
      ...profiles.map((profile) => `${profile.name}: ${profile.description}`),
    ].join("\n"),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["description", "prompt"],
      properties: {
        description: {
          type: "string",
          description: "Short three-to-five-word description of the delegated task.",
        },
        prompt: {
          type: "string",
          description: "Complete standalone briefing for the subagent.",
        },
        subagent_type: {
          type: "string",
          enum: profiles.map((profile) => profile.name),
          description: "Agent profile. Defaults to general-purpose.",
        },
        model: {
          type: "string",
          description: "Optional exact model identifier for this subagent; otherwise inherit the parent model.",
        },
        run_in_background: {
          type: "boolean",
          description: "Run asynchronously and return a task ID immediately. Use task_output or task_stop later.",
        },
        name: {
          type: "string",
          description: "Stable teammate name when launching into an Agent Team.",
        },
        team_name: {
          type: "string",
          description: "Create or join this session's Agent Team. Team agents always run in the background.",
        },
        task_id: {
          type: "string",
          description: "Optional persistent work-item id assigned to the teammate.",
        },
        resume: {
          type: "string",
          description: "Resume a prior subagent by runtime task ID or durable agent ID, restoring its transcript.",
        },
      },
    },
    validate(input) {
      const value = objectInput(input);
      const description = nonEmptyString(value.description, "agent description");
      const prompt = nonEmptyString(value.prompt, "agent prompt");
      const subagentType = value.subagent_type ?? "general-purpose";
      if (typeof subagentType !== "string") {
        throw new Error("agent subagent_type must be a string");
      }
      const profile = profilesByName.get(subagentType.toLowerCase());
      if (!profile) {
        throw new Error(`agent subagent_type must be one of: ${profiles.map(({ name }) => name).join(", ")}`);
      }
      if (value.model !== undefined && (typeof value.model !== "string" || !value.model.trim())) {
        throw new Error("agent model must be a non-empty string");
      }
      if (value.run_in_background !== undefined && typeof value.run_in_background !== "boolean") {
        throw new Error("agent run_in_background must be a boolean");
      }
      const name = optionalString(value.name, "agent name");
      const teamName = optionalString(value.team_name, "agent team_name");
      const taskId = optionalString(value.task_id, "agent task_id");
      const resume = optionalString(value.resume, "agent resume");
      if (teamName && value.run_in_background !== true) {
        throw new Error("agent team_name requires run_in_background: true");
      }
      if (name && !teamName) throw new Error("agent name requires team_name");
      return {
        description,
        prompt,
        subagentType: profile.name,
        profile,
        runInBackground: value.run_in_background === true,
        ...(typeof value.model === "string" ? { model: value.model } : {}),
        ...(name ? { name } : {}),
        ...(teamName ? { teamName } : {}),
        ...(taskId ? { taskId } : {}),
        ...(resume ? { resume } : {}),
      };
    },
    execute(input, signal) {
      return options.runAgent({ ...input, signal });
    },
    access: "execute",
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    permissionRuleContent: ({ subagentType }) => subagentType,
  });
}

function optionalString(input: unknown, label: string): string | undefined {
  if (input === undefined) return undefined;
  return nonEmptyString(input, label);
}

export function selectAgentTools(
  tools: AgentTool[],
  profileOrName: AgentProfile | SubagentType,
  options: { mainThread?: boolean } = {},
): AgentTool[] {
  const profile = typeof profileOrName === "string"
    ? BUILT_IN_AGENT_PROFILES.find(({ name }) => name === profileOrName)
    : profileOrName;
  if (!profile) throw new Error(`Unknown built-in agent profile: ${profileOrName}`);
  const candidates = options.mainThread
    ? tools
    : tools.filter(
        ({ name }) =>
          name !== "todo_write" &&
          name !== "ask_user_question" &&
          name !== "enter_worktree" &&
          name !== "exit_worktree" &&
          !name.startsWith("checkpoint_"),
      );
  const disallowed = new Set((profile.disallowedTools ?? []).map(normalizeToolSpec));
  const available = candidates.filter(({ name }) => !disallowed.has(name.toLowerCase()));
  if (profile.tools === undefined || (profile.tools.length === 1 && profile.tools[0] === "*")) {
    return available;
  }
  const requested = new Set(profile.tools.map(normalizeToolSpec));
  const selected = available.filter(({ name }) => requested.has(name.toLowerCase()));
  const missing = [...requested].filter((name) => !candidates.some((tool) => tool.name.toLowerCase() === name));
  if (missing.length && profile.source !== "built-in") {
    throw new Error(`Agent ${profile.name} references unavailable tools: ${missing.join(", ")}`);
  }
  return selected;
}

export function buildSubagentInstruction(type: SubagentType, description: string): string {
  const role = type === "explore"
    ? "Perform a focused read-only investigation. Locate and inspect relevant evidence, then report concrete findings without changing the workspace."
    : type === "plan"
      ? "Analyze the repository without changing it and return a concrete implementation plan with relevant paths, dependencies, risks, and verification steps."
      : "Complete the delegated task autonomously within its stated scope, including focused implementation and verification when requested.";
  return `# Active subagent\n\nYou are the ${type} subagent assigned to: ${description}. ${role} Return a focused result to the parent Agent.`;
}

export function buildAgentProfileInstruction(
  profile: AgentProfile,
  taskDescription: string,
): string {
  if (profile.prompt) {
    return [
      "# Active agent",
      "",
      `Agent profile: ${profile.name}`,
      `Assigned task: ${taskDescription}`,
      ...(profile.baseDir ? [`Definition base directory: ${profile.baseDir}`] : []),
      "",
      profile.prompt,
    ].join("\n");
  }
  return buildSubagentInstruction(profile.name as SubagentType, taskDescription);
}

function normalizeToolSpec(value: string): string {
  const parenthesis = value.indexOf("(");
  return value.slice(0, parenthesis < 0 ? undefined : parenthesis).trim().toLowerCase();
}

function objectInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("agent input must be an object");
  }
  return input as Record<string, unknown>;
}

function nonEmptyString(input: unknown, label: string): string {
  if (typeof input !== "string" || !input.trim()) throw new Error(`${label} must be a non-empty string`);
  return input;
}
