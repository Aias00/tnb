import type { AdapterPluginIdentity } from "./domain";
import type { ContributionReference } from "./extensions";

export type ServiceScope = "host" | "contribution";
type Methods<T> = { readonly [K in keyof T]: T[K] extends (...args: any[]) => any ? true : never };
declare const serviceType: unique symbol;
export type ServiceRef<T extends object> = {
  readonly id: string; readonly version: number; readonly name: string; readonly scope: ServiceScope;
  readonly methods: Methods<T>;
  readonly [serviceType]?: (value: T) => T;
};
type AnyRef = ServiceRef<any>;
export type ServiceConsumer = { readonly plugin: Readonly<AdapterPluginIdentity>; readonly contribution: Readonly<ContributionReference> };
export type ServiceFactoryContext = {
  readonly signal: AbortSignal;
  /** Host-scoped providers never receive a shorter-lived consumer identity. */
  readonly consumer?: Readonly<ServiceConsumer>;
  assertActive(): void;
  /** Admit and track asynchronous work performed through a nested business handle. */
  track<T>(operation: () => Promise<T>): Promise<T>;
  service<T extends object>(ref: ServiceRef<T>): T;
  onDispose(callback: () => void | Promise<void>): void;
};
export type ServiceProvider<T extends object = any> = {
  readonly ref: ServiceRef<T>;
  readonly requires?: readonly AnyRef[];
  /** Synchronously create an interface; open asynchronous resources through its methods. */
  create(context: ServiceFactoryContext): T;
};
export class PluginServiceError extends Error {
  constructor(readonly code: "SERVICE_UNAVAILABLE" | "SERVICE_CONTRACT_MISMATCH" | "SERVICE_DEPENDENCY" | "SERVICE_SCOPE_ENDED" | "SERVICE_FACTORY_INVALID", readonly service: string, detail: string) {
    super(`${code}: ${service}: ${detail}`); this.name = "PluginServiceError";
  }
}

export function createServiceRef<T extends object>(input: { id: string; version: number; scope: ServiceScope; methods: Methods<T> }): ServiceRef<T> {
  const ref = { ...input, name: `${input.id}/v${input.version}`, methods: Object.freeze({ ...input.methods }) };
  signature(ref); return Object.freeze(ref);
}
export function provideService<T extends object>(ref: ServiceRef<T>, create: ServiceProvider<T>["create"], requires: readonly AnyRef[] = []): ServiceProvider<T> {
  return Object.freeze({ ref, create, requires: Object.freeze([...requires]) });
}
function signature(ref: AnyRef): string {
  if (!ref || typeof ref.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(ref.id)
    || !Number.isSafeInteger(ref.version) || ref.version < 1 || ref.version > 999
    || ref.name !== `${ref.id}/v${ref.version}` || !["host", "contribution"].includes(ref.scope)
    || !ref.methods || typeof ref.methods !== "object" || Array.isArray(ref.methods)) throw new Error("Invalid plugin service reference");
  const methods = Object.keys(ref.methods).sort();
  if (!methods.length || methods.length > 32 || methods.some(name => !/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(name)
    || ["constructor", "prototype", "__proto__", "then"].includes(name) || ref.methods[name] !== true)) throw new Error("Invalid plugin service methods");
  return JSON.stringify([ref.id, ref.version, ref.scope, methods]);
}
type Instance = { provider: ServiceProvider; methods?: Record<string, (...args: any[]) => any>; failure?: Error; callbacks: Array<() => void | Promise<void>> };
type Owner = { controller: AbortController; signal: AbortSignal; consumer?: Readonly<ServiceConsumer>; instances: Map<string, Instance>;
  sourceSignal?: AbortSignal; pending: Set<Promise<unknown>>; cleanups: Set<Promise<void>>; errors: unknown[]; closing?: Promise<void> };

