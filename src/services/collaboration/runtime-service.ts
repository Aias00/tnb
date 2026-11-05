import { randomUUID } from "node:crypto";
import type { CollaborationService, CollaborationServiceFactory, CollaborationStateTransaction } from "../../agent/collaboration-service";
import type { ChannelRegistry } from "../../agent/extensions";
import type { DurableRuntime, RuntimeConfiguration } from "../runtime/engine-core";
import type { ApplicationRecord } from "../runtime/store";
import type { RoutingInput } from "../runtime/routing";
import { digestJson, integer, text } from "../runtime/json";
import { sourceIdentity } from "./config";
import { NS, eventId, ticketId as expectedTicketId, parseAction } from "./protocol";
import type { Action, CollaborationConfig, IncomingEvent, IntakeEvent, Source, Ticket } from "./types";
import { migrateCollaborationChannels, resolveCollaborationChannel } from "./channels";

type Admission = { sourceId: string; incoming: IncomingEvent; digest: string; identity: string; action: Action; configuration?: RuntimeConfiguration; mode?: Source["mode"] };
type Ownership = { eventId: string; sourceId: string; identity: string; actor: string; thread: string };
const ADMISSION = "host.collaboration.admission", OWNER = "host.collaboration.owner", MIGRATION = "host.collaboration.bridge";
const namespaces = new Set<string>([...Object.values(NS), "collaboration.sources", "collaboration.meta"]);
const stateKinds = new Set(["collaboration.intake", "collaboration.blocked", "collaboration.link", "collaboration.bind", "collaboration.event", "collaboration.pr", "collaboration.project", "collaboration.outbox", "collaboration.outbox.resolve"]);
const routing = (id: string, admission: Admission, workspace: string): RoutingInput => ({ source: "api", inputId: id, workspace,
  sessionId: `collab:${digestJson({ source: admission.sourceId, thread: admission.incoming.thread }).slice(0, 48)}`, rawText: admission.incoming.text });
