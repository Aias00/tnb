import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHostPlugins } from "../../src/agent/plugins";
import { loadPlugins, loadPluginHooks, loadPluginMcpConfig } from "../../src/services/plugins/loader";
import { pluginTrustStorePath, trustPlugin } from "../../src/services/plugins/trust";
import { applyPluginPolicy } from "../../src/services/plugins/policy";
import { PluginLifecycleManager, reconcilePluginCatalog } from "../../src/services/plugins/lifecycle";
import { createExternalPluginTools, PluginToolRuntimeManager } from "../../src/services/plugins/tools";
import { runResourceListCommand } from "../../src/services/cli/management";
import { runCli } from "../../src/entrypoints/cli";
import type { ModelTransport } from "../../src/providers/types";

const cleanup: Array<() => void | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const signal = () => new AbortController().signal;

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tnb-plugin-policy-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const configDir = join(root, "config"), workspace = join(root, "workspace"), directory = join(configDir, "plugins"), pack = join(directory, "policy-pack");
  await mkdir(workspace); await mkdir(join(pack, "skills", "policy-skill"), { recursive: true });
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return Response.json({ result: "fixture response" }); } });
  cleanup.push(() => server.stop(true));
  const imported = join(root, "imported");
  await writeFile(join(pack, "index.mjs"), `await Bun.write(${JSON.stringify(imported)},'imported');export default api=>api.registerApplication({id:'policy-app',version:'1',start(){return {}}});`);
  await writeFile(join(pack, "plugin.json"), JSON.stringify({ name: "policy-pack", manifestVersion: 2, version: "1.0.0", apiVersion: "tnb.host-plugin/v1",
    contributes: { applications: [{ id: "policy-app", version: "1", entry: "index.mjs" }], hooks: "hooks.json", mcpServers: "mcp.json",
      tools: ["builtin:security_scan", { id: "http", description: "Offline fixture", command: server.url.href, lifecycle: { transport: "http" }, security: { network: "loopback", access: "read" } }] } }));
  await writeFile(join(pack, "hooks.json"), JSON.stringify({ SessionStart: [{ hooks: [{ type: "command", command: "policy-fixture-must-not-run" }] }] }));
  await writeFile(join(pack, "mcp.json"), JSON.stringify({ mcpServers: { "policy-server": { type: "http", url: server.url.href } } }));
  await writeFile(join(pack, "skills", "policy-skill", "SKILL.md"), "---\nname: policy-skill\ndescription: Policy fixture instructions\n---\nDo the offline policy fixture.\n");
  await mkdir(join(pack, "commands")); await writeFile(join(pack, "commands", "policy-command.md"), "Policy fixture command.");
  await mkdir(join(pack, "agents")); await writeFile(join(pack, "agents", "policy-agent.md"), "---\nname: policy-agent\ndescription: Policy fixture agent\n---\nInspect offline fixture.\n");
  const trustStorePath = pluginTrustStorePath(configDir), approved = await trustPlugin(trustStorePath, pack);
  const roots = [{ directory, source: "user" as const }];
  const load = (blockedFingerprints: string[] = []) => loadPlugins(roots, {}, { trustStorePath, blockedFingerprints });
  const block = () => writeFile(join(configDir, "settings.json"), JSON.stringify({ blockedPluginFingerprints: [approved.fingerprint] }));
  return { root, configDir, workspace, pack, imported, trustStorePath, roots, fingerprint: approved.fingerprint, load, block, requests: () => requests };
}

test("one blocked fingerprint denies executable and resource contributions, including direct consumers", async () => {
  const f = await fixture();
  const { plugins } = await f.load([f.fingerprint]);
  const plugin = plugins[0]!;
  expect(plugin).toMatchObject({ active: false, trust: "trusted", policy: { status: "blocked" } });
  expect(await loadPluginHooks(plugins)).toEqual({});
  expect(await loadPluginMcpConfig(plugins, {})).toEqual({ mcpServers: {} });
  expect(await createExternalPluginTools(plugins, {})).toEqual([]);
  const runtime = new PluginToolRuntimeManager({}); cleanup.push(() => runtime.close());
  const lifecycle = new PluginLifecycleManager(join(f.root, "lifecycle.json"), "policy", runtime);
  await lifecycle.start(plugins); expect(lifecycle.isActive(plugin)).toBe(false);
  await expect(lifecycle.activate(plugin)).rejects.toThrow("blocked");
  const external = plugin.toolContributions.find(row => row.type === "external")!;
  if (external.type !== "external") throw new Error("fixture external tool missing");
  // A stale consumer must not override the authoritative policy with active:true.
  await expect(runtime.call({ ...plugin, active: true }, external, {}, signal())).rejects.toThrow("blocked");
  const host = await loadHostPlugins({ roots: f.roots, trustStorePath: f.trustStorePath, blockedFingerprints: [f.fingerprint] }); cleanup.push(() => host.close());
  expect(host.list()[0]?.status).toBe("blocked"); expect(host.extensions.list()).toEqual([]);
  expect(await readFile(f.imported, "utf8").catch(() => "")).toBe(""); expect(f.requests()).toBe(0);
});

