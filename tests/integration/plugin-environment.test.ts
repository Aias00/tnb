import { afterEach, expect, spyOn, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPlugins, type ExternalPluginToolContribution } from "../../src/services/plugins/loader";
import { createExternalPluginTools, PluginToolRuntimeManager } from "../../src/services/plugins/tools";
import { PluginToolEnvironments, parsePluginToolEnvironment, type PluginToolEnvironmentGrant } from "../../src/services/plugins/environment";
import { loadSettings } from "../../src/services/settings/load";
import { computePluginTreeSha256 } from "../../src/services/plugins/trust";
import { query } from "../../src/sdk/query";
import { installLocalPlugin } from "../../src/services/plugins/management";
import { trustPlugin, pluginTrustStorePath } from "../../src/services/plugins/trust";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const signal = () => new AbortController().signal;
const secret = "fixture-authorized-secret-7f31";
const inspect = `const report=()=>({pid:process.pid,home:process.env.HOME,tmp:process.env.TMPDIR,path:process.env.PATH,
  leaked:['HOST_TOKEN','ANTHROPIC_API_KEY','MAGPIE_KEY','NODE_OPTIONS','BUN_OPTIONS','LD_PRELOAD','DYLD_INSERT_LIBRARIES','PYTHONPATH','SSH_AUTH_SOCK','HTTP_PROXY','TNB_HOME'].filter(name=>process.env[name]!==undefined),
  token:process.env.TOOL_TOKEN??null,received:process.env.TOOL_TOKEN===${JSON.stringify(secret)}});`;
async function fixture(source = inspect + "console.log(JSON.stringify(report()));") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tnb-plugin-environment-"))); cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const pack = join(root, "pack"); await mkdir(pack); await writeFile(join(pack, "plugin.json"), JSON.stringify({ name: "env-pack" }));
  const script = join(pack, "tool.mjs"); await writeFile(script, source);
  const plugin = { ...(await loadPlugins([{ directory: root, source: "user" }])).plugins[0]!, fingerprint: await computePluginTreeSha256(pack) };
  const contribution: ExternalPluginToolContribution = { id: "fixture", type: "external", description: "Offline environment fixture", command: process.execPath, args: [script],
    security: { access: "read", workspace: "none", network: "none", shell: false, approval: "inherit" }, lifecycle: { transport: "oneshot", start: "lazy", reload: "runtime" } };
  const env = { PATH: process.env.PATH, HOST_TOKEN: secret, ANTHROPIC_API_KEY: "provider-secret", MAGPIE_KEY: "magpie-secret", NODE_OPTIONS: "--require forbidden-loader", BUN_OPTIONS: "forbidden-options",
    LD_PRELOAD: "forbidden-preload", DYLD_INSERT_LIBRARIES: "forbidden-dylib", PYTHONPATH: "forbidden-python", SSH_AUTH_SOCK: "forbidden-agent", HTTP_PROXY: "http://forbidden-proxy", TNB_HOME: "/forbidden-config", HOME: "/forbidden-home", TMPDIR: "/forbidden-temp" };
  const grant: PluginToolEnvironmentGrant = { plugin: plugin.name, fingerprint: plugin.fingerprint, tool: contribution.id, variables: { TOOL_TOKEN: "HOST_TOKEN" } };
  const runtime = (grants: PluginToolEnvironmentGrant[] = [], limits = {}) => {
    const manager = new PluginToolRuntimeManager(env, { timeoutMs: 2000, killGraceMs: 20, ...limits }, grants); cleanup.push(() => manager.close()); return manager;
  };
  return { root, pack, script, plugin, contribution, env, grant, runtime };
}

test("process tools receive minimal runtime variables and private home/temp without ambient credentials or loader hooks", async () => {
  const f = await fixture(), runtime = f.runtime(), output = JSON.parse(await runtime.call(f.plugin, f.contribution, {}, signal()));
  expect(output.leaked).toEqual([]); expect(output.token).toBeNull(); expect(output.path).toBe(f.env.PATH);
  expect(output.home).not.toBe(f.env.HOME); expect(output.tmp).not.toBe(f.env.TMPDIR); expect(output.home).not.toBe(output.tmp);
  expect((await lstat(output.home)).isDirectory()).toBe(true); if (process.platform !== "win32") expect((await lstat(output.home)).mode & 0o077).toBe(0);
  await runtime.close(); expect(await lstat(output.home).catch(() => null)).toBeNull(); expect(await lstat(output.tmp).catch(() => null)).toBeNull();
});

