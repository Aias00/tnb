import type { CollaborationService } from "../../agent/collaboration-service";
import { CollaborationEngine, NS } from "./engine";
import type { CollaborationConfig, IncomingEvent, IntakeEvent, Notification, SourcePort, Ticket } from "./types";

/** Optional application over the existing owner/store, never another runtime owner. */
export class CollaborationHost {
  readonly engine: CollaborationEngine;
  readonly errors = new Map<string, string>();
  readonly #controller = new AbortController();
  #server?: ReturnType<typeof Bun.serve>;
  #timer?: ReturnType<typeof setTimeout>;
  #pass?: Promise<void>;
  #polling?: Promise<void>;
  #delivery?: Promise<void>;
  #observing?: Promise<void>;
  #closed = false;
  readonly #requests = new Set<Promise<Response>>();
  #lastPR = 0;
  #lastPoll = new Map<string, number>();
  constructor(readonly service: CollaborationService, readonly config: CollaborationConfig, ports: Map<string, SourcePort>, readonly unavailableSources: ReadonlyMap<string, string> = new Map()) {
    this.engine = new CollaborationEngine(service, config, ports);
  }
  static async open(service: CollaborationService, ports: Map<string, SourcePort>): Promise<CollaborationHost | undefined> {
    const config = service.configuration();
    if (!config.enabled) return undefined;
    const host = new CollaborationHost(service, config, ports);
    try { await host.start(); return host; } catch (error) { await host.close(); throw error; }
  }
  async start(): Promise<void> {
    for (const source of this.config.sources) this.engine.registerSource(source);
    this.engine.recoverOutbox();
    if (this.config.listen) this.#server = Bun.serve({ ...this.config.listen, maxRequestBodySize: 32 * 1024,
      fetch: request => {
        const pending = this.receive(request); this.#requests.add(pending);
        void pending.finally(() => this.#requests.delete(pending)); return pending;
      } });
    // Persist the initial GitHub watermark before the first request, including restart before page one.
    for (const source of this.config.sources) if (source.type === "github" && !this.engine.cursor(source.id)) {
      const now = new Date().toISOString();
      await this.engine.ingest(source.id, [], JSON.stringify({ since: now, floor: now }), 0);
    }
    this.schedule(0);
  }
  schedule(delay: number): void {
    if (this.#closed) return;
    this.#timer = setTimeout(() => { void this.tick().finally(() => this.schedule(1000)); }, delay);
  }
  async tick(): Promise<void> {
    if (this.#closed) return;
    if (this.#pass) return this.#pass;
    this.#pass = this.pass().catch(error => { this.errors.set("host", error instanceof Error ? error.message : String(error)); }).finally(() => { this.#pass = undefined; });
    return this.#pass;
  }
  async pass(): Promise<void> {
    const signal = this.#controller.signal;
    this.errors.delete("host");
    await this.engine.process(signal); await this.engine.project(signal, false);
    // Intake, projection, outbound delivery and PR observation have independent network lifetimes.
    // A stalled source cannot prevent another channel's question/result notifications.
    if (!this.#polling) this.#polling = this.pollSources(signal).catch(error => this.errors.set("polling", String(error))).then(() => undefined).finally(() => { this.#polling = undefined; });
    if (!this.#delivery) this.#delivery = this.engine.deliver(signal).catch(error => this.errors.set("delivery", String(error))).then(() => undefined).finally(() => { this.#delivery = undefined; });
    if (!this.#observing && Date.now() - this.#lastPR >= 30000) {
      this.#lastPR = Date.now();
      this.#observing = this.engine.inspectPullRequests(signal).catch(error => this.errors.set("pr", String(error))).then(() => undefined).finally(() => { this.#observing = undefined; });
    }
  }
  async pollSources(signal: AbortSignal): Promise<void> {
    // Independent source reads share no cursor. Each full scan commits its watermark only after every page was read.
    const results = await Promise.allSettled(this.config.sources.map(async source => {
      const port = this.engine.ports.get(source.id), now = Date.now();
      if (signal.aborted || !port?.poll || now - (this.#lastPoll.get(source.id) ?? 0) < source.pollIntervalMs) return;
      this.#lastPoll.set(source.id, now);
      try {
        const saved = this.engine.cursor(source.id), scanSignal = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
        const batch = await port.poll(saved?.value.value, scanSignal);
        if (signal.aborted) return;
        // Earlier chunks are safe to replay after a crash; the final chunk commits the complete scan's cursor.
        for (let start = 0; start < batch.events.length; start += 100) {
          await this.engine.ingest(source.id, batch.events.slice(start, start + 100));
          if (signal.aborted) return;
        }
        await this.engine.ingest(source.id, [], batch.cursor, saved?.revision ?? 0);
        this.errors.delete(source.id);
      } catch (error) { if (!signal.aborted) this.errors.set(source.id, error instanceof Error ? error.message : String(error)); }
    }));
    for (const result of results) if (result.status === "rejected") this.errors.set("host", String(result.reason));
  }
  async receive(request: Request): Promise<Response> {
    if (this.#closed) return Response.json({ error: "Collaboration is stopping" }, { status: 503 });
    try {
      const match = /^\/sources\/([A-Za-z0-9_-]+)\/events$/.exec(new URL(request.url).pathname);
      if (request.method !== "POST" || !match) return Response.json({ error: "Not found" }, { status: 404 });
      if (this.unavailableSources.has(match[1]!)) return Response.json({ error: "Source channel is temporarily unavailable" }, { status: 503 });
      const source = this.engine.source(match[1]!);
      const port = this.engine.ports.get(source.id);
      if (!port?.receive) return Response.json({ error: "Source channel does not accept incoming requests" }, { status: 403 });
      const batch = await port.receive(request, this.#controller.signal);
      if (this.#closed) return Response.json({ error: "Collaboration is stopping" }, { status: 503 });
      const events = await this.engine.ingest(source.id, batch), event = events[0];
      return Response.json({ eventId: event?.id, state: event?.state, ...(events.length > 1 ? { events: events.map(item => ({ id: item.id, state: item.state })) } : {}) }, { status: 202 });
    } catch (error) { const status = (error as { status?: number })?.status; return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: status && [400, 401, 403, 404, 413, 429].includes(status) ? status : 400 }); }
  }
  status(): unknown {
    return { enabled: true, sources: this.config.sources.map(source => ({ id: source.id, type: source.type, error: this.errors.get(source.id), cursor: this.engine.cursor(source.id)?.value })),
      errors: { ...Object.fromEntries(this.errors), ...Object.fromEntries(this.engine.errors) },
      pendingEvents: this.engine.records<IntakeEvent>(NS.events).filter(row => ["pending", "clarify", "blocked"].includes(row.value.state)).length,
      tickets: this.engine.records<Ticket>(NS.tickets).length,
      notifications: this.engine.records<Notification>(NS.outbox).reduce((counts, row) => ({ ...counts, [row.value.state]: (counts[row.value.state] ?? 0) + 1 }), {} as Record<string, number>) };
  }
  async resource(request: Request): Promise<unknown> {
    const url = new URL(request.url), kind = url.searchParams.get("kind") ?? "status";
    if (request.method === "GET") {
      if (kind === "status") return this.status();
      if (!["events", "tickets", "outbox"].includes(kind)) throw new Error("Unknown collaboration inventory");
      return this.service.state.applicationRecords(NS[kind as "events" | "tickets" | "outbox"], url.searchParams.get("after") ?? "");
    }
    if (request.method !== "POST") throw new Error("Unknown collaboration method");
    const input = await request.json() as { action: string; id: string; ticketId: string; revision: number; decision: "sent" | "retry"; evidence: string };
    if (input.action === "retry") return this.engine.retryEvent(input.id, input.revision);
    if (input.action === "resolve") return this.engine.resolveEvent(input.id, input.ticketId, input.revision);
    if (input.action === "reconcile") return { found: await this.engine.reconcile(input.id, this.#controller.signal) };
    if (input.action === "outbox-resolve") { this.engine.resolveOutbox(input.id, input.revision, input.decision, input.evidence); return { resolved: true }; }
    throw new Error("Unknown collaboration management command");
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true; clearTimeout(this.#timer); this.#controller.abort();
    await this.#server?.stop(true); await this.#pass; await Promise.allSettled([this.#polling, this.#delivery, this.#observing, ...this.#requests]);
  }
}
