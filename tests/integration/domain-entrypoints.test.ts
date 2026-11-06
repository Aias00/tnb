import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializePlugin } from "../../src/services/plugins/development";
import { installLocalPlugin } from "../../src/services/plugins/management";
import { trustPlugin, pluginTrustStorePath } from "../../src/services/plugins/trust";
import { serveDurableRuntime, runtimePaths, runtimeRequest } from "../../src/services/runtime/server";
import { runRuntimeCommand, runRuntimeChatCommand, runLongTaskChatCommand } from "../../src/entrypoints/runtime";
import { readDomainSubmission } from "../../src/services/cli/domain-submission";
import { tryAcquireResources } from "../../src/services/runtime/resources";

const roots: string[] = [], cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tnb-domain-entry-")); roots.push(root);
  const configDir = join(root, "home"); await mkdir(configDir);
  const plugin = join(root, "plugin"); await initializePlugin(plugin, "agent", "business-demo");
  const installed = await installLocalPlugin({ source: plugin, targetRoot: join(configDir, "plugins"), sourceType: "user" });
  const descriptor = JSON.parse(await readFile(join(plugin, "task.json"), "utf8"));
  const taskFile = join(root, "task.json"); await writeFile(taskFile, JSON.stringify(descriptor));
  return { root, configDir, plugin, installed, taskFile, descriptor };
}
async function owner(configDir: string) {
  const controller = new AbortController(), ready = Promise.withResolvers<void>();
  const done = serveDurableRuntime({ configDir, env: {}, signal: controller.signal, ready: () => ready.resolve() });
  cleanup.push(async () => { controller.abort(); await done; });
  await Promise.race([ready.promise, done.then(() => { throw new Error("Owner stopped before ready"); })]);
  return { async close() { controller.abort(); await done; } };
}
async function cli(configDir: string, cwd: string, args: string[]) {
  let output = "", error = "";
  const code = await runRuntimeCommand({ argv: ["runtime", ...args, "--config-dir", configDir], cwd, env: {}, stdout: { write: text => { output += text; } }, stderr: { write: text => { error += text; } } });
  return { code, output, error };
}
async function result(configDir: string, runId: string) {
  const deadline = Date.now() + 10000;
  for (;;) {
    const value = await runtimeRequest(configDir, `/status?runId=${runId}`) as any;
    if (["succeeded", "failed", "paused", "cancelled"].includes(value.run.status)) return value;
    if (Date.now() > deadline) throw new Error("Domain task timed out"); await Bun.sleep(10);
  }
}

test("invalid domain CLI input is rejected before any owner state is created", async () => {
  const f = await fixture();
  for (const extra of [["--allow-write"], ["--check", "echo forbidden"], ["--cwd", f.root], ["--mode", "invalid"], ["--max-turns", "0"], ["--max-budget-usd", "NaN"], ["--namespace", "second"]]) {
    const value = await cli(f.configDir, f.root, ["submit", "Read", "--adapter", f.taskFile, "--namespace", "support", ...extra]);
    expect(value.code).toBe(1); expect(value.error.length).toBeGreaterThan(0);
  }
  await writeFile(f.taskFile, JSON.stringify({ ...f.descriptor, grants: [{ name: "read", mode: "write", resources: ["not-claimed"] }] }));
  expect((await cli(f.configDir, f.root, ["submit", "Read", "--adapter", f.taskFile, "--namespace", "support"])).code).toBe(1);
  expect(await Bun.file(join(f.configDir, "runtime/state.sqlite")).exists()).toBe(false);
  expect((await cli(f.configDir, f.root, ["list", "--namespace"])).error).toContain("requires a value");
});

test("descriptor reads are bounded and report malformed JSON without disclosing values", async () => {
  const f = await fixture();
  for (const content of ['{"private":"fixture-secret", broken', "x".repeat(65537)]) {
    await writeFile(f.taskFile, content);
    const value = await cli(f.configDir, f.root, ["submit", "Read", "--adapter", f.taskFile, "--namespace", "support"]);
    expect(value.code).toBe(1); expect(value.error).not.toContain("fixture-secret");
  }
  await writeFile(f.taskFile, JSON.stringify(f.descriptor));
  const input = await readDomainSubmission(["submit", "Read", "--adapter", "task.json", "--namespace", "support", "--command-id", "stable", "--max-model-requests", "12"], f.root);
  expect(input.commandId).toBe("stable"); expect(input.maxModelRequests).toBe(12); expect(input.adapter).toEqual(f.descriptor);
});

