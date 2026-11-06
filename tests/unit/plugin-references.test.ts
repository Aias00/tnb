import { expect, test } from "bun:test";
import { pluginReferenceReport } from "../../src/agent/plugin-references";
import { pluginGenerationKey } from "../../src/agent/plugin-generations";

const plugin = { name: "mixed", version: "1.0.0", fingerprint: "a".repeat(64) };
const collection = { phase: "startup", status: "completed" } as const;
test("retention combines terminal evidence, live task overrides and disabled Sources for an exact identity", () => {
  const report = pluginReferenceReport({ generationReferences: [
    { plugin, adapter: { id: "domain", version: "1" }, runId: "terminal", load: false },
    { plugin, adapter: { id: "domain", version: "1" }, runId: "live", taskId: "child", load: true },
  ], channelReferences: [{ plugin, channel: { id: "chat", version: "1" }, owner: "collaboration", key: "disabled", load: false }] }, [
    { ...plugin, root: "history", enabled: true, trust: "trusted", status: "active", generation: "retained" },
    { ...plugin, version: "2.0.0", root: "other", enabled: true, trust: "trusted", status: "failed" },
  ], collection);
  expect(report.inventory).toEqual({ domains: "complete", channels: "complete" });
  expect(report.generations).toHaveLength(1);
  expect(report.generations[0]).toMatchObject({ key: pluginGenerationKey(plugin), retain: true, load: true,
    references: [{ kind: "run", runId: "terminal", load: false }, { kind: "task", taskId: "child", load: true }, { kind: "channel", key: "disabled", load: false }],
    implementations: [{ generation: "retained", status: "active" }] });
  report.generations[0]!.plugin.name = "mutated";
  expect(plugin.name).toBe("mixed");
});

test("unknown inventories are distinct from empty ones; missing implementations never erase a retention reason", () => {
  const report = pluginReferenceReport({ channelReferences: [{ plugin, channel: { id: "chat", version: "1" }, owner: "collaboration", key: "removed", load: false }] }, [],
    { phase: "startup", status: "disabled", reason: "incomplete-inventory" });
  expect(report.inventory).toEqual({ domains: "unknown", channels: "complete" });
  expect(report.generations[0]).toMatchObject({ retain: true, load: false, implementations: [] });
  expect(pluginReferenceReport({ generationReferences: [] }, [], collection).inventory).toEqual({ domains: "complete", channels: "unknown" });
  expect(pluginReferenceReport({}, [], collection).inventory).toEqual({ domains: "unknown", channels: "unknown" });
});
