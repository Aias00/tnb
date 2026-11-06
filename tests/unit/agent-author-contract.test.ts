import { expect, test } from "bun:test";
import { defineAgent, type AgentDefinition } from "../../src/plugin-sdk/agent";
import type { DomainContext } from "../../src/agent/domain";
import { DomainRegistry } from "../../src/agent/domain";
import { validateAgentTaskInput } from "../../src/agent/execution";
import { DurableRuntime } from "../../src/services/runtime/engine-core";
import { RuntimeStore } from "../../src/services/runtime/store";

test("author context strips Coding flags and host paths, while descriptor schema validates before execution", async () => {
  let received: unknown;
  const definition: AgentDefinition = { id: "business", version: "1",
    configuration: { type: "object", properties: { message: { type: "string", minLength: 1 } }, required: ["message"], additionalProperties: false },
    async snapshot(context) { received = context; context.descriptor.config = null; return null; },
    async createWorker() { throw new Error("Not used"); }, async accept() { return { checks: [] }; },
  };
  const adapter = defineAgent(definition);
  expect(() => adapter.validate({ message: "ok", allowShell: true })).toThrow();
  adapter.validate({ message: "ok" });
  const context = { namespace: "support", signal: new AbortController().signal, run: {}, task: {}, stateRoot: "/host/private",
    descriptor: { id: "business", version: "1", config: { message: "ok" }, resources: [], grants: [] },
    configuration: { maxTurns: 10, maxRetries: 1, compactThreshold: 1000, maxModelRequests: 32, workspace: "/private", allowShell: true, checks: ["private command"] },
  } as unknown as DomainContext;
  await adapter.snapshot(context);
  expect(Object.keys(received as object).sort()).toEqual(["descriptor", "execution", "namespace", "run", "signal", "task"]);
  expect((received as any).execution).toEqual({ maxTurns: 10, maxRetries: 1, compactThreshold: 1000, maxModelRequests: 32 });
  expect(context.descriptor.config).toEqual({ message: "ok" });
});

test("async validators cannot silently escape the synchronous admission contract", () => {
  const adapter = defineAgent({ id: "business", version: "1", configuration: { type: "null" },
    async validate() { throw new Error("late validation failure"); }, async snapshot() { return null; },
    async createWorker() { throw new Error("unused"); }, async accept() { return { checks: [] }; } });
  expect(() => adapter.validate(null)).toThrow("synchronous");
});

test("catalog exposes copied current schemas and provenance, while retained code remains recovery-only", () => {
  const adapter = defineAgent({ id: "business", version: "1", configuration: { type: "null" }, async snapshot() { return null; }, async createWorker() { throw new Error("unused"); }, async accept() { return { checks: [] }; } });
  const current = { name: "business-plugin", version: "2", fingerprint: "a".repeat(64) }, old = { ...current, version: "1", fingerprint: "b".repeat(64) };
  const registry = new DomainRegistry([], [{ adapter, plugin: current }, { adapter, plugin: old, recoveryOnly: true }]);
  expect(registry.catalog()).toEqual([{ id: "business", version: "1", submission: "domain", plugin: current, configurationSchema: { type: "null" } }]);
  expect(() => new DomainRegistry([{ ...adapter, configurationSchema: null as any }])).toThrow();
  registry.catalog()[0]!.configurationSchema!.type = "string";
  expect(registry.catalog()[0]!.configurationSchema!.type).toBe("null");
});

test("neutral submission rejects unknown fields, malformed limits and authority outside resource claims", () => {
  const task = { commandId: "new", objective: "Read", namespace: "support", adapter: { id: "business", version: "1", config: null,
    resources: [{ id: "ticket:1", mode: "read" }], grants: [{ name: "ticket.read", mode: "read", resources: ["ticket:1"] }] } };
  expect(validateAgentTaskInput(task).namespace).toBe("support");
  for (const override of [{ allowShell: true }, { maxTurns: 0 }, { maxRetries: 11 }, { maxModelRequests: 3 }, { compactThreshold: 0 }, { maxCostUsd: Infinity }, { mode: "unknown" }]) {
    expect(() => validateAgentTaskInput({ ...task, ...override })).toThrow();
  }
  expect(() => validateAgentTaskInput({ ...task, adapter: { ...task.adapter, grants: [{ name: "ticket.read", mode: "write", resources: ["ticket:1"] }] } })).toThrow("exceeds");
});

test("the product domain route cannot select a host adapter or let normalization change its scope", async () => {
  for (const policy of [{ legacyDescriptor() { throw new Error("unused"); } }, { async normalize(config: any) { config.workspace = "agent:other"; config.allowedWorkspaces = [config.workspace]; } }]) {
    const store = new RuntimeStore(":memory:");
    const adapter = { id: "business", version: "1", runtime: policy, validate() {}, async snapshot() { return null; }, async createWorker(): Promise<never> { throw new Error("must not execute"); }, async accept() { return { checks: [] }; } };
    const runtime = new DurableRuntime(store, "/unused", new DomainRegistry([adapter]));
    try {
      const error = await runtime.submitDomain({ commandId: "guard", objective: "Read", namespace: "support", adapter: { id: "business", version: "1", config: null, resources: [{ id: "r", mode: "read" }], grants: [] } }, { domainOnly: true }).then(() => null, error => error);
      expect(error).toBeInstanceOf(Error); expect(store.runs()).toEqual([]);
    } finally { await runtime.close(); store.close(); }
  }
});
