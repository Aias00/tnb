import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GoalManager } from "../../src/services/goals/manager";
import { createGoalTools } from "../../src/tools/goals";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function manager(): Promise<GoalManager> {
  const directory = await mkdtemp(join(tmpdir(), "tnb-goal-"));
  directories.push(directory);
  const value = new GoalManager(join(directory, "goals", "session.json"));
  await value.initialize();
  return value;
}

describe("session goals", () => {
  test("persists one goal and pauses it at the turn budget", async () => {
    const goals = await manager();
    const created = await goals.create("Finish the feature", 2);
    expect(created).toMatchObject({ objective: "Finish the feature", status: "active", turnsUsed: 0, maxTurns: 2 });
    await expect(goals.create("Replace it")).rejects.toThrow("already exists");

    expect(await goals.recordTurn()).toMatchObject({ status: "active", turnsUsed: 1 });
    expect(await goals.recordTurn()).toMatchObject({ status: "paused", turnsUsed: 2 });

    const restored = new GoalManager(goals.filePath);
    await restored.initialize();
    expect(restored.current()).toMatchObject({ objective: "Finish the feature", status: "paused", turnsUsed: 2 });
    expect(await restored.resume(true)).toMatchObject({ status: "active", maxTurns: 22 });
  });

  test("exposes create, get, and update through Agent tools", async () => {
    const goals = await manager();
    const tools = new Map(createGoalTools(goals).map((tool) => [tool.name, tool]));
    const signal = new AbortController().signal;
    const create = tools.get("goal_create")!;
    const get = tools.get("goal_get")!;
    const update = tools.get("goal_update")!;

    await create.execute(create.validate({ objective: "Ship", max_turns: 3 }), signal);
    expect(await get.execute(get.validate({}), signal)).toContain('"objective":"Ship"');
    expect(await update.execute(update.validate({ status: "complete" }), signal)).toContain('"status":"complete"');
    expect(goals.current()).toMatchObject({ status: "complete" });
    expect(await goals.clear()).toBe(true);
    expect(await goals.clear()).toBe(false);
  });

  test("renders active goal context for the next model request", async () => {
    const goals = await manager();
    await goals.create("Verify every deliverable", 5);
    expect(goals.reminder()).toContain("<goal_objective>Verify every deliverable</goal_objective>");
    await goals.pause();
    expect(goals.reminder()).toBeUndefined();
  });

  test("serializes concurrent managers and does not resurrect a cleared goal", async () => {
    const first = await manager();
    const second = new GoalManager(first.filePath);
    await second.initialize();

    const results = await Promise.allSettled([
      first.create("First goal", 5),
      second.create("Second goal", 5),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);

    await second.refresh();
    await Promise.all([first.recordTurn(), second.recordTurn()]);
    const restored = new GoalManager(first.filePath);
    await restored.initialize();
    expect(restored.current()?.turnsUsed).toBe(2);

    expect(await first.clear()).toBe(true);
    expect(await second.recordTurn()).toBeUndefined();
    await restored.refresh();
    expect(restored.current()).toBeUndefined();
  });
});