test("explicit fingerprint/tool environment references reach only their intended process and are redacted from results", async () => {
  const f = await fixture(), runtime = f.runtime([f.grant]);
  const output = await runtime.call(f.plugin, f.contribution, {}, signal()), report = JSON.parse(output);
  expect(report.received).toBe(true); expect(report.token).toBe("[redacted]"); expect(output).not.toContain(secret); expect(report.leaked).toEqual([]);
  const other = JSON.parse(await runtime.call(f.plugin, { ...f.contribution, id: "other-tool" }, {}, signal())); expect(other.received).toBe(false); expect(other.token).toBeNull();
  const another = JSON.parse(await runtime.call({ ...f.plugin, name: "other-package", root: f.root }, f.contribution, {}, signal())); expect(another.token).toBeNull();
  expect(JSON.stringify(runtime)).not.toContain(secret);
});

test("missing references and mismatched fingerprints are refused before process startup without printing values", async () => {
  const f = await fixture(`await Bun.write(new URL('started',import.meta.url),'started');console.log('unexpected');`);
  for (const grant of [{ ...f.grant, fingerprint: "0".repeat(64) }, { ...f.grant, variables: { TOOL_TOKEN: "ABSENT_HOST_REFERENCE" } }, { ...f.grant, variables: { TOOL_TOKEN: "__proto__" } }]) {
    const runtime = f.runtime([grant]);
    await expect(runtime.call(f.plugin, f.contribution, {}, signal())).rejects.toThrow("PLUGIN_TOOL_ENVIRONMENT_DENIED");
    expect(await readFile(join(f.pack, "started"), "utf8").catch(() => "")).toBe("");
  }
});

test("CLI and SDK apply user environment grants to an installed trusted process tool without exposing keys to the model", async () => {
  const f = await fixture(), configDir = join(f.root, "config"), workspace = join(f.root, "work"); await mkdir(configDir); await mkdir(workspace);
  const command = process.platform === "win32" ? "probe.exe" : "probe";
  const compiled = await Bun.build({ entrypoints: [f.script], target: "bun", compile: { outfile: join(f.pack, command) } }); expect(compiled.success).toBe(true);
  await writeFile(join(f.pack, "plugin.json"), JSON.stringify({ name: "env-pack", contributes: { tools: [{ id: "fixture", description: "Check only explicit environment references", command: "./" + command, security: { access: "read", network: "none" } }] } }));
  const installed = await installLocalPlugin({ source: f.pack, targetRoot: join(configDir, "plugins"), sourceType: "user" }); await trustPlugin(pluginTrustStorePath(configDir), installed.root);
  const grant = { ...f.grant, fingerprint: await computePluginTreeSha256(installed.root) };
  await writeFile(join(configDir, "settings.json"), JSON.stringify({ pluginToolEnvironment: [grant] }));
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as any; requests++;
    const result = body.messages.find((message: any) => message.role === "tool");
    if (result) { expect(result.content).toContain('"received":true'); expect(result.content).toContain("[redacted]"); expect(JSON.stringify(body)).not.toContain(secret); }
    const delta = result ? { content: "ENV_BOUNDARY_OK" } : { tool_calls: [{ index: 0, id: "environment", type: "function", function: { name: "plugin__env-pack__fixture", arguments: "{}" } }] };
    return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: result ? "stop" : "tool_calls" }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } }); cleanup.push(() => server.stop(true));
  await writeFile(join(configDir, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: server.url.href + "v1", apiKey: "provider-private", models: [{ id: "fixture", contextWindow: 32000, maxTokens: 256 }] } } }));
  const client = query({ prompt: "Use the external fixture tool once", options: { cwd: workspace, env: { TNB_HOME: configDir, HOST_TOKEN: secret }, provider: "fixture", model: "fixture", maxTurns: 3 } });
  try { const records = []; for await (const message of client) records.push(message); expect(records.at(-1)).toMatchObject({ type: "result", subtype: "success", result: "ENV_BOUNDARY_OK" }); expect(requests).toBe(2); }
  finally { client.close(); await client.waitForExit(); }
}, 20000);

test("stdio coalesces private setup, shares one owned process and redacts authorized credentials", async () => {
  const f = await fixture(inspect + `const {createInterface}=await import('node:readline');createInterface({input:process.stdin}).on('line',line=>console.log(JSON.stringify({id:JSON.parse(line).id,result:JSON.stringify(report())})));`);
  const runtime = f.runtime([f.grant]), contribution = { ...f.contribution, lifecycle: { ...f.contribution.lifecycle, transport: "stdio" as const } };
  const values = await Promise.all(Array.from({ length: 4 }, () => runtime.call(f.plugin, contribution, {}, signal()).then(JSON.parse)));
  expect(new Set(values.map(value => value.pid)).size).toBe(1); expect(new Set(values.map(value => value.home)).size).toBe(1);
  expect(values.every(value => value.received && value.token === "[redacted]" && value.leaked.length === 0)).toBe(true);
});

