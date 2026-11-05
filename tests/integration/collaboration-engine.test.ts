import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DurableRuntime, type RuntimeWorkerFactory } from "../../src/services/runtime/engine";
import { DurableRuntime as CoreRuntime } from "../../src/services/runtime/engine-core";
import { RuntimeStore } from "../../src/services/runtime/store";
import { CollaborationHost } from "../../src/services/collaboration/host";
import { CollaborationEngine, eventId, NS, ticketId } from "../../src/services/collaboration/engine";
import { parseCollaborationConfig } from "../../src/services/collaboration/config";
import type { CollaborationConfig, IncomingEvent, IntakeEvent, Notification, SourcePort, Ticket } from "../../src/services/collaboration/types";
import type { ModelTransport } from "../../src/providers/types";

const roots: string[] = [], stores: RuntimeStore[] = [], runtimes: DurableRuntime[] = [];
const signal = () => new AbortController().signal;
async function flush(engine: CollaborationEngine) {
  for (let i = 0; i < 20 && engine.records<Notification>(NS.outbox, { state: "pending" }).length; i++) await engine.deliver(signal());
}
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.close(); stores.splice(0).forEach(store => store.close()); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function* report() { yield { type: "text" as const, index: 0, text: "Reviewed the code and delivered a report" }; yield { type: "response-end" as const, reason: "end-turn" as const }; }
function* call(name: string, input: unknown) { yield { type: "tool-start" as const, index: 0, id: name, name }; yield { type: "tool-input" as const, index: 0, json: JSON.stringify(input) }; yield { type: "response-end" as const, reason: "tool-use" as const }; }
async function fixture(transport: ModelTransport = { async *stream() { yield* report(); } }, start = false) {
  const root = await mkdtemp(join(tmpdir(), "tnb-collab-engine-")); roots.push(root); await mkdir(join(root, "work")); const workspace = await realpath(join(root, "work"));
  const state = join(root, "control", "runtime"), database = join(state, "state.sqlite"), store = new RuntimeStore(database); stores.push(store);
  const factory: RuntimeWorkerFactory = async () => ({ transport, model: "fixture", tools: [], authorize: async () => ({ behavior: "allow" }), route: { provider: "fixture", model: "fixture" }, maxOutputTokens: 128 });
  const runtime = new DurableRuntime(store, state, factory); runtimes.push(runtime); if (start) await runtime.start();
  const config = await parseCollaborationConfig({ enabled: true, listen: { hostname: "127.0.0.1", port: 19999 }, sources: [{ id: "chat", type: "webhook", actors: ["alice", "bob"], controllers: ["admin"],
    configuration: { workspace, allowWrite: false, allowShell: false, checks: [] }, mode: "single", webhook: { secretEnv: "BRIDGE_KEY", outboundUrl: "http://127.0.0.1:19998/reply" } }] });
  const delivered: Notification[] = [], ports = new Map<string, SourcePort>([["chat", { async send(notification) { delivered.push(notification as Notification); return `receipt:${notification.id}`; } }]]);
  const engine = new CollaborationEngine(runtime, config, ports);
  const incoming = (id: string, text = "/tnb run Inspect the repository", actor = "alice", thread = "thread-1"): IncomingEvent => ({ externalId: id, text, actor, thread });
  const ticket = (id: string) => store.applicationRecord<Ticket>(NS.tickets, ticketId(eventId("chat", id)))!.value;
  return { root, state, database, store, runtime, factory, config, ports, engine, delivered, incoming, ticket };
}
async function until(runtime: DurableRuntime, predicate: () => boolean) { const end = Date.now() + 8000; while (!predicate()) { if (Date.now() > end) throw new Error(`timeout: ${runtime.lastError}`); await runtime.tick(); await Bun.sleep(5); } }

