import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskManager } from "../../src/services/tasks/manager";
import { ShellSessionManager } from "../../src/services/shell/manager";
import { withFileLock } from "../../src/utils/lockfile";

function gate() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }

test("shutdown prevents dispatch after a pending initial task write commits", async () => {
  const root = await mkdtemp(join(tmpdir(), "tnb-startup-drain-"));
  const file = join(root, "tasks.json"); const manager = new TaskManager(file);
  const held = gate(); const unlock = gate(); const published = gate(); let effects = 0;
  await manager.initialize();
  const holding = withFileLock(file, async () => { held.resolve(); await unlock.promise; });
  await held.promise;
  const detach = manager.subscribe(() => { if (manager.current().some((task) => task.status === "running")) published.resolve(); });
  const starting = manager.startAgent({ subject: "fixture", description: "fixture", profile: "general-purpose", run: async () => { effects++; return "effect"; } });
  const outcome = starting.then(() => "started", () => "cancelled");
  try {
    await published.promise;
    const closing = manager.shutdown();
    unlock.resolve(); await holding; await closing;
    expect(await outcome).toBe("cancelled");
    expect(effects).toBe(0);
    expect(manager.list().find((task) => task.type === "agent")?.status).toBe("stopped");
  } finally { unlock.resolve(); await holding; await outcome; detach(); await manager.shutdown(); await rm(root, { recursive: true, force: true }); }
});

for (const transition of ["shutdown", "switch"] as const) {
  test(`${transition} waits for a pending creation Hook and releases its activation scope`, async () => {
    const root = await mkdtemp(join(tmpdir(), "tnb-hook-drain-"));
    const manager = new TaskManager(join(root, "old.json")); await manager.initialize();
    const entered = gate(); const resume = gate(); let released = false; let finished = false; let effects = 0;
    manager.setLifecycleHooks({ retain: () => () => { released = true; }, beforeCreate: async () => { entered.resolve(); await resume.promise; } });
    const starting = manager.startAgent({ subject: "old activation", description: "fixture", profile: "general-purpose", run: async () => { effects++; return "effect"; } });
    const outcome = starting.then(() => "started", () => "cancelled");
    await entered.promise;
    const draining = (transition === "shutdown" ? manager.shutdown() : manager.switchStorage(join(root, "new.json")))
      .then(() => { finished = true; });
    try {
      // A bounded negative check: the deliberately blocked Hook must keep the drain open.
      await Promise.race([draining, Bun.sleep(40)]);
      expect(finished).toBe(false);
      resume.resolve(); await draining;
      expect(await outcome).toBe("cancelled");
      expect(released).toBe(true);
      expect(effects).toBe(0);
      if (transition === "switch") expect(manager.list()).toEqual([]);
    } finally { resume.resolve(); await outcome; await draining; await manager.shutdown(); await rm(root, { recursive: true, force: true }); }
  });
}

for (const mode of ["foreground", "background", "pty"] as const) {
  test.skipIf(process.platform === "win32")(`shell close rejects ${mode} startup before its first async boundary settles`, async () => {
    const root = await mkdtemp(join(tmpdir(), "tnb-shell-drain-"));
    const manager = new ShellSessionManager({ cwd: root, outputDir: join(root, "logs") });
    const command = "printf effect > should-not-exist";
    const starting = mode === "foreground" ? manager.runForeground(command, 5000, new AbortController().signal)
      : mode === "background" ? manager.runBackground(command) : manager.startPty({ command, waitMs: 0 });
    const outcome = starting.then(() => "started", () => "cancelled");
    try {
      await manager.close();
      expect(await outcome).toBe("cancelled");
      expect(await Bun.file(join(root, "should-not-exist")).exists()).toBe(false);
      expect(manager.runtimeSnapshots()).toEqual([]);
    } finally { await outcome; await manager.close(); await rm(root, { recursive: true, force: true }); }
  });
}

for (const stage of ["creation", "completion"] as const) {
  test(`shutdown cancels a cooperative ${stage} Hook through its attempt signal`, async () => {
    const root = await mkdtemp(join(tmpdir(), "tnb-signal-drain-"));
    const manager = new TaskManager(join(root, "tasks.json")); await manager.initialize();
    const entered = gate(); let aborted = false;
    const hook = async (_: unknown, signal?: AbortSignal) => {
      expect(signal).toBeDefined(); entered.resolve();
      await new Promise<void>((resolve) => signal!.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
      signal!.throwIfAborted();
    };
    manager.setLifecycleHooks(stage === "creation" ? { beforeCreate: hook } : { beforeComplete: hook });
    const starting = manager.startAgent({ subject: "fixture", description: "fixture", profile: "general-purpose", run: async () => "done" });
    const outcome = starting.catch(() => undefined);
    try { await entered.promise; await manager.shutdown(); await outcome; expect(aborted).toBe(true); }
    finally { await manager.shutdown(); await outcome; await rm(root, { recursive: true, force: true }); }
  });
}
