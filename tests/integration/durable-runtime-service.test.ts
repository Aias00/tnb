import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveDurableRuntime, runtimeRequest, runtimePaths } from "../../src/services/runtime/server";
import { createRuntimeWorkerFactory } from "../../src/services/runtime/worker";
import type { RuntimeConfiguration } from "../../src/services/runtime/engine";
import { runRuntimeCommand } from "../../src/entrypoints/runtime";
import { acquireWorkspace } from "../../src/services/runtime/workspace";

const roots: string[] = []; const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))); });
const usage = { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 };
function sse(text: string) { return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } }); }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tnb-runtime-service-")); roots.push(root);
  const configDir = join(root, "config"); const workspace = join(root, "work"); await mkdir(configDir); await mkdir(workspace);
  let requests = 0;
  const model = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return sse("service report"); } });
  cleanup.push(() => model.stop(true));
  await writeFile(join(configDir, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: `${model.url}v1`, models: [{ id: "fixture", maxTokens: 1000, pricing: { input: 1, output: 1 } }] } } }));
  const config: RuntimeConfiguration = { workspace, allowedWorkspaces: [workspace], provider: "fixture", model: "fixture", allowWrite: false, allowShell: false,
    checks: [], maxTurns: 10, maxRetries: 1, compactThreshold: 10000, maxCostUsd: 1 };
  return { root, configDir, workspace, config, modelUrl: String(model.url), requests: () => requests };
}
async function service(configDir: string) {
  const controller = new AbortController(); const ready = Promise.withResolvers<void>();
  const done = serveDurableRuntime({ configDir, env: process.env, signal: controller.signal, ready: () => ready.resolve() });
  cleanup.push(async () => { controller.abort(); await done; });
  await Promise.race([ready.promise, done.then(() => { throw new Error("service stopped before ready"); })]); return { controller, done };
}
async function terminal(configDir: string, runId: string) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const status = await runtimeRequest(configDir, `/status?runId=${runId}`) as { run: { status: string }; tasks: unknown[] };
    if (["succeeded", "failed", "paused", "cancelled"].includes(status.run.status)) return status;
    await Bun.sleep(20);
  }
  throw new Error("service task did not settle");
}

test("authenticated Unix service executes a loopback model and survives owner restart with receipt replay", async () => {
  const f = await fixture(); const first = await service(f.configDir); const paths = await runtimePaths(f.configDir);
  const unauthorized = await fetch("http://localhost/health", { unix: paths.socket }); expect(unauthorized.status).toBe(403);
  const body = { action: "submit", commandId: "service-submit", objective: "inspect", configuration: f.config };
  const submitted = await runtimeRequest(f.configDir, "/command", body) as { run: { runId: string } };
  expect((await terminal(f.configDir, submitted.run.runId)).run.status).toBe("succeeded"); expect(f.requests()).toBe(1);
  const oldToken = await readFile(paths.token, "utf8");
  first.controller.abort(); await first.done;
  await service(f.configDir);
  expect(await readFile(paths.token, "utf8")).not.toBe(oldToken);
  expect(await runtimeRequest(f.configDir, "/command", body)).toEqual(submitted);
  expect((await terminal(f.configDir, submitted.run.runId)).run.status).toBe("succeeded"); expect(f.requests()).toBe(1);
  const secondOwner = new AbortController();
  await expect(serveDurableRuntime({ configDir: f.configDir, env: process.env, signal: secondOwner.signal })).rejects.toThrow("already being held");
});

test("HTTP control command receipts survive duplicate pause, resume and cancellation", async () => {
  const f = await fixture(); await service(f.configDir);
  // Pause before a worker can advance the queue.
  const submitted = await runtimeRequest(f.configDir, "/command", { action: "submit", commandId: "control-run", objective: "control", configuration: f.config }) as { run: { runId: string } };
  const runId = submitted.run.runId;
  for (const action of ["pause", "resume", "cancel"]) {
    const command = { action, commandId: `control-${action}`, runId };
    const response = await runtimeRequest(f.configDir, "/command", command);
    expect(await runtimeRequest(f.configDir, "/command", command)).toEqual(response);
  }
  expect((await terminal(f.configDir, runId)).run.status).toBe("cancelled");
});

test("explicit start/restart preserves paused work and resumes it only after the user's command", async () => {
  const f = await fixture(); await service(f.configDir);
  const oldPid = (await runtimeRequest(f.configDir, "/health") as { pid: number }).pid;
  const release = await acquireWorkspace(f.workspace);
  let runId: string;
  try {
    const submitted = await runtimeRequest(f.configDir, "/command", { action: "submit", commandId: "restart-run", objective: "Preserve my paused work", configuration: f.config }) as { run: { runId: string } };
    runId = submitted.run.runId;
    await runtimeRequest(f.configDir, "/command", { action: "pause", commandId: "pause-restart", runId });
  } finally { await release(); }
  cleanup.push(async () => {
    try {
      await runtimeRequest(f.configDir, "/command", { action: "stop", commandId: "stop-restarted-owner" });
      const end = Date.now() + 5000;
      while (Date.now() < end) { try { await runtimeRequest(f.configDir, "/health"); await Bun.sleep(20); } catch { break; } }
    } catch { /* The test may have stopped it already. */ }
  });
  for (const action of ["start", "restart"]) {
    let output = "", error = "";
    expect(await runRuntimeCommand({ argv: ["runtime", action, "--config-dir", f.configDir], cwd: f.workspace, env: process.env,
      stdout: { write: (text) => { output += text; } }, stderr: { write: (text) => { error += text; } } })).toBe(0);
    expect(error).toBe(""); const health = JSON.parse(output);
    expect(action === "start" ? health.pid === oldPid : health.pid !== oldPid).toBe(true);
  }
  expect(f.requests()).toBe(0);
  const status = await runtimeRequest(f.configDir, `/status?runId=${runId!}`) as { run: { status: string } };
  expect(status.run.status).toBe("paused");
  await runtimeRequest(f.configDir, "/command", { action: "resume", commandId: "resume-restarted", runId: runId! });
  expect((await terminal(f.configDir, runId!)).run.status).toBe("succeeded"); expect(f.requests()).toBe(1);
}, 15000);