test("environment sources are snapshotted and equivalent grant ordering does not restart live processes", async () => {
  const f = await fixture(inspect + `const {createInterface}=await import('node:readline');createInterface({input:process.stdin}).on('line',line=>console.log(JSON.stringify({id:JSON.parse(line).id,result:JSON.stringify(report())})));`);
  const original = structuredClone(f.grant), extra = { ...f.grant, tool: "unused" }, runtime = f.runtime([original, extra]);
  f.env.HOST_TOKEN = "changed-after-runtime-created";
  const contribution = { ...f.contribution, lifecycle: { ...f.contribution.lifecycle, transport: "stdio" as const } };
  const first = JSON.parse(await runtime.call(f.plugin, contribution, {}, signal())); expect(first.received).toBe(true);
  await runtime.configureEnvironment([extra, original]);
  const second = JSON.parse(await runtime.call(f.plugin, contribution, {}, signal())); expect(second.pid).toBe(first.pid); expect(second.home).toBe(first.home);
});

test("revoking grants drains calls, joins process exit and removes private files before allowing fresh calls", async () => {
  const f = await fixture(inspect + `const {createInterface}=await import('node:readline');createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);if(!request.params.input.wait)console.log(JSON.stringify({id:request.id,result:JSON.stringify(report())}));});`);
  const runtime = f.runtime([f.grant]), contribution = { ...f.contribution, lifecycle: { ...f.contribution.lifecycle, transport: "stdio" as const } };
  const expected = runtime.environmentIdentity(f.plugin, contribution), original = JSON.parse(await runtime.call(f.plugin, contribution, {}, signal()));
  const pending = runtime.call(f.plugin, contribution, { wait: true }, signal()); void pending.catch(() => {}); await Bun.sleep(10);
  const revoked = runtime.configureEnvironment([]);
  await expect(runtime.call(f.plugin, contribution, {}, signal())).rejects.toThrow("PLUGIN_TOOL_ENVIRONMENT_CHANGED");
  await revoked; await expect(pending).rejects.toThrow(); expect(() => process.kill(original.pid, 0)).toThrow(); expect(await lstat(original.home).catch(() => null)).toBeNull();
  await expect(runtime.call(f.plugin, contribution, {}, signal(), expected)).rejects.toThrow("PLUGIN_TOOL_ENVIRONMENT_CHANGED");
  const fresh = JSON.parse(await runtime.call(f.plugin, contribution, {}, signal())); expect(fresh.received).toBe(false); expect(fresh.home).not.toBe(original.home);
});

test("cached model tools cannot silently switch to a newly credentialed execution policy", async () => {
  const f = await fixture(), runtime = f.runtime();
  // Catalog construction accepts a package-local command; rejection must occur before attempting to spawn it.
  const contribution = { ...f.contribution, command: f.script, args: [] }, plugin = { ...f.plugin, toolContributions: [contribution] };
  const tool = (await createExternalPluginTools([plugin], f.env, runtime))[0]!;
  await runtime.configureEnvironment([f.grant]);
  await expect(tool.execute({}, signal())).rejects.toThrow("PLUGIN_TOOL_ENVIRONMENT_CHANGED");
});

test("tool stderr failures cannot carry granted credential values into lifecycle diagnostics", async () => {
  const f = await fixture(`console.error('tool failed: '+process.env.TOOL_TOKEN);process.exit(1);`), runtime = f.runtime([f.grant]);
  try { await runtime.call(f.plugin, f.contribution, {}, signal()); throw new Error("unexpected success"); }
  catch (error) { expect(String(error)).toContain("[redacted]"); expect(String(error)).not.toContain(secret); expect((error as Error).cause).toBeUndefined(); }
});

test("eager preflight verifies the entire package's environment references before starting any process", async () => {
  const f = await fixture(`await Bun.write(new URL('started',import.meta.url),'started');setInterval(()=>{},1000);`);
  const first = { ...f.contribution, lifecycle: { ...f.contribution.lifecycle, transport: "stdio" as const, start: "eager" as const } }, second = { ...first, id: "unavailable" };
  const runtime = f.runtime([{ ...f.grant, tool: "unavailable", variables: { TOOL_TOKEN: "MISSING" } }]);
  await expect(runtime.startEager([{ ...f.plugin, toolContributions: [first, second] }])).rejects.toThrow("PLUGIN_TOOL_ENVIRONMENT_DENIED");
  expect(await readFile(join(f.pack, "started"), "utf8").catch(() => "")).toBe("");
});

test("private environment count is bounded and stopping a package releases its capacity", async () => {
  const f = await fixture(), runtime = f.runtime([], { maxProcessEnvironments: 1 });
  await runtime.call(f.plugin, f.contribution, {}, signal());
  await expect(runtime.call(f.plugin, { ...f.contribution, id: "second" }, {}, signal())).rejects.toThrow("environment limit");
  await runtime.stopPlugin(f.plugin); await runtime.startEager([f.plugin]);
  expect(JSON.parse(await runtime.call(f.plugin, { ...f.contribution, id: "second" }, {}, signal())).home).toBeTruthy();
});

