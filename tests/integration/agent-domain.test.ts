import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { openAgentRuntime, type AgentRuntimeHost } from "../../src/agent/runtime";
import { defineTool } from "../../src/agent";
import type { AgentDomainAdapter, DomainDescriptor } from "../../src/agent/domain";
import { createResearchAdapter, researchTask } from "../../src/adapters/research";
import type { ModelTransport } from "../../src/providers/types";
import type { Operation } from "../../src/services/runtime/journal";
import { tryAcquireResources } from "../../src/services/runtime/resources";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function directory() { const root = await mkdtemp(join(tmpdir(), "tnb-domain-")); cleanup.push(() => rm(root, { recursive: true, force: true })); return root; }
async function open(root: string, adapters: AgentDomainAdapter[]) { const host = await openAgentRuntime({ directory: root, adapters }); cleanup.push(() => host.close()); return host; }
async function until(host: AgentRuntimeHost, check: () => boolean) { const end = Date.now() + 8000; while (!check()) { if (Date.now() > end) throw new Error(`Timeout: ${JSON.stringify(host.store.runs())}; ${JSON.stringify(host.store.runs().flatMap(run => host.store.tasks(run.runId)))}`); await host.runtime.tick(); await Bun.sleep(10); } }
function* call(name: string, input: unknown, id = name) { yield { type: "tool-start" as const, index: 0, id, name }; yield { type: "tool-input" as const, index: 0, json: JSON.stringify(input) }; yield { type: "response-end" as const, reason: "tool-use" as const }; }
function* report(text = "Verified domain deliverable") { yield { type: "text" as const, index: 0, text }; yield { type: "response-end" as const, reason: "end-turn" as const }; }
const descriptor = (resource = `test:${randomUUID()}`): DomainDescriptor => ({ id: "fixture", version: "1", config: {}, resources: [{ id: resource, mode: "read" }], grants: [] });
function adapter(transport: ModelTransport, overrides: Partial<AgentDomainAdapter> = {}): AgentDomainAdapter {
  return { id: "fixture", version: "1", validate() {}, snapshot: async () => ({ version: 1 }),
    createWorker: async () => ({ transport, model: "fixture", route: { provider: "fixture", model: "fixture" }, maxOutputTokens: 512, tools: [], authorize: async () => ({ behavior: "allow" }) }),
    accept: async () => ({ checks: [{ command: "domain-fact", output: "confirmed" }] }), ...overrides };
}

test("research executes without a project directory, file tools, Shell or Git and accepts actual source evidence", async () => {
  let calls = 0;
  const source = `docs:${randomUUID()}`;
  const transport: ModelTransport = { async *stream(request) {
    expect(request.systemPrompt).not.toContain("coding agent"); expect(request.systemPrompt).not.toContain("Working directory:");
    expect(request.tools.some(tool => ["read", "write", "bash", "edit"].includes(tool.name))).toBe(false);
    if (++calls === 1) yield* call("read_source_0", {});
    else { expect(JSON.stringify(request.messages)).toContain("actual source fact"); yield* report(`Finding: actual source fact [source:${source}]`); }
  } };
  const host = await open(await directory(), [createResearchAdapter({ model: "fixture", transport, readSource: async () => ({ version: "v1", text: "actual source fact" }) })]);
  const { run, tasks } = await host.submit({ commandId: "create", namespace: "research/account", objective: "Investigate a document", adapter: researchTask([source]), mode: "single" });
  await until(host, () => host.store.getRun(run.runId)?.status === "succeeded");
  const result = await host.runtime.artifacts.get<{ acceptance: string; checks: unknown[] }>(host.store.getTask(tasks[0]!.taskId)!.resultRef!);
  expect(result.acceptance).toBe("domain-verified"); expect(result.checks).toHaveLength(1); expect(calls).toBe(2);
  expect(host.runtime.configuration(run.runId).workspace).toBe("agent:research/account");
});

test("a citation without a successful source receipt is rejected by the research adapter", async () => {
  const source = `docs:${randomUUID()}`;
  const host = await open(await directory(), [createResearchAdapter({ model: "fixture", transport: { async *stream() { yield* report(`Claim [source:${source}]`); } }, readSource: async () => ({ version: "1", text: "fact" }) })]);
  const { run } = await host.submit({ commandId: "create", namespace: "research", objective: "Report", adapter: researchTask([source]), maxRetries: 0 });
  await until(host, () => host.store.getRun(run.runId)?.status === "failed");
  expect(host.store.tasks(run.runId)[0]!.error).toContain("actual source receipt");
});