test("management skills and plugin inventories apply the same host block policy", async () => {
  const f = await fixture(); await f.block();
  const invoke = async (argv: string[]) => {
    let stdout = "", stderr = "";
    expect(await runResourceListCommand({ argv, configDir: f.configDir, cwd: f.workspace, env: {}, stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } } })).toBe(0);
    expect(stderr).toBe(""); return JSON.parse(stdout);
  };
  expect((await invoke(["skills", "list", "--json"])).some((row: { name: string }) => row.name === "policy-skill")).toBe(false);
  expect(await invoke(["plugins", "show", "policy-pack"])).toMatchObject({ active: false, policy: { status: "blocked" } });
  await writeFile(join(f.configDir, "settings.json"), JSON.stringify({ enabledPlugins: { "policy-pack": false } }));
  expect(await invoke(["plugins", "show", "policy-pack"])).toMatchObject({ active: false, enabled: false, policy: { status: "disabled" } });
  expect(await invoke(["plugins", "list", "--json"])).toContainEqual(expect.objectContaining({ name: "policy-pack", policy: { status: "disabled", reason: "Plugin is disabled" } }));
});

test("refresh revokes old restart-only packages instead of deferring their denial", async () => {
  const f = await fixture(), original = (await f.load()).plugins[0]!;
  for (const next of [applyPluginPolicy(original, { enabled: { "policy-pack": false } }), applyPluginPolicy(original, { blockedFingerprints: [f.fingerprint] }), { ...original, active: false, trust: "untrusted" as const }]) {
    const result = reconcilePluginCatalog([original], [next]);
    expect(result.stop).toEqual([original]); expect(result.plugins[0]?.active).toBe(false); expect(result.deferred).toEqual([]);
  }
  const changed = { ...original, fingerprint: "b".repeat(64) };
  const deferred = reconcilePluginCatalog([original], [changed]);
  expect(deferred.plugins).toEqual([original]); expect(deferred.deferred[0]?.policy).toBe("restart");
});

test("cached external tools cannot restart a stopped generation or call a closed runtime", async () => {
  const f = await fixture(), plugin = (await f.load()).plugins[0]!;
  const runtime = new PluginToolRuntimeManager({}); cleanup.push(() => runtime.close());
  const tool = (await createExternalPluginTools([plugin], {}, runtime))[0]!;
  expect(await tool.execute({}, signal())).toBe("fixture response"); expect(f.requests()).toBe(1);
  await runtime.stopPlugin(plugin);
  await expect(tool.execute({}, signal())).rejects.toThrow("stopped"); expect(f.requests()).toBe(1);
  await runtime.startEager([plugin]); expect(await tool.execute({}, signal())).toBe("fixture response");
  await runtime.close(); await expect(tool.execute({}, signal())).rejects.toThrow("stopped"); expect(f.requests()).toBe(2);
});

test("stopping stdio admission during startup rejects dispatch and permits explicit restart", async () => {
  const f = await fixture(), plugin = (await f.load()).plugins[0]!;
  const server = join(f.root, "stdio.mjs");
  await writeFile(server, `import {createInterface} from "node:readline";
    createInterface({input:process.stdin}).on("line",line=>{const request=JSON.parse(line);
      process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result:"stdio reply"})+"\\n");});`);
  const external = plugin.toolContributions.find(row => row.type === "external")!;
  if (external.type !== "external") throw new Error("fixture external tool missing");
  const contribution = { ...external, command: process.execPath, args: [server], lifecycle: { ...external.lifecycle, transport: "stdio" as const } };
  const runtime = new PluginToolRuntimeManager({}); cleanup.push(() => runtime.close());
  const pending = runtime.call(plugin, contribution, {}, signal());
  void pending.catch(() => {});
  const stopping = runtime.stopPlugin(plugin);
  await expect(pending).rejects.toThrow("stopped"); await stopping;
  await runtime.startEager([plugin]);
  expect(await runtime.call(plugin, contribution, {}, signal())).toBe("stdio reply");
  await runtime.stopPlugin(plugin);
  await expect(runtime.call(plugin, contribution, {}, signal())).rejects.toThrow("stopped");
});

// The CLI's native workspace/session lifecycle is verified on macOS and Linux.
test.skipIf(process.platform === "win32")("a cached CLI catalog is rechecked before exposing its tools and skills", async () => {
  const f = await fixture(), catalog = (await f.load()).plugins; await f.block(); let modelRequests = 0;
  const transport: ModelTransport = { async *stream(request) {
    modelRequests++; const names = request.tools.map(tool => tool.name);
    expect(names).not.toContain("plugin__policy-pack__http"); expect(names).not.toContain("security_scan");
    expect(JSON.stringify(request.tools)).not.toContain("policy-skill");
    yield { type: "text", index: 0, text: "Offline check passed" }; yield { type: "response-end", reason: "end-turn" };
  } };
  let stderr = "";
  expect(await runCli({ argv: ["-p", "Inspect offline"], configDir: f.configDir, cwd: f.workspace, env: {}, pluginCatalog: catalog, transport,
    stdout: { write() {} }, stderr: { write: value => { stderr += value; } }, sessionIdFactory: () => "policy-cli" })).toBe(0);
  expect(modelRequests).toBe(1); expect(stderr).not.toContain("hook exited"); expect(f.requests()).toBe(0);
});
