import { expect, test } from "bun:test";
import { defineAgent, type AgentDefinition } from "../../src/plugin-sdk/agent";
import type { DomainContext } from "../../src/agent/domain";

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
