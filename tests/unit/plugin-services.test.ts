import { afterEach, expect, test } from "bun:test";
import { createServiceRef, PluginServiceRegistry, provideService, type ServiceConsumer, type ServiceFactoryContext, type ServiceProvider } from "../../src/agent/services";
import type { ExtensionContext } from "../../src/agent/extensions";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
type Probe = { ping(value: string): string };
const ref = createServiceRef<Probe>({ id: "fixture.probe", version: 1, scope: "contribution", methods: { ping: true } });
const consumer = (id = "one"): ServiceConsumer => ({ plugin: { name: "fixture", version: "1.0.0", fingerprint: "a".repeat(64) }, contribution: { kind: "application", id, version: "1" } });
function registry(providers: readonly ServiceProvider[]) { const host = new PluginServiceRegistry(providers); cleanup.push(() => host.close()); return host; }
function bind(host: PluginServiceRegistry, id = "one", allowed = (_name: string) => {}) { return host.bind(id, consumer(id), new AbortController().signal, allowed); }

// This function is intentionally not called; tsc verifies reference inference and rejects misuse.
function compileTimeContract(context: ExtensionContext) {
  const service = context.service(ref);
  const text: string = service.ping("value");
  // @ts-expect-error the reference fixes the method's argument type
  service.ping(42);
  // @ts-expect-error the reference does not expose undeclared methods
  service.deleteEverything();
  // @ts-expect-error all typed service methods must appear in the descriptor
  createServiceRef<Probe>({ id: "bad", version: 1, scope: "host", methods: {} });
  return text;
}

test("references match structurally, publish only declared bound methods and infer the contract", () => {
  const value = { prefix: "bound:", ping(text: string) { return this.prefix + text; }, privateMethod() { throw new Error("private"); } };
  const host = registry([provideService(ref, () => value)]), resolve = bind(host);
  const separatelyCreated = createServiceRef<Probe>({ id: ref.id, version: 1, scope: "contribution", methods: { ping: true } });
  const service = resolve(separatelyCreated), ping = service.ping;
  expect(ping("ok")).toBe("bound:ok"); expect(Object.keys(service)).toEqual(["ping"]);
  expect(Object.isFrozen(service)).toBe(true); expect((service as any).privateMethod).toBeUndefined();
  expect(resolve<Probe>(ref.name).ping("legacy name")).toBe("bound:legacy name");
});

test("scope, version and method mismatches fail before executing a host factory", () => {
  let created = 0; const host = registry([provideService(ref, () => { created++; return { ping: value => value }; })]), resolve = bind(host);
  expect(() => resolve(createServiceRef<Probe>({ ...ref, scope: "host" }))).toThrow("SERVICE_CONTRACT_MISMATCH");
  expect(() => resolve(createServiceRef<{ other(): void }>({ id: ref.id, version: 1, scope: "contribution", methods: { other: true } }))).toThrow("SERVICE_CONTRACT_MISMATCH");
  expect(() => resolve(createServiceRef<Probe>({ ...ref, version: 2 }))).toThrow("SERVICE_UNAVAILABLE");
  expect(created).toBe(0);
});

test("host instances are shared but consumer identity and stale facades never escape their lifetime", async () => {
  const shared = createServiceRef<Probe>({ ...ref, id: "fixture.shared", scope: "host" });
  let created = 0, hostConsumer: unknown = "unset"; const identities: string[] = [];
  const host = registry([provideService(shared, scope => { created++; hostConsumer = scope.consumer; return { ping: value => value }; }),
    provideService(ref, scope => { identities.push(scope.consumer!.contribution.id); return { ping: () => scope.consumer!.contribution.id }; })]);
  const one = bind(host, "one"), two = bind(host, "two"), first = one(shared), second = two(shared), cached = first.ping;
  expect(one(ref).ping("")).toBe("one"); expect(two(ref).ping("")).toBe("two"); expect(identities).toEqual(["one", "two"]);
  expect(created).toBe(1); expect(hostConsumer).toBeUndefined();
  await host.closeConsumer("one"); expect(() => cached("late")).toThrow("SERVICE_SCOPE_ENDED");
  expect(second.ping("healthy")).toBe("healthy"); expect(() => one(ref)).toThrow("SERVICE_SCOPE_ENDED");
});

test("declaration/grant checks run again on cached methods and cannot be bypassed by retaining a function", () => {
  let allowed = true, calls = 0;
  const host = registry([provideService(ref, () => ({ ping: value => { calls++; return value; } }))]);
  const resolve = bind(host, "one", () => { if (!allowed) throw new Error("host denied"); }), cached = resolve(ref).ping;
  expect(cached("first")).toBe("first"); allowed = false;
  expect(() => cached("second")).toThrow("host denied"); expect(calls).toBe(1);
});

