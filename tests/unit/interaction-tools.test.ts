import { describe, expect, test } from "bun:test";

import {
  createAskUserQuestionTool,
  createTodoWriteTool,
  type UserQuestion,
} from "../../src/tools/interaction";

describe("interaction tools", () => {
  test("todo_write replaces the current structured task list", async () => {
    const snapshots: unknown[] = [];
    const tool = createTodoWriteTool({ onChange: (todos) => snapshots.push(todos) });
    const input = tool.validate({
      todos: [
        {
          content: "Inspect the implementation",
          activeForm: "Inspecting the implementation",
          status: "in_progress",
        },
        {
          content: "Run tests",
          activeForm: "Running tests",
          status: "pending",
        },
      ],
    });

    const output = await tool.execute(input, new AbortController().signal);

    expect(output).toContain("Todos have been modified successfully");
    expect(output).toContain("Inspect the implementation");
    expect(snapshots).toHaveLength(1);
    expect(tool.access).toBe("read");
    expect(tool.isReadOnly(input)).toBe(true);
  });

  test("todo_write rejects malformed task states", () => {
    const tool = createTodoWriteTool();
    expect(() =>
      tool.validate({
        todos: [{ content: "Test", activeForm: "Testing", status: "blocked" }],
      }),
    ).toThrow("status");
  });

  test("todo_write restores the previous session list before replacing it", async () => {
    const previous = [
      { content: "Inspect", activeForm: "Inspecting", status: "completed" as const },
    ];
    const tool = createTodoWriteTool({ initialTodos: previous });
    const input = tool.validate({
      todos: [{ content: "Test", activeForm: "Testing", status: "in_progress" }],
    });

    const output = await tool.execute(input, new AbortController().signal);
    expect(output).toContain('"content":"Inspect"');
    expect(output).toContain('"content":"Test"');
  });

  test("ask_user_question validates and returns answers in question order", async () => {
    const seen: UserQuestion[] = [];
    const tool = createAskUserQuestionTool({
      async askUser(question) {
        seen.push(question);
        return question.options[0]!.label;
      },
    });
    const input = tool.validate({
      questions: [
        {
          header: "Library",
          question: "Which library should we use?",
          options: [
            { label: "Existing", description: "Use the current dependency." },
            { label: "Custom", description: "Write a local implementation." },
          ],
          multiSelect: false,
        },
      ],
    });

    const output = await tool.execute(input, new AbortController().signal);

    expect(seen).toHaveLength(1);
    expect(output).toContain('"Which library should we use?"="Existing"');
    expect(tool.isConcurrencySafe(input)).toBe(false);
  });

  test("ask_user_question fails explicitly when user interaction is unavailable", async () => {
    const tool = createAskUserQuestionTool();
    const input = tool.validate({
      questions: [
        {
          header: "Choice",
          question: "Which option?",
          options: [
            { label: "One", description: "First option" },
            { label: "Two", description: "Second option" },
          ],
        },
      ],
    });

    expect(tool.execute(input, new AbortController().signal)).rejects.toThrow(
      "interactive user interface",
    );
  });
});