const nativeWorkerTest = process.platform === "darwin" || process.platform === "linux" ? test : test.skip;
nativeWorkerTest("production worker checks use native sandbox, strip model keys, and deny control state and sockets", async () => {
  const f = await fixture(); const paths = await runtimePaths(f.configDir);
  await service(f.configDir);
  const command = `test -z "$ANTHROPIC_API_KEY" && test -z "$OPENAI_API_KEY" && printf checked > checked.txt`;
  const deniedCommands = [`cat '${paths.token}'`, `/usr/bin/curl --max-time 2 '${f.modelUrl}'`, `/usr/bin/curl --max-time 2 --unix-socket '${paths.socket}' http://localhost/health`, `cat '${join(f.root, "unrelated-secret")}'`];
  await writeFile(join(f.root, "unrelated-secret"), "private");
  const resources = await createRuntimeWorkerFactory({ configDir: f.configDir, runtimeRoot: paths.root, env: { ...process.env, ANTHROPIC_API_KEY: "secret", OPENAI_API_KEY: "secret" } })({
    run: { runId: "fixture", objective: "fixture", revision: 1, status: "active", policy: { mode: "single", maxActiveAgents: 1, maxDelegationDepth: 0 }, createdAt: Date.now(), updatedAt: Date.now() },
    task: { taskId: "fixture", runId: "fixture", key: "fixture", objective: "fixture", inputDigest: "0".repeat(64), dependsOn: [], revision: 1, epoch: 1, status: "running", createdAt: Date.now(), updatedAt: Date.now() },
    configuration: { ...f.config, allowWrite: true, checks: [command, ...deniedCommands] }, signal: new AbortController().signal,
  });
  try {
    await resources.check!(command, new AbortController().signal); expect(await readFile(join(f.workspace, "checked.txt"), "utf8")).toBe("checked");
    for (const denied of deniedCommands) {
      let blocked = false; try { await resources.check!(denied, new AbortController().signal); } catch { blocked = true; }
      expect({ command: denied, blocked }).toEqual({ command: denied, blocked: true });
    }
    expect(f.requests()).toBe(0);
  } finally { await resources.close!(); }
});

test("runtime CLI submits, inspects and stops a detached owner without paid model calls", async () => {
  const f = await fixture(); const entry = join(import.meta.dir, "../../src/entrypoints/cli.ts");
  async function cli(args: string[]) {
    const process = Bun.spawn([globalThis.process.execPath, entry, "runtime", ...args, "--config-dir", f.configDir], { cwd: f.workspace, stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(15000) });
    const [code, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    expect(stderr).toBe(""); expect(code).toBe(0); return JSON.parse(stdout);
  }
  cleanup.push(async () => { try { await runtimeRequest(f.configDir, "/command", { action: "stop", commandId: "cleanup" }); } catch { /* already stopped */ } });
  const submitted = await cli(["submit", "inspect", "--provider", "fixture", "--model", "fixture"]);
  expect((await terminal(f.configDir, submitted.run.runId)).run.status).toBe("succeeded");
  expect((await cli(["status", submitted.run.runId])).run.status).toBe("succeeded");
  await cli(["stop"]);
  const end = Date.now() + 5000;
  while (Date.now() < end) { try { await runtimeRequest(f.configDir, "/health"); await Bun.sleep(25); } catch { return; } }
  throw new Error("detached owner did not stop");
}, 20000);

test("durable provider requests disable hidden transport retries so each attempt has a ledger identity", async () => {
  const f = await fixture(); let calls = 0;
  const unavailable = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { calls++; return new Response("unavailable", { status: 503 }); } });
  cleanup.push(() => unavailable.stop(true));
  await writeFile(join(f.configDir, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: `${unavailable.url}v1`, models: [{ id: "fixture" }] } } }));
  const resources = await createRuntimeWorkerFactory({ configDir: f.configDir, runtimeRoot: (await runtimePaths(f.configDir)).root, env: process.env })({
    run: { runId: "retry", objective: "retry", revision: 1, status: "active", policy: { mode: "single", maxActiveAgents: 1, maxDelegationDepth: 0 }, createdAt: 1, updatedAt: 1 },
    task: { taskId: "retry", runId: "retry", key: "retry", objective: "retry", revision: 1, epoch: 1, inputDigest: "0".repeat(64), status: "running", dependsOn: [], createdAt: 1, updatedAt: 1 },
    configuration: f.config, signal: new AbortController().signal,
  });
  try {
    const execute = async () => { for await (const _event of resources.transport.stream({ model: "fixture", messages: [], tools: [] })) {} };
    await expect(execute()).rejects.toThrow(); expect(calls).toBe(1);
  } finally { await resources.close!(); }
});
