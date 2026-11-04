import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeStore } from "../../src/services/runtime/store";
import { RuntimeCommands } from "../../src/services/runtime/commands";
import { TaskRouter, type RoutingInput } from "../../src/services/runtime/routing";

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
