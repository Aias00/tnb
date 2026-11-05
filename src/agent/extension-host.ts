import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PluginServiceRegistry } from "./services";
import { digestJson, encodeJson, text } from "../services/runtime/json";
import type { PluginAdapterRegistration } from "./domain";
import type { ChannelGenerationReference } from "./channel-bindings";
import type { ActiveExtension, ChannelConnection, ChannelDescriptor, ChannelPort, ChannelRegistry, ContributionReference, ExtensionContext, ExtensionHostOptions, ExtensionRegistration, ExtensionState, PluginApplication, PluginChannel, PluginStateStore } from "./extensions";

const key = (ref: ContributionReference) => digestJson({ kind: ref.kind, id: ref.id, version: ref.version });
const generationKey = (ref: ContributionReference, plugin: ChannelDescriptor["plugin"]) => digestJson({ contribution: key(ref), plugin });
export class ExtensionHost {
  readonly #states = new Map<string, ExtensionState>();
  readonly #registrations = new Map<string, ExtensionRegistration>();
  readonly #contexts = new Map<string, { controller: AbortController; callbacks: Array<() => void | Promise<void>>; accepting: boolean; finished: boolean }>();
  readonly #active = new Map<string, ActiveExtension>();
  readonly #order: string[] = [];
  readonly #inFlight = new Set<Promise<unknown>>();
  readonly #connections = new Map<ChannelConnection, string>();
  #options?: ExtensionHostOptions;
  #services?: PluginServiceRegistry;
  #closed = false;
  #started = false;
  #closing?: Promise<void>;
  #starting?: Promise<void>;
  #removeAbortListener?: () => void;
  readonly channels: ChannelRegistry = Object.freeze({ descriptor: (input: ChannelDescriptor) => this.channelDescriptor(input), connect: (input: ChannelDescriptor, config: Parameters<ChannelRegistry["connect"]>[1], signal?: AbortSignal) => this.track(this.connect(input, config, signal)) });
  constructor(registrations: readonly ExtensionRegistration[], readonly adapters: readonly Pick<PluginAdapterRegistration, "adapter">[], readonly root?: string, readonly channelReferences: readonly ChannelGenerationReference[] = []) {
    if (registrations.length > 512) throw new Error("Host extension capacity exceeded");
    for (const registration of registrations) {
      if (registration.recoveryOnly && (registration.declaration.kind !== "channel" || registration.declaration.requires.length)) throw new Error("Retained channels must be self-contained and have no contribution dependencies");
      const id = registration.recoveryOnly ? generationKey(registration.declaration, registration.plugin) : key(registration.declaration);
      if (this.#registrations.has(id)) throw new Error("Duplicate host contribution");
      this.#registrations.set(id, registration);
      this.#states.set(id, { kind: registration.declaration.kind, id: registration.declaration.id, version: registration.declaration.version, plugin: registration.plugin, status: "registered" });
    }
  }
  list(): ExtensionState[] { return structuredClone([...this.#states.values()]); }
  start(options: ExtensionHostOptions): Promise<void> {
    if (this.#started || this.#closed) return Promise.reject(new Error("Plugin extensions already started or closed"));
    this.#started = true;
    this.#starting = Promise.resolve().then(() => this.startContributions(options));
    return this.#starting;
  }
  private async startContributions(options: ExtensionHostOptions): Promise<void> {
    if (this.#closed) throw new Error("Plugin startup cancelled");
    if (options.signal) {
      const abort = () => { void this.stop().catch(() => undefined); };
      options.signal.addEventListener("abort", abort, { once: true });
      this.#removeAbortListener = () => options.signal!.removeEventListener("abort", abort);
      if (options.signal.aborted) { abort(); throw new Error("Plugin startup cancelled"); }
    }
    this.#options = { store: options.store, services: new Map(options.services), grants: structuredClone(options.grants ?? {}) };
    this.#services = new PluginServiceRegistry(options.serviceProviders, this.#options.services);
    const visiting = new Set<string>(), visited = new Set<string>(), ordered: string[] = [];
    const visit = (id: string) => {
      if (visited.has(id)) return;
      const state = this.#states.get(id)!;
      if (visiting.has(id)) throw new Error("Plugin contribution dependency cycle");
      visiting.add(id);
      try {
        for (const dependency of this.#registrations.get(id)!.declaration.requires) {
          if (dependency.kind === "adapter") {
            if (!this.adapters.some(row => row.adapter.id === dependency.id && row.adapter.version === dependency.version)) throw new Error(`Missing adapter dependency: ${dependency.id}@${dependency.version}`);
          } else {
            if (!this.#registrations.has(key(dependency))) throw new Error(`Missing plugin dependency: ${dependency.kind}:${dependency.id}@${dependency.version}`);
            visit(key(dependency));
            if (this.#states.get(key(dependency))!.status === "failed") throw new Error("Plugin dependency failed validation");
          }
        }
        visited.add(id); ordered.push(id);
      } catch (error) { state.status = "failed"; state.error = message(error); throw error; }
      finally { visiting.delete(id); }
    };
    // Stable phases unless an explicit dependency requires a more specific order.
    for (const kind of ["channel", "application", "interface"] as const) for (const [id, row] of this.#registrations) if (row.declaration.kind === kind) {
      try { visit(id); } catch { /* Validation failure is visible and does not disable independent contributions. */ }
    }
    for (const id of ordered) {
      if (this.#closed) throw new Error("Plugin startup cancelled");
      const registration = this.#registrations.get(id)!, state = this.#states.get(id)!;
      if (state.status === "failed") continue;
      try {
        if (registration.declaration.requires.some(ref => ref.kind !== "adapter" && this.#states.get(key(ref))?.status !== "active")) throw new Error("Plugin dependency did not activate");
        const grants = this.#options.grants?.[registration.plugin.name] ?? [];
        const unavailable = registration.declaration.services.find(name => !grants.includes(name) || !this.#services!.has(name));
        if (unavailable) throw new Error(`Plugin service is not granted or unavailable: ${unavailable}`);
        for (const name of registration.declaration.services) this.#services.assertAvailable(name);
        state.status = "starting";
        const context = await this.context(id);
        this.#order.push(id);
        context.signal.throwIfAborted(); // Include partially started resources in reverse cleanup.
        if (registration.declaration.kind !== "channel") {
          const active = await (registration.definition as PluginApplication).start(context);
          if (active && (typeof active !== "object" || active.handle !== undefined && typeof active.handle !== "function" || active.status !== undefined && typeof active.status !== "function")) throw new Error("Invalid active plugin interface");
          context.signal.throwIfAborted();
          this.#active.set(id, Object.freeze({ ...(active?.handle ? { handle: active.handle.bind(active) } : {}), ...(active?.status ? { status: active.status.bind(active) } : {}) }));
        }
        state.status = "active";
      } catch (error) {
        state.status = "failed"; state.error = message(error);
        try { await this.dispose(id); } catch (cleanup) { state.error += `; ${message(cleanup)}`; }
      }
    }
    if (this.#closed) throw new Error("Plugin startup cancelled");
  }
  assertActive(ref: ContributionReference): void {
    if (this.#closed || this.#states.get(key(ref))?.status !== "active") throw new Error(`Plugin contribution unavailable: ${ref.kind}:${ref.id}@${ref.version}`);
  }
  async handle(ref: ContributionReference, request: Request): Promise<Response> {
    this.assertActive(ref); const handle = this.#active.get(key(ref))?.handle;
    if (!handle) throw new Error("Plugin contribution has no request handler");
    const controller = this.#contexts.get(key(ref))!.controller;
    const headers = new Headers(request.headers);
    for (const name of ["authorization", "proxy-authorization", "cookie"]) headers.delete(name);
    // Bun 1.3 can retain original headers when cloning a Request with an empty override.
    const routed = new Request(request.url, { method: request.method, headers,
      ...(!["GET", "HEAD"].includes(request.method) ? { body: request.body } : {}), signal: AbortSignal.any([request.signal, controller.signal]) });
    return this.track(Promise.resolve().then(() => handle(routed)).then(response => { if (!(response instanceof Response)) throw new Error("Plugin handler must return a Response"); return response; }));
  }
  status(ref: ContributionReference): unknown {
    this.assertActive(ref); const status = this.#active.get(key(ref))?.status?.() ?? null;
    return JSON.parse(encodeJson(status, 128 * 1024));
  }
  channelDescriptor(input: ChannelDescriptor): ChannelDescriptor {
    const { registration } = this.selectChannel(input), plugin = registration.plugin;
    return { id: input.id, version: input.version, plugin: { ...plugin } };
  }
  private selectChannel(input: ChannelDescriptor) {
    const ref = { kind: "channel" as const, id: input.id, version: input.version }, current = this.#registrations.get(key(ref));
    const id = input.plugin && (!current || digestJson(current.plugin) !== digestJson(input.plugin)) ? generationKey(ref, input.plugin) : key(ref);
    const registration = this.#registrations.get(id);
    if (this.#closed || !registration || this.#states.get(id)?.status !== "active") throw new Error("Channel plugin generation is unavailable; do not replace persisted provenance");
    return { id, registration };
  }
  private async connect(input: ChannelDescriptor, configuration: Parameters<ChannelRegistry["connect"]>[1], signal?: AbortSignal): Promise<ChannelConnection> {
    signal?.throwIfAborted();
    const descriptor = this.channelDescriptor(input), { id } = this.selectChannel(descriptor);
    encodeJson(configuration, 128 * 1024);
    const context = await this.context(id), controller = new AbortController();
    const connectionId = `${id}:connection:${randomUUID()}`, combined = AbortSignal.any([context.signal, controller.signal, ...(signal ? [signal] : [])]);
    const service = this.bindServices(id, connectionId, combined, () => { if (combined.aborted || this.#closed) throw new Error("Channel connection lifetime ended"); });
    let port: ChannelPort | undefined;
    const callbacks: Array<() => void | Promise<void>> = []; let accepting = true;
    const disposeConnection = async () => {
      accepting = false; controller.abort(); const errors: unknown[] = [];
      try { await port?.close?.(); } catch (error) { errors.push(error); }
      for (const callback of callbacks.splice(0).reverse()) { try { await callback(); } catch (error) { errors.push(error); } }
      try { await this.#services?.closeConsumer(connectionId); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "Channel connection cleanup failed");
    };
    const opening = Promise.resolve().then(() => { combined.throwIfAborted(); return (this.#registrations.get(id)!.definition as PluginChannel).connect(structuredClone(configuration), Object.freeze({ ...context, signal: combined, service, onDispose(callback: () => void | Promise<void>) {
      if (!accepting || combined.aborted || typeof callback !== "function") throw new Error("Channel connection registration is closed"); callbacks.push(callback);
    } })); });
    try { port = await opening; } catch (error) { try { await disposeConnection(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Channel startup and cleanup failed"); } throw error; }
    if (!port || typeof port.send !== "function" || ["receive", "poll", "find", "observe", "close"].some(name => (port as any)[name] !== undefined && typeof (port as any)[name] !== "function")) {
      await disposeConnection(); throw new Error("Invalid plugin channel port");
    }
    if (this.#closed || combined.aborted) { await disposeConnection(); throw new Error("Plugin host or consumer closed while opening channel"); }
    let closed = false, closing: Promise<void> | undefined;
    const pending = new Set<Promise<unknown>>();
    const invoke = <T>(apply: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> => {
      if (closed || this.#closed) return Promise.reject(new Error("Plugin channel is closed"));
      const active = this.track(Promise.resolve().then(() => { const callSignal = AbortSignal.any([signal, combined]); callSignal.throwIfAborted(); return apply(callSignal); }));
      pending.add(active); void active.then(() => pending.delete(active), () => pending.delete(active)); return active;
    };
    const wrapped: ChannelPort = {
      ...(port.receive ? { receive: (request: Request, signal: AbortSignal) => invoke(signal => port!.receive!(request, signal), signal) } : {}),
      send: (message, signal) => invoke(signal => port!.send(message, signal), signal),
      ...(port.poll ? { poll: (cursor: string | undefined, signal: AbortSignal) => invoke(signal => port!.poll!(cursor, signal), signal) } : {}),
      ...(port.find ? { find: (message: Parameters<ChannelPort["send"]>[0], signal: AbortSignal) => invoke(signal => port!.find!(message, signal), signal) } : {}),
      ...(port.observe ? { observe: (resource: { kind: string; id: string }, signal: AbortSignal) => invoke(signal => port!.observe!(resource, signal), signal) } : {}),
    };
    const connection: ChannelConnection = { descriptor, port: Object.freeze(wrapped), close: () => closing ??= (async () => {
      closed = true; controller.abort();
      try { await Promise.allSettled([...pending]); await disposeConnection(); } finally { this.#connections.delete(connection); }
    })() };
    this.#connections.set(connection, id); return connection;
  }
  private async context(id: string): Promise<ExtensionContext> {
    const registration = this.#registrations.get(id)!;
    if (!this.#contexts.has(id)) this.#contexts.set(id, { controller: new AbortController(), callbacks: [], accepting: true, finished: false });
    const lifetime = this.#contexts.get(id)!;
    const identity = { plugin: registration.plugin.name, kind: registration.declaration.kind, id: registration.declaration.id, version: registration.declaration.version };
    let stateKey = digestJson(identity);
    if (registration.declaration.kind === "channel") {
      const store = this.#options!.store, namespace = "host.channel-state", previous = store.applicationRecord<{ plugin: typeof registration.plugin }>(namespace, stateKey);
      let owner = previous?.value.plugin;
      if (!owner) {
        const referenced = this.channelReferences.filter(ref => ref.channel.id === registration.declaration.id && ref.channel.version === registration.declaration.version && ref.plugin.name === registration.plugin.name);
        if (new Set(referenced.map(ref => digestJson(ref.plugin))).size > 1) throw new Error("Legacy channel state owner is ambiguous; explicit migration is required");
        owner = referenced[0]?.plugin ?? registration.plugin;
        const value = { plugin: owner }; store.command(`channel-state:${stateKey}`, value, Date.now(), tx => tx.saveApplicationRecord({ namespace, id: stateKey, value }, 0));
      }
      if (digestJson(owner) !== digestJson(registration.plugin)) stateKey = digestJson({ ...identity, generation: registration.plugin });
    }
    const namespace = `plugin:${stateKey.slice(0, 48)}`;
    const stateDirectory = this.root ? join(this.root, "plugin-state", stateKey) : undefined;
    if (stateDirectory) await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const store = this.#options!.store;
    const assertLive = () => { if (this.#closed || !lifetime.accepting || lifetime.controller.signal.aborted) throw new Error("Plugin contribution lifetime ended"); };
    const assertState = () => { if (lifetime.finished) throw new Error("Plugin state lifetime ended"); };
    const service = this.bindServices(id, id, lifetime.controller.signal, assertLive);
    const state: PluginStateStore = Object.freeze({
      get: <T>(recordId: string) => { assertState(); return store.applicationRecord<T>(namespace, recordId); },
      list: <T>(afterId = "", limit = 256) => { assertState(); return store.applicationRecords<T>(namespace, afterId, limit); },
      command: <T>(commandId: string, input: unknown, apply: Parameters<PluginStateStore["command"]>[2]): T => {
        assertState(); text(commandId, "plugin command ID", 128);
        return store.command(digestJson({ namespace, commandId }), { namespace, input }, Date.now(), tx => apply({
          get: <V>(recordId: string) => tx.applicationRecord<V>(namespace, recordId),
          save: <V>(recordId: string, value: V, previousRevision: number) => { assertState(); return tx.saveApplicationRecord({ namespace, id: recordId, value }, previousRevision); },
        }) as T);
      },
    });
    return Object.freeze({ identity: registration.plugin, signal: lifetime.controller.signal, stateDirectory, state,
      service,
      request: (ref: ContributionReference, request: Request) => {
        assertLive();
        if (!registration.declaration.requires.some(dependency => key(dependency) === key(ref))) throw new Error("Plugin request target was not declared as a dependency");
        return this.handle(ref, request);
      },
      onDispose: (callback: () => void | Promise<void>) => { assertLive(); if (typeof callback !== "function") throw new Error("Invalid plugin disposer"); lifetime.callbacks.push(callback); },
    });
  }
  private track<T>(promise: Promise<T>): Promise<T> {
    this.#inFlight.add(promise); void promise.then(() => this.#inFlight.delete(promise), () => this.#inFlight.delete(promise)); return promise;
  }
  private bindServices(id: string, consumerId: string, signal: AbortSignal, assertLive: () => void): ExtensionContext["service"] {
    const registration = this.#registrations.get(id)!;
    const resolve = this.#services!.bind(consumerId, { plugin: registration.plugin, contribution: {
      kind: registration.declaration.kind, id: registration.declaration.id, version: registration.declaration.version,
    } }, signal, name => {
      assertLive();
      if (!registration.declaration.services.includes(name) || !this.#options!.grants?.[registration.plugin.name]?.includes(name)) throw new Error(`Plugin service access denied: ${name}`);
    });
    return resolve as ExtensionContext["service"];
  }
  private async dispose(id: string, deferStateClose = false): Promise<void> {
    const context = this.#contexts.get(id); if (!context || !context.accepting) return;
    context.accepting = false; context.controller.abort(); const errors: unknown[] = [];
    for (const callback of context.callbacks.splice(0).reverse()) { try { await callback(); } catch (error) { errors.push(error); } }
    try { await this.#services?.closeConsumer(id); } catch (error) { errors.push(error); }
    if (!deferStateClose) context.finished = true;
    if (errors.length) throw new AggregateError(errors, "Plugin contribution cleanup failed");
  }
  stop(): Promise<void> {
    if (this.#closing) return this.#closing;
    const closing = Promise.withResolvers<void>(); this.#closing = closing.promise;
    void this.stopContributions().then(closing.resolve, closing.reject); return closing.promise;
  }
  private async stopContributions(): Promise<void> {
    this.#closed = true; this.#removeAbortListener?.();
    this.#services?.stopAdmission();
    for (const context of this.#contexts.values()) context.controller.abort();
    // Startup callbacks observe cancellation and finish before their resources are disposed.
    await this.#starting?.catch(() => undefined);
    const errors: unknown[] = [];
    for (const id of [...this.#order].reverse()) {
      const state = this.#states.get(id)!; if (state.status === "failed") continue;
      state.status = "draining";
      if (state.kind === "channel") for (const [connection, provider] of this.#connections) if (provider === id) { try { await connection.close(); } catch (error) { errors.push(error); } }
      try { await this.dispose(id, true); state.status = "stopped"; } catch (error) { state.status = "failed"; state.error = message(error); errors.push(error); }
    }
    await Promise.allSettled([...this.#inFlight]);
    for (const connection of [...this.#connections.keys()]) { try { await connection.close(); } catch (error) { errors.push(error); } }
    try { await this.#services?.close(); } catch (error) { errors.push(error); }
    for (const context of this.#contexts.values()) context.finished = true;
    for (const state of this.#states.values()) if (state.status === "registered") state.status = "stopped";
    if (errors.length) throw new AggregateError(errors, "Plugin extension shutdown failed");
  }

}
function message(error: unknown): string { return error instanceof Error ? `${error.message}${error instanceof AggregateError ? `: ${error.errors.map(String).join("; ")}` : ""}` : String(error); }
