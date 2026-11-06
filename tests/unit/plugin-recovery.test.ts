import { expect, test } from "bun:test";
import { pluginReferenceReport } from "../../src/agent/plugin-references";
import { inspectPluginRecovery } from "../../src/agent/plugin-recovery";

test("recovery report omits arbitrary loader error text without mutating the supplied reference snapshot", async () => {
  const plugin = { name: "fixture", version: "1.0.0", fingerprint: "a".repeat(64) };
  const inventory = { generationReferences: [{ plugin, adapter: { id: "fixture", version: "1" }, runId: "run", load: true }], channelReferences: [] };
  const references = pluginReferenceReport(inventory, [{ ...plugin, root: "fixture", enabled: true, trust: "trusted", generation: "retained", status: "failed", error: "private parser content" }],
    { phase: "startup", status: "disabled", reason: "no-history-root" });
  const report = await inspectPluginRecovery({ roots: [], trustStorePath: "unused" }, undefined, inventory, references, new AbortController().signal);
  expect(report.status).toBe("issues-found");
  expect(report.generations[0]?.diagnostics[0]).toMatchObject({ code: "PLUGIN_HISTORY_UNAVAILABLE", phase: "archive", retryable: false });
  expect(JSON.stringify(report)).not.toContain("private parser content");
  expect(references.generations[0]?.implementations[0]?.error).toBe("private parser content");
});

test("unknown inventories cannot produce a successful empty preflight", async () => {
  const references = pluginReferenceReport({}, [], { phase: "startup", status: "disabled", reason: "incomplete-inventory" });
  const report = await inspectPluginRecovery({ roots: [], trustStorePath: "unused" }, undefined, {}, references, new AbortController().signal);
  expect(report.status).toBe("issues-found");
  expect(report.diagnostics[0]?.code).toBe("PLUGIN_INVENTORY_INCOMPLETE");
  expect(report.unchecked).toContain("factory-initialization-and-registration");
});
