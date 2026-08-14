import { describe, expect, test } from "bun:test";

import { defineTool } from "../../src/core/tool";
import { createWorkflowTool, defaultWorkflowConcurrency } from "../../src/tools/workflow";

describe("workflow tool", () => {
  test("runs ready agents and passes dependency output to downstream steps", async () => {
    const prompts: string[] = [];
    const agent = defineTool({
      name: "agent",
      description: "fake agent",
      inputSchema: { type: "object" },
      validate(input) {
        return input as { description: string; prompt: string; subagent_type: string };
      },
      async execute(input) {
        prompts.push(input.prompt);
        return `result:${input.description}`;
      },
      access: "execute",
    });
    const workflow = createWorkflowTool(agent);
    const input = workflow.validate({
      max_concurrency: 2,
      steps: [
        { id: "inspect", description: "inspect code", prompt: "Inspect", agent_type: "explore" },
        { id: "review", description: "review result", prompt: "Review", depends_on: ["inspect"] },
      ],
    });

    const output = await workflow.execute(input, new AbortController().signal);
    expect(JSON.parse(String(output))).toEqual({
      status: "completed",
      steps: [
        { id: "inspect", status: "completed", output: "result:inspect code" },
        { id: "review", status: "completed", output: "result:review result" },
      ],
    });
    expect(prompts[1]).toContain('<workflow_dependency id="inspect">\nresult:inspect code');
  });

  test("reports failed steps and skips their dependents", async () => {
    const agent = defineTool({
      name: "agent",
      description: "fake agent",
      inputSchema: { type: "object" },
      validate(input) {
        return input as { description: string };
      },
      async execute(input) {
        if (input.description === "fail") throw new Error("agent failed");
        return "ok";
      },
      access: "execute",
    });
    const workflow = createWorkflowTool(agent);
    const output = await workflow.execute(workflow.validate({
      steps: [
        { id: "first", description: "fail", prompt: "Fail" },
        { id: "second", description: "blocked", prompt: "Continue", depends_on: ["first"] },
      ],
    }), new AbortController().signal);

    expect(JSON.parse(String(output))).toMatchObject({
      status: "completed_with_errors",
      steps: [
        { id: "first", status: "failed", error: "agent failed" },
        { id: "second", status: "skipped" },
      ],
    });
  });

  test("rejects cyclic graphs and uses the reference CPU-aware concurrency policy", () => {
    const agent = defineTool({
      name: "agent",
      description: "fake agent",
      inputSchema: { type: "object" },
      validate: (input) => input,
      execute: async () => "ok",
    });
    const workflow = createWorkflowTool(agent);
    expect(() => workflow.validate({
      steps: [
        { id: "a", description: "a", prompt: "a", depends_on: ["b"] },
        { id: "b", description: "b", prompt: "b", depends_on: ["a"] },
      ],
    })).toThrow("dependency cycle");
    expect(defaultWorkflowConcurrency(1)).toBe(2);
    expect(defaultWorkflowConcurrency(8)).toBe(6);
    expect(defaultWorkflowConcurrency(64)).toBe(16);
  });
});