const ownerTest = process.platform === "win32" ? test.skip : test;
ownerTest("default product owner installs, lists, submits and restores a business task through CLI and HTTP", async () => {
  const f = await fixture(); await trustPlugin(pluginTrustStorePath(f.configDir), f.installed.root);
  const first = await owner(f.configDir);
  const catalog = JSON.parse((await cli(f.configDir, f.root, ["adapters"])).output);
  expect(catalog.find((row: any) => row.id === "business-demo")).toMatchObject({ version: "1", submission: "domain", plugin: { name: "business-demo" } });
  expect(catalog.find((row: any) => row.id === "coding").submission).toBe("host");
  const paths = await runtimePaths(f.configDir);
  expect((await fetch("http://localhost/adapters", { unix: paths.socket })).status).toBe(403);
  expect((await fetch("http://localhost/agent-tasks", { unix: paths.socket, method: "POST", body: "{}" })).status).toBe(403);
  const args = ["submit", "Read the message", "--adapter", f.taskFile, "--namespace", "support", "--mode", "single", "--command-id", "business-1", "--no-start"];
  const response = await cli(f.configDir, f.root, args); expect(response.code, response.error).toBe(0);
  const accepted = JSON.parse(response.output);
  expect((await result(f.configDir, accepted.run.runId)).run.status).toBe("succeeded");
  const report = await runtimeRequest(f.configDir, `/result?runId=${accepted.run.runId}`);
  expect(JSON.stringify(report)).toContain("Verified: Hello from my plugin");
  const listed = JSON.parse((await cli(f.configDir, f.root, ["list", "--namespace", "support"])).output); expect(listed.map((row: any) => row.runId)).toEqual([accepted.run.runId]);
  expect(JSON.parse((await cli(f.configDir, f.root, ["list", "--namespace", "other"])).output)).toEqual([]);
  await first.close(); await owner(f.configDir);
  const replay = await cli(f.configDir, f.root, args); expect(replay.code, replay.error).toBe(0); expect(JSON.parse(replay.output)).toEqual(accepted);
  expect(await runtimeRequest(f.configDir, `/result?runId=${accepted.run.runId}`)).toEqual(report);
  const changed = await cli(f.configDir, f.root, args.map(arg => arg === "Read the message" ? "Different objective" : arg)); expect(changed.code).toBe(1); expect(changed.error).toContain("business-1");
});

ownerTest("conversation submission uses the chosen namespace, keeps origin and supports scoped controls", async () => {
  const f = await fixture(); await trustPlugin(pluginTrustStorePath(f.configDir), f.installed.root); await owner(f.configDir);
  const options = { cwd: f.root, workspace: f.root, configDir: f.configDir, env: {}, provider: "offline", model: "fixture", sessionId: "domain-conversation" };
  const submitted = await runRuntimeChatCommand({ ...options, args: ["submit", "Read", "--adapter", f.taskFile, "--namespace", "support", "--command-id", "dialogue", "--no-start"] });
  const accepted = JSON.parse(submitted.slice(submitted.indexOf("{")));
  expect((await result(f.configDir, accepted.run.runId)).run.status).toBe("succeeded");
  expect((await runtimeRequest(f.configDir, "/runs?workspace=agent%3Asupport&sessionId=domain-conversation") as any[])).toHaveLength(1);
  const routing = await runRuntimeChatCommand({ ...options, args: ["routing", "--namespace", "support"] }); expect(JSON.parse(routing)).toHaveLength(1);
  const status = JSON.parse(await runLongTaskChatCommand({ ...options, args: ["status", "--namespace", "support"] })); expect(status.run.runId).toBe(accepted.run.runId);
  const wrong = await cli(f.configDir, f.root, ["followup", accepted.run.runId, "--namespace", "other", "--text", "Wrong scope"]); expect(wrong.code).toBe(0); expect(JSON.parse(wrong.output).status).toBe("rejected");
  const resource = "ticket:" + f.root;
  const adapter = { ...f.descriptor, resources: [{ id: resource, mode: "read" }], grants: [{ name: "read", mode: "read", resources: [resource] }] };
  const release = tryAcquireResources([{ id: resource, mode: "write" }]); expect(release).toBeDefined();
  try {
    const blocked = await runtimeRequest(f.configDir, "/agent-tasks", { commandId: "blocked", objective: "Read later", namespace: "support", adapter, mode: "single" }) as any;
    expect((await cli(f.configDir, f.root, ["pause", blocked.run.runId])).code).toBe(0);
    const followup = await cli(f.configDir, f.root, ["followup", blocked.run.runId, "--namespace", "support", "--text", "Keep the message evidence"]);
    expect(followup.code, followup.error).toBe(0); expect(JSON.parse(followup.output).status).toBe("accepted");
  } finally { release?.(); }
});

