import { defineTool, type AgentTool } from "../../core/tool";
import { SKILL_TOOL_PROMPT } from "../../constants/tool-prompts";
import type { LoadedSkill } from "./loader";
import { renderSkillPrompt, skillDiscoveryDescription } from "./loader";

export function selectSkillTools(tools: AgentTool[], allowedTools?: string[]): AgentTool[] {
  if (allowedTools === undefined) return tools;
  const allowed = new Set(allowedTools.map(normalizeToolSpec));
  return tools.filter((tool) => allowed.has(tool.name.toLowerCase()));
}

export function createSkillTool(options: {
  skills: LoadedSkill[];
  runSkill(request: { skill: LoadedSkill; prompt: string; signal: AbortSignal }): Promise<string>;
}): AgentTool {
  const discoverableSkills = options.skills.filter((skill) => skill.disableModelInvocation !== true);
  const skills = new Map(discoverableSkills.map((skill) => [skill.name.toLowerCase(), skill]));
  return defineTool({
    name: "skill",
    description: [
      SKILL_TOOL_PROMPT,
      "\nAvailable skills:",
      ...discoverableSkills.map((skill) => `${skill.name}: ${skillDiscoveryDescription(skill)}`),
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          enum: discoverableSkills.map((skill) => skill.name),
          description: "Exact name of an available skill listed in this tool description.",
        },
        arguments: {
          type: "string",
          description: "Optional user arguments substituted into the selected skill instructions.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    validate(input) {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new Error("skill input must be an object");
      }
      const value = input as { name?: unknown; arguments?: unknown };
      if (typeof value.name !== "string" || !value.name) {
        throw new Error("skill name is required");
      }
      if (value.arguments !== undefined && typeof value.arguments !== "string") {
        throw new Error("skill arguments must be a string");
      }
      return { name: value.name, arguments: value.arguments ?? "" };
    },
    async execute(input, signal) {
      const skill = skills.get(input.name.toLowerCase());
      if (!skill) throw new Error(`Unknown skill: ${input.name}`);
      return options.runSkill({
        skill,
        prompt: renderSkillPrompt(skill, input.arguments),
        signal,
      });
    },
    access: "execute",
  });
}

function normalizeToolSpec(value: string): string {
  return value.slice(0, value.indexOf("(") < 0 ? undefined : value.indexOf("(")).trim().toLowerCase();
}
