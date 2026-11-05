import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadPlugins, type ExternalPluginToolContribution } from "../../src/services/plugins/loader";
import { PluginToolRuntimeManager } from "../../src/services/plugins/tools";
import { DEFAULT_PLUGIN_TOOL_LIMITS, pluginToolLimits } from "../../src/services/plugins/io";
import { pluginHttpTarget } from "../../src/services/plugins/network";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const signal = () => new AbortController().signal;
async function fixture(source = "") {
  const root = await mkdtemp(join(tmpdir(), "tnb-plugin-runtime-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const pack = join(root, "pack"); await mkdir(pack);
  await writeFile(join(pack, "plugin.json"), JSON.stringify({ name: "runtime-pack" }));
  await writeFile(join(pack, "tool.mjs"), source);
  const plugin = (await loadPlugins([{ directory: root, source: "user" }])).plugins[0]!;
  const contribution: ExternalPluginToolContribution = { id: "fixture", type: "external", description: "Offline fixture", command: process.execPath, args: [join(pack, "tool.mjs")],
    security: { access: "read", workspace: "none", network: "loopback", shell: false, approval: "inherit" }, lifecycle: { transport: "oneshot", start: "lazy", reload: "runtime" } };
  const runtime = new PluginToolRuntimeManager({}, { timeoutMs: 1500, killGraceMs: 20 }); cleanup.push(() => runtime.close());
  return { root, pack, plugin, contribution, runtime };
}
const listen = (fetch: (request: Request) => Response | Promise<Response>) => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch }); cleanup.push(() => server.stop(true)); return server;
};
async function waitFor(file: string): Promise<string> {
  const end = Date.now() + 3000;
  for (;;) { const value = await readFile(file, "utf8").catch(() => ""); if (value) return value;
    if (Date.now() > end) throw new Error("Fixture did not start"); await Bun.sleep(5); }
}
function exited(pid: string) { expect(() => process.kill(Number(pid), 0)).toThrow(); }

test("loopback policy rejects DNS aliases, external targets, URL credentials and unspecified addresses", () => {
  for (const url of ["http://example.com", "http://localhost.example.com", "http://127.0.0.1.example.com", "http://0.0.0.0", "http://[::]", "http://[::ffff:127.0.0.1]", "http://192.168.1.1"]) {
    expect(() => pluginHttpTarget(url, "loopback")).toThrow("loopback");
  }
  for (const url of ["http://127.1", "http://2130706433", "http://[::1]", "http://localhost"]) expect(pluginHttpTarget(url, "loopback").protocol).toBe("http:");
  expect(() => pluginHttpTarget("http://user:password@127.0.0.1", "egress")).toThrow("credentials");
  expect(() => pluginHttpTarget("file:///tmp/fixture", "egress")).toThrow("HTTP(S)");
  expect(() => pluginHttpTarget("http://127.0.0.1", "none")).toThrow("declare");
  expect(pluginHttpTarget("https://example.com", "egress").hostname).toBe("example.com");
});

test("HTTP pins localhost, ignores environment proxy routing and never follows redirect POSTs", async () => {
  const f = await fixture(); let targets = 0;
  const target = listen(() => { targets++; return Response.json({ result: "must not redirect" }); });
  const endpoint = listen(request => new URL(request.url).pathname === "/redirect" ? Response.redirect(target.url, 307) : Response.json({ result: "direct localhost" }));
  const contribution = { ...f.contribution, command: endpoint.url.href.replace("127.0.0.1", "localhost"), lifecycle: { ...f.contribution.lifecycle, transport: "http" as const }, args: [] };
  expect(await f.runtime.call(f.plugin, contribution, {}, signal())).toBe("direct localhost");
  await expect(f.runtime.call(f.plugin, { ...contribution, command: new URL("redirect", endpoint.url).href }, {}, signal())).rejects.toThrow("redirects are not allowed");
  expect(targets).toBe(0);
  await expect(f.runtime.call(f.plugin, { ...contribution, command: "http://example.com" }, {}, signal())).rejects.toThrow("loopback");
  // A separate host process proves proxy environment cannot reroute the connection.
  const script = join(f.root, "proxy.mjs");
  await writeFile(script, `import {requestPluginHttp} from ${JSON.stringify(new URL("../../src/services/plugins/http.ts", import.meta.url).href)};
    const result=await requestPluginHttp(new URL(process.argv[2]),'{}',1024,new AbortController().signal);console.log(result.text);`);
  const child = Bun.spawn([process.execPath, script, contribution.command], { env: { ...process.env, HTTP_PROXY: target.url.href, HTTPS_PROXY: target.url.href, ALL_PROXY: target.url.href, http_proxy: target.url.href, https_proxy: target.url.href, all_proxy: target.url.href, NO_PROXY: "", no_proxy: "" }, stdout: "pipe", stderr: "pipe" });
  const [code, output, diagnostic] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, diagnostic).toBe(0); expect(output).toContain("direct localhost"); expect(targets).toBe(0);
});