test("cancelling while private environment setup is pending cannot start a stdio process afterward", async () => {
  const f = await fixture(`await Bun.write(new URL('started',import.meta.url),'started');setInterval(()=>{},1000);`), runtime = f.runtime();
  const ready = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), prepare = PluginToolEnvironments.prototype.prepare;
  const intercepted = spyOn(PluginToolEnvironments.prototype, "prepare").mockImplementation(async function(this: PluginToolEnvironments, ...args) {
    const env = await prepare.apply(this, args); ready.resolve(); await release.promise; return env;
  });
  const controller = new AbortController(), contribution = { ...f.contribution, lifecycle: { ...f.contribution.lifecycle, transport: "stdio" as const } };
  const pending = runtime.call(f.plugin, contribution, {}, controller.signal); void pending.catch(() => {});
  try {
    await ready.promise; controller.abort(new Error("cancelled during environment preparation")); release.resolve();
    await expect(pending).rejects.toThrow("cancelled during environment preparation"); await Bun.sleep(20);
    expect(await readFile(join(f.pack, "started"), "utf8").catch(() => "")).toBe("");
  } finally { release.resolve(); intercepted.mockRestore(); }
});

test("grant policy is user-only even in trusted projects or explicit settings overlays", async () => {
  const f = await fixture(), configDir = join(f.root, "config"); await mkdir(configDir); await mkdir(join(f.pack, ".tnb"));
  await writeFile(join(configDir, "settings.json"), JSON.stringify({ pluginToolEnvironment: [f.grant], security: { trustedFolders: [f.pack] } }));
  const malicious = [{ ...f.grant, variables: { TOOL_TOKEN: "ANTHROPIC_API_KEY" } }];
  await writeFile(join(f.pack, ".tnb/settings.json"), JSON.stringify({ pluginToolEnvironment: malicious }));
  const settings = await loadSettings({ configDir, cwd: f.pack, additional: JSON.stringify({ pluginToolEnvironment: malicious }) });
  expect(settings.pluginToolEnvironment).toEqual([f.grant]); expect(settings.warnings?.filter(value => value.includes("pluginToolEnvironment"))).toHaveLength(2);
});

test("invalid grants reject wildcards, duplicate targets, loader injection and literal credential objects", async () => {
  const f = await fixture();
  const invalid = [null, [{ ...f.grant, plugin: "*" }], [{ ...f.grant, tool: "*" }], [{ ...f.grant, fingerprint: "latest" }], [f.grant, f.grant], [{ ...f.grant, variables: { PATH: "HOST_TOKEN" } }],
    [{ ...f.grant, variables: { NODE_OPTIONS: "HOST_TOKEN" } }], [{ ...f.grant, variables: { LD_PRELOAD: "HOST_TOKEN" } }], [{ ...f.grant, variables: { HTTPS_PROXY: "HOST_TOKEN" } }],
    [{ ...f.grant, variables: { TOKEN: "HOST_TOKEN", token: "HOST_TOKEN" } }], [{ ...f.grant, variables: { TOKEN: { value: secret } } }], [{ ...f.grant, variables: { TOKEN: "literal-secret-value" } }], [{ ...f.grant, inherit: true }]];
  for (const value of invalid) { try { parsePluginToolEnvironment(value); throw new Error("accepted"); } catch (error) { expect(String(error)).toContain("PLUGIN_TOOL_ENVIRONMENT_INVALID"); expect(String(error)).not.toContain(secret); } }
});

test("HTTP tools cannot consume process grants and manifests cannot self-authorize environment inheritance", async () => {
  const f = await fixture(); let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return Response.json({ result: "unexpected" }); } }); cleanup.push(() => server.stop(true));
  const runtime = f.runtime([f.grant]);
  await expect(runtime.call(f.plugin, { ...f.contribution, command: server.url.href, args: [], lifecycle: { ...f.contribution.lifecycle, transport: "http" } }, {}, signal())).rejects.toThrow("PLUGIN_TOOL_ENVIRONMENT_DENIED"); expect(requests).toBe(0);
  await writeFile(join(f.pack, "plugin.json"), JSON.stringify({ name: "env-pack", contributes: { tools: [{ id: "fixture", description: "cannot grant itself", command: "./tool.mjs", env: { TOKEN: "HOST_TOKEN" } }] } }));
  const discovered = await loadPlugins([{ directory: f.root, source: "user" }]); expect(discovered.plugins).toEqual([]); expect(discovered.errors[0]?.error).toContain("environment grants belong to host");
});
