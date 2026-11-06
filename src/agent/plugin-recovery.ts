import type { AgentPluginOptions } from "./plugins";
import type { AdapterPluginIdentity } from "./domain";
import { pluginGenerationKey } from "./plugin-generations";
import { loadPlugins } from "../services/plugins/loader";
import { resolveRetainedPlugin, assertPinnedPluginContributions } from "./plugin-recovery-selection";
import { PluginRecoveryError, type PluginRecoveryCode, type PluginRecoveryPhase } from "./plugin-recovery-error";
import type { PluginReferenceInventory, PluginReferenceReport } from "./plugin-references";

export type PluginRecoveryDiagnostic = { code: PluginRecoveryCode; phase: PluginRecoveryPhase; retryable: false; plugin?: AdapterPluginIdentity };
export type PluginRecoveryReport = {
  version: 1;
  scope: "local-plugin-recovery";
  status: "local-checks-passed" | "issues-found";
  references: PluginReferenceReport;
  diagnostics: PluginRecoveryDiagnostic[];
  generations: Array<{ key: string; plugin: AdapterPluginIdentity; load: boolean; status: "local-checks-passed" | "issues-found"; diagnostics: PluginRecoveryDiagnostic[] }>;
  unchecked: string[];
};

/** No factory, migration, connection, approval or state write is performed here. */
export async function inspectPluginRecovery(options: AgentPluginOptions, historyRoot: string | undefined, inventory: PluginReferenceInventory,
  references: PluginReferenceReport, signal: AbortSignal): Promise<PluginRecoveryReport> {
  signal.throwIfAborted();
  const evidence = structuredClone(references);
  for (const generation of evidence.generations) for (const implementation of generation.implementations) delete implementation.error;
  const report: PluginRecoveryReport = { version: 1, scope: "local-plugin-recovery", status: "local-checks-passed", references: evidence, diagnostics: [], generations: [],
    unchecked: ["factory-initialization-and-registration", "configuration-and-state-migrations", "current-resource-authorization", "credentials-and-remote-services", "transcripts-and-operation-reconciliation"] };
  if (references.inventory.domains !== "complete" || references.inventory.channels !== "complete") report.diagnostics.push({ code: "PLUGIN_INVENTORY_INCOMPLETE", phase: "inventory", retryable: false });
  let discovered: Awaited<ReturnType<typeof loadPlugins>>;
  try { discovered = await loadPlugins(options.roots, options.enabled, { trustStorePath: options.trustStorePath, includeDisabled: true, blockedFingerprints: options.blockedFingerprints }); }
  catch { signal.throwIfAborted(); report.diagnostics.push({ code: "PLUGIN_CHECK_FAILED", phase: "selection", retryable: false }); report.status = "issues-found"; return report; }
  signal.throwIfAborted();
  const all = [...(inventory.generationReferences ?? []), ...(inventory.channelReferences ?? [])];
  for (const generation of references.generations) {
    signal.throwIfAborted();
    const row: PluginRecoveryReport["generations"][number] = { key: generation.key, plugin: generation.plugin, load: generation.load, status: "local-checks-passed", diagnostics: [] };
    try {
      if (!historyRoot) throw new PluginRecoveryError("PLUGIN_HISTORY_UNAVAILABLE", "archive", "No private plugin history directory is configured");
      const refs = all.filter(ref => pluginGenerationKey(ref.plugin) === generation.key);
      const retained = await resolveRetainedPlugin(options, historyRoot, generation.plugin, refs, discovered);
      signal.throwIfAborted();
      const current = discovered.plugins.some(plugin => plugin.name === generation.plugin.name && plugin.version === generation.plugin.version && plugin.fingerprint === generation.plugin.fingerprint)
        || retained.builtin && options.builtins?.some(plugin => pluginGenerationKey(plugin.identity) === generation.key);
      await assertPinnedPluginContributions(retained.plugin, refs, !current);
      signal.throwIfAborted();
    } catch (error) {
      signal.throwIfAborted();
      row.status = "issues-found";
      // Do not echo manifest JSON, arbitrary parser messages or plugin-supplied content.
      row.diagnostics.push({ code: error instanceof PluginRecoveryError ? error.code : "PLUGIN_CHECK_FAILED", phase: error instanceof PluginRecoveryError ? error.phase : "selection", retryable: false, plugin: generation.plugin });
    }
    report.generations.push(row);
  }
  if (report.diagnostics.length || report.generations.some(row => row.status === "issues-found")) report.status = "issues-found";
  return report;
}