test("HTTP rejects oversized streamed responses before accepting partial JSON results", async () => {
  const f = await fixture(), runtime = new PluginToolRuntimeManager({}, { maxOutputBytes: 1024 }); cleanup.push(() => runtime.close());
  let cancelled = false;
  const endpoint = listen(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(2048))); }, cancel() { cancelled = true; } })));
  const contribution = { ...f.contribution, command: endpoint.url.href, lifecycle: { ...f.contribution.lifecycle, transport: "http" as const }, args: [] };
  await expect(runtime.call(f.plugin, contribution, {}, signal())).rejects.toThrow("byte limit");
  const end = Date.now() + 1000; while (!cancelled && Date.now() < end) await Bun.sleep(5);
  expect(cancelled).toBe(true);
});

test("oneshot stdout and stderr limits terminate the direct child and never return truncated success", async () => {
  for (const pipe of ["stdout", "stderr"]) {
    const f = await fixture(`import {writeFileSync} from 'node:fs';writeFileSync(new URL('pid',import.meta.url),String(process.pid));
      process.on('SIGTERM',()=>{});setInterval(()=>process.${pipe}.write('x'.repeat(8192)),1);`);
    const runtime = new PluginToolRuntimeManager({}, { maxOutputBytes: 1024, maxStderrBytes: 1024, timeoutMs: 1500, killGraceMs: 20 }); cleanup.push(() => runtime.close());
    await expect(runtime.call(f.plugin, f.contribution, {}, signal())).rejects.toThrow(`${pipe} exceeds`);
    exited(await readFile(join(f.pack, "pid"), "utf8"));
  }
});

test("oneshot concurrently drains large stderr while preserving successful stdout", async () => {
  const f = await fixture(`await Bun.write(Bun.stderr,'d'.repeat(128*1024));await Bun.write(Bun.stdout,JSON.stringify({content:'complete'}));`);
  expect(await f.runtime.call(f.plugin, f.contribution, {}, signal())).toBe("complete");
});

test("stdio rejects an overlong unfinished frame, oversized result and cumulative notifications", async () => {
  const cases = [
    { source: "process.stdout.write('x'.repeat(4096));setInterval(()=>{},1000);", limits: { maxFrameBytes: 1024 }, error: "frame exceeds" },
    { source: `import {createInterface} from 'node:readline';createInterface({input:process.stdin}).on('line',line=>{const {id}=JSON.parse(line);console.log(JSON.stringify({id,result:'x'.repeat(2048)}));});`, limits: { maxOutputBytes: 1024 }, error: "result exceeds" },
    { source: `import {createInterface} from 'node:readline';createInterface({input:process.stdin}).on('line',line=>{const {id}=JSON.parse(line);console.log(JSON.stringify({id,error:'x'.repeat(2048)}));});`, limits: { maxOutputBytes: 1024 }, error: "result exceeds" },
    { source: `setInterval(()=>process.stdout.write(('{}\\n').repeat(512)),1);`, limits: { maxStdioBytes: 1024 }, error: "stdio output exceeds" },
    { source: `import {createInterface} from 'node:readline';createInterface({input:process.stdin}).on('line',line=>console.log(JSON.stringify({id:JSON.parse(line).id})));`, limits: {}, error: "missing result" },
  ];
  for (const item of cases) {
    const f = await fixture(item.source), runtime = new PluginToolRuntimeManager({}, { ...item.limits, timeoutMs: 1500, killGraceMs: 20 }); cleanup.push(() => runtime.close());
    await expect(runtime.call(f.plugin, { ...f.contribution, lifecycle: { ...f.contribution.lifecycle, transport: "stdio" } }, {}, signal())).rejects.toThrow(item.error);
    await runtime.close();
  }
});

