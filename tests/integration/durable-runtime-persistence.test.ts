import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RuntimeStore } from "../../src/services/runtime/store";
import { RuntimeCommands } from "../../src/services/runtime/commands";

const roots: string[] = [];
const stores: RuntimeStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tnb-durable-process-")); roots.push(root);
  return join(root, "state.sqlite");
}
const imports = `import { RuntimeStore } from ${JSON.stringify(fileURLToPath(new URL("../../src/services/runtime/store.ts", import.meta.url)))};
import { RuntimeCommands } from ${JSON.stringify(fileURLToPath(new URL("../../src/services/runtime/commands.ts", import.meta.url)))};`;
async function child(source: string) {
  const process = Bun.spawn([globalThis.process.execPath, "-e", imports + "\n" + source], {
    stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(5000),
  });
  const [code, output, error] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
  return { code, signal: process.signalCode, output, error };
}

test("SIGKILL before commit leaves no partial state, event, effect or dedup receipt", async () => {
  const path = await fixture();
  const initial = new RuntimeStore(path); initial.close();
  const result = await child(`const store = new RuntimeStore(${JSON.stringify(path)});
    store.command("interrupted", { phase: "fixture" }, 1000, (tx) => {
      tx.insertRun({runId:"uncommitted",objective:"fixture",revision:1,status:"active",policy:{mode:"single",maxActiveAgents:1,maxDelegationDepth:0},createdAt:1000,updatedAt:1000});
      tx.event("uncommitted", "run.created", {});
      tx.enqueue({runId:"uncommitted",kind:"control",key:"run-control",dueAt:1000,data:{action:"pause"}});
      process.kill(process.pid,"SIGKILL");
      return true;
    });`);
  expect(result.code).not.toBe(0);
  expect(result.signal).toBe("SIGKILL");
  expect(result.error).toBe("");
  const store = new RuntimeStore(path); stores.push(store);
  expect(store.getRun("uncommitted")).toBeUndefined();
  const db = new Database(path, { readonly: true });
  try {
    for (const table of ["commands", "events", "effects"]) expect(db.query(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  } finally { db.close(); }
  expect(new RuntimeCommands(store, () => 2000).createRun({ commandId: "interrupted", objective: "retry" }).run.status).toBe("active");
});

test("SIGKILL after commit preserves one Run and replays its original receipt without dispatch", async () => {
  const path = await fixture();
  const result = await child(`const store = new RuntimeStore(${JSON.stringify(path)});
    new RuntimeCommands(store,()=>1000).createRun({commandId:"accepted",objective:"Persistent work"});
    process.kill(process.pid,"SIGKILL");`);
  expect(result.code).not.toBe(0);
  expect(result.signal).toBe("SIGKILL");
  expect(result.error).toBe("");
  const store = new RuntimeStore(path); stores.push(store);
  const commands = new RuntimeCommands(store, () => 9000);
  const restored = commands.createRun({ commandId: "accepted", objective: "Persistent work" });
  expect(restored.run.createdAt).toBe(1000);
  expect(store.events(restored.run.runId).map((event) => event.type)).toEqual(["run.created", "task.created"]);
  expect(store.getTask(restored.tasks[0]!.taskId)?.status).toBe("ready");
  expect(store.effects(restored.run.runId)).toHaveLength(1);
  const db = new Database(path, { readonly: true });
  try { expect(db.query("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 1 }); }
  finally { db.close(); }
});

test("two real processes cannot reserve two attempts or fork the event sequence", async () => {
  const path = await fixture(); const store = new RuntimeStore(path); stores.push(store);
  const created = new RuntimeCommands(store, () => 1000).createRun({ commandId: "create", objective: "One owner" });
  const results = await Promise.all(["one", "two"].map((ownerId) => child(`
    const store = new RuntimeStore(${JSON.stringify(path)});
    try {
      const result = new RuntimeCommands(store,()=>1100).startAttempt({commandId:${JSON.stringify(ownerId)},taskId:${JSON.stringify(created.tasks[0]!.taskId)},expectedRevision:1,ownerId:${JSON.stringify(ownerId)},leaseMs:1000});
      console.log(JSON.stringify({accepted:true,attemptId:result.attempt.attemptId}));
    } catch(error) { console.log(JSON.stringify({accepted:false,error:error.message})); }
    finally {store.close();}`)));
  for (const result of results) { expect(result.code).toBe(0); expect(result.error).toBe(""); }
  const reports = results.map((result) => JSON.parse(result.output) as { accepted: boolean; error?: string });
  expect(reports.filter((report) => report.accepted)).toHaveLength(1);
  expect(reports.find((report) => !report.accepted)?.error).toContain("revision conflict");
  expect(store.events(created.run.runId).map((event) => event.sequence)).toEqual([1, 2, 3]);
  expect(store.getTask(created.tasks[0]!.taskId)?.epoch).toBe(1);
  const db = new Database(path, { readonly: true });
  try { expect(db.query("SELECT COUNT(*) AS n FROM attempts WHERE status='active'").get()).toEqual({ n: 1 }); }
  finally { db.close(); }
});

test("simultaneous first openers serialize migration without losing either committed Run", async () => {
  const path = await fixture();
  const results = await Promise.all(["one", "two"].map((id) => child(`
    const store = new RuntimeStore(${JSON.stringify(path)});
    const result = new RuntimeCommands(store,()=>1000).createRun({commandId:${JSON.stringify(id)},objective:${JSON.stringify(id)}});
    console.log(result.run.runId);
    store.close();`)));
  for (const result of results) { expect(result.code).toBe(0); expect(result.error).toBe(""); }
  const ids = results.map((result) => result.output.trim());
  expect(new Set(ids).size).toBe(2);
  const store = new RuntimeStore(path); stores.push(store);
  for (const id of ids) expect(store.getRun(id)?.status).toBe("active");
});

test("opening an interrupted running task is read-only and cannot silently turn it pending", async () => {
  const path = await fixture();
  const result = await child(`const store=new RuntimeStore(${JSON.stringify(path)}); const commands=new RuntimeCommands(store,()=>1000);
    const created=commands.createRun({commandId:"create",objective:"Interrupted"});
    commands.startAttempt({commandId:"start",taskId:created.tasks[0].taskId,expectedRevision:1,ownerId:"old",leaseMs:1});
    process.kill(process.pid,"SIGKILL");`);
  expect(result.code).not.toBe(0);
  expect(result.signal).toBe("SIGKILL");
  expect(result.error).toBe("");
  const store = new RuntimeStore(path); stores.push(store);
  const created = new RuntimeCommands(store, () => 9999).createRun({ commandId: "create", objective: "Interrupted" });
  const first = store.getTask(created.tasks[0]!.taskId)!;
  expect(first.status).toBe("running");
  expect(store.getTask(first.taskId)).toEqual(first);
  expect(store.getAttempt(first.currentAttemptId!)?.status).toBe("active");
  expect(store.events(created.run.runId)).toHaveLength(3);
  expect(() => new RuntimeCommands(store, () => 9999).startAttempt({ commandId: "new", taskId: first.taskId,
    expectedRevision: first.revision, ownerId: "new", leaseMs: 1000 })).toThrow("not ready");
});