/** Host-selected provider graph. It never lets a plugin register or replace a provider. */
export class PluginServiceRegistry {
  readonly #providers = new Map<string, ServiceProvider>();
  readonly #failures = new Map<string, Error>();
  readonly #owners = new Map<string, Owner>();
  readonly #controller = new AbortController();
  readonly #host: Owner;
  #closed = false;
  #closing?: Promise<void>;
  constructor(providers: readonly ServiceProvider[] = [], readonly legacy: ReadonlyMap<string, unknown> = new Map()) {
    if (providers.length > 128) throw new Error("Plugin service provider capacity exceeded");
    this.#host = this.owner();
    for (const item of providers) {
      signature(item.ref);
      if (this.#providers.has(item.ref.name) || legacy.has(item.ref.name)) throw new Error(`Duplicate plugin service provider: ${item.ref.name}`);
      const ref = createServiceRef(item.ref), requires = (item.requires ?? []).map(dependency => { signature(dependency); return createServiceRef(dependency); });
      if (requires.length > 32 || new Set(requires.map(ref => ref.name)).size !== requires.length || typeof item.create !== "function") throw new Error("Invalid plugin service provider");
      this.#providers.set(ref.name, { ref, requires, create: item.create.bind(item) });
      if (item.create.constructor.name === "AsyncFunction") this.#failures.set(ref.name, new PluginServiceError("SERVICE_FACTORY_INVALID", ref.name, "async factories are unsupported; open resources through methods"));
    }
    const visited = new Set<string>(), visiting = new Set<string>();
    const visit = (name: string): void => {
      if (this.#failures.has(name)) throw this.#failures.get(name);
      if (visited.has(name)) return;
      const row = this.#providers.get(name)!;
      try {
        if (visiting.has(name)) throw new PluginServiceError("SERVICE_DEPENDENCY", name, "dependency cycle");
        visiting.add(name);
        for (const ref of row.requires ?? []) {
          const dependency = this.#providers.get(ref.name);
          if (!dependency) throw new PluginServiceError("SERVICE_DEPENDENCY", name, `missing ${ref.name}`);
          this.match(ref, dependency.ref);
          if (row.ref.scope === "host" && ref.scope !== "host") throw new PluginServiceError("SERVICE_DEPENDENCY", name, `host scope cannot depend on ${ref.name} contribution scope`);
          visit(ref.name);
        }
        visited.add(name);
      } catch (error) { const failure = error instanceof Error ? error : new Error(String(error)); this.#failures.set(name, failure); throw failure; }
      finally { visiting.delete(name); }
    };
    for (const name of this.#providers.keys()) { try { visit(name); } catch { /* Unrelated contributions can still start. */ } }
  }
  has(name: string): boolean { return this.#providers.has(name) || this.legacy.has(name); }
  assertAvailable(name: string): void {
    if (!this.has(name)) throw new PluginServiceError("SERVICE_UNAVAILABLE", name, "no host provider");
    if (this.#failures.has(name)) throw this.#failures.get(name);
  }
  bind(id: string, consumer: ServiceConsumer, signal: AbortSignal, assertAllowed: (name: string) => void) {
    if (this.#closed || signal.aborted) throw new PluginServiceError("SERVICE_SCOPE_ENDED", "scope", "service lifetime ended");
    let owner = this.#owners.get(id);
    if (owner && (owner.sourceSignal !== signal || JSON.stringify(owner.consumer) !== JSON.stringify(consumer))) throw new Error("Plugin service consumer identity changed within a scope");
    if (!owner) { owner = this.owner(consumer, signal); this.#owners.set(id, owner); }
    const target = owner;
    return <T extends object>(reference: string | ServiceRef<T>): T => {
      this.assertLive(target); const name = typeof reference === "string" ? reference : reference.name; assertAllowed(name);
      const provider = this.#providers.get(name);
      if (!provider) {
        if (typeof reference !== "string" && this.legacy.has(name)) throw new PluginServiceError("SERVICE_CONTRACT_MISMATCH", name, "legacy value has no typed provider; explicitly adapt it on the host");
        this.assertAvailable(name); return this.legacy.get(name) as T;
      }
      if (typeof reference !== "string") this.match(reference, provider.ref);
      this.assertAvailable(name);
      const instanceOwner = provider.ref.scope === "host" ? this.#host : target;
      return this.facade(this.instance(provider, instanceOwner), instanceOwner, target, () => assertAllowed(name)) as T;
    };
  }
  stopAdmission(): void { this.#closed = true; this.#controller.abort(); }
  closeConsumer(id: string): Promise<void> {
    const owner = this.#owners.get(id); if (!owner) return Promise.resolve();
    const closing = this.closeOwner(owner);
    void closing.then(() => { if (this.#owners.get(id) === owner) this.#owners.delete(id); }, () => {});
    return closing;
  }
  close(): Promise<void> {
    if (!this.#closing) {
      this.stopAdmission();
      this.#closing = (async () => {
        const results = await Promise.allSettled([...this.#owners.values()].reverse().map(owner => this.closeOwner(owner)));
        results.push(...await Promise.allSettled([this.closeOwner(this.#host)]));
        const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
        if (failures.length) throw new AggregateError(failures, "Plugin service cleanup failed");
      })();
    }
    return this.#closing;
  }
  private owner(consumer?: ServiceConsumer, signal?: AbortSignal): Owner {
    const controller = new AbortController();
    return { controller, signal: AbortSignal.any([controller.signal, this.#controller.signal, ...(signal ? [signal] : [])]),
      sourceSignal: signal,
      ...(consumer ? { consumer: Object.freeze({ plugin: Object.freeze({ ...consumer.plugin }), contribution: Object.freeze({ ...consumer.contribution }) }) } : {}),
      instances: new Map(), pending: new Set(), cleanups: new Set(), errors: [] };
  }
  private assertLive(owner: Owner): void {
    if (this.#closed || owner.signal.aborted) throw new PluginServiceError("SERVICE_SCOPE_ENDED", "scope", "service lifetime ended");
  }
  private match(requested: AnyRef, provided: AnyRef): void {
    if (signature(requested) !== signature(provided)) throw new PluginServiceError("SERVICE_CONTRACT_MISMATCH", provided.name, "id, version, scope or methods differ");
  }
  private instance(provider: ServiceProvider, owner: Owner): Instance {
    this.assertLive(owner); this.assertAvailable(provider.ref.name);
    const previous = owner.instances.get(provider.ref.name);
    if (previous) { if (previous.failure) throw previous.failure; if (!previous.methods) throw new PluginServiceError("SERVICE_DEPENDENCY", provider.ref.name, "reentrant factory"); return previous; }
    const instance: Instance = { provider, callbacks: [] }; owner.instances.set(provider.ref.name, instance);
    const context: ServiceFactoryContext = Object.freeze({ signal: owner.signal, ...(owner.consumer ? { consumer: owner.consumer } : {}),
      assertActive: () => this.assertLive(owner),
      track: <T>(operation: () => Promise<T>): Promise<T> => {
        this.assertLive(owner);
        const pending = Promise.resolve().then(() => { this.assertLive(owner); return operation(); });
        this.monitor(pending, [owner]); return pending;
      },
      service: <T extends object>(ref: ServiceRef<T>): T => {
        this.assertLive(owner);
        const declared = provider.requires?.find(item => item.name === ref.name);
        if (!declared) throw new PluginServiceError("SERVICE_DEPENDENCY", provider.ref.name, `undeclared ${ref.name}`);
        this.match(ref, declared); const dependency = this.#providers.get(ref.name)!;
        const dependencyOwner = ref.scope === "host" ? this.#host : owner;
        return this.facade(this.instance(dependency, dependencyOwner), dependencyOwner, owner) as T;
      },
      onDispose: (callback: () => void | Promise<void>) => { this.assertLive(owner); if (instance.failure || typeof callback !== "function") throw new Error("Invalid or failed service disposer registration"); instance.callbacks.push(callback); },
    });
    try {
      const value = provider.create(context) as Record<string, unknown>;
      if (!value || typeof value !== "object" || typeof value.then === "function") {
        if (value && typeof value.then === "function") this.monitor(Promise.resolve(value), [owner]);
        throw new PluginServiceError("SERVICE_FACTORY_INVALID", provider.ref.name, "factory must synchronously return a method interface");
      }
      const methods: Record<string, (...args: any[]) => any> = Object.create(null);
      for (const name of Object.keys(provider.ref.methods)) {
        const method = value[name];
        if (typeof method !== "function") throw new PluginServiceError("SERVICE_FACTORY_INVALID", provider.ref.name, `missing method ${name}`);
        methods[name] = method.bind(value);
      }
      instance.methods = methods;
    } catch (error) {
      instance.failure = error instanceof Error ? error : new Error(String(error));
      const cleanup = this.cleanup(instance).catch(error => { owner.errors.push(error); }); owner.cleanups.add(cleanup);
      void cleanup.finally(() => owner.cleanups.delete(cleanup));
      throw instance.failure;
    } finally {
      // Dependants dispose before the dependencies they acquired during creation.
      owner.instances.delete(provider.ref.name); owner.instances.set(provider.ref.name, instance);
    }
    return instance;
  }
  private facade(instance: Instance, providerOwner: Owner, consumerOwner: Owner, assertAllowed = () => {}): object {
    const result: Record<string, (...args: any[]) => any> = Object.create(null);
    for (const [name, method] of Object.entries(instance.methods!)) result[name] = (...args) => {
      this.assertLive(consumerOwner); this.assertLive(providerOwner); assertAllowed();
      const value = method(...args);
      if (!value || typeof value.then !== "function") return value;
      const pending = Promise.resolve(value);
      this.monitor(pending, [consumerOwner, providerOwner]);
      return pending;
    };
    return Object.freeze(result);
  }
  private monitor(pending: Promise<unknown>, owners: Owner[]): void {
    for (const owner of new Set(owners)) {
      owner.pending.add(pending); void pending.then(() => owner.pending.delete(pending), () => owner.pending.delete(pending));
    }
  }
  private async cleanup(instance: Instance): Promise<void> {
    const errors: unknown[] = [];
    for (const callback of instance.callbacks.splice(0).reverse()) { try { await callback(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, "Plugin service instance cleanup failed");
  }
  private closeOwner(owner: Owner): Promise<void> {
    return owner.closing ??= (async () => {
      owner.controller.abort(); await Promise.allSettled([...owner.pending, ...owner.cleanups]);
      const errors = [...owner.errors];
      const ordered: Instance[] = [], visited = new Set<string>();
      const visit = (instance: Instance) => {
        if (visited.has(instance.provider.ref.name)) return;
        visited.add(instance.provider.ref.name);
        for (const dependency of instance.provider.requires ?? []) { const value = owner.instances.get(dependency.name); if (value) visit(value); }
        ordered.push(instance);
      };
      for (const instance of owner.instances.values()) visit(instance);
      for (const instance of ordered.reverse()) { try { await this.cleanup(instance); } catch (error) { errors.push(error); } }
      if (errors.length) throw new AggregateError(errors, "Plugin service scope cleanup failed");
    })();
  }
}
