import { describe, expect, test } from "bun:test";
import { PromptCompletionController } from "../../src/ui/prompt-input/completion";

describe("prompt completion controller", () => {
  test("fences stale async results and applies replacement ranges", () => {
    const controller = new PromptCompletionController();
    const stale = controller.begin("file", { start: 5, end: 8 });
    const current = controller.begin("mcp", { start: 5, end: 8 });
    expect(controller.resolve(stale, ["old"])).toBe(false);
    expect(controller.resolve(current, ["alpha", "beta"])).toBe(true);
    controller.move(1);
    expect(controller.accept("use @fi now")?.value).toBe("use @betanow");
    expect(controller.current()).toBeUndefined();
  });
});
