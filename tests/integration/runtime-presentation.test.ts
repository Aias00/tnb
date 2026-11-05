import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeStore } from "../../src/services/runtime/store";
import { DurableRuntime, type RuntimeConfiguration } from "../../src/services/runtime/engine";
import { serveDurableRuntime, runtimeRequest } from "../../src/services/runtime/server";
import { DurableQuestionInbox } from "../../src/services/runtime/attention";
import { acquireWorkspace } from "../../src/services/runtime/workspace";
import { presentRun, presentRunDetail } from "../../src/services/runtime/presentation";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function until(test: () => boolean) { const end = Date.now() + 8000; while (!test()) { if (Date.now() > end) throw new Error("Presentation timeout"); await Bun.sleep(10); } }
function* report() { yield { type: "text" as const, index: 0, text: "Verified report" }; yield { type: "response-end" as const, reason: "end-turn" as const }; }
async function fixture(check?: (command: string) => Promise<string>) {
  const root = await mkdtemp(join(tmpdir(), "tnb-presentation-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "work"), other = join(root, "other"); await mkdir(workspace); await mkdir(other);
  const configDir = join(root, "config"), state = join(configDir, "runtime"), store = new RuntimeStore(join(state, "state.sqlite")); cleanup.push(async () => store.close());
  const runtime = new DurableRuntime(store, state, async () => ({ model: "fixture", transport: { async *stream() { yield* report(); } }, tools: [],
    route: { provider: "fixture", model: "fixture" }, maxOutputTokens: 128, authorize: async () => ({ behavior: "allow" }), check }));
  const controller = new AbortController(), ready = Promise.withResolvers<void>(); const serving = serveDurableRuntime({ configDir, runtime, env: process.env, signal: controller.signal, ready: () => ready.resolve() });
  cleanup.push(async () => { controller.abort(); await serving; }); await ready.promise;
  const configuration: RuntimeConfiguration = { workspace, allowedWorkspaces: [workspace], allowWrite: false, allowShell: false, checks: [], maxTurns: 8, maxRetries: 0, compactThreshold: 10000 };
  return { root, workspace, other, configDir, runtime, store, configuration };
}
test("live presentation and controls remain workspace scoped; saved followups are distinct from delivery and completion", async () => {
  const f = await fixture(), release = await acquireWorkspace(f.workspace); let released = false; cleanup.push(async () => { if (!released) await release(); });
  const { run } = await f.runtime.submit({ commandId: "create", objective: "Inspect", configuration: f.configuration, mode: "single" });
  f.runtime.commands.pauseRun({ commandId: "pause", runId: run.runId, expectedRevision: run.revision });
  let workspace = f.workspace; const inbox = new DurableQuestionInbox({ configDir: f.configDir, workspace: () => workspace }); inbox.start(); cleanup.push(() => inbox.close());
  await until(() => inbox.runs().length === 1 && inbox.connection().state === "online");
  expect(inbox.runs()[0]!.phase).toBe("用户暂停");
  await inbox.followup(run.runId, "Keep compatibility", "input"); await until(() => inbox.runs()[0]!.inputs.length === 1);
  expect(inbox.runs()[0]!.inputs[0]!.state).toBe("pending"); expect(inbox.runs()[0]!.status).toBe("paused");
  await expect(runtimeRequest(f.configDir, `/presentation?workspace=${encodeURIComponent(f.other)}&runId=${run.runId}`)).rejects.toThrow("workspace");
  await inbox.control(run.runId, "resume", inbox.runs()[0]!.revision, "resume"); await release(); released = true;
  await until(() => inbox.runs()[0]?.status === "succeeded");
  expect(inbox.runs()[0]!.inputs[0]!.state).toBe("delivered");
  expect(inbox.runs()[0]!.budget.priced).toBe(false);
  expect((await inbox.inspect(run.runId)).acceptance).toBe("report-delivered");
  workspace = f.other;
  await expect(inbox.followup(run.runId, "Must not reach old task", "different-project")).rejects.toThrow("工作区");
});
test("verification counts come from completed checks and presentation reads do not change the business state", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const f = await fixture(async (command) => { if (command === "check-one") { entered.resolve(); await release.promise; } return "passed"; });
  const { run } = await f.runtime.submit({ commandId: "create", objective: "Deliver", configuration: { ...f.configuration, allowWrite: true, checks: ["check-one", "check-two"] }, mode: "single" });
  await entered.promise;
  const revision = f.store.getRun(run.runId)!.revision, events = f.store.events(run.runId).length;
  expect(presentRun(f.runtime, run.runId).phase).toBe("验收 0/2");
  expect(f.store.getRun(run.runId)!.revision).toBe(revision); expect(f.store.events(run.runId)).toHaveLength(events);
  release.resolve(); await until(() => f.store.getRun(run.runId)?.status === "succeeded");
  const detail = await presentRunDetail(f.runtime, run.runId);
  expect(detail.acceptance).toBe("verification-commands"); expect(detail.checks.map((check) => check.command)).toEqual(["check-one", "check-two"]);
});
