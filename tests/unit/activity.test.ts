import { expect, test } from "bun:test";
import { activityLabel } from "../../src/ui/activity";

test("waiting status progresses without claiming unobserved model activity", () => {
  expect(activityLabel("Requesting model", 0)).toBe("Requesting model");
  expect(activityLabel("Requesting model", 8)).toBe("Waiting for model response");
  expect(activityLabel("Requesting model", 20)).toBe("Still waiting for model response");
  expect(activityLabel("Thinking", 20)).toBe("Thinking");
  expect(activityLabel("Running bash", 20)).toBe("Running bash");
});
