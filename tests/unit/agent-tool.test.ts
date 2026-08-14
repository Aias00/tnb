import { describe, expect, test } from "bun:test";

import {
  buildSubagentInstruction,
  createAgentTool,
  selectAgentTools,
} from "../../src/tools/agent";
import { defineTool } from "../../src/core/tool";

describe("Agent tool", () => {
  test("validates a task and delegates it to the selected subagent", async () => {
    const calls: unknown[] = [];
    const tool = createAgentTool({
      async runAgent(input) {
        calls.push(input);
        return "Found the relevant implementation.";
      },
    });
    const input = tool.validate({
      description: "Locate implementation",
      prompt: "Find the provider registry and report the relevant files.",
      subagent_type: "explore",
      model: "test-small",
    });

    const output = await tool.execute(input, new AbortController().signal);

    expect(output).toBe("Found the relevant implementation.");
    expect(calls).toEqual([
      {
        description: "Locate implementation",
        prompt: "Find the provider registry and report the relevant files.",
        subagentType: "explore",
        profile: expect.objectContaining({ name: "explore", source: "built-in" }),
        model: "test-small",
        runInBackground: false,
        signal: expect.any(AbortSignal),
      },
    ]);
    expect(tool.access).toBe("execute");
    expect(tool.isConcurrencySafe(input)).toBe(false);
  });

  test("defaults to general-purpose and rejects unsupported agent types", () => {
    const tool = createAgentTool({ runAgent: async () => "done" });
    expect(tool.validate({ description: "Implement change", prompt: "Make the requested edit." })).toMatchObject({
      subagentType: "general-purpose",
    });
    expect(() =>
      tool.validate({
        description: "Unknown",
        prompt: "Do work.",
        subagent_type: "made-up",
      }),
    ).toThrow("subagent_type");
  });

  test("accepts an explicit durable resume target", () => {
    const tool = createAgentTool({ runAgent: async () => "done" });
    expect(tool.validate({
      description: "Continue review",
      prompt: "Continue from the restored transcript and verify the remaining files.",
      resume: "agent-runtime-42",
    })).toMatchObject({ resume: "agent-runtime-42", runInBackground: false });
  });

  test("gives explore and plan agents only discovery tools", () => {
    const tools = [
      fakeTool("read", "read"),
      fakeTool("grep", "read"),
      fakeTool("write", "write"),
      fakeTool("bash", "execute"),
      fakeTool("web_fetch", "network"),
      fakeTool("todo_write", "read"),
      fakeTool("ask_user_question", "read"),
      fakeTool("mcp__server__lookup", "unknown"),
    ];

    expect(selectAgentTools(tools, "explore").map(({ name }) => name)).toEqual([
      "read",
      "grep",
      "web_fetch",
    ]);
    expect(selectAgentTools(tools, "plan").map(({ name }) => name)).toEqual([
      "read",
      "grep",
      "web_fetch",
    ]);
    expect(selectAgentTools(tools, "general-purpose").map(({ name }) => name)).toEqual([
      "read",
      "grep",
      "write",
      "bash",
      "web_fetch",
      "mcp__server__lookup",
    ]);
    expect(selectAgentTools(tools, "general-purpose", { mainThread: true }).map(({ name }) => name)).toEqual([
      "read",
      "grep",
      "write",
      "bash",
      "web_fetch",
      "todo_write",
      "ask_user_question",
      "mcp__server__lookup",
    ]);
  });

  test("gives each subagent type a distinct bounded role instruction", () => {
    expect(buildSubagentInstruction("explore", "Locate provider code")).toContain(
      "read-only investigation",
    );
    expect(buildSubagentInstruction("plan", "Design provider migration")).toContain(
      "implementation plan",
    );
    expect(buildSubagentInstruction("general-purpose", "Implement provider migration")).toContain(
      "delegated task",
    );
    for (const type of ["explore", "plan", "general-purpose"] as const) {
      expect(buildSubagentInstruction(type, "Scoped task")).toContain("Scoped task");
      expect(buildSubagentInstruction(type, "Scoped task")).toContain("parent Agent");
    }
  });
});

function fakeTool(name: string, access: "read" | "write" | "execute" | "network" | "unknown") {
  return defineTool({
    name,
    description: name,
    inputSchema: { type: "object" },
    validate: (input) => input,
    execute: async () => "ok",
    access,
  });
}
