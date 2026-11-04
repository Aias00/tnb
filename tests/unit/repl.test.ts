import { describe, expect, test } from "bun:test";

import {
  createTerminalPermissionPrompt,
  runRepl,
} from "../../src/ui/repl";

describe("interactive REPL", () => {
  test("bare task command shows the live overview without invoking a model", async () => {
    const answers = ["/task", "/exit"]; let output = "", calls = 0;
    await runRepl({ question: async () => answers.shift() ?? "/exit", write: (text) => { output += text; }, sessionIdFactory: () => "session",
      runTurn: async () => { calls++; return 0; }, durableQuestions: {
        current: () => [], next: () => undefined, dismiss: () => {}, answer: async () => ({ paused: false }), subscribe: () => () => {},
        runs: () => [{ runId: "run", revision: 1, title: "后台任务", workspace: "/work", mode: "single", status: "paused", phase: "预算不足", updatedAt: 1,
          checks: 0, budget: { requests: 2, limit: 8, priced: false, reported: 0, reserved: 0 }, inputs: [], tasks: [] }],
      } });
    expect(output).toContain("后台任务"); expect(output).toContain("预算不足"); expect(output).toContain("2/8 请求"); expect(calls).toBe(0);
  });
  test("runs multiple prompts in one session and exits on slash exit", async () => {
    const answers = ["first task", "", "second task", "/exit"];
    const turns: Array<{ prompt: string; sessionId: string; resume: boolean }> = [];
    let output = "";

    const exitCode = await runRepl({
      question: async () => answers.shift() ?? "/exit",
      write: (text) => void (output += text),
      sessionIdFactory: () => "session-1",
      async runTurn(turn) {
        turns.push(turn);
        return 0;
      },
    });

    expect(exitCode).toBe(0);
    expect(turns).toEqual([
      { prompt: "first task", sessionId: "session-1", resume: false },
      { prompt: "second task", sessionId: "session-1", resume: true },
    ]);
    expect(output).toContain("tnb interactive");
  });

  test("asks for explicit yes or no permission", async () => {
    let output = "";
    const allow = createTerminalPermissionPrompt({
      question: async () => "y",
      write: (text) => void (output += text),
    });
    const deny = createTerminalPermissionPrompt({
      question: async () => "n",
      write: () => undefined,
    });
    const request = {
      tool: { name: "bash", risk: "execute" as const, isReadOnly: () => false },
      input: { command: "bun test" },
      message: "bash requires approval",
    };

    expect(await allow(request)).toBe("allow");
    expect(await deny(request)).toBe("deny");
    expect(output).toContain("bun test");
  });

  test("does not resume a session after a failed turn", async () => {
    const answers = ["failed", "retry", "/exit"];
    const resumeValues: boolean[] = [];
    await runRepl({
      question: async () => answers.shift() ?? "/exit",
      write: () => undefined,
      sessionIdFactory: () => "session",
      async runTurn(turn) {
        resumeValues.push(turn.resume);
        return turn.prompt === "failed" ? 1 : 0;
      },
    });

    expect(resumeValues).toEqual([false, false]);
  });
});