ownerTest("namespace questions notify through the existing stream and survive owner restart", async () => {
  const f = await fixture(); const entry = join(f.installed.root, "index.mjs");
  const code = await readFile(entry, "utf8");
  await writeFile(entry, code.replace('        } else {\n          yield { type: "text"', `        } else if (!request.messages.some(row => row.content.some(block => block.type === "tool-result" && block.toolUseId === "decision"))) {
          yield { type: "tool-start", index: 0, id: "decision", name: "durable_wait" };
          yield { type: "tool-input", index: 0, json: JSON.stringify({ kind: "question", key: "decision", about: "Business review", question: "Proceed?", options: ["yes", "no"] }) };
          yield { type: "response-end", reason: "tool-use" };
        } else {
          yield { type: "text"`));
  await trustPlugin(pluginTrustStorePath(f.configDir), f.installed.root); const first = await owner(f.configDir);
  const submitted = await cli(f.configDir, f.root, ["submit", "Review", "--adapter", f.taskFile, "--namespace", "support", "--mode", "single", "--command-id", "question", "--no-start"]);
  expect(submitted.code, submitted.error).toBe(0); const runId = JSON.parse(submitted.output).run.runId;
  let questions: any[] = []; const deadline = Date.now() + 10000;
  while (!questions.length) { questions = await runtimeRequest(f.configDir, `/questions?runId=${runId}`) as any[]; if (Date.now() > deadline) throw new Error("No domain question"); await Bun.sleep(10); }
  const paths = await runtimePaths(f.configDir), token = await readFile(paths.token, "utf8");
  for (const namespace of ["support", "other"]) {
    const controller = new AbortController();
    const response = await fetch(`http://localhost/attention?workspace=${encodeURIComponent("agent:" + namespace)}`, { unix: paths.socket, headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
    const reader = response.body!.getReader();
    try { const first = await reader.read(); expect(new TextDecoder().decode(first.value).includes("Proceed?")).toBe(namespace === "support"); }
    finally { controller.abort(); await reader.cancel().catch(() => {}); }
  }
  await first.close(); await owner(f.configDir);
  const restored = await runtimeRequest(f.configDir, `/questions?runId=${runId}`) as any[];
  expect(restored[0].waitId).toBe(questions[0].waitId);
  const answer = await cli(f.configDir, f.root, ["answer", runId, "--question", restored[0].waitId, "--answer", "yes", "--version", String(restored[0].version), "--command-id", "answer"]);
  expect(answer.code, answer.error).toBe(0); expect((await result(f.configDir, runId)).run.status).toBe("succeeded");
});

ownerTest("untrusted/disabled adapters and invalid domain configuration cannot create tasks", async () => {
  const f = await fixture(); const first = await owner(f.configDir);
  const input = { commandId: "untrusted", objective: "Read", namespace: "support", adapter: f.descriptor };
  const attempt = async (body: unknown) => runtimeRequest(f.configDir, "/agent-tasks", body).then(() => null, error => error);
  expect((await attempt(input)).message).toContain("unavailable");
  expect(await runtimeRequest(f.configDir, "/runs")).toEqual([]);
  await first.close(); await trustPlugin(pluginTrustStorePath(f.configDir), f.installed.root); const second = await owner(f.configDir);
  expect((await attempt({ ...input, adapter: { ...f.descriptor, config: {} } })).message).toContain("config.message");
  expect((await attempt({ ...input, extra: true })).message).toContain("Unknown Agent task field");
  expect(await runtimeRequest(f.configDir, "/runs")).toEqual([]);
  await second.close(); await writeFile(join(f.configDir, "settings.json"), JSON.stringify({ enabledPlugins: { "business-demo": false } })); await owner(f.configDir);
  expect((await attempt(input)).message).toContain("unavailable"); expect(await runtimeRequest(f.configDir, "/runs")).toEqual([]);
});

ownerTest("upgrades/disable preserve exact receipts while refusing fresh retained-generation submissions", async () => {
  const f = await fixture(); await trustPlugin(pluginTrustStorePath(f.configDir), f.installed.root); const first = await owner(f.configDir);
  const previous = (await runtimeRequest(f.configDir, "/adapters") as any[]).find(row => row.id === "business-demo").plugin;
  const args = ["submit", "Read", "--adapter", f.taskFile, "--namespace", "support", "--mode", "single", "--command-id", "original", "--no-start"];
  const submitted = await cli(f.configDir, f.root, args); expect(submitted.code, submitted.error).toBe(0);
  const accepted = JSON.parse(submitted.output); expect((await result(f.configDir, accepted.run.runId)).run.status).toBe("succeeded"); await first.close();
  const manifest = JSON.parse(await readFile(join(f.installed.root, "plugin.json"), "utf8")); manifest.version = "0.2.0";
  await writeFile(join(f.installed.root, "plugin.json"), JSON.stringify(manifest));
  await writeFile(join(f.installed.root, "index.mjs"), await readFile(join(f.installed.root, "index.mjs"), "utf8") + "\n// new generation\n");
  await trustPlugin(pluginTrustStorePath(f.configDir), f.installed.root); const second = await owner(f.configDir);
  const current = (await runtimeRequest(f.configDir, "/adapters") as any[]).filter(row => row.id === "business-demo");
  expect(current).toHaveLength(1); expect(current[0].plugin.version).toBe("0.2.0"); expect(current[0].plugin.fingerprint).not.toBe(previous.fingerprint);
  const replay = await cli(f.configDir, f.root, args); expect(replay.code, replay.error).toBe(0); expect(JSON.parse(replay.output)).toEqual(accepted);
  const stale = await runtimeRequest(f.configDir, "/agent-tasks", { commandId: "fresh-old", objective: "Read", namespace: "support", adapter: { ...f.descriptor, plugin: previous } }).then(() => null, error => error);
  expect(stale).toBeInstanceOf(Error); expect(await runtimeRequest(f.configDir, "/runs")).toHaveLength(1);
  await second.close(); await writeFile(join(f.configDir, "settings.json"), JSON.stringify({ enabledPlugins: { "business-demo": false } })); await owner(f.configDir);
  const receipt = await cli(f.configDir, f.root, args); expect(receipt.code, receipt.error).toBe(0); expect(JSON.parse(receipt.output)).toEqual(accepted);
  const fresh = await cli(f.configDir, f.root, args.map(value => value === "original" ? "new-disabled" : value)); expect(fresh.code).toBe(1);
  expect(await runtimeRequest(f.configDir, "/runs")).toHaveLength(1);
});

ownerTest("older owners require explicit restart and cannot receive a fallback Coding submission", async () => {
  const f = await fixture(), paths = await runtimePaths(f.configDir); await writeFile(paths.token, "fixture-token", { mode: 0o600 });
  let submissions = 0;
  const server = Bun.serve({ unix: paths.socket, fetch(request) { if (new URL(request.url).pathname !== "/health") submissions++; return Response.json({ ready: true, capabilities: {} }); } });
  cleanup.push(async () => { await server.stop(true); });
  const submitted = await cli(f.configDir, f.root, ["submit", "Read", "--adapter", f.taskFile, "--namespace", "support"]);
  expect(submitted.code).toBe(1); expect(submitted.error).toContain("restart");
  const catalog = await cli(f.configDir, f.root, ["adapters"]); expect(catalog.code).toBe(1); expect(catalog.error).toContain("restart"); expect(submissions).toBe(0);
});