test("intake authenticates actors, rejects conflicting identities atomically, and pins original authority", async () => {
  const f = await fixture();
  expect((await f.engine.ingest("chat", [f.incoming("forbidden", undefined, "mallory")]))[0]?.state).toBe("rejected");
  await f.engine.ingest("chat", [f.incoming("one")], "cursor-1", 0);
  expect((await f.engine.ingest("chat", [f.incoming("one")]))[0]?.id).toBe(eventId("chat", "one"));
  await expect(f.engine.ingest("chat", [f.incoming("one", "/tnb run CHANGED"), f.incoming("two")], "cursor-2", 1)).rejects.toThrow("conflicting");
  expect(f.engine.cursor("chat")?.value.value).toBe("cursor-1"); expect(f.store.applicationRecord(NS.events, eventId("chat", "two"))).toBeUndefined();
  f.config.sources[0]!.configuration.allowWrite = true; f.config.sources[0]!.configuration.checks = ["touch unauthorized"];
  await f.engine.process(signal()); const ticket = f.ticket("one");
  expect(f.runtime.configuration(ticket.runId).allowWrite).toBe(false); expect(f.runtime.configuration(ticket.runId).checks).toEqual([]);
  await f.engine.ingest("chat", [f.incoming("one")]); await f.engine.process(signal()); expect(f.store.runs()).toHaveLength(1);
});

test("a committed Run replays after the ticket-link crash even if the original plugin is unavailable", async () => {
  const f = await fixture(); await f.engine.ingest("chat", [f.incoming("crash")]);
  const submit = f.runtime.submit.bind(f.runtime);
  f.runtime.submit = async input => { await submit(input); throw new Error("process died before link"); };
  await expect(f.engine.execute(eventId("chat", "crash"), signal())).rejects.toThrow("before link");
  expect(f.store.runs()).toHaveLength(1); expect(f.engine.records(NS.tickets)).toHaveLength(0);
  f.config.sources[0]!.actors = []; // revocation cannot orphan an already committed Run
  const recovered = new CoreRuntime(f.store, f.state); // intentionally no installed Coding adapter
  const engine = new CollaborationEngine(recovered, f.config, f.ports);
  await engine.process(signal());
  expect(f.store.runs()).toHaveLength(1); expect(engine.records<Ticket>(NS.tickets)[0]?.value.runId).toBe(f.store.runs()[0]!.runId);
});

test("thread ambiguity stays explicit, and other actors/threads cannot inject controls", async () => {
  const f = await fixture(); await f.engine.ingest("chat", [f.incoming("one"), f.incoming("two")]); await f.engine.process(signal());
  const [ambiguous] = await f.engine.ingest("chat", [f.incoming("follow", "Extra requirement")]);
  expect(ambiguous?.state).toBe("clarify"); expect(ambiguous?.candidates).toHaveLength(2);
  const row = f.store.applicationRecord<IntakeEvent>(NS.events, ambiguous!.id)!;
  expect(() => f.engine.resolveEvent(row.id, "t_bad", row.revision)).toThrow("conflict");
  f.engine.resolveEvent(row.id, f.ticket("one").id, row.revision); await f.engine.process(signal());
  expect(f.store.applicationRecord<IntakeEvent>(NS.events, row.id)?.value.state).toBe("processed");
  await f.engine.ingest("chat", [f.incoming("stranger", `/tnb followup ${f.ticket("one").id} inject`, "bob"), f.incoming("thread", `/tnb cancel ${f.ticket("one").id}`, "admin", "thread-2"), f.incoming("unauthorized-control", `/tnb cancel ${f.ticket("one").id}`, "alice")]);
  await f.engine.process(signal());
  for (const id of ["stranger", "thread", "unauthorized-control"]) expect(f.store.applicationRecord<IntakeEvent>(NS.events, eventId("chat", id))?.value.state).toBe("blocked");
  expect(f.store.getRun(f.ticket("one").runId)?.status).toBe("active");
});