test("questions survive owner close and reopen with the same identities and no polling model", async () => {
  const root = await directory(), desc = descriptor(); let requests = 0;
  const profile = adapter({ async *stream() { if (++requests === 1) yield* call("durable_wait", { kind: "question", key: "choice", question: "Which option?", options: ["A", "B"], about: "Continue the accepted choice" }); else yield* report("Used option A"); } });
  const first = await open(root, [profile]); const { run, tasks } = await first.submit({ commandId: "create", namespace: "decisions", objective: "Wait for a decision", adapter: desc });
  await until(first, () => first.store.getTask(tasks[0]!.taskId)?.status === "waiting");
  const question = first.runtime.waits.questions(run.runId)[0]!; await first.close();
  const reopened = await open(root, [profile]); expect(requests).toBe(1);
  expect(reopened.runtime.waits.questions(run.runId)[0]!.waitId).toBe(question.waitId);
  reopened.runtime.waits.answer({ commandId: "answer", runId: run.runId, waitId: question.waitId, expectedVersion: question.version, answer: "A" });
  await until(reopened, () => reopened.store.getRun(run.runId)?.status === "succeeded");
  expect(reopened.store.tasks(run.runId)[0]!.taskId).toBe(tasks[0]!.taskId); expect(requests).toBe(2);
});

test("an unavailable pinned adapter pauses active tasks and a different version cannot resume them", async () => {
  const root = await directory(); let requests = 0;
  const profile = adapter({ async *stream() { requests++; yield* call("durable_wait", { kind: "question", key: "choice", question: "Continue?", options: ["Yes", "No"], about: "Pending decision" }); } });
  const first = await open(root, [profile]); const { run } = await first.submit({ commandId: "create", namespace: "version", objective: "Wait", adapter: descriptor() });
  await until(first, () => first.runtime.waits.questions(run.runId).length === 1); await first.close();
  const reopened = await open(root, [{ ...profile, version: "2" }]);
  await until(reopened, () => reopened.store.getRun(run.runId)?.status === "paused");
  await expect(reopened.runtime.resume(run.runId)).rejects.toThrow("pinned version"); expect(requests).toBe(1);
});

test("ungranted and unclassified tools never enter a domain model request", async () => {
  const desc = descriptor(), resource = desc.resources[0]!.id; desc.grants = [{ name: "lookup", resources: [resource], mode: "read" }];
  let exposed: string[] = [];
  const base = adapter({ async *stream(request) { exposed = request.tools.map(tool => tool.name); yield* report(); } });
  const create = base.createWorker;
  const host = await open(await directory(), [{ ...base, async createWorker(context) { const worker = await create(context);
    worker.tools = [defineTool({ name: "lookup", inputSchema: {}, description: "read", validate: value => value, execute: async () => "fact", capability: { name: "lookup", resources: [resource], mode: "read" } }),
      defineTool({ name: "change_account", inputSchema: {}, description: "write", validate: value => value, execute: async () => "changed", capability: { name: "lookup", resources: [resource], mode: "write" } }),
      defineTool({ name: "unclassified_mcp", inputSchema: {}, description: "unknown", validate: value => value, execute: async () => "unknown" })]; return worker;
  } }]);
  const { run } = await host.submit({ commandId: "create", namespace: "policy", objective: "Investigate", adapter: desc, mode: "single" });
  await until(host, () => host.store.getRun(run.runId)?.status === "succeeded");
  expect(exposed).toContain("lookup"); expect(exposed).not.toContain("change_account"); expect(exposed).not.toContain("unclassified_mcp");
});

test("external input versions are checked after acceptance, not inferred from model completion", async () => {
  let version = 1;
  const host = await open(await directory(), [adapter({ async *stream() { yield* report(); } }, {
    snapshot: async () => ({ version }), accept: async () => { version++; return { checks: [{ command: "changed", output: "changed during verification" }] }; },
  })]);
  const { run } = await host.submit({ commandId: "create", namespace: "stale", objective: "Report", adapter: descriptor(), maxRetries: 0 });
  await until(host, () => host.store.getRun(run.runId)?.status === "failed");
  expect(host.store.tasks(run.runId)[0]!.error).toContain("Verification changed its inputs");
});

