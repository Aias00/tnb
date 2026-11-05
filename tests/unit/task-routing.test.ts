import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeStore } from "../../src/services/runtime/store";
import { RuntimeCommands } from "../../src/services/runtime/commands";
import { TaskRouter, type RoutingInput } from "../../src/services/runtime/routing";
import { Database } from "bun:sqlite";

const stores: RuntimeStore[] = []; const roots: string[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
function fixture(store = new RuntimeStore(":memory:")) {
  stores.push(store); const commands = new RuntimeCommands(store); const router = new TaskRouter(store);
  const workspace = "/fixture/project";
  const create = (id: string, directory = workspace) => commands.createRun({ commandId: id, objective: `Task ${id}`,
    configuration: { workspace: directory, originSessionId: "old-chat", allowWrite: false, allowShell: false },
    source: { inputId: id, rawText: `Original ${id}`, workspace: directory, source: "cli" } });
  const source = (id: string, rawText = "补充：保留兼容性"): RoutingInput => ({ inputId: id, rawText, workspace, source: "conversation", sessionId: "new-chat" });
  return { store, commands, router, workspace, create, source };
}

test("submit atomically records original input and identity conflicts roll back the entire new Run", () => {
  const f = fixture(); const first = f.create("original");
  expect(f.store.route<{ rawText: string; runId: string }>("original")).toMatchObject({ rawText: "Original original", runId: first.run.runId });
  expect(() => f.commands.createRun({ commandId: "conflicting-command", objective: "New work", source: f.source("original", "Different input") })).toThrow("identity");
  expect(f.store.runs()).toHaveLength(1);
});

test("ambiguous followup persists without mutating candidates; resolution survives SQLite reopen and retains the original input", async () => {
  const root = await mkdtemp(join(tmpdir(), "tnb-routing-")); roots.push(root); const path = join(root, "state.sqlite");
  let f = fixture(new RuntimeStore(path)); const a = f.create("a"), b = f.create("b");
  const source = f.source("follow-original");
  const decision = f.router.followup({ commandId: "ambiguous", source });
  expect(decision.status).toBe("clarify"); expect(decision.candidates).toHaveLength(2);
  expect(f.store.records("task-input", a.run.runId)).toHaveLength(0); expect(f.store.records("task-input", b.run.runId)).toHaveLength(0);
  expect(f.store.getTask(a.tasks[0]!.taskId)?.revision).toBe(1);
  f.store.close(); f = fixture(new RuntimeStore(path));
  const resolved = f.router.followup({ commandId: "choice", source: f.source("selection", "Choose task A"), runId: a.run.runId,
    resolveInputId: decision.inputId, expectedRevision: decision.revision });
  expect(resolved).toMatchObject({ status: "accepted", rawText: source.rawText, runId: a.run.runId, revision: 2 });
  const inputs = f.store.records<{ text: string; state: string }>("task-input", a.run.runId);
  expect(inputs).toHaveLength(1); expect(inputs[0]!.value).toMatchObject({ text: source.rawText, state: "pending" });
  expect(f.store.getTask(a.tasks[0]!.taskId)?.inputRevision).toBe(1);
  expect(() => f.router.followup({ commandId: "other-choice", source: f.source("other"), runId: b.run.runId,
    resolveInputId: decision.inputId, expectedRevision: 1 })).toThrow("already decided");
});

test("input identity, not matching text, controls dedup; different payloads cannot reuse an accepted identity", () => {
  const f = fixture(); const { run } = f.create("a");
  const one = f.router.followup({ commandId: "one", source: f.source("input-one"), runId: run.runId });
  expect(f.router.followup({ commandId: "retry", source: f.source("input-one"), runId: run.runId })).toEqual(one);
  f.router.followup({ commandId: "new-event", source: f.source("input-two"), runId: run.runId });
  expect(f.store.records("task-input", run.runId)).toHaveLength(2);
  expect(() => f.router.followup({ commandId: "tamper", source: f.source("input-one", "Other requirement"), runId: run.runId })).toThrow("identity conflict");
});

test("paused targets receive pending input without resuming; terminal and other-workspace targets are rejected", () => {
  const f = fixture(); const a = f.create("a"), other = f.create("other", "/different");
  const paused = f.commands.pauseRun({ commandId: "pause", runId: a.run.runId, expectedRevision: 1 });
  expect(f.router.followup({ commandId: "paused-input", source: f.source("p"), runId: a.run.runId }).status).toBe("accepted");
  expect(f.store.getRun(a.run.runId)?.status).toBe("paused");
  expect(f.router.followup({ commandId: "outside", source: f.source("o"), runId: other.run.runId }).reason).toBe("target-outside-workspace");
  f.commands.cancelRun({ commandId: "cancel", runId: a.run.runId, expectedRevision: paused.revision });
  expect(f.router.followup({ commandId: "late", source: f.source("late"), runId: a.run.runId }).status).toBe("rejected");
  expect(f.store.record<{ allowWrite: boolean }>("configuration", a.run.runId)?.value.allowWrite).toBe(false);
});

test("routing identities cannot cross conversations or workspaces and resolutions retain their original candidate scope", () => {
  const f = fixture(); f.create("a"); f.create("b");
  const source = f.source("control");
  f.router.clarifyControl({ commandId: "control", source, action: "cancel" });
  for (const changed of [{ ...source, workspace: "/different" }, { ...source, sessionId: "another-chat" }]) {
    expect(() => f.router.clarifyControl({ commandId: `control-${changed.workspace}-${changed.sessionId}`, source: changed, action: "cancel" })).toThrow("identity conflict");
  }
  const decision = f.router.followup({ commandId: "ambiguous", source: f.source("followup") });
  const later = f.create("later");
  expect(() => f.router.followup({ commandId: "outside-question", source: f.source("choice"), runId: later.run.runId,
    resolveInputId: decision.inputId, expectedRevision: decision.revision })).toThrow("original question scope");
  expect(() => f.router.followup({ commandId: "cross-session", source: { ...f.source("followup"), sessionId: "another-chat" } })).toThrow("identity conflict");
  expect(() => f.router.clarifyControl({ commandId: "invalid-revision", source: { ...f.source("invalid"), resolutionRevision: 0 }, action: "cancel" })).toThrow();
  expect(f.store.records("task-input", later.run.runId)).toHaveLength(0);
});

test("SIGKILL after routing commit preserves the input, decision and one delivery intent", async () => {
  const root = await mkdtemp(join(tmpdir(), "tnb-route-kill-")); roots.push(root);
  const path = join(root, "state.sqlite");
  const storeModule = join(import.meta.dir, "../../src/services/runtime/store.ts"), commandsModule = join(import.meta.dir, "../../src/services/runtime/commands.ts"), routerModule = join(import.meta.dir, "../../src/services/runtime/routing.ts");
  const code = `import {RuntimeStore} from ${JSON.stringify(storeModule)};
    import {RuntimeCommands} from ${JSON.stringify(commandsModule)}; import {TaskRouter} from ${JSON.stringify(routerModule)};
    const store=new RuntimeStore(${JSON.stringify(path)});
    const created=new RuntimeCommands(store).createRun({commandId:'create',objective:'Original task',configuration:{workspace:'/fixture/project'}});
    new TaskRouter(store).followup({commandId:'route',runId:created.run.runId,source:{inputId:'kill-input',workspace:'/fixture/project',rawText:'Preserve committed input',source:'api'}});
    process.kill(process.pid,'SIGKILL');`;
  const child = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).not.toBe(0);
  const f = fixture(new RuntimeStore(path)); const run = f.store.runs()[0]!;
  expect(f.store.route<{ status: string }>("kill-input")?.status).toBe("accepted");
  expect(f.store.records("task-input", run.runId)).toHaveLength(1);
  f.router.followup({ commandId: "retry-after-kill", runId: run.runId, source: { inputId: "kill-input", workspace: "/fixture/project", rawText: "Preserve committed input", source: "api" } });
  expect(f.store.records("task-input", run.runId)).toHaveLength(1);
  expect(f.store.tasks(run.runId)[0]!.inputRevision).toBe(1);
});

