import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DomainRegistry, validateDomainDescriptor, type DomainDescriptor, type AgentDomainAdapter } from "../../src/agent/domain";
import { tryAcquireResources } from "../../src/services/runtime/resources";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function directory() { const path = await mkdtemp(join(tmpdir(), "tnb-domain-resources-")); roots.push(path); return path; }
const descriptor = (): DomainDescriptor => ({ id: "fixture", version: "1", config: {}, resources: [{ id: "account/document", mode: "read" }], grants: [{ name: "read.document", resources: ["account/document"], mode: "read" }] });
test("persisted adapter descriptors reject executable config and permission escalation", () => {
  const value = descriptor();
  expect(validateDomainDescriptor(value)).toEqual(value);
  value.grants[0]!.mode = "write"; expect(() => validateDomainDescriptor(value)).toThrow("exceeds resource");
  value.grants = []; (value as unknown as { config: unknown }).config = { callback() {} };
  expect(() => validateDomainDescriptor(value)).toThrow("JSON");
  expect(() => new DomainRegistry().resolve(descriptor())).toThrow("pinned version");
  const sparse = descriptor(); sparse.config = Array(2);
  expect(() => validateDomainDescriptor(sparse)).toThrow("JSON");
});
test("plugin provenance cannot be acquired during recovery or fall back to an inline adapter", () => {
  const adapter: AgentDomainAdapter = { id: "fixture", version: "1", validate() {}, async snapshot() { return {}; },
    async createWorker(): Promise<never> { throw new Error("unused"); }, async accept() { return { checks: [{ command: "test", output: "ok" }] }; } };
  const identity = { name: "fixture-plugin", version: "1.0.0", fingerprint: "a".repeat(64) };
  const registry = new DomainRegistry([], [{ adapter, plugin: identity }]);
  expect(() => registry.resolve(descriptor())).toThrow("identity changed");
  const pinned = registry.prepare(descriptor()); expect(pinned.plugin).toEqual(identity);
  expect(registry.resolve(pinned).id).toBe("fixture");
  expect(() => new DomainRegistry([adapter]).resolve(pinned)).toThrow("identity changed");
  expect(() => validateDomainDescriptor({ ...descriptor(), plugin: null } as unknown as DomainDescriptor)).toThrow("plugin identity");
});
test("retained generations resolve exact pins without becoming defaults, and children can retain their parent's generation", () => {
  const adapter: AgentDomainAdapter = { id: "fixture", version: "1", validate() {}, async snapshot() { return {}; },
    async createWorker(): Promise<never> { throw new Error("unused"); }, async accept() { return { checks: [] }; } };
  const current = { name: "fixture-plugin", version: "1.0.0", fingerprint: "b".repeat(64) }, old = { ...current, fingerprint: "a".repeat(64) };
  const registry = new DomainRegistry([], [{ adapter, plugin: old, recoveryOnly: true }, { adapter, plugin: current }]);
  expect(registry.prepare(descriptor()).plugin).toEqual(current);
  const pinned = { ...descriptor(), plugin: old };
  expect(registry.resolve(pinned).id).toBe("fixture");
  expect(() => registry.prepare(pinned)).toThrow("recovery only");
  expect(registry.prepare(pinned, true).plugin).toEqual(old);
  const recovery = new DomainRegistry([], [{ adapter, plugin: old, recoveryOnly: true }]);
  expect(recovery.has("fixture", "1")).toBe(false);
  expect(() => recovery.prepare(descriptor())).toThrow("unavailable");
  expect(recovery.resolve(pinned).id).toBe("fixture");
  expect(() => new DomainRegistry([], [{ adapter, plugin: old }, { adapter, plugin: current }])).toThrow("Duplicate");
});
test("resource admission atomically allows readers, excludes writers and rolls back partial admission", async () => {
  const directoryPath = await directory(), id = randomUUID();
  const first = tryAcquireResources([{ id, mode: "read" }], directoryPath)!;
  const second = tryAcquireResources([{ id, mode: "read" }], directoryPath)!;
  try {
    expect(second).toBeDefined(); expect(tryAcquireResources([{ id, mode: "write" }], directoryPath)).toBeUndefined();
    expect(tryAcquireResources([{ id: "free", mode: "write" }, { id, mode: "write" }], directoryPath)).toBeUndefined();
    const free = tryAcquireResources([{ id: "free", mode: "write" }], directoryPath); expect(free).toBeDefined(); free!();
  } finally { second(); first(); }
  const writer = tryAcquireResources([{ id, mode: "write" }], directoryPath)!;
  try { expect(tryAcquireResources([{ id, mode: "read" }], directoryPath)).toBeUndefined(); } finally { writer(); }
});
test.skipIf(process.platform === "win32")("resource leases from a killed process are reclaimed without replaying work", async () => {
  const directoryPath = await directory(), id = randomUUID();
  const module = new URL("../../src/services/runtime/resources.ts", import.meta.url).href;
  const script = `import { tryAcquireResources } from ${JSON.stringify(module)}; const release=tryAcquireResources([{id:process.env.RESOURCE_ID,mode:'write'}],process.env.RESOURCE_DIRECTORY);if(!release)throw new Error('busy');process.stdout.write('held\\n');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["-e", script], { env: { ...process.env, RESOURCE_ID: id, RESOURCE_DIRECTORY: directoryPath }, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Resource child did not acquire lease")), 3000);
      child.stdout.once("data", () => { clearTimeout(timer); resolve(); }); child.once("error", reject); child.once("exit", () => { clearTimeout(timer); reject(new Error("Resource child exited early")); }); });
    expect(tryAcquireResources([{ id, mode: "read" }], directoryPath)).toBeUndefined();
    child.kill("SIGKILL"); await exited;
    const next = tryAcquireResources([{ id, mode: "write" }], directoryPath); expect(next).toBeDefined(); next!();
  } finally { if (child.exitCode === null) child.kill("SIGKILL"); await exited; }
});
