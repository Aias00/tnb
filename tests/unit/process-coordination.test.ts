import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ModelRequestCoordinator, openCoordinator } from "../../src/services/usage/coordinator";
import { acquireWorkspace, workspaceIsLocked } from "../../src/services/runtime/workspace";

const roots: string[] = []; const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function directory() { const root = await mkdtemp(join(tmpdir(), "tnb-coordination-")); roots.push(root); return root; }
const signal = () => new AbortController().signal;

test("overlapping roots, child directories and symlinks share one exclusion boundary; disjoint projects remain independent", async () => {
  const root = await directory(); const a = join(root, "a"), nested = join(a, "nested"), b = join(root, "b"), alias = join(root, "alias");
  await mkdir(nested, { recursive: true }); await mkdir(b); await symlink(a, alias);
  const release = await acquireWorkspace(a); cleanup.push(release);
  expect(await workspaceIsLocked(nested)).toBe(true);
  expect(await workspaceIsLocked(alias)).toBe(true);
  await expect(acquireWorkspace(nested)).rejects.toMatchObject({ code: "ELOCKED" });
  await expect(acquireWorkspace(root)).rejects.toMatchObject({ code: "ELOCKED" });
  const disjoint = await acquireWorkspace(b); await disjoint();
});

test("one invocation may declare both parent and child roots without granting access to another invocation", async () => {
  const root = await directory(); const nested = join(root, "nested"); await mkdir(nested);
  const a = await acquireWorkspace(root, "same-invocation"); cleanup.push(a);
  const b = await acquireWorkspace(nested, "same-invocation"); cleanup.push(b);
  await expect(acquireWorkspace(nested, "other-invocation")).rejects.toMatchObject({ code: "ELOCKED" });
});

test("resource-domain slots cap independent coordinators and prefer a queued different project", async () => {
  const directory = await directoryForBroker();
  const first = new ModelRequestCoordinator({ directory, perDomain: 1, total: 2 });
  const second = new ModelRequestCoordinator({ directory, perDomain: 1, total: 2 });
  const held = await first.acquire("provider", "project-a", signal()); cleanup.push(held);
  const order: string[] = [];
  const a = second.acquire("provider", "project-a", signal()).then((release) => { order.push("a"); release(); });
  const b = second.acquire("provider", "project-b", signal()).then((release) => { order.push("b"); release(); });
  await Bun.sleep(30); expect(order).toEqual([]); held();
  await Promise.all([a, b]); expect(order[0]).toBe("b");
});
async function directoryForBroker() { return join(await directory(), "broker"); }

test("cancelling queued requests removes their durable ticket and cannot occupy a slot", async () => {
  const directory = await directoryForBroker(); const coordinator = new ModelRequestCoordinator({ directory, perDomain: 1 });
  const release = await coordinator.acquire("provider", "a", signal()); cleanup.push(release);
  const controller = new AbortController(); const pending = coordinator.acquire("provider", "b", controller.signal);
  await Bun.sleep(20); controller.abort(new Error("Cancelled before physical request"));
  await expect(pending).rejects.toThrow("Cancelled before physical request");
  const db = openCoordinator(directory);
  try { expect(db.query("SELECT COUNT(*) AS n FROM slots WHERE state='waiting'").get()).toEqual({ n: 0 }); } finally { db.close(); }
});

test("an independent killed process releases machine capacity even under different TNB_HOME values", async () => {
  const directory = await directoryForBroker();
  const module = resolve(import.meta.dir, "../../src/services/usage/coordinator.ts");
  const code = `import { ModelRequestCoordinator } from ${JSON.stringify(module)};
    const release=await new ModelRequestCoordinator({directory:${JSON.stringify(directory)},perDomain:1}).acquire('shared-provider','child-project',new AbortController().signal);
    console.log('HELD'); setInterval(()=>{},1000); await new Promise(()=>{});`;
  const child = Bun.spawn([process.execPath, "-e", code], { env: { ...process.env, TNB_HOME: join(directory, "other-config") }, stdout: "pipe", stderr: "pipe" });
  cleanup.push(async () => { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; });
  const reader = child.stdout.getReader(); const first = await reader.read(); expect(new TextDecoder().decode(first.value)).toContain("HELD"); await reader.cancel();
  const coordinator = new ModelRequestCoordinator({ directory, perDomain: 1 }); let entered = false;
  const pending = coordinator.acquire("shared-provider", "parent-project", signal()).then((release) => { entered = true; return release; });
  await Bun.sleep(50); expect(entered).toBe(false); child.kill("SIGKILL"); await child.exited;
  const release = await pending; expect(entered).toBe(true); release();
});

test.skipIf(process.platform === "win32")("PID reuse cannot retain a slot belonging to a previous process incarnation", async () => {
  const directory = await directoryForBroker(); const db = openCoordinator(directory);
  db.query("INSERT INTO slots(id,domain,project,pid,state,queued,born) VALUES(?,?,?,?,?,?,?)").run("old-process", "provider", "old-project", process.pid, "active", Date.now(), "previous-process-birth");
  db.close();
  const release = await new ModelRequestCoordinator({ directory, perDomain: 1 }).acquire("provider", "current-project", signal());
  try {
    const current = openCoordinator(directory);
    try { expect(current.query("SELECT id FROM slots WHERE id='old-process'").get()).toBeNull(); } finally { current.close(); }
  } finally { release(); }
});