function creation(id: string, admission: Admission) {
  const configuration = admission.configuration!, mode = admission.mode!;
  return { commandId: `collab:${id}`, objective: (admission.action as Extract<Action, { kind: "run" }>).text, configuration,
    tasks: undefined, deadline: undefined, source: routing(id, admission, configuration.workspace), successorOf: undefined,
    policy: { mode, maxActiveAgents: mode === "single" ? 1 : mode === "multi" ? 4 : 2, maxDelegationDepth: mode === "single" ? 0 : 1 } };
}
/** The only host-owned bridge: no Runtime/Store/transaction object crosses the plugin boundary. */
export function createCollaborationService(runtime: DurableRuntime, configuration: CollaborationConfig, channels?: ChannelRegistry, ownerSignal?: AbortSignal, track?: <T>(operation: () => Promise<T>) => Promise<T>): CollaborationServiceFactory {
  const store = runtime.store;
  migrateCollaborationChannels(store);
  const hostLive = () => ownerSignal?.throwIfAborted();
  const currentSource = (id: string): Source => {
    const source = configuration.enabled && configuration.sources.find(item => item.id === id);
    if (!source) throw new Error("Collaboration Source is not enabled");
    const value = structuredClone(source);
    if (value.type === "plugin" && channels) value.channel = resolveCollaborationChannel(store, configuration, channels, id);
    return value;
  };
  const saveOwner = (runId: string, id: string, admission: Admission) => {
    const value: Ownership = { eventId: id, sourceId: admission.sourceId, identity: admission.identity, actor: admission.incoming.actor, thread: admission.incoming.thread };
    const previous = store.applicationRecord<Ownership>(OWNER, runId);
    if (previous) { if (digestJson(previous.value) !== digestJson(value)) throw new Error("Collaboration Run ownership conflict"); return; }
    store.command(`collab-owner:${runId}`, { kind: OWNER, runId, value }, Date.now(), tx => tx.saveApplicationRecord({ namespace: OWNER, id: runId, runId, value }, 0));
  };
  // Legacy application data is trusted once, before the upgraded application is started.
  // Recovery never resolves/replaces an old domain merely to link its committed createRun receipt.
  if (!store.applicationRecord(MIGRATION, "v1")) {
    let after = "";
    for (;;) {
      const page = store.applicationRecords<IntakeEvent>(NS.events, after, 256);
      for (const row of page) {
        const event = row.value;
        if (!["pending", "blocked", "clarify", "processed"].includes(event.state) || !event.action || !event.incoming || event.id !== eventId(event.sourceId, event.incoming.externalId) || event.digest !== digestJson(event.incoming)) continue;
        const admission: Admission = { sourceId: event.sourceId, incoming: event.incoming, digest: event.digest, identity: event.identity, action: event.action,
          ...(event.configuration ? { configuration: event.configuration } : {}), ...(event.mode ? { mode: event.mode } : {}) };
        if (!store.applicationRecord(ADMISSION, row.id)) store.command(`collab-migrate:${row.id}`, { kind: ADMISSION, id: row.id, admission }, Date.now(), tx => tx.saveApplicationRecord({ namespace: ADMISSION, id: row.id, value: admission }, 0));
        if (event.action.kind === "run" && admission.configuration && admission.mode) {
          const created = runtime.commands.replayCreateRun(creation(row.id, admission));
          if (created) saveOwner(created.run.runId, row.id, admission);
        }
      }
      if (page.length < 256) break;
      after = page.at(-1)!.id;
    }
    store.command("collab-bridge-migration:v1", { kind: MIGRATION, version: 1 }, Date.now(), tx => tx.saveApplicationRecord({ namespace: MIGRATION, id: "v1", value: { complete: true } }, 0));
  }
  const owned = (runId: string) => {
    text(runId, "Run ID", 128);
    const owner = store.applicationRecord<Ownership>(OWNER, runId)?.value, run = store.getRun(runId);
    if (!owner || !run) throw new Error("Run is not owned by collaboration");
    return { owner, run };
  };
  const eventAdmission = (id: string) => {
    const event = store.applicationRecord<IntakeEvent>(NS.events, id)?.value, admission = store.applicationRecord<Admission>(ADMISSION, id)?.value;
    if (!event || !admission || event.id !== id || event.digest !== admission.digest || digestJson(event.incoming) !== admission.digest || event.sourceId !== admission.sourceId || event.identity !== admission.identity
      || event.action?.kind !== admission.action.kind) throw new Error("Event does not match its host admission");
    if (admission.action.kind === "run" && (digestJson(event.configuration ?? null) !== digestJson(admission.configuration ?? null) || event.mode !== admission.mode)
      || "text" in admission.action && (event.action as { text?: string }).text !== admission.action.text) throw new Error("Event changed its admitted contract");
    return { event, admission };
  };
  const ticketFor = (id: string, admission: Admission) => {
    const ticket = store.applicationRecord<Ticket>(NS.tickets, id)?.value;
    if (!ticket) throw new Error("Ticket is not owned by collaboration");
    const { owner, run } = owned(ticket.runId);
    if (ticket.eventId !== owner.eventId || ticket.sourceId !== owner.sourceId || ticket.identity !== owner.identity || ticket.actor !== owner.actor || ticket.thread !== owner.thread
      || admission.sourceId !== owner.sourceId || admission.identity !== owner.identity || admission.incoming.thread !== owner.thread) throw new Error("Ticket is not in the original Source/thread");
    return { ticket, run };
  };
  const authorize = (admission: Admission, ticket?: Ticket) => {
    const source = currentSource(admission.sourceId), actor = admission.incoming.actor;
    if (sourceIdentity(source) !== admission.identity) throw new Error("Source transport identity changed");
    const controlled = ["pause", "resume", "cancel", "bind"].includes(admission.action.kind);
    if (admission.action.kind === "run" ? !source.actors.includes(actor) : controlled ? !source.controllers.includes(actor)
      : !source.controllers.includes(actor) && !(source.actors.includes(actor) && ticket?.actor === actor)) throw new Error("Actor cannot control this ticket or submit new work");
    return source;
  };
  const assertNamespace = (namespace: string) => { if (!namespaces.has(namespace)) throw new Error("Collaboration state namespace is not granted"); };
  const assertStateInput = (id: string, input: unknown) => {
    text(id, "state command ID", 128);
    const kind = (input as { kind?: unknown })?.kind;
    if (typeof kind === "string" && stateKinds.has(kind)) return;
    if (id.startsWith("collab-source:") && input && typeof input === "object" && Object.keys(input).length === 1 && typeof (input as { identity?: unknown }).identity === "string") return;
    throw new Error("Collaboration state command kind is not granted");
  };
  return { open(signal) {
    if (!(signal instanceof AbortSignal)) throw new Error("A collaboration lifecycle signal is required");
    hostLive(); signal.throwIfAborted(); let closed = false;
    const stateLive = () => { if (closed) throw new Error("Collaboration service lifetime ended"); };
    const taskLive = () => { stateLive(); hostLive(); signal.throwIfAborted(); };
    const state: CollaborationService["state"] = Object.freeze({
      applicationRecord<T>(namespace: string, id: string) { stateLive(); assertNamespace(namespace); return store.applicationRecord<T>(namespace, id); },
      applicationRecords<T>(namespace: string, after = "", limit = 256, filter?: Parameters<typeof store.applicationRecords>[3]) { stateLive(); assertNamespace(namespace); return store.applicationRecords<T>(namespace, after, limit, filter); },
      replayCommand<T>(id: string, input: unknown) { stateLive(); assertStateInput(id, input); return store.replayCommand<T>(id, input) ?? store.replayCommand<T>(`collab-state:${digestJson(id)}`, input); },
      command<T>(id: string, input: unknown, now: number, apply: (tx: CollaborationStateTransaction) => T): T {
        stateLive(); assertStateInput(id, input); integer(now, "state timestamp", 0);
        const legacy = store.replayCommand<T>(id, input); if (legacy !== undefined) return legacy;
        return store.command(`collab-state:${digestJson(id)}`, input, now, tx => {
          if ((input as { kind?: string }).kind === "collaboration.bind") {
            const binding = input as { ticketId: string; number: number };
            const event = /^collab:([a-f0-9]{64})$/.exec(id)?.[1];
            if (!event) throw new Error("Binding requires an admitted event command");
            const { admission } = eventAdmission(event), { ticket } = ticketFor(binding.ticketId, admission);
            if (admission.action.kind !== "bind" || admission.action.number !== binding.number || admission.action.ticketId !== ticket.id) throw new Error("Binding differs from its admitted command");
            authorize(admission, ticket);
          }
          let live = true;
          const assertTx = () => { stateLive(); if (!live) throw new Error("Collaboration transaction lifetime ended"); };
          const scoped: CollaborationStateTransaction = Object.freeze({ now: tx.now,
            applicationRecord<V>(namespace: string, key: string) { assertTx(); assertNamespace(namespace); return tx.applicationRecord<V>(namespace, key); },
            saveApplicationRecord<V>(row: Omit<ApplicationRecord<V>, "revision">, revision: number) {
              assertTx(); assertNamespace(row.namespace); if (row.runId) owned(row.runId);
              if (row.namespace === NS.events) {
                const value = row.value as IntakeEvent, admission = store.applicationRecord<Admission>(ADMISSION, row.id)?.value;
                if (value.id !== row.id || admission && (value.sourceId !== admission.sourceId || value.identity !== admission.identity || value.digest !== admission.digest || digestJson(value.incoming) !== admission.digest)) throw new Error("Event conflicts with its host admission identity");
              }
              const previous = tx.applicationRecord(row.namespace, row.id);
              if (row.namespace === NS.events && previous) {
                const before = previous.value as IntakeEvent, after = row.value as IntakeEvent;
                const resolving = before.state === "clarify" && before.action?.kind === "followup" && after.action?.kind === "followup"
                  && before.action.text === after.action.text && !before.action.ticketId && before.candidates?.includes(after.action.ticketId ?? "") && after.state === "pending";
                if (!resolving && digestJson(before.action ?? null) !== digestJson(after.action ?? null)) throw new Error("Admitted event action is immutable");
                if (before.prepared && digestJson(before.prepared) !== digestJson(after.prepared ?? null)) throw new Error("Prepared control revision is immutable");
                for (const key of ["id", "sourceId", "incoming", "digest", "identity", "configuration", "mode", "receivedAt", "candidates"] as const) if (digestJson(before[key] ?? null) !== digestJson(after[key] ?? null)) throw new Error("Admitted event identity/configuration is immutable");
              }
              if (row.namespace === NS.tickets) {
                const value = row.value as Ticket, { owner } = owned(value.runId);
                if (row.id !== value.id || value.id !== expectedTicketId(owner.eventId) || row.runId !== value.runId || value.eventId !== owner.eventId || value.sourceId !== owner.sourceId || value.identity !== owner.identity || value.actor !== owner.actor || value.thread !== owner.thread) throw new Error("Ticket cannot claim another Run");
              }
              return tx.saveApplicationRecord(row, revision);
            },
          });
          try { return apply(scoped); } finally { live = false; }
        });
      },
    });
    const tasks: CollaborationService["tasks"] = {
      async admit(sourceId, incoming) {
        taskLive(); const source = currentSource(sourceId);
        if (!incoming || Object.keys(incoming).some(key => !["externalId", "actor", "thread", "text"].includes(key))) throw new Error("Invalid incoming event fields");
        text(incoming.externalId, "external ID", 128); text(incoming.actor, "actor", 128); text(incoming.thread, "thread", 128); text(incoming.text, "event text", 8000);
        const id = eventId(sourceId, incoming.externalId), digest = digestJson(incoming), action = parseAction(incoming.text);
        if (!action) throw new Error("An actionable event is required");
        if (!(action.kind === "run" ? source.actors : [...source.actors, ...source.controllers]).includes(incoming.actor)) throw new Error("Actor is not authorized by this Source");
        const existing = store.applicationRecord<Admission>(ADMISSION, id)?.value;
        if (existing) {
          if (existing.digest !== digest || existing.identity !== sourceIdentity(source)) throw new Error("Admission identity conflict");
          return structuredClone({ ...(existing.configuration ? { configuration: existing.configuration } : {}), ...(existing.mode ? { mode: existing.mode } : {}) });
        }
        const admission: Admission = { sourceId, incoming: structuredClone(incoming), digest, identity: sourceIdentity(source), action };
        if (action.kind === "run") {
          const value = structuredClone(source.configuration); value.strategyVersion = 2; value.maxModelRequests ??= 256;
          value.domain = runtime.domains.prepare(runtime.domains.descriptor(value));
          await runtime.domains.resolve(value.domain).runtime?.normalize?.(value, runtime.root);
          admission.configuration = value; admission.mode = source.mode;
        }
        taskLive();
        store.command(`collab-admit:${id}`, { kind: ADMISSION, id, admission }, Date.now(), tx => tx.saveApplicationRecord({ namespace: ADMISSION, id, value: admission }, 0));
        return structuredClone({ ...(admission.configuration ? { configuration: admission.configuration } : {}), ...(admission.mode ? { mode: admission.mode } : {}) });
      },
      async create(id) {
        taskLive(); const { admission } = eventAdmission(id);
        if (admission.action.kind !== "run" || !admission.configuration || !admission.mode) throw new Error("Run admission is missing");
        const input = creation(id, admission);
        let created = runtime.commands.replayCreateRun(input);
        if (!created) { if (!["pending", "blocked"].includes(eventAdmission(id).event.state)) throw new Error("Event is not ready for task creation"); authorize(admission); created = await runtime.submit({ commandId: input.commandId, objective: input.objective, configuration: input.configuration, mode: admission.mode, source: input.source }); }
        saveOwner(created.run.runId, id, admission); return { run: structuredClone(created.run) };
      },
      async apply(id, ticketId) {
        taskLive(); const { event, admission } = eventAdmission(id), { ticket, run } = ticketFor(ticketId, admission), action = admission.action, commandId = `collab:${id}`;
        if (action.kind === "run" || action.kind === "bind") throw new Error("This event is not a task control");
        if ("ticketId" in action && action.ticketId && action.ticketId !== ticket.id) throw new Error("Ticket differs from the original command");
        if (event.prepared && event.prepared.runId !== run.runId) throw new Error("Prepared control Run mismatch");
        const source = routing(id, admission, runtime.configuration(run.runId).workspace);
        const input = { commandId, runId: run.runId, expectedRevision: event.prepared?.revision ?? run.revision, source };
        const replay = () => action.kind === "followup" ? store.replayCommand<{ status: string }>(commandId, { kind: "input.route", commandId, runId: run.runId, source: { ...source, rawText: action.text } })?.status === "accepted"
          : action.kind === "answer" ? store.replayCommand(commandId, { kind: "wait.answer", input: { commandId, runId: run.runId, waitId: action.waitId, expectedVersion: action.version, answer: action.text, source } })
          : event.prepared && store.replayCommand(commandId, { kind: `run.${action.kind}`, input });
        if (replay()) return;
        if (!["pending", "blocked"].includes(event.state) || event.action?.kind !== action.kind || !("ticketId" in event.action) || event.action.ticketId !== ticket.id) throw new Error("Event requires an explicit target resolution");
        authorize(admission, ticket);
        if (action.kind === "followup") { const result = runtime.router.followup({ commandId, runId: run.runId, source: { ...source, rawText: action.text } }); if (result.status !== "accepted") throw new Error(`Followup requires local resolution: ${result.reason}`); }
        else if (action.kind === "answer") runtime.waits.answer({ commandId, runId: run.runId, waitId: action.waitId, expectedVersion: action.version, answer: action.text, source });
        else {
          if (!event.prepared) state.command(randomUUID(), { kind: "collaboration.event", id }, Date.now(), tx => { const row = tx.applicationRecord<IntakeEvent>(NS.events, id)!; tx.saveApplicationRecord({ ...row, value: { ...row.value, prepared: { runId: run.runId, revision: run.revision } } }, row.revision); return true; });
          if (action.kind === "pause") runtime.commands.pauseRun(input);
          else if (action.kind === "cancel") runtime.commands.cancelRun(input);
          else { try { await runtime.resume(run.runId, commandId, input.expectedRevision, source); } catch (error) { if (!store.replayCommand(commandId, { kind: "run.resume", input })) throw error; } }
        }
      },
      run(runId) { taskLive(); return structuredClone(owned(runId).run); },
      questions(runId) { taskLive(); owned(runId); return runtime.waits.questions(runId); },
      async summaries(runId) {
        taskLive(); owned(runId); const summaries: string[] = [];
        for (const task of store.tasks(runId).filter(task => !task.parentTaskId)) {
          if (task.resultRef) { const result = await runtime.artifacts.get<{ report?: unknown; acceptance?: unknown; checks?: unknown }>(task.resultRef); taskLive(); summaries.push(`${task.key}: ${task.status}; acceptance=${JSON.stringify(result.acceptance ?? "recorded")}; checks=${JSON.stringify(result.checks ?? []).slice(0, 2500)}\n${typeof result.report === "string" ? result.report.slice(0, 7000) : ""}\n完整证据：tnb runtime result ${runId} --task ${task.taskId}`); }
          else summaries.push(`${task.key}: ${task.status}${task.error ? `; ${task.error.slice(0, 1000)}` : ""}`);
        }
        return summaries;
      },
    };
    // Nested async handles stay owned even when a plugin does not await their promises.
    if (track) for (const name of ["admit", "create", "apply", "summaries"] as const) {
      const method = tasks[name].bind(tasks);
      (tasks as any)[name] = (...args: any[]) => track(() => (method as (...args: any[]) => Promise<unknown>)(...args));
    }
    Object.freeze(tasks);
    return Object.freeze({ configuration: () => { taskLive(); return structuredClone(configuration); },
      channel: (sourceId: string) => { taskLive(); if (!channels) throw new Error("Channel registry is unavailable"); return resolveCollaborationChannel(store, configuration, channels, sourceId); }, state, tasks, close: () => { closed = true; } });
  } };
}
