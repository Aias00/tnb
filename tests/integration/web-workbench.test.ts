import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DurableRuntime } from "../../src/services/runtime/engine";
import { RuntimeStore } from "../../src/services/runtime/store";
import { runtimeRequest, serveDurableRuntime } from "../../src/services/runtime/server";
import { runWebCommand } from "../../src/entrypoints/web";
import type { ModelTransport } from "../../src/providers/types";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const ownerTest = test.skipIf(process.platform === "win32");
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tnb-web-owner-"))); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "work"), other = join(root, "other"), configDir = join(root, "config");
  await mkdir(workspace); await mkdir(other); await mkdir(configDir);
  await writeFile(join(configDir, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", apiKey: "never-expose-provider-key", baseUrl: "http://127.0.0.1:1/v1", models: [{ id: "fixture", maxTokens: 4096 }] } } }));
  let requests = 0;
  const transport: ModelTransport = { async *stream(request) {
    if (++requests === 1) {
      yield { type: "tool-start", index: 0, id: "question", name: "durable_wait" };
      yield { type: "tool-input", index: 0, json: JSON.stringify({ kind: "question", key: "database", question: "选择数据库", options: ["SQLite", "其他"], about: "已核对需求，等待选择" }) };
      yield { type: "response-end", reason: "tool-use" };
    } else {
      expect(JSON.stringify(request.messages)).toContain("SQLite");
      yield { type: "text", index: 0, text: "SQLite 方案已确认 <script>globalThis.pwned=true</script>" }; yield { type: "response-end", reason: "end-turn" };
    }
  } };
  async function start() {
    const state = join(configDir, "runtime"), store = new RuntimeStore(join(state, "state.sqlite"));
    const runtime = new DurableRuntime(store, state, async () => ({ model: "fixture", transport, tools: [], authorize: async () => ({ behavior: "allow" }), route: { provider: "fixture", model: "fixture" }, maxOutputTokens: 4096 }));
    const controller = new AbortController(), ready = Promise.withResolvers<void>();
    const done = serveDurableRuntime({ configDir, env: {}, runtime, signal: controller.signal, ready: () => ready.resolve() });
    await Promise.race([ready.promise, done.then(() => { throw new Error("Service exited"); })]);
    let closed = false; const close = async () => { if (!closed) { closed = true; controller.abort(); await done; store.close(); } }; cleanup.push(close);
    return { runtime, store, close };
  }
  return { root, workspace, other, configDir, start, requests: () => requests };
}
async function launch(f: Awaited<ReturnType<typeof fixture>>, workspace = f.workspace) {
  let output = "", error = "";
  expect(await runWebCommand({ argv: ["web", "--json", "--no-start", "--config-dir", f.configDir, "--cwd", workspace], cwd: workspace, env: {}, stdout: { write: value => { output += value; } }, stderr: { write: value => { error += value; } } })).toBe(0); expect(error).toBe("");
  const link = JSON.parse(output), url = new URL(link.url), base = url.origin + url.pathname;
  const response = await fetch(base + "auth/exchange", { method: "POST", headers: { origin: url.origin, "content-type": "application/json" }, body: JSON.stringify({ code: new URLSearchParams(url.hash.slice(1)).get("code") }) });
  expect(response.status).toBe(200); const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  const get = async (path: string) => { const response = await fetch(base + path, { headers: { cookie } }); if (!response.ok) throw new Error(await response.text()); return response.json(); };
  const command = (input: unknown) => fetch(base + "api/command", { method: "POST", headers: { cookie, origin: url.origin, "content-type": "application/json" }, body: JSON.stringify(input) });
  return { link, base, cookie, get, command };
}
async function until(predicate: () => boolean) { const end = Date.now() + 8000; while (!predicate()) { if (Date.now() > end) throw new Error("Web task timed out"); await Bun.sleep(10); } }

ownerTest("web plugin submits once, pushes versioned questions, accepts an answer and restores the same Run after restart", async () => {
  const f = await fixture(), first = await f.start(), view = await launch(f);
  const info = await view.get("api/info"); expect(JSON.stringify(info)).not.toContain("never-expose-provider-key");
  const key = await readFile(join(f.configDir, "runtime", "control.key"), "utf8"); expect(view.link.url).not.toContain(key.trim());
  const input = { action: "submit", commandId: "web-task", objective: "确定数据库方案", provider: "fixture", model: "fixture", mode: "single" };
  const accepted = await (await view.command(input)).json() as any;
  expect((await (await view.command(input)).json() as any).run.runId).toBe(accepted.run.runId); expect(first.store.runs()).toHaveLength(1);
  await until(() => first.runtime.waits.questions(accepted.run.runId).length > 0);
  const stream = await fetch(view.base + "api/attention", { headers: { cookie: view.cookie } }), reader = stream.body!.getReader();
  const snapshot = JSON.parse(new TextDecoder().decode((await reader.read()).value).split("data: ")[1]!.trim());
  const question = snapshot.questions[0]; expect(question.proposal.question).toBe("选择数据库"); await reader.cancel();
  const answer = { action: "answer", commandId: "answer-task", runId: accepted.run.runId, waitId: question.waitId, expectedVersion: question.version, answer: "SQLite" };
  expect((await view.command(answer)).status).toBe(200);
  await until(() => first.store.getRun(accepted.run.runId)?.status === "succeeded");
  expect((await view.get("api/runs/" + accepted.run.runId)).report).toContain("SQLite 方案已确认");
  const other = await launch(f, f.other); expect(await other.get("api/runs")).toEqual([]);
  expect((await other.command({ action: "cancel", commandId: "cross-workspace", runId: accepted.run.runId, expectedRevision: 1 })).status).toBe(400);
  for (const field of ["workspace", "configuration", "source", "allowedWorkspaces"]) expect((await view.command({ ...input, commandId: "forged-" + field, [field]: f.other })).status).toBe(400);
  expect(first.store.runs()).toHaveLength(1); await first.close();
  const second = await f.start(), reopened = await launch(f); expect((await reopened.get("api/runs"))[0].runId).toBe(accepted.run.runId);
  expect(f.requests()).toBe(2); expect(second.store.runs()).toHaveLength(1);
});

test("web help validates without loading an owner or model configuration", async () => {
  let output = "";
  expect(await runWebCommand({ argv: ["web", "--help"], cwd: "/does-not-exist", env: {}, stdout: { write: value => { output += value; } }, stderr: { write() {} } })).toBe(0);
  expect(output).toContain("--cwd"); expect(output).toContain("60 seconds");
});

ownerTest("a disabled web interface has no fallback listener", async () => {
  const f = await fixture(); await writeFile(join(f.configDir, "settings.json"), JSON.stringify({ enabledPlugins: { "tnb-web": false } })); await f.start();
  const extensions = await runtimeRequest(f.configDir, "/extensions") as Array<{ id: string }>;
  expect(extensions.some(item => item.id === "web")).toBe(false);
  let error = ""; expect(await runWebCommand({ argv: ["web", "--no-start", "--config-dir", f.configDir], cwd: f.workspace, env: {}, stdout: { write() {} }, stderr: { write: value => { error += value; } } })).toBe(1); expect(error).toContain("Web plugin unavailable");
});

ownerTest("an installed web package uses ordinary trust, grants and lifecycle instead of a built-in fallback", async () => {
  const f = await fixture(), packageDir = join(f.root, "package"); await mkdir(packageDir);
  const { cp } = await import("node:fs/promises"), { fileURLToPath } = await import("node:url");
  const { installLocalPlugin } = await import("../../src/services/plugins/management"), { trustPlugin, pluginTrustStorePath } = await import("../../src/services/plugins/trust");
  const built = await Bun.build({ entrypoints: [fileURLToPath(new URL("../../src/plugins/web/plugin.ts", import.meta.url))], target: "bun", outdir: packageDir, naming: "index.mjs" }); expect(built.success).toBe(true);
  await cp(new URL("../../src/plugins/web/plugin.json", import.meta.url), join(packageDir, "plugin.json"));
  const installed = await installLocalPlugin({ source: packageDir, targetRoot: join(f.configDir, "plugins"), sourceType: "user" });
  let owner = await f.start();
  expect((await runtimeRequest(f.configDir, "/extensions") as Array<{ id: string }>).some(item => item.id === "web")).toBe(false); await owner.close();
  await trustPlugin(pluginTrustStorePath(f.configDir), installed.root); owner = await f.start();
  const view = await launch(f); expect((await view.get("api/info")).workspace).toBe(f.workspace);
  expect((await runtimeRequest(f.configDir, "/plugins") as Array<{ name: string; root?: string }>).find(item => item.name === "tnb-web")?.root).toBe(installed.root);
  await owner.close();
});