test("full routing history permits controls; terminal pruning frees payload space but retains durable input tombstones", async () => {
  const root = await mkdtemp(join(tmpdir(), "tnb-route-capacity-")); roots.push(root); const path = join(root, "state.sqlite");
  const f = fixture(new RuntimeStore(path)); const { run } = f.create("original");
  f.store.command("fill", { kind: "fixture" }, Date.now(), (tx) => {
    for (let index = 0; index < 9999; index++) tx.saveRoute(`history-${index}`, f.workspace, { inputId: `history-${index}`, runId: run.runId, status: "accepted" });
    return true;
  });
  expect(() => f.create("new-work")).toThrow("Routing history capacity reached");
  const paused = f.commands.pauseRun({ commandId: "pause-full", runId: run.runId, expectedRevision: run.revision, source: f.source("pause-full") });
  expect(paused.status).toBe("paused");
  expect(f.router.clarifyControl({ commandId: "clarify-full", source: f.source("clarify-full"), action: "cancel" }).status).toBe("clarify");
  const cancelling = f.commands.cancelRun({ commandId: "cancel-full", runId: run.runId, expectedRevision: paused.revision, source: f.source("cancel-full") });
  f.store.command("drain", { kind: "fixture" }, Date.now(), (tx) => { tx.saveRun({ ...cancelling, status: "cancelled", revision: cancelling.revision + 1 }, cancelling.revision); return true; });
  f.store.deleteTerminalRun(run.runId); f.store.close();
  const restored = fixture(new RuntimeStore(path));
  expect(restored.store.routes(restored.workspace)).toHaveLength(1); // Unresolved routing questions are never pruned implicitly.
  expect(() => restored.commands.createRun({ commandId: "reuse-retired-input", objective: "Must not restart old work",
    source: { inputId: "original", rawText: "Original original", workspace: restored.workspace, source: "cli" } })).toThrow("pruned");
  expect(restored.store.runs()).toHaveLength(0);
  expect(restored.create("fresh-event").run.status).toBe("active");
});

