import { expect, test } from "bun:test";
import { IdleNotifications, terminalNotice } from "../../src/services/notifications/idle";

test("idle notifications wait for inactivity, deduplicate and remove resolved requests", () => {
  let now = 0; const seen: string[] = [];
  const notifications = new IdleNotifications(kind => seen.push(kind), () => now);
  notifications.sync([{ id: "approval", kind: "permission" }]);
  now = 5000; notifications.tick(); expect(seen).toEqual([]);
  notifications.interaction(); now = 7000; notifications.tick(); expect(seen).toEqual([]);
  now = 11000; notifications.tick(); notifications.tick(); expect(seen).toEqual(["permission"]);
  notifications.sync([{ id: "gone", kind: "question" }]); notifications.sync([]); now = 20000; notifications.tick(); expect(seen).toEqual(["permission"]);
});
test("background terminal notices are prompt-free and completion is acknowledged by input", () => {
  let now = 0; const seen: string[] = [];
  const notifications = new IdleNotifications(kind => seen.push(kind), () => now);
  notifications.add({ id: "done", kind: "finished" }); notifications.interaction(); now = 10000; notifications.tick(); expect(seen).toEqual([]);
  notifications.sync([{ id: "question", kind: "question" }]); now += 500; notifications.tick(false); expect(seen).toEqual(["question"]);
  expect(terminalNotice("permission", {})).toBe("\u0007");
  expect(terminalNotice("permission", { TERM_PROGRAM: "iTerm.app" })).toContain("TNB needs tool approval");
  expect(terminalNotice("question", { TERM_PROGRAM: "ghostty" })).toContain("777;notify;TNB;");
  expect(terminalNotice("question", { TERM_PROGRAM: "iTerm.app", TMUX: "session" })).toBe("\u0007");
  notifications.close();
});
