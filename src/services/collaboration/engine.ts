import { randomUUID } from "node:crypto";
import type { DurableRuntime, RuntimeConfiguration } from "../runtime/engine-core";
import type { ApplicationQuery, ApplicationRecord, RuntimeTransaction } from "../runtime/store";
import { digestJson, integer, text } from "../runtime/json";
import type { RoutingInput } from "../runtime/routing";
import { sourceIdentity } from "./config";
import type { Action, CollaborationConfig, IncomingEvent, IntakeEvent, Notification, Source, SourceCursor, SourcePort, Ticket } from "./types";

export const NS = { events: "collaboration.events", tickets: "collaboration.tickets", outbox: "collaboration.outbox", cursors: "collaboration.cursors" } as const;
export function eventId(sourceId: string, externalId: string): string { return digestJson({ sourceId, externalId }); }
export function ticketId(event: string): string { return `t_${event.slice(0, 32)}`; }
export function parseAction(raw: string): Action | undefined {
  const input = raw.trim();
  if (!input.startsWith("/tnb")) return input ? { kind: "followup", text: input } : undefined;
  let match = /^\/tnb run\s+([\s\S]+)$/.exec(input);
  if (match) return { kind: "run", text: text(match[1]!, "objective", 4000) };
  match = /^\/tnb followup\s+(t_[a-f0-9]{32})\s+([\s\S]+)$/.exec(input);
  if (match) return { kind: "followup", ticketId: match[1], text: match[2]! };
  match = /^\/tnb answer\s+(t_[a-f0-9]{32})\s+([a-f0-9]{64})\s+(\d+)\s+([\s\S]+)$/.exec(input);
  if (match) return { kind: "answer", ticketId: match[1]!, waitId: match[2]!, version: integer(Number(match[3]), "question version", 1), text: match[4]! };
  match = /^\/tnb (pause|resume|cancel)\s+(t_[a-f0-9]{32})$/.exec(input);
  if (match) return { kind: match[1] as "pause" | "resume" | "cancel", ticketId: match[2]! };
  match = /^\/tnb bind\s+(t_[a-f0-9]{32})\s+(\d+)$/.exec(input);
  if (match) return { kind: "bind", ticketId: match[1]!, number: integer(Number(match[2]), "PR number", 1) };
  throw new Error("Unknown /tnb command; use run, followup, answer, pause, resume, cancel or bind");
}
export class CollaborationEngine {
  readonly store;
  readonly errors = new Map<string, string>();
  #prOffset = 0;
  constructor(readonly runtime: DurableRuntime, readonly config: CollaborationConfig, readonly ports: Map<string, SourcePort>, readonly clock: () => number = Date.now) { this.store = runtime.store; }
  source(id: string): Source {
    const source = this.config.sources.find(source => source.id === id);
    if (!this.config.enabled || !source) throw new Error("Collaboration Source is not enabled");
    return source;
  }
  registerSource(source: Source): void {
    const identity = sourceIdentity(source);
    const previous = this.store.applicationRecord<{ identity: string }>("collaboration.sources", source.id);
    if (previous) {
      if (previous.value.identity !== identity) throw new Error(`Source ${source.id} transport identity is immutable; use a new Source ID`);
      return;
    }
    this.store.command(`collab-source:${source.id}`, { identity }, this.clock(), tx => {
      tx.saveApplicationRecord({ namespace: "collaboration.sources", id: source.id, value: { identity } }, 0); return true;
    });
  }
  records<T>(namespace: string, filter?: ApplicationQuery): ApplicationRecord<T>[] {
    const result: ApplicationRecord<T>[] = []; let after = "";
    for (;;) {
      const page = this.store.applicationRecords<T>(namespace, after, 256, filter); result.push(...page);
      if (page.length < 256) return result;
      after = page.at(-1)!.id;
    }
  }
  cursor(sourceId: string): ApplicationRecord<SourceCursor> | undefined { return this.store.applicationRecord<SourceCursor>(NS.cursors, sourceId); }
  /** A whole source page and its cursor commit together. No task or network write occurs in this transaction. */
  async ingest(sourceId: string, batch: IncomingEvent[], cursor?: string, expectedCursorRevision?: number): Promise<IntakeEvent[]> {
    const source = this.source(sourceId), now = this.clock(), identity = sourceIdentity(source);
    this.registerSource(source);
    if (!Array.isArray(batch) || batch.length > 100) throw new Error("Source page exceeds 100 events");
    const entries: IntakeEvent[] = [];
    for (const incoming of batch) {
      if (!incoming || Object.keys(incoming).some(key => !["externalId", "actor", "thread", "text"].includes(key))) throw new Error("Invalid incoming event fields");
      text(incoming.externalId, "external event ID", 128); text(incoming.actor, "event actor", 128); text(incoming.thread, "event thread", 128); text(incoming.text, "event text", 8000);
      if (source.type === "github" && !/^[1-9]\d*$/.test(incoming.thread)) throw new Error("GitHub thread must be an issue number");
      const id = eventId(sourceId, incoming.externalId), digest = digestJson(incoming);
      const previous = this.store.applicationRecord<IntakeEvent>(NS.events, id);
      if (previous) {
        if (previous.value.digest !== digest) throw new Error("External event ID has conflicting payload");
        entries.push(previous.value); continue;
      }
      const entry: IntakeEvent = { id, sourceId, incoming: structuredClone(incoming), digest, identity, receivedAt: now, state: "pending" };
      try {
        const action = parseAction(incoming.text); entry.action = action;
        if (!action) entry.state = "ignored";
        else if (!(action.kind === "run" ? source.actors : [...source.actors, ...source.controllers]).includes(incoming.actor)) {
          entry.state = "rejected"; entry.error = "Actor is not authorized by this Source";
        } else if (action.kind === "run") {
          const configuration = structuredClone(source.configuration);
          configuration.strategyVersion = 2; configuration.maxModelRequests ??= 256;
          configuration.domain = this.runtime.domains.prepare(this.runtime.domains.descriptor(configuration));
          const adapter = this.runtime.domains.resolve(configuration.domain);
          await adapter.runtime?.normalize?.(configuration, this.runtime.root);
          entry.configuration = configuration; entry.mode = source.mode;
        } else if (action.kind === "followup" && !action.ticketId) {
          const candidates = this.records<Ticket>(NS.tickets, { sourceId: source.id, thread: incoming.thread }).map(row => row.value).filter(ticket => this.inScope(ticket, entry) && this.mayContribute(source, ticket, incoming.actor));
          if (candidates.length === 1) action.ticketId = candidates[0]!.id;
          else if (!candidates.length) entry.state = "ignored";
          else { entry.state = "clarify"; entry.candidates = candidates.map(ticket => ticket.id); }
        }
      } catch (error) { entry.state = "rejected"; entry.error = message(error); }
      entries.push(entry);
    }
    if (cursor !== undefined) text(cursor, "Source cursor", 4096);
    const ids = this.store.command(randomUUID(), { kind: "collaboration.intake", sourceId, events: entries.map(entry => ({ id: entry.id, digest: entry.digest })), cursor, expectedCursorRevision }, now, tx => {
      for (const entry of entries) {
        const previous = tx.applicationRecord<IntakeEvent>(NS.events, entry.id);
        if (previous) { if (previous.value.digest !== entry.digest) throw new Error("External event ID has conflicting payload"); continue; }
        tx.saveApplicationRecord({ namespace: NS.events, id: entry.id, value: entry }, 0);
        // Never send an acknowledgement to an unauthorized actor.
        if (entry.state === "rejected" && [...source.actors, ...source.controllers].includes(entry.incoming.actor)) this.enqueue(tx, `rejected:${entry.id}`, entry, `请求未被接纳：${entry.error ?? "无效命令"}`);
        if (entry.state === "clarify") this.enqueue(tx, `clarify:${entry.id}`, entry, `请求需要选择工单：${entry.candidates!.join(", ")}。请使用 /tnb followup <工单ID> <补充内容>，或由本机操作者 resolve 此事件。`);
      }
      if (cursor !== undefined) {
        const previous = tx.applicationRecord<SourceCursor>(NS.cursors, sourceId);
        if ((previous?.revision ?? 0) !== (expectedCursorRevision ?? 0)) throw new Error("Source cursor revision conflict");
        tx.saveApplicationRecord({ namespace: NS.cursors, id: sourceId, value: { value: cursor, lastPollAt: now } }, previous?.revision ?? 0);
      }
      return entries.map(entry => entry.id);
    });
    return ids.map(id => this.store.applicationRecord<IntakeEvent>(NS.events, id)!.value);
  }
  inScope(ticket: Ticket, event: IntakeEvent): boolean { return ticket.sourceId === event.sourceId && ticket.thread === event.incoming.thread && ticket.identity === event.identity; }
  mayContribute(source: Source, ticket: Ticket, actor: string): boolean { return source.controllers.includes(actor) || source.actors.includes(actor) && ticket.actor === actor; }
  async process(signal: AbortSignal): Promise<void> {
    for (const record of this.store.applicationRecords<IntakeEvent>(NS.events, "", 100, { state: "pending" }).sort((a, b) => a.value.receivedAt - b.value.receivedAt).slice(0, 100)) {
      if (signal.aborted) return;
      try { await this.execute(record.id, signal); }
      catch (error) {
        if (!signal.aborted) {
          const blocked = this.updateEvent(record.id, event => ({ ...event, state: "blocked", error: message(error) }));
          this.store.command(randomUUID(), { kind: "collaboration.blocked", id: record.id }, this.clock(), tx => {
            this.enqueue(tx, `blocked:${record.id}`, blocked, `请求 ${record.id} 未能执行：${blocked.error}。原请求已保留；请由本机操作者检查 events 和 runtime status。`); return true;
          });
        }
      }
    }
  }
  async execute(id: string, signal: AbortSignal): Promise<void> {
    let event = this.store.applicationRecord<IntakeEvent>(NS.events, id)!.value;
    if (event.state !== "pending" || !event.action) return;
    const action = event.action, commandId = `collab:${id}`;
    let ticket: Ticket;
    if (action.kind === "run") {
      // The admitted configuration is pinned before createRun. Replay before resolving plugins,
      // so a committed Run can be linked even when that plugin generation is now unavailable.
      if (!event.configuration || !event.mode) throw new Error("Admission contract is missing");
      const configuration = event.configuration, mode = event.mode;
      const input = { commandId, objective: action.text, configuration, tasks: undefined, deadline: undefined, source: this.routingSource(event, configuration), successorOf: undefined,
        policy: { mode, maxActiveAgents: mode === "single" ? 1 : mode === "multi" ? 4 : 2, maxDelegationDepth: mode === "single" ? 0 : 1 } };
      let created = this.runtime.commands.replayCreateRun(input);
      if (!created) {
        const source = this.source(event.sourceId);
        if (sourceIdentity(source) !== event.identity || !source.actors.includes(event.incoming.actor)) throw new Error("Admission authority or Source transport identity changed");
        created = await this.runtime.submit({ commandId, objective: action.text, configuration, mode, source: input.source });
      }
      ticket = { id: ticketId(id), sourceId: event.sourceId, identity: event.identity, thread: event.incoming.thread, actor: event.incoming.actor,
        objective: action.text, eventId: id, runId: created.run.runId, createdAt: event.receivedAt, state: "watching", status: created.run.status, delivery: "executing" };
      this.store.command(`collab-link:${id}`, { kind: "collaboration.link", id, runId: ticket.runId }, this.clock(), tx => {
        tx.saveApplicationRecord({ namespace: NS.tickets, id: ticket.id, runId: ticket.runId, value: ticket }, 0);
        const current = tx.applicationRecord<IntakeEvent>(NS.events, id)!;
        tx.saveApplicationRecord({ ...current, runId: ticket.runId, value: { ...current.value, state: "processed", ticketId: ticket.id } }, current.revision);
        this.enqueue(tx, `accepted:${ticket.id}`, ticket, `已接单 ${ticket.id}\nRun: ${ticket.runId}\n${ticket.objective}`); return ticket.id;
      });
      return;
    }
    const selected = action.ticketId && this.store.applicationRecord<Ticket>(NS.tickets, action.ticketId)?.value;
    if (!selected || !this.inScope(selected, event)) throw new Error("Ticket is not in the original Source/thread");
    ticket = selected;
    const configuration = this.runtime.configuration(ticket.runId), routing = this.routingSource(event, configuration);
    // Link an already committed operation before checking today's admission list. This is
    // recovery of an observed action, not fresh authority to execute a revoked command.
    let committed: unknown;
    if (action.kind === "followup") {
      const receipt = this.store.replayCommand<{ status: string }>(commandId, { kind: "input.route", commandId, runId: ticket.runId, source: { ...routing, rawText: action.text } });
      committed = receipt?.status === "accepted";
    } else if (action.kind === "answer") committed = this.store.replayCommand(commandId, { kind: "wait.answer", input: { commandId, runId: ticket.runId, waitId: action.waitId, expectedVersion: action.version, answer: action.text, source: routing } });
    else if (action.kind === "bind") committed = this.store.replayCommand(commandId, { kind: "collaboration.bind", ticketId: ticket.id, number: action.number });
    else if (event.prepared) committed = this.store.replayCommand(commandId, { kind: `run.${action.kind}`, input: { commandId, runId: ticket.runId, expectedRevision: event.prepared.revision, source: routing } });
    if (committed) { this.updateEvent(id, current => ({ ...current, state: "processed", ticketId: ticket.id })); return; }
    const source = this.source(event.sourceId);
    if (sourceIdentity(source) !== event.identity) throw new Error("Source transport identity changed; original event remains blocked");
    const controlled = ["pause", "resume", "cancel", "bind"].includes(action.kind);
    if (controlled ? !source.controllers.includes(event.incoming.actor) : !this.mayContribute(source, ticket, event.incoming.actor)) throw new Error("Actor cannot control this ticket");
    if (action.kind === "followup") {
      const decision = this.runtime.router.followup({ commandId, runId: ticket.runId, source: { ...routing, rawText: action.text } });
      if (decision.status !== "accepted") throw new Error(`Followup requires local resolution: ${decision.reason}`);
    } else if (action.kind === "answer") this.runtime.waits.answer({ commandId, runId: ticket.runId, waitId: action.waitId, expectedVersion: action.version, answer: action.text, source: routing });
    else if (action.kind === "bind") {
      const port = this.ports.get(source.id);
      if (source.type !== "github" || !port?.inspectPR) throw new Error("PR binding requires a GitHub Source");
      const bindingInput = { kind: "collaboration.bind", ticketId: ticket.id, number: action.number };
      if (!this.store.replayCommand(commandId, bindingInput)) {
        const pr = await port.inspectPR(action.number, AbortSignal.any([signal, AbortSignal.timeout(10000)]));
        if (pr.number !== action.number) throw new Error("PR identity mismatch");
        this.store.command(commandId, bindingInput, this.clock(), tx => {
          const current = tx.applicationRecord<Ticket>(NS.tickets, ticket.id)!;
          tx.saveApplicationRecord({ ...current, value: { ...current.value, pr, state: "watching" } }, current.revision);
          this.enqueue(tx, `pr:${ticket.id}:${digestJson(pr)}`, ticket, `${ticket.id} 已绑定 PR #${pr.number}\nhead: ${pr.head}\n${pr.url}`); return true;
        });
      }
    } else {
      if (!event.prepared) {
        const run = this.store.getRun(ticket.runId)!;
        event = this.updateEvent(id, current => ({ ...current, prepared: { runId: run.runId, revision: run.revision } }));
      }
      const input = { commandId, runId: ticket.runId, expectedRevision: event.prepared!.revision, source: routing };
      if (action.kind === "pause") this.runtime.commands.pauseRun(input);
      else if (action.kind === "cancel") this.runtime.commands.cancelRun(input);
      else if (!this.store.replayCommand(commandId, { kind: "run.resume", input })) {
        try { await this.runtime.resume(ticket.runId, commandId, input.expectedRevision, routing); }
        catch (error) { if (!this.store.replayCommand(commandId, { kind: "run.resume", input })) throw error; }
      }
    }
    this.updateEvent(id, current => ({ ...current, state: "processed", ticketId: ticket.id }));
  }
  routingSource(event: IntakeEvent, configuration: RuntimeConfiguration): RoutingInput {
    return { source: "api", inputId: event.id, workspace: configuration.workspace, sessionId: `collab:${digestJson({ source: event.sourceId, thread: event.incoming.thread }).slice(0, 48)}`, rawText: event.incoming.text };
  }
  updateEvent(id: string, update: (value: IntakeEvent) => IntakeEvent, expectedRevision?: number): IntakeEvent {
    return this.store.command(randomUUID(), { kind: "collaboration.event", id }, this.clock(), tx => {
      const current = tx.applicationRecord<IntakeEvent>(NS.events, id)!;
      if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new Error("Event revision conflict");
      return tx.saveApplicationRecord({ ...current, value: update(current.value) }, current.revision).value;
    });
  }
  resolveEvent(id: string, ticketId: string, revision: number): IntakeEvent {
    const record = this.store.applicationRecord<IntakeEvent>(NS.events, id);
    if (!record || record.revision !== revision || record.value.state !== "clarify" || !record.value.candidates?.includes(ticketId) || record.value.action?.kind !== "followup") throw new Error("Event resolution conflict or target outside original candidates");
    return this.updateEvent(id, event => ({ ...event, state: "pending", action: { kind: "followup", text: (event.action as Extract<Action, { kind: "followup" }>).text, ticketId } }), revision);
  }
  retryEvent(id: string, revision: number): IntakeEvent {
    const row = this.store.applicationRecord<IntakeEvent>(NS.events, id);
    if (!row || row.revision !== revision || row.value.state !== "blocked") throw new Error("Event retry conflict");
    return this.updateEvent(id, event => ({ ...event, state: "pending", error: undefined }), revision);
  }
  /** Bounded external observation. It never publishes an old Run status over a newer projection. */
  async inspectPullRequests(signal: AbortSignal): Promise<void> {
    const candidates = this.records<Ticket>(NS.tickets, { state: "watching" }).map(row => row.value)
      .filter(ticket => ticket.pr && !ticket.pr.merged && this.config.sources.some(source => source.id === ticket.sourceId && sourceIdentity(source) === ticket.identity));
    if (!candidates.length) return;
    const selected = Array.from({ length: Math.min(4, candidates.length) }, (_, index) => candidates[(this.#prOffset + index) % candidates.length]!);
    this.#prOffset = (this.#prOffset + selected.length) % candidates.length;
    const results = await Promise.allSettled(selected.map(async ticket => {
      if (signal.aborted) return;
      try {
        const pr = await this.ports.get(ticket.sourceId)?.inspectPR?.(ticket.pr!.number, AbortSignal.any([signal, AbortSignal.timeout(10000)]));
        if (!pr || signal.aborted) return;
        const before = this.store.applicationRecord<Ticket>(NS.tickets, ticket.id)!;
        if (before.value.pr?.number !== ticket.pr!.number) return;
        if (digestJson(before.value.pr) !== digestJson(pr)) this.store.command(randomUUID(), { kind: "collaboration.pr", ticketId: ticket.id, pr }, this.clock(), tx => {
          const current = tx.applicationRecord<Ticket>(NS.tickets, ticket.id)!;
          if (current.value.pr?.number !== ticket.pr!.number) return false;
          tx.saveApplicationRecord({ ...current, value: { ...current.value, pr } }, current.revision);
          this.enqueue(tx, `pr:${ticket.id}:${digestJson(pr)}`, ticket, `${ticket.id} PR #${pr.number}: ${pr.merged ? "merged" : pr.state}\nhead: ${pr.head}\nCI: ${JSON.stringify(pr.ci).slice(0, 3000)}\n${pr.url}`); return true;
        });
        this.errors.delete(ticket.id);
      } catch (error) { if (!signal.aborted) this.errors.set(ticket.id, message(error)); }
    }));
    for (const result of results) if (result.status === "rejected") throw result.reason;
  }
  /** Project business facts and enqueue their notifications in the same transaction. */
  async project(signal: AbortSignal, inspectPR = true): Promise<void> {
    if (inspectPR) await this.inspectPullRequests(signal);
    for (const record of this.records<Ticket>(NS.tickets, { state: "watching" })) {
      if (signal.aborted) return;
      const ticket = record.value, run = this.store.getRun(ticket.runId)!, pr = ticket.pr;
      const terminal = ["succeeded", "failed", "cancelled"].includes(run.status);
      const delivery: Ticket["delivery"] = pr?.merged ? "merged" : pr?.state === "closed" ? "closed" : !terminal ? "executing" : pr ? "awaiting-pr" : "completed";
      const questions = this.runtime.waits.questions(run.runId);
      const unchanged = ticket.status === run.status && ticket.delivery === delivery && digestJson(ticket.pr ?? null) === digestJson(pr ?? null);
      const questionMissing = questions.some(q => !this.store.applicationRecord(NS.outbox, digestJson({ key: `question:${ticket.id}:${q.waitId}:${q.version}` })));
      const statusKey = terminal ? `result:${ticket.id}:${run.status}` : run.status === "paused" ? `paused:${ticket.id}:${run.revision}` : undefined;
      if (unchanged && !questionMissing && (!statusKey || this.store.applicationRecord(NS.outbox, digestJson({ key: statusKey })))) continue;
      // Read only the root acceptance summary; full evidence remains in the runtime result endpoint.
      const summaries: string[] = [];
      if (terminal) for (const task of this.store.tasks(run.runId).filter(task => !task.parentTaskId)) {
        if (task.resultRef) {
          const result = await this.runtime.artifacts.get(task.resultRef) as { report?: unknown; acceptance?: unknown; checks?: unknown };
          summaries.push(`${task.key}: ${task.status}; acceptance=${JSON.stringify(result.acceptance ?? "recorded")}; checks=${JSON.stringify(result.checks ?? []).slice(0, 2500)}\n${typeof result.report === "string" ? result.report.slice(0, 7000) : ""}\n完整证据：tnb runtime result ${run.runId} --task ${task.taskId}`);
        } else summaries.push(`${task.key}: ${task.status}${task.error ? `; ${task.error.slice(0, 1000)}` : ""}`);
      }
      this.store.command(randomUUID(), { kind: "collaboration.project", ticketId: ticket.id, revision: run.revision }, this.clock(), tx => {
        const current = tx.applicationRecord<Ticket>(NS.tickets, ticket.id)!;
        if (current.revision !== record.revision) return false; // A newer PR/binding fact arrived while reading acceptance artifacts.
        const next: Ticket = { ...current.value, status: run.status, delivery, state: terminal && (!pr || pr.merged) ? "settled" : "watching", ...(pr ? { pr } : {}) };
        if (digestJson(current.value) !== digestJson(next)) tx.saveApplicationRecord({ ...current, value: next }, current.revision);
        for (const question of questions) if (question.proposal.kind === "question") {
          const { question: prompt, options } = question.proposal;
          this.enqueue(tx, `question:${ticket.id}:${question.waitId}:${question.version}`, ticket,
            `${ticket.id} 需要你决定。请回复：\n/tnb answer ${ticket.id} ${question.waitId} ${question.version} <答案>\n回答不会恢复已暂停的任务。\n\n${prompt}\n${options?.map((option, i) => `${i + 1}. ${option}`).join("\n") ?? ""}`, { runId: run.runId, waitId: question.waitId, version: question.version });
        }
        if (terminal) this.enqueue(tx, `result:${ticket.id}:${run.status}`, ticket, `${ticket.id} 执行状态：${run.status}\nRun: ${run.runId}\n${summaries.join("\n")}\n交付：${delivery}`);
        else if (run.status === "paused") this.enqueue(tx, `paused:${ticket.id}:${run.revision}`, ticket, `${ticket.id} 已暂停：${run.pauseReason ?? "user"}。需要本机处理的权限、预算或不确定操作，请使用 tnb runtime status ${run.runId} 查看。`);
        if (pr && digestJson(ticket.pr ?? null) !== digestJson(pr)) this.enqueue(tx, `pr:${ticket.id}:${digestJson(pr)}`, ticket, `${ticket.id} PR #${pr.number}: ${pr.merged ? "merged" : pr.state}\nhead: ${pr.head}\nCI: ${JSON.stringify(pr.ci).slice(0, 3000)}\n${pr.url}`);
        return true;
      });
    }
  }
  enqueue(tx: RuntimeTransaction, key: string, target: Pick<Notification, "sourceId" | "identity"> & { thread?: string; id?: string; incoming?: IncomingEvent }, body: string, question?: Notification["question"]): void {
    const id = digestJson({ key });
    if (tx.applicationRecord(NS.outbox, id)) return;
    const thread = "incoming" in target && target.incoming ? target.incoming.thread : target.thread!;
    const sequence = tx.applicationRecord<{ count: number }>("collaboration.meta", "outbox-sequence");
    const count = (sequence?.value.count ?? 0) + 1;
    tx.saveApplicationRecord({ namespace: "collaboration.meta", id: "outbox-sequence", value: { count } }, sequence?.revision ?? 0);
    const value: Notification = { id, sourceId: target.sourceId, identity: target.identity, thread,
      ...(target.id?.startsWith("t_") ? { ticketId: target.id } : {}), text: body.slice(0, 12000), state: "pending", createdAt: tx.now, sequence: count, ...(question ? { question } : {}) };
    tx.saveApplicationRecord({ namespace: NS.outbox, id, value }, 0);
  }
  recoverOutbox(): void {
    for (const row of this.records<Notification>(NS.outbox, { state: "dispatched" })) this.setNotification(row.id, "unknown", undefined, "Owner stopped after dispatch; verify receipt before retrying");
  }
  setNotification(id: string, state: Notification["state"], receipt?: string, error?: string): void {
    this.store.command(randomUUID(), { kind: "collaboration.outbox", id, state, receipt, error }, this.clock(), tx => {
      const row = tx.applicationRecord<Notification>(NS.outbox, id)!;
      tx.saveApplicationRecord({ ...row, value: { ...row.value, state, ...(receipt ? { receipt } : {}), ...(error ? { error: error.slice(0, 1000) } : {}) } }, row.revision); return true;
    });
  }
  async deliver(signal: AbortSignal): Promise<void> {
    const targets = new Set<string>();
    const selected: ApplicationRecord<Notification>[] = [];
    for (const row of this.store.applicationRecords<Notification>(NS.outbox, "", 256, { state: "pending", orderBySequence: true })) {
      const key = digestJson({ source: row.value.sourceId, thread: row.value.thread });
      if (!targets.has(key)) { targets.add(key); selected.push(row); }
      if (selected.length >= 16) break;
    }
    const results = await Promise.allSettled(selected.map(async row => {
      if (signal.aborted) return;
      const notification = row.value, source = this.config.sources.find(source => source.id === notification.sourceId), port = this.ports.get(notification.sourceId);
      if (!source || !port || sourceIdentity(source) !== notification.identity) return;
      if (notification.question && !this.runtime.waits.questions(notification.question.runId).some(q => q.waitId === notification.question!.waitId && q.version === notification.question!.version)) {
        this.setNotification(row.id, "suppressed", undefined, "Question is no longer open at the notified version"); return;
      }
      this.setNotification(row.id, "dispatched");
      try {
        const receipt = text(await port.send(notification, signal), "notification receipt", 512);
        this.setNotification(row.id, "sent", receipt);
      } catch (error) { this.setNotification(row.id, "unknown", undefined, message(error)); }
    }));
    for (const result of results) if (result.status === "rejected") throw result.reason;
  }

  async reconcile(id: string, signal: AbortSignal): Promise<boolean> {
    const row = this.store.applicationRecord<Notification>(NS.outbox, id);
    if (!row || row.value.state !== "unknown") throw new Error("Only unknown notifications can be reconciled");
    const source = this.source(row.value.sourceId);
    if (sourceIdentity(source) !== row.value.identity) throw new Error("Source transport identity changed");
    const receipt = await this.ports.get(source.id)?.find?.(row.value, signal);
    if (!receipt) return false;
    this.setNotification(id, "sent", text(receipt, "notification receipt", 512)); return true;
  }
  resolveOutbox(id: string, revision: number, decision: "sent" | "retry", evidence: string): void {
    text(evidence, "receipt evidence", 1000);
    if (!["sent", "retry"].includes(decision)) throw new Error("Decision must be sent or retry");
    this.store.command(randomUUID(), { kind: "collaboration.outbox.resolve", id, revision, decision, evidence }, this.clock(), tx => {
      const row = tx.applicationRecord<Notification>(NS.outbox, id);
      if (!row || row.revision !== revision || row.value.state !== "unknown") throw new Error("Outbox resolution conflict");
      if ((row.value.history?.length ?? 0) >= 100) throw new Error("Outbox reconciliation limit reached");
      tx.saveApplicationRecord({ ...row, value: { ...row.value, state: decision === "sent" ? "sent" : "pending", receipt: decision === "sent" ? evidence : undefined,
        history: [...(row.value.history ?? []), { decision, evidence, at: tx.now }] } }, row.revision); return true;
    });
  }
}
function message(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 1000); }
