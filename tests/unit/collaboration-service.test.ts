import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { DurableRuntime } from "../../src/services/runtime/engine";
import { DurableRuntime as CoreRuntime } from "../../src/services/runtime/engine-core";
import { RuntimeStore } from "../../src/services/runtime/store";
import { createCollaborationService } from "../../src/services/collaboration/runtime-service";
import { parseCollaborationConfig, sourceIdentity } from "../../src/services/collaboration/config";
import { CollaborationEngine, NS, eventId, ticketId, parseAction } from "../../src/services/collaboration/engine";
import { digestJson } from "../../src/services/runtime/json";
import type { CollaborationStateTransaction } from "../../src/agent/collaboration-service";
import type { IntakeEvent, Ticket } from "../../src/services/collaboration/types";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const signal = () => new AbortController().signal;
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tnb-collab-service-"))); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "work"); await mkdir(workspace);
  const state = join(root, "control/runtime"); await mkdir(state, { recursive: true }); const store = new RuntimeStore(":memory:"); cleanup.push(async () => store.close());
  const runtime = new DurableRuntime(store, state, async () => { throw new Error("No model should run in a capability boundary test"); }); cleanup.push(() => runtime.close());
  const config = await parseCollaborationConfig({ enabled: true, sources: [{ id: "notes", type: "plugin", channel: { id: "notes", version: "1" }, actors: ["alice", "bob"], controllers: ["admin"],
    configuration: { workspace, allowWrite: false, allowShell: false, checks: [], maxCostUsd: 1 }, mode: "single" }] });
  const incoming = (id: string, text = "/tnb run Inspect", actor = "alice", thread = "thread-1") => ({ externalId: id, text, actor, thread });
  const open = () => createCollaborationService(runtime, config).open(signal());
  return { root, workspace, state, store, runtime, config, incoming, open };
}

test("collaboration state is namespaced, transactions expire and Runtime command kinds are unavailable", async () => {
  const f = await fixture(), service = f.open();
  expect(() => service.state.applicationRecord("configuration", "foreign")).toThrow("namespace");
  expect(() => service.state.applicationRecord("host.collaboration.admission", "foreign")).toThrow("namespace");
  expect(() => service.state.command("foreign", { kind: "run.cancel" }, Date.now(), () => true)).toThrow("kind");
  expect(() => service.state.replayCommand("foreign", { kind: "wait.answer" })).toThrow("kind");
  let saved!: CollaborationStateTransaction;
  service.state.command("write", { kind: "collaboration.event", id: "meta" }, Date.now(), tx => { saved = tx; tx.saveApplicationRecord({ namespace: "collaboration.meta", id: "scoped", value: { count: 1 } }, 0); return true; });
  expect(service.state.applicationRecord("collaboration.meta", "scoped")?.value).toEqual({ count: 1 });
  expect(() => saved.saveApplicationRecord({ namespace: "collaboration.meta", id: "escaped", value: {} }, 0)).toThrow("lifetime");
  expect(() => service.state.command("cross-state", { kind: "collaboration.event" }, Date.now(), tx => tx.saveApplicationRecord({ namespace: "host.collaboration.admission", id: "forged", value: {} }, 0))).toThrow("namespace");
  expect(() => service.state.command("write", { kind: "collaboration.event", id: "changed" }, Date.now(), () => true)).toThrow("different input");
  service.close(); expect(() => service.state.applicationRecord("collaboration.meta", "scoped")).toThrow("lifetime");
});

