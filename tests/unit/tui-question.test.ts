import { describe, expect, test } from "bun:test";

import { QuestionController } from "../../src/ui/question-controller";

describe("TUI question controller", () => {
  test("publishes one question and resolves the selected answer", async () => {
    const controller = new QuestionController();
    const snapshots: string[] = [];
    controller.subscribe(() => snapshots.push(controller.current()?.header ?? "none"));
    const answer = controller.request({
      header: "Library",
      question: "Which library?",
      options: [
        { label: "Existing", description: "Use the existing dependency" },
        { label: "Custom", description: "Build it locally" },
      ],
      multiSelect: false,
    });

    expect(controller.current()?.question).toBe("Which library?");
    controller.resolve("Existing");

    expect(await answer).toBe("Existing");
    expect(snapshots).toEqual(["Library", "none"]);
  });

  test("rejects overlapping questions", async () => {
    const controller = new QuestionController();
    const question = {
      header: "Choice",
      question: "Choose?",
      options: [
        { label: "One", description: "First" },
        { label: "Two", description: "Second" },
      ],
      multiSelect: false,
    };
    const first = controller.request(question);
    expect(controller.request(question)).rejects.toThrow("already pending");
    controller.resolve("One");
    expect(await first).toBe("One");
  });

  test("clears a pending question when its request is cancelled", async () => {
    const controller = new QuestionController();
    const abort = new AbortController();
    const result = controller.request({
      header: "MCP input",
      question: "Enter a value",
      options: [],
      multiSelect: false,
    }, abort.signal);

    abort.abort(new Error("server cancelled"));
    await expect(result).rejects.toThrow("server cancelled");
    expect(controller.current()).toBeUndefined();
  });
});
