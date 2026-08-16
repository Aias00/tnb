import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TaskManager } from "../../src/services/tasks/manager";

describe("task lifecycle", () => {
  test("runs blocking lifecycle callbacks before persistence and completion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tnb-tasks-"));
    try {
      const manager = new TaskManager(join(directory, "tasks.json"));
      await manager.initialize();
      const events: string[] = [];
      manager.setLifecycleHooks({
        beforeCreate: async (task) => void events.push(`created:${task.id}`),
        beforeComplete: async () => { throw new Error("completion blocked"); },
      });

      const task = await manager.createWorkItem({ subject: "ship", description: "finish it" });
      await expect(manager.update(task.id, { status: "completed" })).rejects.toThrow("completion blocked");
      expect(manager.get(task.id)?.status).toBe("pending");
      expect(events).toEqual(["created:1"]);

      manager.setLifecycleHooks({
        beforeComplete: async (next) => void events.push(`completed:${next.id}`),
      });
      await manager.update(task.id, { status: "completed" });
      expect(manager.get(task.id)?.status).toBe("completed");
      expect(events).toEqual(["created:1", "completed:1"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("marks interrupted persisted agents for recovery and reuses their runtime task id", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tnb-tasks-"));
    try {
      const path = join(directory, "tasks.json");
      const now = new Date().toISOString();
      await writeFile(path, JSON.stringify({
        version: 1,
        nextWorkItemId: 1,
        tasks: [{
          id: "agent-restored",
          type: "agent",
          subject: "restored teammate",
          description: "resume unfinished work",
          profile: "general-purpose",
          status: "running",
          blocks: [],
          blockedBy: [],
          metadata: { teamName: "delivery", teammateName: "reviewer" },
          createdAt: now,
          updatedAt: now,
        }],
      }));

      const manager = new TaskManager(path);
      await manager.initialize();
      expect(manager.recoverableAgents().map(({ id }) => id)).toEqual(["agent-restored"]);

      await manager.recoverAgent("agent-restored", async () => "recovered output");
      expect(manager.get("agent-restored")?.status).toBe("running");
      await Bun.sleep(10);
      expect(manager.get("agent-restored")).toMatchObject({
        id: "agent-restored",
        status: "completed",
        output: "recovered output",
        metadata: { recoveryPending: false },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("allocates unique task ids and prevents stale-process resurrection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tnb-tasks-"));
    try {
      const path = join(directory, "tasks.json");
      const first = new TaskManager(path);
      const second = new TaskManager(path);
      await Promise.all([first.initialize(), second.initialize()]);

      const [alpha, beta] = await Promise.all([
        first.createWorkItem({ subject: "alpha", description: "first" }),
        second.createWorkItem({ subject: "beta", description: "second" }),
      ]);
      expect([alpha.id, beta.id].sort()).toEqual(["1", "2"]);

      const stale = new TaskManager(path);
      await stale.initialize();
      await first.update(alpha.id, { status: "deleted" });
      await stale.createWorkItem({ subject: "gamma", description: "stale writer continues" });

      const restored = new TaskManager(path);
      await restored.initialize();
      expect(restored.list().map(({ subject }) => subject).sort()).toEqual(["beta", "gamma"]);
      expect(restored.get(alpha.id)).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
