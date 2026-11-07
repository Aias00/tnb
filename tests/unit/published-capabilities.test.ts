import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PublishedCapabilities, validateCapabilityDefinition, validateCapabilityRequest } from "../../src/services/runtime/capabilities";
import { DurableRuntime, type RuntimeConfiguration } from "../../src/services/runtime/engine-core";
import { RuntimeStore } from "../../src/services/runtime/store";
import { DomainRegistry, type AgentDomainAdapter } from "../../src/agent/domain";
import type { CapabilityConsumer, CapabilityDefinition, ExecutionService } from "../../src/agent/execution-service";
import type { ServiceFactoryContext } from "../../src/agent/services";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const plugin = { name: "domain-fixture", version: "1.0.0", fingerprint: "a".repeat(64) };
const consumer: CapabilityConsumer = { plugin: { name: "business", version: "1.0.0", fingerprint: "b".repeat(64) }, contribution: { kind: "application", id: "intake", version: "1" } };
const ref = { id: "support.reply", version: "1" };
function definition(): CapabilityDefinition { return { protocol: "tnb.capability/v1", ...ref, namespace: "support", objective: "Reply to the supplied message",
  adapter: { id: "reply", version: "1" }, inputSchema: { type: "object", properties: { message: { type: "string", minLength: 1 } }, required: ["message"], additionalProperties: false },
  resources: [{ id: "support:inbox", mode: "read" }], grants: [], execution: { mode: "single", maxTurns: 4, maxRetries: 0, maxDurationMs: 60000 } }; }
const request = (commandId = "business-1") => ({ commandId, capability: ref, input: { message: "hello" } });
function adapter(normalize?: (configuration: RuntimeConfiguration) => Promise<void>): AgentDomainAdapter {
  return { id: "reply", version: "1", validate(config) { if (!(config as any)?.message) throw new Error("message required"); },
    ...(normalize ? { runtime: { normalize } } : {}), snapshot: async () => ({ version: 1 }), accept: async () => ({ checks: [] }), createWorker: async () => { throw new Error("Unit test must not execute a model"); } };
}
async function fixture(options: { normalize?: (configuration: RuntimeConfiguration) => Promise<void>; database?: string; identity?: typeof plugin } = {}) {
  const root = await mkdtemp(join(tmpdir(), "tnb-publications-")); cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const store = new RuntimeStore(options.database ?? ":memory:");
  const runtime = new DurableRuntime(store, root, new DomainRegistry([], [{ adapter: adapter(options.normalize), plugin: options.identity ?? plugin }]));
  cleanup.push(async () => { await runtime.close(); store.close(); if (process.platform === "win32") Bun.gc(true); });
  const capabilities = new PublishedCapabilities(runtime);
  const scope = (identity = consumer, assertActive = () => {}) => ({ consumer: identity, assertActive }) as ServiceFactoryContext;
  const service = (identity = consumer, assertActive = () => {}) => capabilities.service(scope(identity, assertActive));
  const grant = (identity = consumer, enabled = true, expectedRevision = 0, commandId = crypto.randomUUID()) => capabilities.command({ action: "grant", commandId, consumer: identity, capability: ref, enabled, expectedRevision });
  return { root, store, runtime, capabilities, service, grant };
}
const failure = async (promise: Promise<unknown>) => promise.then(() => "unexpected success", error => String(error));

test("publication checks are metadata-only, immutable and use revision CAS", async () => {
  const f = await fixture();
  const checked: any = f.capabilities.command({ action: "check", definition: definition() }); expect(checked.plugin).toEqual(plugin); expect(f.store.runs()).toHaveLength(0);
  const published: any = f.capabilities.command({ action: "publish", definition: definition() }); expect(published.revision).toBe(1);
  expect(f.capabilities.command({ action: "publish", definition: definition() })).toEqual(published);
  expect(() => f.capabilities.command({ action: "publish", definition: { ...definition(), objective: "Changed" } })).toThrow("immutable");
  expect(() => f.capabilities.command({ action: "state", commandId: "stale", capability: ref, enabled: false, expectedRevision: 7 })).toThrow("revision");
  const disabled: any = f.capabilities.command({ action: "state", commandId: "disable", capability: ref, enabled: false, expectedRevision: 1 }); expect(disabled.revision).toBe(2);
  expect(f.capabilities.get(ref).enabled).toBe(false); expect(f.capabilities.get(ref).digest).toBe(published.digest);
  expect((f.capabilities.command({ action: "list", limit: 1 }) as any).items).toHaveLength(1);
});

