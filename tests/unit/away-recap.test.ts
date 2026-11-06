import { test, expect } from "bun:test";
import { AwayRecap } from "../../src/services/notifications/away-recap";
test("recap counts only away events and returns once without tool content", () => {
  const recap = new AwayRecap();
  recap.toolFinished(false); expect(recap.focus(true)).toBeUndefined();
  recap.focus(false); recap.toolFinished(false); recap.toolFinished(true); recap.focus(false);
  expect(recap.focus(true)).toContain("1 次工具执行完成，1 次失败");
  expect(recap.focus(true)).toBeUndefined();
  recap.focus(false); expect(recap.focus(true)).toBeUndefined();
});