test("deadlines cancel stalled HTTP and stdio calls without retrying", async () => {
  const f = await fixture("process.on('SIGTERM',()=>{});setInterval(()=>{},1000);"), runtime = new PluginToolRuntimeManager({}, { timeoutMs: 80, killGraceMs: 20 }); cleanup.push(() => runtime.close());
  let requests = 0;
  const endpoint = listen(() => { requests++; return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(" ")); } })); });
  await expect(runtime.call(f.plugin, { ...f.contribution, command: endpoint.url.href, lifecycle: { ...f.contribution.lifecycle, transport: "http" }, args: [] }, {}, signal())).rejects.toThrow("deadline");
  expect(requests).toBe(1);
  await expect(runtime.call(f.plugin, { ...f.contribution, lifecycle: { ...f.contribution.lifecycle, transport: "stdio" } }, {}, signal())).rejects.toThrow("deadline");
  await runtime.close();
});

test("stop and close cancel owned calls, join direct process exit and share shutdown completion", async () => {
  const f = await fixture(`import {writeFileSync} from 'node:fs';writeFileSync(new URL('pid',import.meta.url),String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`);
  const pending = f.runtime.call(f.plugin, f.contribution, {}, signal()); void pending.catch(() => {});
  const pid = await waitFor(join(f.pack, "pid"));
  const first = f.runtime.stopPlugin(f.plugin), second = f.runtime.stopPlugin(f.plugin);
  expect(first).toBe(second); await Promise.all([first, second]);
  await expect(pending).rejects.toThrow("stopped"); exited(pid);
  await expect(f.runtime.call(f.plugin, f.contribution, {}, signal())).rejects.toThrow("stopped");
  const closing = f.runtime.close(); expect(f.runtime.close()).toBe(closing); await closing;
});

test("concurrency and input budgets reject calls before another HTTP effect starts", async () => {
  const f = await fixture(), runtime = new PluginToolRuntimeManager({}, { maxInputBytes: 1024, maxConcurrentCalls: 1 }); cleanup.push(() => runtime.close());
  let requests = 0, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const endpoint = listen(() => { requests++; entered(); return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(" ")); } })); });
  const contribution = { ...f.contribution, command: endpoint.url.href, lifecycle: { ...f.contribution.lifecycle, transport: "http" as const }, args: [] };
  await expect(runtime.call(f.plugin, contribution, { body: "x".repeat(2048) }, signal())).rejects.toThrow("input exceeds"); expect(requests).toBe(0);
  const pending = runtime.call(f.plugin, contribution, {}, signal()); void pending.catch(() => {}); await ready;
  await expect(runtime.call(f.plugin, contribution, {}, signal())).rejects.toThrow("concurrent call limit");
  const close = runtime.close(); expect(runtime.close()).toBe(close); await close;
  await expect(pending).rejects.toThrow("stopped"); expect(requests).toBe(1);
});

test("host limits reject invalid overrides and cannot be enlarged by a plugin", () => {
  expect(pluginToolLimits().maxFrameBytes).toBe(DEFAULT_PLUGIN_TOOL_LIMITS.maxFrameBytes);
  for (const invalid of [0, -1, NaN, Infinity, 1.5, DEFAULT_PLUGIN_TOOL_LIMITS.timeoutMs + 1]) expect(() => pluginToolLimits({ timeoutMs: invalid })).toThrow("limit");
  expect(() => pluginToolLimits({ unknown: 1 } as never)).toThrow("limit");
  expect(() => pluginToolLimits({ toString: 1 } as never)).toThrow("limit");
});