test("pending routing has an independent bounded cursor and cannot be buried by newer accepted history", () => {
  const f = fixture(); f.create("a"); f.create("b");
  for (let index = 0; index < 3; index++) f.router.followup({ commandId: `question-${index}`, source: f.source(`question-${index}`) });
  f.store.command("recent", { kind: "fixture" }, Date.now(), (tx) => { for (let index = 0; index < 300; index++) tx.saveRoute(`recent-${index}`, f.workspace, { inputId: `recent-${index}`, status: "accepted" }); return true; });
  expect(f.store.routes<{ inputId: string }>(f.workspace)[0]!.inputId).toBe("question-2");
  const page = f.store.routes<{ inputId: string }>(f.workspace, { pendingOnly: true, limit: 2 });
  expect(page.map((row) => row.inputId)).toEqual(["question-2", "question-1"]);
  expect(f.store.routes<{ inputId: string }>(f.workspace, { pendingOnly: true, beforeInputId: page[1]!.inputId })).toEqual([expect.objectContaining({ inputId: "question-0" })]);
  expect(() => f.store.routes("/different", { pendingOnly: true, beforeInputId: "question-1" })).toThrow("workspace");
  f.store.command("old-unactionable", { kind: "fixture" }, Date.now(), (tx) => { for (let index = 0; index < 300; index++) tx.saveRoute(`unactionable-${index}`, f.workspace, { inputId: `unactionable-${index}`, status: "clarify", candidates: [] }); return true; });
  expect(f.store.routes<{ inputId: string }>(f.workspace, { pendingOnly: true, actionableOnly: true, limit: 2 }).map((row) => row.inputId)).toEqual(["question-2", "question-1"]);
});

test("schema v3 routing migrates without losing pending decisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "tnb-route-migrate-")); roots.push(root); const path = join(root, "state.sqlite");
  const f = fixture(new RuntimeStore(path)); f.create("a"); f.create("b");
  f.router.followup({ commandId: "question", source: f.source("question") }); f.store.close();
  const legacy = new Database(path); legacy.exec("DROP TABLE routing_tombstones; DROP INDEX routing_pending; PRAGMA user_version=3"); legacy.close();
  const next = fixture(new RuntimeStore(path));
  expect(next.store.routes<{ status: string }>(next.workspace, { pendingOnly: true })[0]!.status).toBe("clarify");
  const db = new Database(path, { readonly: true });
  try { expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 4 }); expect(db.query("SELECT COUNT(*) AS n FROM routing_tombstones").get()).toEqual({ n: 0 }); } finally { db.close(); }
});
