import { describe, expect, test } from "bun:test";

import { createSkillTool, selectSkillTools } from "../../src/services/skills/tool";
import { defineTool } from "../../src/core/tool";

const read = defineTool({
  name: "read",
  description: "Read",
  inputSchema: { type: "object" },
  validate: (input) => input,
  execute: async () => "read",
  access: "read",
  isReadOnly: () => true,
});
const bash = defineTool({
  name: "bash",
  description: "Bash",
  inputSchema: { type: "object" },
  validate: (input) => input,
  execute: async () => "bash",
  access: "execute",
});

describe("Skill tool", () => {
  test("limits a fork to explicitly allowed tools", () => {
    expect(selectSkillTools([read, bash], ["Read"])).toEqual([read]);
    expect(selectSkillTools([read, bash], undefined)).toEqual([read, bash]);
  });

  test("renders and delegates the selected skill", async () => {
    const calls: unknown[] = [];
    const tool = createSkillTool({
      skills: [
        {
          name: "review",
          description: "Review code",
          allowedTools: ["read"],
          argumentHint: "<path> [mode]",
          context: "fork",
          agent: "explore",
          effort: "high",
          instructions: "Review $ARGUMENTS",
          baseDir: "/skills/review",
          source: "project",
        },
      ],
      runSkill: async (request) => {
        calls.push(request);
        return "review complete";
      },
    });

    expect(tool.name).toBe("skill");
    expect(tool.access).toBe("execute");
    expect(tool.description).toContain("Arguments: <path> [mode].");
    expect(tool.description).toContain("Execution: context=fork, agent=explore, effort=high.");
    expect(await tool.execute({ name: "review", arguments: "src" }, new AbortController().signal)).toBe(
      "review complete",
    );
    expect(calls).toEqual([
      {
        skill: expect.objectContaining({ name: "review" }),
        prompt: "Skill base directory: /skills/review\n\nReview src",
        signal: expect.any(AbortSignal),
      },
    ]);
  });

  test("rejects unknown skill names", async () => {
    const tool = createSkillTool({ skills: [], runSkill: async () => "unused" });
    await expect(
      tool.execute({ name: "missing", arguments: "" }, new AbortController().signal),
    ).rejects.toThrow("Unknown skill: missing");
  });

  test("hides skills that disable model invocation", async () => {
    const tool = createSkillTool({
      skills: [{ name: "manual", description: "Manual only", disableModelInvocation: true, instructions: "Manual", baseDir: "/skills/manual", source: "user" }],
      runSkill: async () => "unused",
    });
    expect((tool.inputSchema.properties as { name: { enum: string[] } }).name.enum).toEqual([]);
    await expect(tool.execute({ name: "manual", arguments: "" }, new AbortController().signal)).rejects.toThrow("Unknown skill");
  });
});