test("questions notify automatically, stale answers fail, and an answer never resumes a paused Run", async () => {
  let calls = 0; const f = await fixture({ async *stream() {
    if (++calls === 1) yield* call("durable_wait", { kind: "question", key: "database", question: "选择数据库", options: ["SQLite", "其他"], about: "根据选择继续" });
    else yield* report();
  } }, true);
  await f.engine.ingest("chat", [f.incoming("question")]); await f.engine.process(signal()); const ticket = f.ticket("question");
  await until(f.runtime, () => f.store.tasks(ticket.runId)[0]?.status === "waiting" && !f.store.activeAttempts(ticket.runId).length);
  const q = f.runtime.waits.questions(ticket.runId)[0]!;
  await f.engine.project(signal(), false); await flush(f.engine);
  const notice = f.delivered.find(n => n.question)!; expect(notice.text).toContain(`/tnb answer ${ticket.id} ${q.waitId} ${q.version}`);
  await f.engine.ingest("chat", [f.incoming("pause", `/tnb pause ${ticket.id}`, "admin")]); await f.engine.process(signal());
  await until(f.runtime, () => f.store.getRun(ticket.runId)?.status === "paused");
  await f.engine.ingest("chat", [f.incoming("stale", `/tnb answer ${ticket.id} ${q.waitId} ${q.version + 1} SQLite`)]); await f.engine.process(signal());
  expect(f.runtime.waits.questions(ticket.runId)).toHaveLength(1);
  await f.engine.ingest("chat", [f.incoming("answer", `/tnb answer ${ticket.id} ${q.waitId} ${q.version} SQLite`)]); await f.engine.process(signal());
  expect(f.store.getRun(ticket.runId)?.status).toBe("paused"); expect(calls).toBe(1);
  await f.engine.ingest("chat", [f.incoming("resume", `/tnb resume ${ticket.id}`, "admin")]); await f.engine.process(signal());
  await until(f.runtime, () => f.store.getRun(ticket.runId)?.status === "succeeded");
  await f.engine.project(signal(), false); await flush(f.engine);
  expect(f.delivered.some(n => n.text.includes("report-delivered") && n.text.includes("Reviewed the code and delivered a report"))).toBe(true); expect(calls).toBe(2);
});

test("uncertain sends survive restart, require evidence for retry, and projection does not fill receipts while idle", async () => {
  const f = await fixture(); let sends = 0;
  f.ports.set("chat", { async send() { sends++; throw new Error("response lost after sending"); } });
  await f.engine.ingest("chat", [f.incoming("one")]); await f.engine.process(signal()); await flush(f.engine);
  const row = f.engine.records<Notification>(NS.outbox)[0]!; expect(row.value.state).toBe("unknown"); expect(sends).toBe(1);
  f.engine.recoverOutbox(); await flush(f.engine); expect(sends).toBe(1);
  expect(await f.engine.reconcile(row.id, signal())).toBe(false);
  expect(() => f.engine.resolveOutbox(row.id, row.revision - 1, "retry", "checked remote")).toThrow("conflict");
  f.engine.resolveOutbox(row.id, row.revision, "retry", "Bridge operator confirmed no delivery by notification ID");
  f.ports.set("chat", { async send() { sends++; return "verified-receipt"; } });
  await flush(f.engine); expect(sends).toBe(2); expect(f.store.applicationRecord<Notification>(NS.outbox, row.id)?.value.state).toBe("sent");
  f.engine.setNotification(row.id, "dispatched");
  const restarted = new CollaborationEngine(f.runtime, f.config, f.ports); restarted.recoverOutbox();
  expect(f.store.applicationRecord<Notification>(NS.outbox, row.id)?.value.state).toBe("unknown"); await flush(restarted); expect(sends).toBe(2);
  await f.engine.project(signal(), false); const before = f.store.snapshot().byteLength;
  for (let i = 0; i < 10; i++) await f.engine.project(signal(), false);
  expect(f.store.snapshot().byteLength).toBe(before);
});

