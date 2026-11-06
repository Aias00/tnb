import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { initializePlugin, testPluginPackage, validatePluginPackage } from "../../src/services/plugins/development";
import { createPluginTestHost, provideService, type PluginTestHost } from "../../src/plugin-sdk/testing";
import { createServiceRef } from "../../src/plugin-sdk";

const roots: string[] = [], hosts: PluginTestHost[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
async function fixture(code?: string, timeoutMs = 3000) {
  const root = await mkdtemp(join(tmpdir(), "tnb-process-integration-")); roots.push(root);
  const directory = join(root, "plugin"); await initializePlugin(directory, "application", "process-fixture", { execution: "process" });
  const manifest = JSON.parse(await readFile(join(directory, "plugin.json"), "utf8"));
  manifest.contributes.applications[0].execution.timeoutMs = timeoutMs;
  await writeFile(join(directory, "plugin.json"), JSON.stringify(manifest));
  if (code) await writeFile(join(directory, "index.mjs"), code);
  return { directory, manifest };
}
const ref = { kind: "application" as const, id: "process-fixture", version: "1" };
const request = (path = "/", signal?: AbortSignal) => new Request("http://plugin" + path, { signal });
async function rejects(job: Promise<unknown>, fragment: string) {
  // Await the outcome before using Bun's matcher: RPC may need to re-enter JS on this thread.
  const error = await job.then(() => null, error => error);
  expect(error).toBeInstanceOf(Error); expect(error.message).toContain(fragment);
}
async function open(directory: string) { const host = await createPluginTestHost({ packageDirectory: directory }); hosts.push(host); return host; }

for (const template of ["application", "channel"] as const) test(`process ${template} template executes the real manifest/test contracts`, async () => {
  const root = await mkdtemp(join(tmpdir(), "tnb-process-template-")); roots.push(root);
  const directory = join(root, "plugin"); await initializePlugin(directory, template, "process-fixture", { execution: "process" });
  expect((await validatePluginPackage(directory)).ok).toBe(true);
  const report = await testPluginPackage(directory); expect(report.ok, JSON.stringify(report)).toBe(true);
});

test("entry imports occur only in a child, environment is minimal, and state survives owner restart", async () => {
  const { directory } = await fixture(`if (process.pid === ${process.pid}) throw new Error("Owner imported plugin entry");
export default { protocol: "tnb.process-plugin/v1", async start(context) { return { async handle() {
  await context.state.command("once", { value: 1 }, [{ id: "record", value: 1, previousRevision: 0 }]);
  return { status: 200, body: JSON.stringify({ pid: process.pid, home: process.env.HOME, credentials: !!process.env.TNB_PROCESS_TEST_SECRET, record: await context.state.get("record") }) };
} }; } };`);
  const previous = process.env.TNB_PROCESS_TEST_SECRET; process.env.TNB_PROCESS_TEST_SECRET = "fixture-only";
  try {
    const host = await open(directory); const first = await (await host.request(ref, request())).json();
    expect(first.pid).not.toBe(process.pid); expect(first.credentials).toBe(false); expect(first.home).not.toBe(process.env.HOME); expect(first.record.value).toBe(1);
    await host.restart(); const next = await (await host.request(ref, request())).json();
    expect(next.pid).not.toBe(first.pid); expect(next.record).toEqual(first.record);
  } finally { if (previous === undefined) delete process.env.TNB_PROCESS_TEST_SECRET; else process.env.TNB_PROCESS_TEST_SECRET = previous; }
});

test("blocked process times out while owner stays responsive; no automatic restart or replay", async () => {
  const { directory } = await fixture(`export default { protocol: "tnb.process-plugin/v1", start() { return { async handle() { while (true) {} } }; } };`, 200);
  const host = await open(directory); let responsive = false;
  const timer = setTimeout(() => { responsive = true; }, 10);
  await rejects(host.request(ref, request()), "timed out"); clearTimeout(timer); expect(responsive).toBe(true);
  await rejects(host.request(ref, request()), "timed out");
});

test("cancel kills a non-cooperative process and invalidates its concurrent requests", async () => {
  const { directory } = await fixture(`export default { protocol: "tnb.process-plugin/v1", start() { return { async handle() { await new Promise(() => {}); } }; } };`);
  const host = await open(directory), cancellation = new AbortController();
  const pending = host.request(ref, request("/first", cancellation.signal));
  const other = host.request(ref, request("/second"));
  const outcomes = Promise.all([pending, other].map(job => job.then(() => null, error => error)));
  setTimeout(() => cancellation.abort(), 20);
  for (const error of await outcomes) expect(error?.message).toContain("cancelled");
});

test("process service calls require declared grants and JSON results; invalid results fail explicitly", async () => {
  const { directory, manifest } = await fixture(`export default { protocol: "tnb.process-plugin/v1", start(context) { return { async handle() {
    const result = await context.call({ id: "test.process", version: 1, name: "test.process/v1", scope: "contribution", methods: { echo: true } }, "echo", ["hello"]);
    return { status: 200, body: JSON.stringify(result) };
  } }; } };`);
  manifest.contributes.applications[0].services = ["test.process/v1"];
  await writeFile(join(directory, "plugin.json"), JSON.stringify(manifest));
  const service = createServiceRef<{ echo(text: string): Promise<any> }>({ id: "test.process", version: 1, scope: "contribution", methods: { echo: true } });
  await rejects(open(directory), "not granted");
  let valid = true;
  const host = await createPluginTestHost({ packageDirectory: directory, serviceGrants: { "process-fixture": [service.name] },
    serviceProviders: [provideService(service, () => ({ async echo(text) { return valid ? { text } : { secretHandle() {} }; } }))] }); hosts.push(host);
  expect(await (await host.request(ref, request())).json()).toEqual({ text: "hello" }); valid = false;
  await rejects(host.request(ref, request()), "Host capability call rejected");
});

test("process rejects oversized output and recovers only after explicit owner restart", async () => {
  const { directory } = await fixture(`export default { protocol: "tnb.process-plugin/v1", start() { return { async handle(request) {
    if (request.url.endsWith("/crash")) process.exit(7);
    if (request.url.endsWith("/large")) return { status: 200, body: "x".repeat(300000) };
    return { status: 200, body: "ready" };
  } }; } };`);
  const host = await open(directory);
  await rejects(host.request(ref, request("/crash")), "exited");
  await rejects(host.request(ref, request()), "exited");
  await host.restart(); expect(await (await host.request(ref, request())).text()).toBe("ready");
  await rejects(host.request(ref, request("/large")), "frame exceeds limit");
});

test("read-only validation rejects unsupported process protocols and synchronous migration callbacks", async () => {
  const { directory, manifest } = await fixture();
  manifest.contributes.applications[0].execution.protocol = "unknown/v2";
  await writeFile(join(directory, "plugin.json"), JSON.stringify(manifest)); expect((await validatePluginPackage(directory)).ok).toBe(false);
  manifest.contributes.applications[0].execution.protocol = "tnb.process-plugin/v1";
  manifest.contributes.applications[0].state = { version: 2, migrations: [{ from: 1, to: 2 }] };
  await writeFile(join(directory, "plugin.json"), JSON.stringify(manifest)); expect((await validatePluginPackage(directory)).ok).toBe(false);
  delete manifest.contributes.applications;
  manifest.contributes.adapters = [{ id: "bad-adapter", version: "1", entry: "index.mjs", execution: { mode: "process" } }];
  await writeFile(join(directory, "plugin.json"), JSON.stringify(manifest)); expect((await validatePluginPackage(directory)).ok).toBe(false);
});

test("process interfaces route through declared contributions without importing either entry into the owner", async () => {
  const { directory, manifest } = await fixture();
  manifest.contributes.interfaces = [{ id: "process-view", version: "1", entry: "view.mjs", execution: { mode: "process", protocol: "tnb.process-plugin/v1" }, requires: [ref] }];
  await writeFile(join(directory, "plugin.json"), JSON.stringify(manifest));
  await writeFile(join(directory, "view.mjs"), `export default { protocol: "tnb.process-plugin/v1", start(context) { return { async handle(request) {
    return context.request({ kind: "application", id: "process-fixture", version: "1" }, request);
  } }; } };`);
  const host = await open(directory);
  expect(await (await host.request({ kind: "interface", id: "process-view", version: "1" }, request())).json()).toEqual({ ready: true, visits: 0 });
});

test("committed state survives a timed-out process without automatic effect replay", async () => {
  const { directory } = await fixture(`export default { protocol: "tnb.process-plugin/v1", start(context) { return { async handle(request) {
    if (request.url.endsWith("/commit")) {
      await context.state.command("once", { value: 1 }, [{ id: "effect", previousRevision: 0, value: 1 }]);
      while (true) {}
    }
    return { status: 200, body: JSON.stringify(await context.state.get("effect")) };
  } }; } };`, 1000);
  const host = await open(directory);
  await rejects(host.request(ref, request("/commit")), "outcomes may be unknown");
  await host.restart(); const record = await (await host.request(ref, request())).json();
  expect(record.value).toBe(1); expect(record.revision).toBe(1);
});

test("non-JSON plugin output is rejected instead of silently dropping functions", async () => {
  const { directory } = await fixture(`export default { protocol: "tnb.process-plugin/v1", start() { return { async handle() {
    return { status: 200, body: "ok", hiddenFunction() {} };
  } }; } };`);
  const host = await open(directory);
  await rejects(host.request(ref, request()), "requires JSON data");
});

test.skipIf(process.platform === "win32")("supervisor reclaims a synchronously blocked plugin after its owner is killed", async () => {
  const { directory } = await fixture(`export default { protocol: "tnb.process-plugin/v1", start() { return { async handle(request) {
    if (request.url.endsWith("/pid")) return { status: 200, body: String(process.pid) };
    while (true) {}
  } }; } };`);
  const module = pathToFileURL(resolve(import.meta.dir, "../../src/plugin-sdk/testing.ts")).href;
  const script = `import { createPluginTestHost } from ${JSON.stringify(module)};
    const host = await createPluginTestHost({ packageDirectory: process.argv.at(-1) });
    const ref = { kind: "application", id: "process-fixture", version: "1" };
    console.log(await (await host.request(ref, new Request("http://plugin/pid"))).text());
    await host.request(ref, new Request("http://plugin/block"));`;
  const parent = Bun.spawn([process.execPath, "-e", script, directory], { stdout: "pipe", stderr: "pipe",
    env: { ...process.env, TMPDIR: roots.at(-1)!, TMP: roots.at(-1)!, TEMP: roots.at(-1)! } });
  const reader = parent.stdout.getReader(); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const first = await Promise.race([reader.read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Owner test startup timed out")), 5000); })]);
    clearTimeout(timer); const pid = Number(Buffer.from(first.value!).toString("utf8").trim()); expect(pid).toBeGreaterThan(0);
    await Bun.sleep(50); parent.kill("SIGKILL"); await parent.exited;
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const deadline = Date.now() + 3000; while (alive() && Date.now() < deadline) await Bun.sleep(10);
    expect(alive()).toBe(false);
  } finally { clearTimeout(timer); parent.kill(); await parent.exited; await reader.cancel(); }
}, 10000);
