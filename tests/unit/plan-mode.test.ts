import { describe, expect, test } from "bun:test";

import type { ConversationMessage } from "../../src/core/message";
import { inferPlanModeState, PermissionModeState } from "../../src/core/plan-mode";
import { createPlanModeTools } from "../../src/tools/plan-mode";

describe("permission plan mode state", () => {
  test("enters plan mode and restores the preceding permission mode", () => {
    const changes: string[] = [];
    const state = new PermissionModeState("acceptEdits", (mode) => changes.push(mode));

    expect(state.enterPlan()).toBe("plan");
    expect(state.current).toBe("plan");
    expect(state.exitPlan()).toBe("acceptEdits");
    expect(state.current).toBe("acceptEdits");
    expect(changes).toEqual(["plan", "acceptEdits"]);
  });

  test("rejects invalid duplicate transitions", () => {
    const state = new PermissionModeState("default");
    expect(() => state.exitPlan()).toThrow("not in plan mode");
    state.enterPlan();
    expect(() => state.enterPlan()).toThrow("already in plan mode");
  });

  test("restores active plan mode from successful persisted tool results", () => {
    const history: ConversationMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool-use", id: "enter-1", name: "enter_plan_mode", input: {} }],
      },
      {
        role: "user",
        content: [
          { type: "tool-result", toolUseId: "enter-1", content: "Entered plan mode", isError: false },
        ],
      },
    ];

    expect(inferPlanModeState(history, "acceptEdits")).toEqual({
      mode: "plan",
      prePlanMode: "acceptEdits",
    });
  });
});

describe("plan mode tools", () => {
  test("enters plan mode with an empty strict input", async () => {
    const state = new PermissionModeState("default");
    const [enter] = createPlanModeTools(state);
    const input = enter!.validate({});

    expect(await enter!.execute(input, new AbortController().signal)).toContain(
      "Entered plan mode",
    );
    expect(state.current).toBe("plan");
    expect(enter!.isReadOnly(input)).toBe(true);
  });

  test("requires approval to exit with a non-empty plan", async () => {
    const state = new PermissionModeState("default");
    state.enterPlan();
    const [, exit] = createPlanModeTools(state);
    const input = exit!.validate({ plan: "1. Inspect the API.\n2. Add tests.\n3. Implement." });

    expect(exit!.requiresApproval?.(input)).toBe(true);
    expect(await exit!.execute(input, new AbortController().signal)).toContain(
      "User approved the plan",
    );
    expect(state.current).toBe("default");
  });
});
