import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  ScheduleManager,
  nextCronRun,
  parseCronExpression,
} from "../../src/services/scheduler/manager";
import { createSchedulerTools } from "../../src/tools/scheduler";
import { ShellSessionManager } from "../../src/services/shell/manager";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("scheduled prompts", () => {
  test("parses five-field cron expressions and computes local next runs", () => {
    expect(parseCronExpression("*/5 * * * *")).toBeDefined();
    expect(parseCronExpression("61 * * * *")).toBeUndefined();
    expect(parseCronExpression("* * *")).toBeUndefined();
    const start = new Date(2026, 7, 10, 10, 2, 30).getTime();
    expect(nextCronRun("*/5 * * * *", start)).toBe(new Date(2026, 7, 10, 10, 5, 0).getTime());
  });

  test("persists durable jobs and keeps session jobs in memory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tnb-schedule-"));
    directories.push(directory);
    const path = join(directory, "scheduled_tasks.json");
    const manager = new ScheduleManager(path);
    await manager.initialize();
    const session = await manager.create({ cron: "*/5 * * * *", prompt: "check logs" });
    const durable = await manager.create({ cron: "7 * * * *", prompt: "check deployment", durable: true });
    expect(manager.list()).toHaveLength(2);
    const file = JSON.parse(await readFile(path, "utf8")) as { tasks: Array<{ id: string }> };
    expect(file.tasks.map(({ id }) => id)).toEqual([durable.id]);
    manager.clearSession();
    expect(manager.list().map(({ id }) => id)).toEqual([durable.id]);
    expect(await manager.remove(session.id)).toBe(false);
    expect(await manager.remove(durable.id)).toBe(true);
  });

  test("exposes cron, wakeup, and monitor tools over shared managers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tnb-schedule-tools-"));
    directories.push(directory);
    const manager = new ScheduleManager(join(directory, "scheduled.json"));
    const shell = new ShellSessionManager({ cwd: directory, outputDir: join(directory, "output") });
    const tools = new Map(createSchedulerTools(manager, shell).map((tool) => [tool.name, tool]));
    expect([...tools.keys()]).toEqual(["cron_create", "cron_list", "cron_delete", "schedule_wakeup", "monitor"]);
    const cron = tools.get("cron_create")!;
    const output = await cron.execute(cron.validate({ cron: "*/10 * * * *", prompt: "inspect status", recurring: false }), new AbortController().signal);
    expect(output).toContain("one-shot");
    const events: string[] = [];
    manager.subscribe((prompt) => events.push(prompt));
    manager.enqueue("wake now", "test");
    expect(events).toEqual(["wake now"]);
    const monitorEvent = new Promise<string>((resolve) => {
      const unsubscribe = manager.subscribe((prompt) => {
        if (!prompt.includes("monitor event")) return;
        unsubscribe();
        resolve(prompt);
      });
    });
    const monitor = tools.get("monitor")!;
    const monitorOutput = await monitor.execute(monitor.validate({
      command: "printf 'monitor event\\n'",
      description: "test stream",
    }), new AbortController().signal);
    expect(monitorOutput).toContain("Started monitor monitor_");
    expect(await Promise.race([
      monitorEvent,
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("monitor event timed out")), 1_000)),
    ])).toContain("monitor event");
    await shell.close();
  });

  test("merges concurrent durable jobs and preserves deletion across stale writers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tnb-schedule-concurrent-"));
    directories.push(directory);
    const path = join(directory, "scheduled_tasks.json");
    const first = new ScheduleManager(path);
    const second = new ScheduleManager(path);
    await Promise.all([first.initialize(), second.initialize()]);

    const [one, two] = await Promise.all([
      first.create({ cron: "1 * * * *", prompt: "first", durable: true }),
      second.create({ cron: "2 * * * *", prompt: "second", durable: true }),
    ]);
    const restored = new ScheduleManager(path);
    await restored.initialize();
    expect(new Set(restored.list().map(({ id }) => id))).toEqual(new Set([one.id, two.id]));

    expect(await first.remove(one.id)).toBe(true);
    await second.close();
    const afterDelete = new ScheduleManager(path);
    await afterDelete.initialize();
    expect(afterDelete.list().map(({ id }) => id)).toEqual([two.id]);
  });
});