test("host Source authority survives plugin configuration mutations and fabricated admission requests", async () => {
  const f = await fixture(), service = f.open(), copy = service.configuration();
  copy.sources[0]!.configuration.allowWrite = true; copy.sources[0]!.configuration.maxCostUsd = 999; copy.sources[0]!.actors.push("mallory");
  await expect(service.tasks.admit("notes", f.incoming("forged", "/tnb run Write everything", "mallory"))).rejects.toThrow("authorized");
  const admitted = await service.tasks.admit("notes", f.incoming("valid"));
  expect(admitted.configuration?.allowWrite).toBe(false); expect(admitted.configuration?.maxCostUsd).toBe(1);
  const conflictInput = f.incoming("valid", "/tnb run Conflicting webhook payload"), conflictId = eventId("notes", "valid");
  expect(() => service.state.command("conflicting-intake", { kind: "collaboration.intake" }, Date.now(), tx => tx.saveApplicationRecord({ namespace: NS.events, id: conflictId,
    value: { id: conflictId, sourceId: "notes", incoming: conflictInput, digest: digestJson(conflictInput), identity: sourceIdentity(f.config.sources[0]!), receivedAt: Date.now(), state: "rejected" } }, 0))).toThrow("admission identity");
  admitted.configuration!.allowWrite = true;
  expect((await service.tasks.admit("notes", f.incoming("valid"))).configuration?.allowWrite).toBe(false);
  await expect(service.tasks.admit("notes", f.incoming("valid", "/tnb run Changed"))).rejects.toThrow("identity conflict");
  await expect(service.tasks.admit("unknown", f.incoming("other"))).rejects.toThrow("not enabled");
});

test("scoped operations refuse foreign Runs/tickets, immutable intake contracts and other actors", async () => {
  const f = await fixture(), service = f.open(), engine = new CollaborationEngine(service, service.configuration(), new Map());
  await engine.ingest("notes", [f.incoming("owned")]); await engine.process(signal());
  const ticket = engine.records<Ticket>(NS.tickets)[0]!.value, row = service.state.applicationRecord<IntakeEvent>(NS.events, eventId("notes", "owned"))!;
  expect(() => service.state.command("mutate-admission", { kind: "collaboration.event" }, Date.now(), tx => tx.saveApplicationRecord({ ...row, value: { ...row.value, configuration: { ...row.value.configuration!, allowWrite: true } } }, row.revision))).toThrow("immutable");
  const foreign = await f.runtime.submit({ commandId: "outside", objective: "Outside collaboration", mode: "single", configuration: f.config.sources[0]!.configuration });
  expect(() => service.tasks.run(foreign.run.runId)).toThrow("not owned"); expect(() => service.tasks.questions(foreign.run.runId)).toThrow("not owned");
  await expect(service.tasks.summaries(foreign.run.runId)).rejects.toThrow("not owned");
  expect(() => service.state.command("steal-ticket", { kind: "collaboration.link" }, Date.now(), tx => tx.saveApplicationRecord({ namespace: NS.tickets, id: ticket.id + "x", runId: foreign.run.runId, value: { ...ticket, id: ticket.id + "x", runId: foreign.run.runId } }, 0))).toThrow("not owned");
  await engine.ingest("notes", [f.incoming("bob", `/tnb followup ${ticket.id} Inject`, "bob")]);
  await expect(service.tasks.apply(eventId("notes", "bob"), ticket.id)).rejects.toThrow("cannot control");
  await engine.ingest("notes", [f.incoming("cross-thread", `/tnb pause ${ticket.id}`, "admin", "other")]);
  await expect(service.tasks.apply(eventId("notes", "cross-thread"), ticket.id)).rejects.toThrow("Source/thread");
  const controller = new AbortController(), lease = createCollaborationService(f.runtime, f.config).open(controller.signal);
  controller.abort(); await expect(lease.tasks.create(eventId("notes", "owned"))).rejects.toThrow();
  // Known outbound results may still be recorded while disposal drains in-flight work.
  expect(lease.state.applicationRecord(NS.tickets, ticket.id)).toBeDefined(); lease.close();
  expect(() => lease.state.applicationRecord(NS.tickets, ticket.id)).toThrow("lifetime");
});