test("a remote write retains its idempotency identity and requires explicit reconciliation after an uncertain response", async () => {
  const root = await directory(), desc = descriptor(); desc.resources[0]!.mode = "write";
  desc.grants = [{ name: "orders.create", resources: [desc.resources[0]!.id], mode: "write" }];
  let writes = 0, requests = 0, id = "";
  const remote = new Map<string, string>();
  const base = adapter({ async *stream() { if (++requests === 1) yield* call("create_order", {}); else yield* report("Order confirmed"); } });
  const create = base.createWorker;
  const profile: AgentDomainAdapter = { ...base, async createWorker(context) { const worker = await create(context);
    worker.tools = [defineTool({ name: "create_order", access: "network", effects: { replay: "never" }, capability: { name: "orders.create", resources: [desc.resources[0]!.id], mode: "write" },
      description: "Create an order", inputSchema: {}, validate: value => value,
      async execute(_input, _signal, _progress, context) { id = context!.operationId!; expect(id).toMatch(/^[a-f0-9]{64}$/); writes++; remote.set(id, "order-123"); throw new Error("Remote response lost after commit"); },
    })]; return worker;
  }, async reconcile(_context, operation) { expect(operation.operationId).toBe(id); const order = remote.get(operation.operationId);
    return order ? { result: { type: "tool-result", toolUseId: operation.call.id, content: order, isError: false }, attachments: [] } : undefined;
  } };
  const first = await open(root, [profile]); const { run, tasks } = await first.submit({ commandId: "create", namespace: "orders", objective: "Create an order", adapter: desc, mode: "single" });
  await until(first, () => first.store.getRun(run.runId)?.status === "paused"); expect(first.store.getRun(run.runId)?.pauseReason).toBe("unknown-effects"); await first.close();
  const reopened = await open(root, [profile]); expect(writes).toBe(1); expect(requests).toBe(1);
  const operation = reopened.store.records<Operation>("operation", run.runId).find(row => row.value.call.name === "create_order")!;
  expect(await reopened.runtime.reconcileDomainOperation(tasks[0]!.taskId, operation.id)).toBe(true);
  expect(reopened.store.getRun(run.runId)?.status).toBe("paused");
  await reopened.runtime.resume(run.runId); await until(reopened, () => reopened.store.getRun(run.runId)?.status === "succeeded");
  expect(writes).toBe(1); expect(requests).toBe(2);
});

test("generic delegation narrows child resources and capabilities and retains parent evidence review", async () => {
  const desc = descriptor(), source = desc.resources[0]!.id, account = `account:${randomUUID()}`;
  desc.resources.push({ id: account, mode: "write" }); desc.grants = [{ name: "read", resources: [source], mode: "read" }, { name: "change", resources: [account], mode: "write" }];
  let rootRequests = 0, childRequests = 0, host: AgentRuntimeHost;
  const base = adapter({ async *stream(request) {
    if (request.systemPrompt?.includes('"contract":{')) {
      childRequests++; expect(request.tools.some(tool => tool.name === "change_account")).toBe(false);
      yield* call("complete_investigation", { summary: "Independent evidence", evidenceRefs: ["input"], uncertainties: [] }); return;
    }
    if (++rootRequests === 1) yield* call("agent", { key: "read-one", prompt: "Investigate the source", reason: "Independent read scope", scope: [source], evidenceRefs: ["input"],
      deliverable: "Evidence report", acceptance: "Reference the input", required: true, maxTurns: 4, maxRequests: 4 });
    else if (rootRequests === 2) {
      const child = host.store.runs().flatMap(run => host.store.tasks(run.runId)).find(task => task.parentTaskId)!;
      yield* call("review_child_result", { taskId: child.taskId, resultRef: child.resultRef, outcome: "accept", reason: "Reviewed actual child evidence", evidenceRefs: ["input"] });
    } else yield* report("Integrated evidence");
  } });
  const create = base.createWorker;
  host = await open(await directory(), [{ ...base, async createWorker(context) { const worker = await create(context);
    worker.tools = [defineTool({ name: "change_account", inputSchema: {}, description: "Change account", validate: value => value, execute: async () => "changed",
      capability: { name: "change", resources: [account], mode: "write" }, effects: { replay: "never" } })]; return worker;
  } }]);
  const { run } = await host.submit({ commandId: "create", namespace: "multi-domain", objective: "Investigate and integrate", adapter: desc });
  await until(host, () => ["succeeded", "failed", "paused"].includes(host.store.getRun(run.runId)!.status));
  expect(host.store.getRun(run.runId)?.status).toBe("succeeded"); expect(childRequests).toBe(1); expect(rootRequests).toBe(3);
  const child = host.store.tasks(run.runId).find(task => task.parentTaskId)!;
  expect(host.runtime.configuration(run.runId, child.taskId).domain).toMatchObject({ resources: [{ id: source, mode: "read" }], grants: [{ name: "read", resources: [source], mode: "read" }] });
  expect(host.store.record("child-review", child.taskId)).toBeDefined();
});