test("strict contracts reject unknown execution authority, invalid schema and excessive input", () => {
  expect(() => validateCapabilityDefinition({ ...definition(), execution: { allowShell: true } })).toThrow("unknown field");
  expect(() => validateCapabilityDefinition({ ...definition(), adapter: { id: "reply", version: "1", plugin } })).toThrow();
  expect(() => validateCapabilityDefinition({ ...definition(), inputSchema: { type: "object", $ref: "remote" } })).toThrow();
  expect(() => validateCapabilityRequest({ ...request(), namespace: "other" })).toThrow();
  expect(() => validateCapabilityRequest({ ...request(), input: "a".repeat(50000) })).toThrow("byte limit");
});

test("exact contribution grants, schema and private run ownership prevent cross-plugin access", async () => {
  const f = await fixture(); f.capabilities.command({ action: "publish", definition: definition() });
  expect(await failure(f.service().submit(request()))).toContain("ACCESS_DENIED");
  f.grant();
  const changed = { ...consumer, contribution: { ...consumer.contribution, id: "other" } };
  expect(f.service(changed).catalog({}).items).toHaveLength(0);
  expect(await failure(f.service(changed).submit(request()))).toContain("ACCESS_DENIED");
  expect(await failure(f.service().submit({ ...request(), input: { message: "hello", allowShell: true } }))).toContain("schema");
  const result = await f.service().submit(request());
  const config = f.runtime.configuration(result.runId); expect(config.allowShell).toBe(false); expect(config.workspace).toBe("agent:support");
  expect(config.executionBinding?.publicationDigest).toBe(result.publicationDigest);
  expect(config.executionBinding?.consumer).toEqual(consumer);
  expect(() => f.service(changed).status({ runId: result.runId })).toThrow("ACCESS_DENIED");
  expect(f.service().catalog({}).items[0]?.capability).toEqual(ref);
  f.grant(consumer, false, 1);
  expect(() => f.service().status({ runId: result.runId })).toThrow("ACCESS_DENIED");
  expect(await failure(f.service().submit(request()))).toContain("ACCESS_DENIED");
  expect(f.store.getRun(result.runId)?.status).toBe("active"); // revoke access, never silently cancel
});

test("business receipts precede publication state; same key with changed input conflicts", async () => {
  const f = await fixture(); f.capabilities.command({ action: "publish", definition: definition() }); f.grant();
  const receipt = await f.service().submit(request());
  f.capabilities.command({ action: "state", commandId: "disable", capability: ref, enabled: false, expectedRevision: 1 });
  expect(await f.service().submit(request())).toEqual(receipt);
  expect(await failure(f.service().submit(request("new")))).toContain("disabled");
  expect(await failure(f.service().submit({ ...request(), input: { message: "changed" } }))).toContain("different input");
  expect(f.store.runs()).toHaveLength(1);
});

test("concurrent identical requests with different prepared deadlines create exactly one Run", async () => {
  let entered = 0; const ready = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const f = await fixture({ normalize: async () => { if (++entered === 2) ready.resolve(); await release.promise; } });
  f.capabilities.command({ action: "publish", definition: definition() }); f.grant();
  const first = f.service().submit(request()); await Bun.sleep(5); const second = f.service().submit(request());
  await ready.promise; release.resolve(); const receipts = await Promise.all([first, second]);
  expect(receipts[0]).toEqual(receipts[1]); expect(f.store.runs()).toHaveLength(1);
});

test("revocation or disable during asynchronous admission prevents any Run creation", async () => {
  for (const action of ["revoke", "disable", "scope"]) {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let active = true;
    const f = await fixture({ normalize: async () => { entered.resolve(); await release.promise; } });
    f.capabilities.command({ action: "publish", definition: definition() }); f.grant();
    const submitted = failure(f.service(consumer, () => { if (!active) throw new Error("scope ended"); }).submit(request()));
    await entered.promise;
    if (action === "revoke") f.grant(consumer, false, 1);
    else if (action === "disable") f.capabilities.command({ action: "state", commandId: "disable", capability: ref, enabled: false, expectedRevision: 1 });
    else active = false;
    release.resolve(); expect(await submitted).not.toBe("unexpected success"); expect(f.store.runs()).toHaveLength(0);
  }
});

test("Adapter normalize cannot rewrite published budgets or resource claims", async () => {
  const f = await fixture({ normalize: async config => { config.maxTurns = 1000; } });
  f.capabilities.command({ action: "publish", definition: definition() }); f.grant();
  expect(await failure(f.service().submit(request()))).toContain("published execution contract"); expect(f.store.runs()).toHaveLength(0);
});

test("separate consumers and Owner have isolated idempotency scopes", async () => {
  const f = await fixture(); f.capabilities.command({ action: "publish", definition: definition() }); f.grant();
  const other = { ...consumer, contribution: { ...consumer.contribution, id: "second" } }; f.grant(other);
  const receipts = await Promise.all([f.service().submit(request()), f.service(other).submit(request()), f.capabilities.submit(request())]);
  expect(new Set(receipts.map(r => r.runId)).size).toBe(3); expect(f.store.runs()).toHaveLength(3);
});