test("legacy admission and createRun receipts migrate without reloading a missing domain or creating another Run", async () => {
  const f = await fixture(), source = f.config.sources[0]!, incoming = f.incoming("legacy"), id = eventId(source.id, incoming.externalId);
  const configuration = structuredClone(source.configuration); configuration.strategyVersion = 2; configuration.maxModelRequests ??= 256;
  configuration.domain = f.runtime.domains.prepare(f.runtime.domains.descriptor(configuration)); await f.runtime.domains.resolve(configuration.domain).runtime?.normalize?.(configuration, f.state);
  const entry: IntakeEvent = { id, sourceId: source.id, identity: sourceIdentity(source), incoming, digest: digestJson(incoming), receivedAt: Date.now(), action: parseAction(incoming.text), configuration, mode: source.mode, state: "pending" };
  f.store.command("old-intake", {}, Date.now(), tx => tx.saveApplicationRecord({ namespace: NS.events, id, value: entry }, 0));
  const created = await f.runtime.submit({ commandId: `collab:${id}`, objective: "Inspect", configuration, mode: source.mode,
    source: { source: "api", inputId: id, workspace: configuration.workspace, sessionId: `collab:${digestJson({ source: source.id, thread: incoming.thread }).slice(0, 48)}`, rawText: incoming.text } });
  const deniedInput = f.incoming("old-denied", `/tnb pause ${ticketId(id)}`, "mallory"), deniedId = eventId(source.id, deniedInput.externalId);
  const denied: IntakeEvent = { id: deniedId, sourceId: source.id, identity: sourceIdentity(source), incoming: deniedInput, digest: digestJson(deniedInput), receivedAt: Date.now(), action: parseAction(deniedInput.text), state: "rejected" };
  f.store.command("old-denied", {}, Date.now(), tx => tx.saveApplicationRecord({ namespace: NS.events, id: deniedId, value: denied }, 0));
  source.controllers.push("mallory"); // A later grant must not turn an old rejected event into an admission.
  const missingDomain = new CoreRuntime(f.store, f.state), service = createCollaborationService(missingDomain, f.config).open(signal()), engine = new CollaborationEngine(service, f.config, new Map());
  await engine.process(signal()); expect(f.store.runs()).toHaveLength(1);
  expect(engine.records<Ticket>(NS.tickets)[0]?.value.runId).toBe(created.run.runId);
  expect(service.tasks.run(created.run.runId).runId).toBe(created.run.runId);
  engine.updateEvent(deniedId, event => ({ ...event, state: "pending" }));
  await expect(service.tasks.apply(deniedId, ticketId(id))).rejects.toThrow("host admission");
  expect(f.store.getRun(created.run.runId)?.status).toBe("active");
  // After the one-time migration, app rows cannot impersonate another legacy admission.
  const forged = { ...entry, id: eventId(source.id, "post-migration"), incoming: f.incoming("post-migration") }; forged.digest = digestJson(forged.incoming);
  service.state.command("forged-history", { kind: "collaboration.intake" }, Date.now(), tx => tx.saveApplicationRecord({ namespace: NS.events, id: forged.id, value: forged }, 0));
  await expect(service.tasks.create(forged.id)).rejects.toThrow("host admission");
});

test("the installed collaboration bundle contains no Runtime implementation, Store or host bridge", async () => {
  const bundle = await Bun.build({ entrypoints: [fileURLToPath(new URL("../../src/plugins/collaboration/plugin.ts", import.meta.url))], target: "bun", metafile: true });
  expect(bundle.success).toBe(true);
  const inputs = Object.keys(bundle.metafile!.inputs).join("\n");
  for (const path of ["runtime/engine-core.ts", "runtime/store.ts", "collaboration/runtime-service.ts", "providers/config.ts"]) expect(inputs).not.toContain(path);
});


test("disabled Sources stay readable without granting admission, and actor revocation blocks an uncommitted Run", async () => {
  const f = await fixture(); f.config.enabled = false;
  const disabled = f.open(); expect(disabled.configuration().enabled).toBe(false);
  await expect(disabled.tasks.admit("notes", f.incoming("disabled"))).rejects.toThrow("not enabled");
  f.config.enabled = true; const service = f.open(), engine = new CollaborationEngine(service, service.configuration(), new Map());
  await engine.ingest("notes", [f.incoming("revoked")]); f.config.sources[0]!.actors = [];
  await expect(service.tasks.create(eventId("notes", "revoked"))).rejects.toThrow("cannot control"); expect(f.store.runs()).toHaveLength(0);
});
