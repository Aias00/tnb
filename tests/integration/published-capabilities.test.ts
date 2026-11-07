import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initializePlugin } from "../../src/services/plugins/development";
import { installLocalPlugin } from "../../src/services/plugins/management";
import { trustPlugin, pluginTrustStorePath } from "../../src/services/plugins/trust";
import { serveDurableRuntime, runtimeRequest, runtimePaths } from "../../src/services/runtime/server";
import { runRuntimeCommand } from "../../src/entrypoints/runtime";
import type { CapabilityDefinition } from "../../src/agent/execution-service";

const roots: string[] = [], closes: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), "tnb-capability-e2e-")); roots.push(root); const configDir = join(root, "home"); await mkdir(configDir); return { root, configDir }; }
async function cli(root: string, configDir: string, args: string[]) {
  let output = "", error = "";
  const code = await runRuntimeCommand({ argv: ["runtime", ...args, "--config-dir", configDir], cwd: root, env: {}, stdout: { write: text => { output += text; } }, stderr: { write: text => { error += text; } } });
  return { code, output, error };
}
async function owner(configDir: string) {
  const controller = new AbortController(), ready = Promise.withResolvers<void>();
  const done = serveDurableRuntime({ configDir, env: {}, signal: controller.signal, ready: () => ready.resolve() });
  const close = async () => { controller.abort(); await done; }; closes.push(close);
  await Promise.race([ready.promise, done.then(() => { throw new Error("Owner stopped before ready"); })]); return { close };
}
const ownerTest = process.platform === "win32" ? test.skip : test;
const ref = { id: "support.reply", version: "1" };
const body = { commandId: "ticket-123", capability: ref, input: { message: "Published reply" } };
const endpoint = "/extensions/application/published-intake/1";
const errorOf = async (promise: Promise<unknown>) => promise.then(() => "unexpected success", error => String(error));

test("capability CLI validates bounded documents and authority before contacting an Owner", async () => {
  const f = await fixture();
  for (const content of [JSON.stringify({ ...body, maxTurns: 2000 }), "x".repeat(65537), '{"private":"do-not-echo",broken']) {
    await writeFile(join(f.root, "request.json"), content);
    const result = await cli(f.root, f.configDir, ["execute", "request.json"]); expect(result.code).toBe(1); expect(result.error).not.toContain("do-not-echo");
  }
  expect((await cli(f.root, f.configDir, ["capabilities", "list", "--allow-shell"])).code).toBe(1);
  expect(await Bun.file(join(f.configDir, "runtime/state.sqlite")).exists()).toBe(false);
});

ownerTest("default product supports publication, real process consumer RPC, restart and live revocation", async () => {
  const f = await fixture(), agent = join(f.root, "agent"), application = join(f.root, "application");
  await initializePlugin(agent, "agent", "reply-agent");
  await mkdir(application);
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../examples/plugins/published-intake/src/intake.ts")], outdir: application, naming: "intake.mjs", target: "bun", plugins: [{ name: "sdk-source", setup(build) { build.onResolve({ filter: /^@tnb\/plugin-sdk$/ }, () => ({ path: resolve(import.meta.dir, "../../src/plugin-sdk/index.ts") })); } }] }); expect(build.success).toBe(true);
  await cp(resolve(import.meta.dir, "../../examples/plugins/published-intake/plugin.json"), join(application, "plugin.json"));
  for (const source of [agent, application]) { const installed = await installLocalPlugin({ source, targetRoot: join(f.configDir, "plugins"), sourceType: "user" }); await trustPlugin(pluginTrustStorePath(f.configDir), installed.root); }
  await writeFile(join(f.configDir, "settings.json"), JSON.stringify({ pluginServices: { "published-intake": ["tnb.executions/v1"] } }));
  const first = await owner(f.configDir), paths = await runtimePaths(f.configDir);
  for (const path of ["/capabilities/command", "/capabilities/execute"]) expect((await fetch("http://localhost" + path, { unix: paths.socket, method: "POST", body: "{}" })).status).toBe(403);
  const publicationDocument = JSON.parse(await readFile(resolve(import.meta.dir, "../../examples/plugins/published-intake/publish.json"), "utf8"));
  const definition: CapabilityDefinition = publicationDocument.definition;
  const admin = async (input: unknown) => { await writeFile(join(f.root, "command.json"), JSON.stringify(input)); const r = await cli(f.root, f.configDir, ["capabilities", "command.json"]); expect(r.code, r.error).toBe(0); return JSON.parse(r.output); };
  const checked = await admin({ action: "check", definition }); expect(checked.revision).toBe(0);
  const publication = await admin({ action: "publish", definition }); expect(publication.plugin.name).toBe("reply-agent");
  expect(JSON.parse((await cli(f.root, f.configDir, ["capabilities", "list"])).output).items).toHaveLength(1);
  expect(await errorOf(runtimeRequest(f.configDir, endpoint + "/submit", body))).toContain("Host capability call rejected");
  const extensions: any = await runtimeRequest(f.configDir, "/extensions"); const state = extensions.find((e: any) => e.id === "published-intake"); expect(state.status).toBe("active");
  const consumer = { plugin: state.plugin, contribution: { kind: "application", id: "published-intake", version: "1" } };
  await admin({ action: "grant", commandId: "allow", capability: ref, consumer, enabled: true, expectedRevision: 0 });
  expect((await runtimeRequest(f.configDir, endpoint + "/catalog") as any).items[0].capability).toEqual(ref);
  const receipt: any = await runtimeRequest(f.configDir, endpoint + "/submit", body);
  let status: any; const deadline = Date.now() + 10000;
  do { status = await runtimeRequest(f.configDir, endpoint + "/status?runId=" + receipt.runId); if (status.status === "succeeded") break; if (["paused", "failed"].includes(status.status) || Date.now() > deadline) throw new Error(JSON.stringify(status)); await Bun.sleep(10); } while (true);
  const result: any = await runtimeRequest(f.configDir, endpoint + `/result?runId=${receipt.runId}&taskId=${status.tasks[0].taskId}`); expect(JSON.parse(result.text).report).toContain("Verified: Published reply");
  await admin({ action: "state", commandId: "disable", capability: ref, enabled: false, expectedRevision: 1 });
  await first.close(); await owner(f.configDir);
  expect(await runtimeRequest(f.configDir, endpoint + "/submit", body)).toEqual(receipt);
  expect(await runtimeRequest(f.configDir, endpoint + `/result?runId=${receipt.runId}&taskId=${status.tasks[0].taskId}`)).toEqual(result);
  expect(await errorOf(runtimeRequest(f.configDir, endpoint + "/submit", { ...body, commandId: "new" }))).toContain("Host capability call rejected");
  await admin({ action: "grant", commandId: "revoke", capability: ref, consumer, enabled: false, expectedRevision: 1 });
  expect(await errorOf(runtimeRequest(f.configDir, endpoint + "/status?runId=" + receipt.runId))).toContain("Host capability call rejected");
  expect((await runtimeRequest(f.configDir, "/status?runId=" + receipt.runId) as any).run.status).toBe("succeeded");
  // Owner uses the same publication admission but an isolated identity, with an explicitly started service.
  await admin({ action: "state", commandId: "enable", capability: ref, enabled: true, expectedRevision: 2 });
  await writeFile(join(f.root, "request.json"), JSON.stringify(body)); const submitted = await cli(f.root, f.configDir, ["execute", "request.json"]); expect(submitted.code, submitted.error).toBe(0); expect(JSON.parse(submitted.output).runId).not.toBe(receipt.runId);
});
