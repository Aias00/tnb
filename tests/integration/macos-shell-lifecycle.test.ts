import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShellSessionManager } from "../../src/services/shell/manager";
import { createSandboxRuntime } from "../../src/services/sandbox/factory";

const roots: string[] = [];
const managers: ShellSessionManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(sandbox = true) {
  const root = await mkdtemp(join(tmpdir(), "tnb-macos-shell-")); roots.push(root);
  const manager = new ShellSessionManager({ cwd: root, outputDir: join(root, "logs"), env: { ...process.env, TNB_SHELL: "/bin/sh" },
    ...(sandbox ? { sandbox: createSandboxRuntime({ requested: true, settings: { networkAccess: false }, env: process.env }) } : {}),
  });
  managers.push(manager); return { root, manager };
}
async function until(check: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { if (await check()) return; await Bun.sleep(10); }
  throw new Error(message);
}
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }

describe.skipIf(process.platform !== "darwin")("macOS shell runtime lifecycle", () => {
  test("foreground and background commands use Seatbelt and preserve workspace writes", async () => {
    const { root, manager } = await fixture();
    await writeFile(join(root, ".env"), "synthetic-secret");
    await expect(manager.runForeground("cat .env", 5000, new AbortController().signal)).rejects.toThrow();
    expect(await manager.runForeground("printf allowed > allowed; cat allowed", 5000, new AbortController().signal)).toBe("allowed");
    const task = await manager.runBackground("cat .env > leaked");
    await until(() => manager.task(task.taskId).status !== "running", "background process did not finish");
    expect(manager.task(task.taskId).status).toBe("failed");
    expect(await readFile(join(root, "leaked"), "utf8")).toBe("");
  });

  test("PTY follows the sandbox policy and close joins its real process exit", async () => {
    const { root, manager } = await fixture();
    await writeFile(join(root, ".env"), "synthetic-secret");
    const pty = await manager.startPty({ command: "cat .env; printf ready; exec /bin/sh", waitMs: 100, idleMs: 20 });
    const view = await manager.readPty({ pid: pty.pid, waitMs: 200, idleMs: 20 });
    expect(view.screen).not.toContain("synthetic-secret");
    expect(view.screen).toContain("ready");
    await manager.close();
    expect(alive(pty.pid)).toBe(false);
    await expect(manager.startPty({ command: "true" })).rejects.toThrow("closing");
  });

  for (const mode of ["foreground", "background"] as const) {
    test(`${mode} close terminates a command that ignores SIGTERM`, async () => {
      const { root, manager } = await fixture(false);
      const command = "trap '' TERM; printf '%s' $$ > pid; while :; do sleep 1; done";
      const foreground = mode === "foreground"
        ? manager.runForeground(command, 5000, new AbortController().signal).then(() => "success", () => "cancelled") : undefined;
      if (mode === "background") await manager.runBackground(command);
      await until(() => Bun.file(join(root, "pid")).exists(), "child did not start");
      const pid = Number(await readFile(join(root, "pid"), "utf8"));
      const started = Date.now();
      await manager.close();
      expect(Date.now() - started).toBeLessThan(2000);
      expect(alive(pid)).toBe(false);
      if (foreground) expect(await foreground).toBe("cancelled");
      await expect(manager.runBackground("printf forbidden > post-close")).rejects.toThrow("closing");
      expect(await Bun.file(join(root, "post-close")).exists()).toBe(false);
    });
  }

  test("closing cancels a pending sandbox probe and joins it before returning", async () => {
    const { root } = await fixture(false);
    const runtime = createSandboxRuntime({ requested: true, env: process.env })!;
    const pidPath = join(root, "probe-pid"); let wraps = 0;
    const manager = new ShellSessionManager({ cwd: root, outputDir: join(root, "logs"), sandbox: {
      ...runtime, wrap() {
        wraps++;
        return { file: process.execPath, args: ["-e", 'require("node:fs").writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)', pidPath] };
      },
    } }); managers.push(manager);
    const result = manager.runForeground("must-not-launch", 5000, new AbortController().signal).then(() => "started", () => "cancelled");
    await until(() => Bun.file(pidPath).exists(), "probe did not start");
    const pid = Number(await readFile(pidPath, "utf8"));
    await manager.close();
    expect(await result).toBe("cancelled"); expect(wraps).toBe(1); expect(alive(pid)).toBe(false);
  });

  test("close kills a resistant descendant after its process-group leader has exited", async () => {
    const { root, manager } = await fixture(false);
    await manager.runBackground(`/bin/sh -c 'trap "" TERM; printf "%s" $$ > descendant-pid; while :; do sleep 1; done' & wait`);
    await until(() => Bun.file(join(root, "descendant-pid")).exists(), "descendant did not start");
    const pid = Number(await readFile(join(root, "descendant-pid"), "utf8"));
    await manager.close();
    // The host may briefly report an already killed orphan as a zombie until reaped.
    await until(() => !alive(pid), "resistant descendant survived runtime close");
  });
});