test("legacy maps remain explicitly untyped and cannot shadow typed providers", async () => {
  const raw = { ping: (value: string) => value }, provider = provideService(ref, () => raw);
  expect(() => new PluginServiceRegistry([provider, provider])).toThrow("Duplicate");
  expect(() => new PluginServiceRegistry([provider], new Map([[ref.name, raw]]))).toThrow("Duplicate");
  const host = new PluginServiceRegistry([], new Map([[ref.name, raw]])); cleanup.push(() => host.close()); const resolve = bind(host);
  expect(resolve<Probe>(ref.name)).toBe(raw);
  expect(() => resolve(ref)).toThrow("legacy value has no typed provider");
});

test("missing, cyclic and inverted scope dependencies are rejected without running factories", () => {
  const a = createServiceRef<Probe>({ ...ref, id: "fixture.a", scope: "host" }), b = createServiceRef<Probe>({ ...ref, id: "fixture.b", scope: "host" });
  let calls = 0; const create = () => { calls++; return { ping: (value: string) => value }; };
  const missing = registry([provideService(a, create, [b]), provideService(ref, create)]);
  expect(() => missing.assertAvailable(a.name)).toThrow("missing"); expect(bind(missing)(ref).ping("healthy")).toBe("healthy");
  const cyclic = registry([provideService(a, create, [b]), provideService(b, create, [a])]);
  const cyclicResolve = bind(cyclic);
  expect(() => cyclicResolve(a)).toThrow("cycle"); expect(() => cyclicResolve(b)).toThrow("cycle");
  const inverted = registry([provideService(a, create, [ref]), provideService(ref, create)]);
  expect(() => bind(inverted)(a)).toThrow("host scope cannot depend");
  expect(calls).toBe(1);
});

test("dependency acquisition is explicit and provider cleanup runs before dependency cleanup", async () => {
  const trace: string[] = [], dependency = createServiceRef<Probe>({ ...ref, id: "fixture.dependency" });
  const host = registry([provideService(dependency, scope => { scope.onDispose(() => { trace.push("dependency"); }); return { ping: value => value }; }),
    provideService(ref, scope => { const target = scope.service(dependency); scope.onDispose(() => { trace.push("consumer"); }); return { ping: value => target.ping(value) }; }, [dependency])]);
  expect(bind(host)(ref).ping("ok")).toBe("ok"); await host.close(); expect(trace).toEqual(["consumer", "dependency"]);
  let dependencyCreated = false;
  const undeclared = registry([provideService(dependency, () => { dependencyCreated = true; return { ping: value => value }; }),
    provideService(ref, scope => scope.service(dependency))]);
  expect(() => bind(undeclared)(ref)).toThrow("undeclared"); expect(dependencyCreated).toBe(false);
});

test("invalid factory results clean partial resources once and do not retry initialization", async () => {
  let created = 0; const trace: string[] = [];
  const host = registry([provideService(ref, scope => { created++; scope.onDispose(() => { trace.push("released"); }); return {} as Probe; })]), resolve = bind(host);
  expect(() => resolve(ref)).toThrow("missing method ping"); expect(() => resolve(ref)).toThrow("missing method ping");
  await host.closeConsumer("one"); expect(created).toBe(1); expect(trace).toEqual(["released"]);
});

test("service calls drain before disposal and repeated close shares the same completion", async () => {
  type Work = { work(): Promise<string> };
  const work = createServiceRef<Work>({ id: "fixture.work", version: 1, scope: "contribution", methods: { work: true } }), trace: string[] = [];
  const host = registry([provideService(work, scope => { scope.onDispose(() => { trace.push("disposed"); }); return { async work() {
    await new Promise<void>(resolve => scope.signal.addEventListener("abort", () => resolve(), { once: true })); trace.push("settled"); return "receipt";
  } }; })]);
  const cached = bind(host)(work), pending = cached.work(), close = host.close(); expect(host.close()).toBe(close);
  expect(() => cached.work()).toThrow("SERVICE_SCOPE_ENDED"); await close;
  expect(await pending).toBe("receipt"); expect(trace).toEqual(["settled", "disposed"]);
});

test("a provider ignoring cancellation retains the close barrier until its actual work finishes", async () => {
  const gate = Promise.withResolvers<string>(); let disposed = false, closed = false;
  const work = createServiceRef<{ work(): Promise<string> }>({ id: "fixture.slow", version: 1, scope: "contribution", methods: { work: true } });
  const host = registry([provideService(work, scope => { scope.onDispose(() => { disposed = true; }); return { work: () => gate.promise }; })]);
  const pending = bind(host)(work).work(), closing = host.close(); void closing.then(() => { closed = true; });
  await Bun.sleep(5); expect(closed).toBe(false); expect(disposed).toBe(false);
  gate.resolve("actual completion"); await closing; expect(await pending).toBe("actual completion"); expect(disposed).toBe(true);
});