test("PR tracking observes changed heads, CI and closure without reopening a successful Run", async () => {
  const f = await fixture(undefined, true); const source = f.config.sources[0]!;
  source.type = "github"; source.github = { repository: "fixture/repo", tokenEnv: "GITHUB_TOKEN" }; delete source.webhook;
  let head = "a".repeat(40), merged = false, closed = false;
  f.ports.set("chat", { async send(n) { return `receipt:${n.id}`; }, async inspectPR(number) { return { number, head, state: closed ? "closed" : "open", merged, url: "https://github.com/fixture/repo/pull/9", ci: [{ name: "unit", status: "completed", conclusion: head[0] === "a" ? "failure" : "success" }], reviews: [{ actor: "reviewer", state: "APPROVED", commit: head }] }; } });
  const incoming = (id: string, text?: string, actor = "alice") => f.incoming(id, text, actor, "4");
  await f.engine.ingest("chat", [incoming("one")]); await f.engine.process(signal()); const ticket = f.ticket("one");
  await until(f.runtime, () => f.store.getRun(ticket.runId)?.status === "succeeded");
  await f.engine.ingest("chat", [incoming("bind", `/tnb bind ${ticket.id} 9`, "admin")]); await f.engine.process(signal());
  await f.engine.project(signal()); expect(f.ticket("one").delivery).toBe("awaiting-pr");
  head = "b".repeat(40); await f.engine.project(signal()); expect(f.ticket("one").pr?.head).toBe(head); expect(f.ticket("one").pr?.ci[0]?.conclusion).toBe("success");
  merged = true; closed = true; await f.engine.project(signal()); expect(f.ticket("one").delivery).toBe("merged");
  expect(f.store.getRun(ticket.runId)?.status).toBe("succeeded"); expect(f.store.runs()).toHaveLength(1);
});

test("pending questions are suppressed after an answer and source identities cannot be repurposed", async () => {
  let calls = 0; const f = await fixture({ async *stream() {
    if (++calls === 1) yield* call("durable_wait", { kind: "question", key: "choice", question: "继续吗", about: "根据答案继续" }); else yield* report();
  } }, true);
  await f.engine.ingest("chat", [f.incoming("question")]); await f.engine.process(signal()); const ticket = f.ticket("question");
  await until(f.runtime, () => f.store.tasks(ticket.runId)[0]?.status === "waiting");
  await f.engine.project(signal(), false); const q = f.runtime.waits.questions(ticket.runId)[0]!;
  await f.engine.ingest("chat", [f.incoming("answer", `/tnb answer ${ticket.id} ${q.waitId} ${q.version} 继续`)]); await f.engine.process(signal());
  await flush(f.engine);
  expect(f.delivered.some(n => n.question)).toBe(false);
  expect(f.engine.records<Notification>(NS.outbox).some(row => row.value.state === "suppressed")).toBe(true);
  f.config.sources[0]!.webhook!.outboundUrl = "http://127.0.0.1:12345/another-channel";
  await expect(f.engine.ingest("chat", [f.incoming("repurpose")])).rejects.toThrow("immutable");
});

