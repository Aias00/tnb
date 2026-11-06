import { expect, test } from "bun:test";
import { ExecutionActivityTracker, executionActivityLabel } from "../../src/agent/activity";

test("shared projection handles retry, parallel tools, approval and sticky cancellation", () => {
  const activity = new ExecutionActivityTracker(1);
  expect(activity.model({ type: "thinking", index: 0, thinking: "plan" }).phase).toBe("thinking");
  const retry = activity.model({ type: "retry", phase: "waiting", reason: "rate-limit", retry: 1, maxRetries: 3, delayMs: 2000 }, 100);
  expect(retry.retryAt).toBe(2100); expect(executionActivityLabel(retry, 1100)).toContain("retry 1/3 in 1s");
  activity.tool("start", "a", "read"); activity.tool("start", "b", "grep");
  expect(activity.tool("end", "a").tool).toBe("grep");
  activity.set("waiting-approval"); expect(activity.model({ type: "text", index: 0, text: "late" }).phase).toBe("waiting-approval");
  expect(activity.resume().phase).toBe("tool"); expect(activity.tool("end", "b").phase).toBe("requesting");
  expect(activity.model({ type: "response-end", reason: "end-turn" }).phase).toBe("finishing");
  activity.set("cancelling"); expect(activity.model({ type: "text", index: 0, text: "late" }).phase).toBe("cancelling");
  expect(activity.tool("end", "missing").phase).toBe("cancelling"); expect(activity.resume().phase).toBe("cancelling");
});