test("consumer identities cannot be swapped under an existing live scope", () => {
  const host = registry([provideService(ref, () => ({ ping: value => value }))]), signal = new AbortController().signal;
  host.bind("same", consumer("one"), signal, () => {});
  expect(() => host.bind("same", consumer("two"), signal, () => {})).toThrow("identity changed");
});

test("all cleanup callbacks run and failures remain visible to the host", async () => {
  const trace: string[] = []; let expected = false;
  const host = new PluginServiceRegistry([provideService(ref, scope => {
    scope.onDispose(() => { trace.push("first"); }); scope.onDispose(() => { trace.push("last"); throw new Error("cleanup failed"); }); return { ping: value => value };
  })]); cleanup.push(async () => { if (!expected) await host.close(); });
  bind(host)(ref);
  await expect(host.close()).rejects.toThrow("Plugin service cleanup failed"); expected = true;
  expect(trace).toEqual(["last", "first"]);
});

test("reference definitions reject invalid identities, scopes and promise-like methods", () => {
  for (const invalid of [{ ...ref, version: 0 }, { ...ref, id: "../outside" }, { ...ref, scope: "run" }, { ...ref, methods: { then: true } }, { ...ref, methods: { ping: false } }]) {
    expect(() => createServiceRef(invalid as never)).toThrow("Invalid plugin service");
  }
});

test("native async factories fail preflight and mismatched dependency contracts cannot execute", () => {
  let effects = 0;
  const asyncProvider = provideService(ref, (async () => { effects++; return { ping: (value: string) => value }; }) as never);
  const host = registry([asyncProvider]); expect(() => bind(host)(ref)).toThrow("async factories are unsupported"); expect(effects).toBe(0);
  const dependency = createServiceRef<Probe>({ ...ref, id: "fixture.dep" }), mismatch = createServiceRef<Probe>({ ...dependency, scope: "host" });
  const invalid = registry([provideService(ref, () => { effects++; return { ping: value => value }; }, [mismatch]), provideService(dependency, () => ({ ping: value => value }))]);
  expect(() => bind(invalid)(ref)).toThrow("SERVICE_CONTRACT_MISMATCH"); expect(effects).toBe(0);
});

test("dependencies first acquired by a later method still dispose after their consumers", async () => {
  const dependency = createServiceRef<Probe>({ ...ref, id: "fixture.late" }), trace: string[] = [];
  const host = registry([provideService(dependency, scope => { scope.onDispose(() => { trace.push("dependency"); }); return { ping: value => value }; }),
    provideService(ref, scope => { scope.onDispose(() => { trace.push("consumer"); }); return { ping: value => scope.service(dependency).ping(value) }; }, [dependency])]);
  const cached = bind(host)(ref); expect(cached.ping("late dependency")).toBe("late dependency");
  await host.close(); expect(trace).toEqual(["consumer", "dependency"]);
});

test("nested asynchronous work is admitted before dispatch and joins its service owner's close barrier", async () => {
  type Nested = { open(): { work(): Promise<string> } };
  const nested = createServiceRef<Nested>({ id: "fixture.nested", version: 1, scope: "contribution", methods: { open: true } });
  const gate = Promise.withResolvers<string>(), entered = Promise.withResolvers<void>(); let closed = false, effects = 0;
  const host = registry([provideService(nested, scope => ({ open: () => ({ work: () => scope.track(async () => { effects++; entered.resolve(); return gate.promise; }) }) }))]);
  const handle = bind(host)(nested).open(), pending = handle.work(); await entered.promise;
  const close = host.close(); void close.then(() => { closed = true; });
  expect(() => handle.work()).toThrow("SERVICE_SCOPE_ENDED"); await Bun.sleep(5); expect(closed).toBe(false);
  gate.resolve("settled nested operation"); await close; expect(await pending).toBe("settled nested operation"); expect(effects).toBe(1);
  const nextHost = registry([provideService(nested, scope => ({ open: () => ({ work: () => scope.track(async () => { effects++; return "must not run"; }) }) }))]);
  const queued = bind(nextHost)(nested).open().work(); void queued.catch(() => {}); await nextHost.close();
  await expect(queued).rejects.toThrow("SERVICE_SCOPE_ENDED"); expect(effects).toBe(1);
});

test("a disguised asynchronous factory never publishes a service or bypasses the shutdown barrier", async () => {
  const gate = Promise.withResolvers<Probe>(); let closed = false;
  const host = registry([provideService(ref, (() => gate.promise) as never)]);
  expect(() => bind(host)(ref)).toThrow("SERVICE_FACTORY_INVALID");
  const closing = host.close(); void closing.then(() => { closed = true; });
  expect(() => bind(host, "after-close")).toThrow("SERVICE_SCOPE_ENDED");
  await Bun.sleep(5); expect(closed).toBe(false); gate.resolve({ ping: value => value }); await closing;
});