test("stdio preserves concurrent response IDs and Unicode frame boundaries", async () => {
  const f = await fixture(`import {createInterface} from 'node:readline';createInterface({input:process.stdin}).on('line',line=>{
    const request=JSON.parse(line);setTimeout(()=>{const data=Buffer.from(JSON.stringify({id:request.id,result:request.params.input.tag+'汉字'})+'\\n');
      for(let i=0;i<data.length;i++)process.stdout.write(data.subarray(i,i+1));},request.params.input.tag==='first'?20:0);});`);
  const contribution = { ...f.contribution, lifecycle: { ...f.contribution.lifecycle, transport: "stdio" as const } };
  expect(await Promise.all([f.runtime.call(f.plugin, contribution, { tag: "first" }, signal()), f.runtime.call(f.plugin, contribution, { tag: "second" }, signal())])).toEqual(["first汉字", "second汉字"]);
});

test("cancelling a shared stdio process fails every pending call and allows only new explicit requests", async () => {
  const f = await fixture(`import {writeFileSync} from 'node:fs';import {createInterface} from 'node:readline';
    writeFileSync(new URL('pid',import.meta.url),String(process.pid));process.on('SIGTERM',()=>{});
    createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);
      if(request.params.input.reply)console.log(JSON.stringify({id:request.id,result:'new request'}));});`);
  const contribution = { ...f.contribution, lifecycle: { ...f.contribution.lifecycle, transport: "stdio" as const } };
  const controller = new AbortController();
  const first = f.runtime.call(f.plugin, contribution, {}, controller.signal), second = f.runtime.call(f.plugin, contribution, {}, signal());
  void first.catch(() => {}); void second.catch(() => {});
  const pid = await waitFor(join(f.pack, "pid")); controller.abort(new Error("operator cancelled"));
  await expect(first).rejects.toThrow("operator cancelled"); await expect(second).rejects.toThrow("operator cancelled");
  // The next request waits for the old child's exit; it never retries either old request.
  expect(await f.runtime.call(f.plugin, contribution, { reply: true }, signal())).toBe("new request"); exited(pid);
});

test("a slow plugin does not delay another generation and stopping one leaves the other active", async () => {
  const f = await fixture(); let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const slow = listen(() => { entered(); return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(" ")); } })); });
  const healthy = listen(async request => Response.json({ result: (await request.json() as { params: { input: { value: string } } }).params.input.value }));
  const contribution = { ...f.contribution, command: slow.url.href, lifecycle: { ...f.contribution.lifecycle, transport: "http" as const }, args: [] };
  const other = { ...f.plugin, name: "other", root: f.root };
  const pending = f.runtime.call(f.plugin, contribution, {}, signal()); void pending.catch(() => {}); await ready;
  const input = { value: "admitted" }, healthyCall = f.runtime.call(other, { ...contribution, command: healthy.url.href }, input, signal()); input.value = "mutated";
  expect(await healthyCall).toBe("admitted");
  await f.runtime.stopPlugin(f.plugin); await expect(pending).rejects.toThrow("stopped");
  expect(await f.runtime.call(other, { ...contribution, command: healthy.url.href }, { value: "healthy" }, signal())).toBe("healthy");
});

test("eager activation obeys the stdio process ceiling and rolls back partial startup", async () => {
  const f = await fixture(`import {createInterface} from 'node:readline';createInterface({input:process.stdin}).on('line',line=>console.log(JSON.stringify({id:JSON.parse(line).id,result:'healthy'})));`);
  const runtime = new PluginToolRuntimeManager({}, { maxStdioProcesses: 1 }); cleanup.push(() => runtime.close());
  const first = { ...f.contribution, lifecycle: { ...f.contribution.lifecycle, transport: "stdio" as const, start: "eager" as const } };
  const overloaded = { ...f.plugin, toolContributions: [first, { ...first, id: "second" }] };
  await expect(runtime.startEager([overloaded])).rejects.toThrow("process limit");
  await expect(runtime.call(overloaded, first, {}, signal())).rejects.toThrow("stopped");
  const healthy = { ...f.plugin, root: f.root, toolContributions: [first] };
  await runtime.startEager([healthy]);
  expect(await runtime.call(healthy, first, {}, signal())).toBe("healthy");
});

