import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorkflowManager } from "../../src/services/workflows/manager";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function manager(): Promise<WorkflowManager> {
  const directory = await mkdtemp(join(tmpdir(), "tnb-workflow-manager-"));
  directories.push(directory);
  return new WorkflowManager({ configDir: join(directory, "config"), cwd: join(directory, "project") });
}

describe("persisted workflow manager", () => {
  test("preserves an external pause request while a step is running", async () => {
    const workflows = await manager();
    const run = await workflows.startRun({
      steps: [{ id: "inspect", description: "inspect", prompt: "inspect", agentType: "explore", dependsOn: [] }],
      maxConcurrency: 1,
    });
    let release!: (value: string) => void;
    const stepStarted = Promise.withResolvers<void>();
    const stepResult = new Promise<string>((resolve) => { release = resolve; });
    const execution = workflows.resumeRun(run.id, {
      signal: new AbortController().signal,
      runStep: async () => {
        stepStarted.resolve();
        return await stepResult;
      },
    });

    await stepStarted.promise;
    expect((await workflows.pauseRun(run.id)).pauseRequested).toBe(true);
    release("done");
    const paused = await execution;
    expect(paused).toMatchObject({ status: "paused", pauseRequested: true });
    expect(paused.steps[0]).toMatchObject({ status: "completed", output: "done" });

    const completed = await workflows.resumeRun(run.id, {
      signal: new AbortController().signal,
      runStep: async () => "must not rerun",
    });
    expect(completed).toMatchObject({ status: "completed", pauseRequested: false });
    expect(completed.steps[0]?.attempt).toBe(1);
  });

  test("rejects a second executor for the same run", async () => {
    const workflows = await manager();
    const run = await workflows.startRun({
      steps: [{ id: "one", description: "one", prompt: "one", agentType: "general-purpose", dependsOn: [] }],
      maxConcurrency: 1,
    });
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<string>();
    const first = workflows.resumeRun(run.id, {
      signal: new AbortController().signal,
      runStep: async () => {
        started.resolve();
        return await finish.promise;
      },
    });
    await started.promise;
    await expect(workflows.resumeRun(run.id, {
      signal: new AbortController().signal,
      runStep: async () => "duplicate",
    })).rejects.toThrow("already executing");
    finish.resolve("done");
    expect((await first).status).toBe("completed");
  });
});