test("changing an adapter worker binding across restart cannot continue an old approved task", async () => {
  const root = await directory(); let requests = 0, version = 1;
  const base = adapter({ async *stream() { requests++; yield* call("durable_wait", { kind: "question", key: "choice", question: "Choose", options: ["A", "B"], about: "Keep authority pinned" }); } });
  const create = base.createWorker;
  const profile = { ...base, async createWorker(context: Parameters<AgentDomainAdapter["createWorker"]>[0]) { return { ...await create(context), binding: { version } }; } };
  const first = await open(root, [profile]); const { run } = await first.submit({ commandId: "create", namespace: "binding", objective: "Wait", adapter: descriptor() });
  await until(first, () => first.runtime.waits.questions(run.runId).length === 1);
  const question = first.runtime.waits.questions(run.runId)[0]!; await first.close(); version = 2;
  const reopened = await open(root, [profile]); reopened.runtime.waits.answer({ commandId: "answer", runId: run.runId, waitId: question.waitId, expectedVersion: question.version, answer: "A" });
  await until(reopened, () => reopened.store.getRun(run.runId)?.status === "paused");
  expect(reopened.store.tasks(run.runId)[0]!.error).toContain("Adapter capabilities changed"); expect(requests).toBe(1);
});

test("a second owner cannot open the same generic runtime while the first owns it", async () => {
  const root = await directory(), profile = adapter({ async *stream() { yield* report(); } });
  const first = await open(root, [profile]);
  await expect(openAgentRuntime({ directory: root, adapters: [profile] })).rejects.toThrow();
  const { run } = await first.submit({ commandId: "create", namespace: "owner", objective: "Still usable", adapter: descriptor() });
  await until(first, () => first.store.getRun(run.runId)?.status === "succeeded");
});

test("business authorization can deny effects without disabling runtime question controls", async () => {
  let requests = 0, effects = 0;
  const desc = descriptor(); desc.grants = [{ name: "lookup", resources: [desc.resources[0]!.id], mode: "read" }];
  const base = adapter({ async *stream() {
    if (++requests === 1) yield* call("lookup", {});
    else yield* call("durable_wait", { kind: "question", key: "help", question: "Choose a fallback", options: ["A", "B"], about: "Lookup was denied" });
  } });
  const create = base.createWorker;
  const host = await open(await directory(), [{ ...base, async createWorker(context) {
    return { ...await create(context), authorize: async () => ({ behavior: "deny" as const, message: "Business policy denied" }), tools: [defineTool({ name: "lookup", access: "read", effects: { replay: "safe" },
      capability: { name: "lookup", resources: [desc.resources[0]!.id], mode: "read" }, description: "lookup", inputSchema: {}, validate: value => value, execute: async () => { effects++; return "fact"; } })] };
  } }]);
  const { run } = await host.submit({ commandId: "create", namespace: "auth", objective: "Consult a resource", adapter: desc, mode: "single" });
  await until(host, () => host.runtime.waits.questions(run.runId).length === 1);
  expect(effects).toBe(0); expect(requests).toBe(2); expect(host.store.getRun(run.runId)?.status).toBe("active");
});

test("a failed attempt transaction releases already admitted domain resources", async () => {
  const desc = descriptor(); desc.resources[0]!.mode = "write";
  const host = await open(await directory(), [adapter({ async *stream() { throw new Error("must not request a model"); } })]);
  host.runtime.commands.startAttempt = () => { throw new Error("Injected attempt storage failure"); };
  await host.submit({ commandId: "create", namespace: "launch-failure", objective: "Fail before dispatch", adapter: desc });
  await expect(host.runtime.tick()).rejects.toThrow("Injected attempt storage failure");
  const release = tryAcquireResources(desc.resources);
  try { expect(release).toBeDefined(); } finally { release?.(); }
});
