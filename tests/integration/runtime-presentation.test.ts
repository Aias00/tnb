import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeStore } from "../../src/services/runtime/store";
import { DurableRuntime, type RuntimeConfiguration } from "../../src/services/runtime/engine";
import { serveDurableRuntime, runtimeRequest } from "../../src/services/runtime/server";
import { DurableQuestionInbox } from "../../src/services/runtime/attention";
import { acquireWorkspace } from "../../src/services/runtime/workspace";
import { presentRun, presentRunDetail } from "../../src/services/runtime/presentation";
import { saveChannelBinding } from "../../src/agent/channel-bindings";
import { COLLABORATION_CHANNEL_OWNER } from "../../src/services/collaboration/channels";
import { sourceIdentity } from "../../src/services/collaboration/config";
import { runRuntimeCommand, runRuntimeChatCommand } from "../../src/entrypoints/runtime";
import type { PluginReferenceReport } from "../../src/agent/plugin-references";
import type { PluginRecoveryReport } from "../../src/agent/plugin-recovery";
import type { Source } from "../../src/services/collaboration/types";
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

test("plugin reference API, CLI and slash command use live bindings and the owner's effective configuration", async () => {
  const f = await fixture();
  const before = await runtimeRequest(f.configDir, "/plugins/references") as PluginReferenceReport;
  expect(before.generations).toEqual([]);
  expect(before.collection.status).toBe("completed");
  const descriptor = { id: "retired-channel", version: "1", plugin: { name: "retained-channel", version: "1.0.0", fingerprint: "a".repeat(64) } };
  const source: Source = { id: "archived", type: "plugin", channel: descriptor, options: {}, actors: ["alice"], controllers: ["alice"], mode: "single", pollIntervalMs: 1000, configuration: f.configuration };
  saveChannelBinding(f.store, { owner: COLLABORATION_CHANNEL_OWNER, key: source.id, transport: sourceIdentity(source), descriptor });
  // This change is not effective until restart. A report must not re-read disk intent as owner policy.
  await writeFile(join(f.configDir, "collaboration.json"), JSON.stringify({ enabled: true, sources: [source] }));
  let output = "", error = "";
  expect(await runRuntimeCommand({ argv: ["runtime", "plugins", "--references", "--config-dir", f.configDir], cwd: f.workspace, env: {},
    stdout: { write(value) { output += value; } }, stderr: { write(value) { error += value; } } })).toBe(0);
  expect(error).toBe("");
  const report: PluginReferenceReport = JSON.parse(output);
  expect(report.inventory).toEqual({ domains: "complete", channels: "complete" });
  expect(report.generations[0]).toMatchObject({ retain: true, load: false, implementations: [], references: [{ kind: "channel", owner: COLLABORATION_CHANNEL_OWNER, key: "archived", load: false }] });
  const slash = await runRuntimeChatCommand({ args: ["plugins", "--references"], configDir: f.configDir, cwd: f.workspace, workspace: f.workspace, env: {}, provider: "fixture", model: "fixture", sessionId: "session" });
  expect(JSON.parse(slash)).toEqual(report);
  expect(await runtimeRequest(f.configDir, "/plugins/references")).toEqual(report);
  expect(Array.isArray(await runtimeRequest(f.configDir, "/plugins"))).toBe(true); // Existing inventory API stays compatible.
  output = "";
  expect(await runRuntimeCommand({ argv: ["runtime", "plugins", "--check", "--config-dir", f.configDir], cwd: f.workspace, env: {},
    stdout: { write(value) { output += value; } }, stderr: { write(value) { error += value; } } })).toBe(0);
  const recovery: PluginRecoveryReport = JSON.parse(output);
  expect(recovery.status).toBe("issues-found");
  expect(recovery.references).toEqual(report);
  expect(recovery.generations[0]?.diagnostics[0]?.code).toBe("PLUGIN_ARCHIVE_MISSING");
  expect(await runtimeRequest(f.configDir, "/plugins/recovery")).toEqual(recovery);
  expect(JSON.parse(await runRuntimeChatCommand({ args: ["plugins", "--check"], configDir: f.configDir, cwd: f.workspace, workspace: f.workspace, env: {}, provider: "fixture", model: "fixture", sessionId: "session" }))).toEqual(recovery);
  await expect(runRuntimeChatCommand({ args: ["plugins", "--check", "--references"], configDir: f.configDir, cwd: f.workspace, workspace: f.workspace, env: {}, provider: "fixture", model: "fixture", sessionId: "session" })).rejects.toThrow("Choose --check or --references");
});
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