test("compiled hosts bundle the pinned HTTP client and retain direct connection policy", async () => {
  const f = await fixture(); let proxies = 0;
  const endpoint = listen(() => Response.json({ result: "compiled direct call" }));
  const proxy = listen(() => { proxies++; return Response.json({ result: "unexpected proxy" }); });
  const script = join(f.root, "compiled.ts"), outfile = join(f.root, process.platform === "win32" ? "probe.exe" : "probe");
  const contribution = { ...f.contribution, command: endpoint.url.href, lifecycle: { ...f.contribution.lifecycle, transport: "http" as const }, args: [] };
  await writeFile(script, `import {PluginToolRuntimeManager} from ${JSON.stringify(fileURLToPath(new URL("../../src/services/plugins/tools.ts", import.meta.url)))};
    const runtime=new PluginToolRuntimeManager({});try{console.log(await runtime.call(${JSON.stringify(f.plugin)},${JSON.stringify(contribution)},{},new AbortController().signal));}finally{await runtime.close();}`);
  const result = await Bun.build({ entrypoints: [script], target: "bun", compile: { outfile } });
  expect(result.success, result.logs.map(item => item.message).join("\n")).toBe(true);
  const child = Bun.spawn([outfile], { cwd: f.root, env: { ...process.env, HTTP_PROXY: proxy.url.href, http_proxy: proxy.url.href, NO_PROXY: "", no_proxy: "" }, stdout: "pipe", stderr: "pipe" });
  const [code, output, diagnostic] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, diagnostic).toBe(0); expect(output).toContain("compiled direct call"); expect(proxies).toBe(0);
}, 15000);

test("discovery rejects unsupported external transports and invalid HTTP declarations", async () => {
  const f = await fixture();
  for (const [tool, error] of [
    [{ command: "http://example.com", lifecycle: { transport: "http" }, security: { network: "loopback" } }, "loopback"],
    [{ command: "http://127.0.0.1", lifecycle: { transport: "http" }, args: [] }, "declare"],
    [{ command: "http://user:secret@127.0.0.1", lifecycle: { transport: "http" }, security: { network: "egress" } }, "credentials"],
    [{ command: "http://127.0.0.1", args: ["ignored"], lifecycle: { transport: "http" }, security: { network: "loopback" } }, "command args"],
    [{ command: "./tool.mjs", lifecycle: { transport: "in_process" } }, "in_process"],
  ] as const) {
    await writeFile(join(f.pack, "plugin.json"), JSON.stringify({ name: "runtime-pack", contributes: { tools: [{ id: "invalid", description: "Invalid fixture", ...tool }] } }));
    const result = await loadPlugins([{ directory: f.root, source: "user" }]);
    expect(result.plugins).toEqual([]); expect(result.errors[0]?.error).toContain(error);
    expect(result.errors[0]?.error).not.toContain("secret");
  }
});

test("a newer stop request supersedes an activation waiting for old cleanup", async () => {
  const f = await fixture(`import {writeFileSync} from 'node:fs';writeFileSync(new URL('pid',import.meta.url),String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`);
  const pending = f.runtime.call(f.plugin, f.contribution, {}, signal()); void pending.catch(() => {});
  await waitFor(join(f.pack, "pid"));
  const stopping = f.runtime.stopPlugin(f.plugin), activating = f.runtime.startEager([f.plugin]); void activating.catch(() => {});
  expect(f.runtime.stopPlugin(f.plugin)).toBe(stopping);
  await stopping; await expect(activating).rejects.toThrow("superseded"); await expect(pending).rejects.toThrow("stopped");
  await expect(f.runtime.call(f.plugin, f.contribution, {}, signal())).rejects.toThrow("stopped");
});

test("HTTP refuses compressed and malformed bodies instead of returning incomplete success", async () => {
  const f = await fixture();
  const endpoint = listen(() => new Response(Bun.gzipSync('x'.repeat(32768)), { headers: { "content-encoding": "gzip" } }));
  const contribution = { ...f.contribution, command: endpoint.url.href, args: [], lifecycle: { ...f.contribution.lifecycle, transport: "http" as const } };
  await expect(f.runtime.call(f.plugin, contribution, {}, signal())).rejects.toThrow("compressed responses");
  const malformed = listen(() => Response.json({ jsonrpc: "2.0", id: "missing-result" }));
  await expect(f.runtime.call(f.plugin, { ...contribution, command: malformed.url.href }, {}, signal())).rejects.toThrow("missing result");
});
