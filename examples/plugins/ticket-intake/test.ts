import { expect, test } from "bun:test";
import { createServiceRef } from "@tnb/plugin-sdk";
import { createPluginTestHost, provideService } from "@tnb/plugin-sdk/testing";

test("configured process intake, idempotent restart and independent Agent execution", async () => {
  let calls = 0;
  const ref = createServiceRef<{ classify(queue: string, text: string): Promise<{ category: string } | null> }>({ id: "example.support", version: 1, scope: "contribution", methods: { classify: true } });
  const host = await createPluginTestHost({ packageDirectory: "package",
    configuration: { "ticket-intake": { "application:ticket-intake@1": { version: 1, value: { queue: "support" } } } },
    serviceGrants: { "ticket-intake": [ref.name] },
    serviceProviders: [provideService(ref, () => ({ async classify(_queue, text) { calls++; return text === "No category" ? null : { category: "billing" }; } }))],
  });
  const submit = (text = "Billing question", id = "ticket-1") => host.request({ kind: "application", id: "ticket-intake", version: "1" }, new Request("http://plugin/tickets", { method: "POST", body: JSON.stringify({ id, text }) }));
  try {
    expect(await (await submit()).json()).toEqual({ id: "ticket-1", queue: "support", classification: { category: "billing" } });
    await host.restart(); expect((await submit()).status).toBe(200); expect(calls).toBe(1);
    expect((await submit("Different ticket")).status).toBe(409);
    expect((await (await submit("No category", "ticket-2")).json()).classification).toBe(null);
    expect((await submit("No category", "ticket-2")).status).toBe(200); expect(calls).toBe(2);
    if (process.platform !== "win32") {
      const { run } = await host.submit({ commandId: "review-1", namespace: "support", objective: "Review the ticket with evidence", adapter: {
        id: "ticket-review", version: "1", config: { ticket: "Billing question" }, resources: [{ id: "ticket:1", mode: "read" }],
        grants: [{ name: "ticket.read", mode: "read", resources: ["ticket:1"] }],
      } });
      const result = await host.wait(run.runId); expect(result.run.status).toBe("succeeded"); expect(JSON.stringify(result.result)).toContain("Billing question");
    }
  } finally { await host.close(); }
});