test("durable publications, grants and original receipts survive reopen and approved consumer upgrade", async () => {
  const f = await fixture(), database = join(f.root, "durable.sqlite"); const first = await fixture({ database });
  first.capabilities.command({ action: "publish", definition: definition() }); first.grant();
  const receipt = await first.service().submit(request()); await first.runtime.close(); first.store.close();
  const second = await fixture({ database, identity: { ...plugin, fingerprint: "c".repeat(64) } });
  expect(await second.service().submit(request())).toEqual(receipt);
  expect(await failure(second.service().submit(request("new")))).toContain("code unavailable or changed");
  const next = { ...consumer, plugin: { ...consumer.plugin, version: "2.0.0", fingerprint: "d".repeat(64) } };
  expect(await failure(second.service(next).submit(request()))).toContain("ACCESS_DENIED");
  second.grant(next, true, 1); expect(await second.service(next).submit(request())).toEqual(receipt);
  expect(await failure(second.service().submit(request()))).toContain("ACCESS_DENIED");
});

test("accepted results use bounded lossless JSON pages and reject other Run/task IDs", async () => {
  const f = await fixture(); f.capabilities.command({ action: "publish", definition: definition() }); f.grant(); const service: ExecutionService = f.service();
  const receipt = await service.submit(request()), task = f.store.tasks(receipt.runId)[0]!;
  expect(await failure(service.result({ runId: receipt.runId, taskId: task.taskId }))).toContain("unavailable");
  const payload = { report: "中文😀".repeat(30000) }, resultRef = await f.runtime.artifacts.put(payload);
  f.store.command("fixture.accept", { taskId: task.taskId }, Date.now(), tx => { let current = task; for (const status of ["running", "validating", "succeeded"] as const) { const next = { ...current, status, resultRef, revision: current.revision + 1 }; tx.saveTask(next, current.revision); current = next; } return true; });
  const another = await service.submit(request("other"));
  expect(await failure(service.result({ runId: another.runId, taskId: task.taskId }))).toContain("unavailable");
  expect(service.status({ runId: receipt.runId, limit: 1 }).tasks[0]?.hasResult).toBe(true);
  let assembled = "", offset = 0;
  for (;;) { const page = await service.result({ runId: receipt.runId, taskId: task.taskId, offset, limit: 16001 }); expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(100000); assembled += page.text; if (page.next === undefined) break; offset = page.next; }
  expect(JSON.parse(assembled)).toEqual(payload);
  expect(await failure(service.result({ runId: receipt.runId, taskId: task.taskId, offset: assembled.length + 1 }))).toContain("offset");
  const read = f.runtime.artifacts.get.bind(f.runtime.artifacts), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  f.runtime.artifacts.get = async <T>(hash: string): Promise<T> => { entered.resolve(); await release.promise; return read<T>(hash); };
  const pending = failure(service.result({ runId: receipt.runId, taskId: task.taskId })); await entered.promise;
  f.grant(consumer, false, 1); release.resolve(); expect(await pending).toContain("ACCESS_DENIED");
});

test("grant CAS failures never broaden access and exact administration retries preserve receipts", async () => {
  const f = await fixture(); f.capabilities.command({ action: "publish", definition: definition() });
  const input = { action: "grant", commandId: "grant-replay", consumer, capability: ref, enabled: true, expectedRevision: 0 };
  const granted = f.capabilities.command(input); expect(f.capabilities.command(input)).toEqual(granted);
  expect(() => f.capabilities.command({ ...input, enabled: false })).toThrow("different input");
  const otherCode = { ...consumer, plugin: { ...consumer.plugin, fingerprint: "e".repeat(64) } };
  expect(() => f.grant(otherCode, true, 9)).toThrow("revision");
  expect(await failure(f.service(otherCode).submit(request()))).toContain("ACCESS_DENIED");
  expect((f.capabilities.command({ action: "grants" }) as any).items[0].consumer).toEqual(consumer);
});

test("explicit terminal prune retires execution evidence without reusing the business identity", async () => {
  const f = await fixture(); f.capabilities.command({ action: "publish", definition: definition() }); f.grant();
  const receipt = await f.service().submit(request());
  f.store.command("fixture.terminal", { runId: receipt.runId }, Date.now(), tx => {
    const run = tx.getRun(receipt.runId)!; tx.saveRun({ ...run, status: "cancelled", revision: run.revision + 1 }, run.revision); return true;
  });
  f.store.deleteTerminalRun(receipt.runId);
  expect(await failure(f.service().submit(request()))).toContain("evidence unavailable"); expect(f.store.runs()).toHaveLength(0);
});
