import { join } from "node:path";
import { createCodingPlugin } from "../adapters/coding/plugin";
import { createChannelsPlugin } from "../plugins/channels/plugin";
import { createCollaborationPlugin, COLLABORATION_EXTENSION, CHANNEL_SERVICE } from "../plugins/collaboration/plugin";
import { loadCollaborationConfig } from "../services/collaboration/config";
import { loadSettings } from "../services/settings/load";
import { pluginTrustStorePath } from "../services/plugins/trust";
import { loadHostPlugins } from "../agent/plugins";
import type { DurableRuntime } from "../services/runtime/engine-core";
import { createWebPlugin } from "../plugins/web/plugin";
import { TASK_SERVICE } from "../agent/task-service";
import { COLLABORATION_SERVICE } from "../agent/collaboration-service";
import { createCollaborationService } from "../services/collaboration/runtime-service";
import { createTaskService } from "../services/workbench/tasks";
import { pluginGenerationReferences } from "../agent/plugin-generations";
import { RuntimeStore } from "../services/runtime/store";
import { builtinGenerationAuthority, builtinChannelGenerationAuthority } from "../agent/builtin-generations";
import { migrateCollaborationChannels, collaborationChannelReferences } from "../services/collaboration/channels";
import { createDurableCapabilityHost } from "../adapters/coding/capabilities";

/** Product composition only; the generic plugin host knows neither Coding nor collaboration. */
export async function loadDefaultProfile(options: { configDir: string; root: string; env: Record<string, string | undefined>; coding: boolean; runtime?: DurableRuntime }) {
  const { configDir, root, env } = options, settings = await loadSettings({ configDir, cwd: configDir });
  const configuration = { "tnb-coding": { configDir, env }, "tnb-channels": { env } };
  const builtins = [ ...(options.coding ? [await createCodingPlugin({ configDir, runtimeRoot: root, env })] : []), await createChannelsPlugin(env), await createCollaborationPlugin(), await createWebPlugin() ];
  // Caller holds the owner lock; collect references before importing any plugin code.
  const config = await loadCollaborationConfig(configDir);
  const referenceStore = options.runtime?.store ?? new RuntimeStore(join(root, "state.sqlite"));
  const capabilities = createDurableCapabilityHost({ configDir, env });
  let plugins;
  try {
    migrateCollaborationChannels(referenceStore);
    plugins = await loadHostPlugins({ roots: [{ directory: join(configDir, "plugins"), source: "user" }],
      trustStorePath: pluginTrustStorePath(configDir), enabled: settings.enabledPlugins, builtins, configuration, generationReferences: pluginGenerationReferences(referenceStore),
      builtinAuthority: builtinGenerationAuthority(referenceStore), builtinChannelAuthority: builtinChannelGenerationAuthority(referenceStore), channelReferences: collaborationChannelReferences(referenceStore, config),
      blockedFingerprints: settings.blockedPluginFingerprints,
      workerGuard: async (context, generation) => generation.recoveryOnly && context.descriptor.id === "coding"
        ? capabilities.guardLegacy(context.configuration, context.signal) : async () => {},
    }, [], join(root, "plugin-snapshots"));
  } finally { if (!options.runtime) referenceStore.close(); }
  return { plugins, async start(runtime: DurableRuntime, signal?: AbortSignal) {
    await plugins.extensions.start({ store: runtime.store, signal, services: new Map<string, unknown>([
      [COLLABORATION_SERVICE, createCollaborationService(runtime, config, plugins.extensions.channels, signal)], [CHANNEL_SERVICE, plugins.extensions.channels],
      [TASK_SERVICE, createTaskService({ runtime, configDir, env, coding: runtime.domains.has("coding", "1") })],
      ["tnb.runtime.read/v1", Object.freeze({ runs: () => runtime.store.runs(), status: (runId: string) => ({ run: runtime.store.getRun(runId), tasks: runtime.store.tasks(runId) }), configuration: (runId: string) => runtime.configuration(runId) })],
    ]), grants: { "tnb-collaboration": [COLLABORATION_SERVICE, CHANNEL_SERVICE], "tnb-web": [TASK_SERVICE], ...settings.pluginServices } });
    if (config.enabled && settings.enabledPlugins?.["tnb-collaboration"] !== false) {
      const state = plugins.extensions.list().find(item => item.kind === "application" && item.id === "collaboration" && item.version === "1");
      if (state?.status !== "active") throw new Error(`Collaboration application unavailable: ${state?.error ?? "disabled, untrusted or failed to register"}`);
    }
  } };
}