test("SIGKILL between createRun and ticket linkage reopens SQLite and links exactly the original Run", async () => {
  const f = await fixture(); await f.engine.ingest("chat", [f.incoming("killed")]); f.store.close();
  const imports = new URL("../../src/services/runtime/engine.ts", import.meta.url).pathname;
  const storeModule = new URL("../../src/services/runtime/store.ts", import.meta.url).pathname;
  const collaborationModule = new URL("../../src/services/collaboration/engine.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, "-e", `
    import { DurableRuntime } from ${JSON.stringify(imports)};
    import { RuntimeStore } from ${JSON.stringify(storeModule)};
    import { CollaborationEngine } from ${JSON.stringify(collaborationModule)};
    const store = new RuntimeStore(process.env.FIXTURE_DB);
    const runtime = new DurableRuntime(store, process.env.FIXTURE_STATE, async () => { throw new Error('unused'); });
    const submit = runtime.submit.bind(runtime);
    runtime.submit = async input => { await submit(input); process.kill(process.pid, 'SIGKILL'); throw new Error('unreachable'); };
    const engine = new CollaborationEngine(runtime, JSON.parse(process.env.FIXTURE_CONFIG), new Map());
    await engine.execute(process.env.FIXTURE_EVENT, new AbortController().signal);
  `], { env: { ...process.env, FIXTURE_DB: f.database, FIXTURE_STATE: f.state, FIXTURE_CONFIG: JSON.stringify(f.config), FIXTURE_EVENT: eventId("chat", "killed") }, stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).not.toBe(0);
  const store = new RuntimeStore(f.database); stores.push(store); expect(store.runs()).toHaveLength(1);
  const originalId = store.runs()[0]!.runId;
  const core = new CoreRuntime(store, f.state), engine = new CollaborationEngine(core, f.config, f.ports);
  await engine.process(signal()); expect(store.runs()).toHaveLength(1); expect(engine.records<Ticket>(NS.tickets)[0]?.value.runId).toBe(originalId);
});


test("a stalled Source does not block automatic questions and all network lanes drain on close", async () => {
  const f = await fixture({ async *stream() {
    yield* call("durable_wait", { kind: "question", key: "channel", question: "继续使用这个方案吗", about: "等待决定" });
  } }, true);
  const polling = Promise.withResolvers<void>(); let aborted = false;
  const sender = f.ports.get("chat")!.send;
  f.ports.set("chat", { send: sender, async poll(_cursor, signal) {
    polling.resolve();
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    aborted = true; throw new Error("aborted");
  } });
  const host = new CollaborationHost(f.runtime, { ...f.config, listen: undefined }, {}, f.ports);
  try {
    await host.start(); await polling.promise;
    await host.engine.ingest("chat", [f.incoming("while-polling")]);
    const deadline = Date.now() + 8000;
    while (!f.delivered.some(n => n.question)) {
      if (Date.now() > deadline) throw new Error("stalled Source blocked the question lane");
      await Bun.sleep(10);
    }
    expect(aborted).toBe(false);
  } finally { await host.close(); }
  expect(aborted).toBe(true);
}, 12000);


test("an acceptance artifact read cannot overwrite a newer PR observation", async () => {
  const f = await fixture(undefined, true);
  await f.engine.ingest("chat", [f.incoming("project-race")]); await f.engine.process(signal()); const ticket = f.ticket("project-race");
  await until(f.runtime, () => f.store.getRun(ticket.runId)?.status === "succeeded");
  const reading = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), get = f.runtime.artifacts.get.bind(f.runtime.artifacts);
  f.runtime.artifacts.get = async <T>(ref: string): Promise<T> => { const value = await get<T>(ref); reading.resolve(); await release.promise; return value; };
  const projecting = f.engine.project(signal(), false); await reading.promise;
  f.store.command("fixture-concurrent-pr", {}, Date.now(), tx => {
    const row = tx.applicationRecord<Ticket>(NS.tickets, ticket.id)!;
    tx.saveApplicationRecord({ ...row, value: { ...row.value, pr: { number: 19, head: "c".repeat(40), state: "open", merged: false, url: "https://github.com/fixture/repo/pull/19", ci: [], reviews: [] } } }, row.revision); return true;
  });
  release.resolve(); await projecting;
  expect(f.ticket("project-race").pr?.number).toBe(19);
  await f.engine.project(signal(), false); expect(f.ticket("project-race").delivery).toBe("awaiting-pr");
});


test("a committed control is linked after recovery even when its actor has since been revoked", async () => {
  const f = await fixture(); await f.engine.ingest("chat", [f.incoming("control-replay")]); await f.engine.process(signal());
  const ticket = f.ticket("control-replay"), incoming = f.incoming("pause-replay", `/tnb pause ${ticket.id}`, "admin");
  await f.engine.ingest("chat", [incoming]);
  const update = f.engine.updateEvent.bind(f.engine);
  f.engine.updateEvent = (id, apply, revision) => {
    const row = f.store.applicationRecord<IntakeEvent>(NS.events, id)!;
    if (apply(row.value).state === "processed") throw new Error("crash after committed control");
    return update(id, apply, revision);
  };
  await expect(f.engine.execute(eventId("chat", incoming.externalId), signal())).rejects.toThrow("committed control");
  expect(f.store.getRun(ticket.runId)?.status).toBe("paused");
  f.config.sources[0]!.controllers = [];
  const recovered = new CollaborationEngine(f.runtime, f.config, f.ports); await recovered.process(signal());
  expect(f.store.applicationRecord<IntakeEvent>(NS.events, eventId("chat", incoming.externalId))?.value.state).toBe("processed");
  expect(f.store.events(ticket.runId).filter(event => event.type === "run.paused")).toHaveLength(1);
});
