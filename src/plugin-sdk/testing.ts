import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAgentRuntime } from "../agent/runtime";
import { installLocalPlugin } from "../services/plugins/management";
import { trustPlugin } from "../services/plugins/trust";
import type { AgentTaskInput } from "../agent/execution";
import type { DurableRun, DurableTask } from "../services/runtime/types";
import type { ContributionReference, ChannelDescriptor, ChannelConnection } from "../agent/extensions";
import type { PluginConfiguration } from "../agent/plugin-data";
import type { ServiceProvider } from "../agent/services";
import type { JsonValue } from "../agent/domain";
export type { ServiceProvider, ServiceFactoryContext } from "../agent/services";
export type { PluginConfiguration } from "../agent/plugin-data";
export { provideService } from "../agent/services";

export type PluginTestHostOptions = {
  packageDirectory: string; serviceProviders?: readonly ServiceProvider[];
  serviceGrants?: Record<string, string[]>; configuration?: PluginConfiguration;
};
export type PluginTestHost = {
  submit(input: AgentTaskInput): Promise<{ run: DurableRun; tasks: DurableTask[] }>;
  wait(runId: string, timeoutMs?: number): Promise<{ run: DurableRun; tasks: DurableTask[]; result?: JsonValue }>;
  request(ref: ContributionReference, request: Request): Promise<Response>;
  connect(descriptor: ChannelDescriptor, configuration: JsonValue): Promise<ChannelConnection>;
  restart(): Promise<void>;
  close(): Promise<void>;
};

/** Opt-in trusted execution. Only temporary host state; not a sandbox for plugin code. */
export async function createPluginTestHost(options: PluginTestHostOptions): Promise<PluginTestHost> {
  const directory = await mkdtemp(join(tmpdir(), "tnb-author-test-"));
  let host: Awaited<ReturnType<typeof openAgentRuntime>> | undefined, closed = false, transitioning = false;
  const assertOpen = () => { if (closed || transitioning || !host) throw new Error("Plugin test host is closed or restarting"); return host; };
  const open = async () => {
    host = await openAgentRuntime({ directory: join(directory, "runtime"),
      plugins: { roots: [{ directory: join(directory, "plugins"), source: "user" }], trustStorePath: join(directory, "trust.json") },
      serviceProviders: options.serviceProviders, serviceGrants: options.serviceGrants, pluginConfiguration: options.configuration });
    const failure = [...host.plugins.list(), ...host.plugins.extensions()].find(row => !["active", "inactive"].includes(row.status));
    if (failure) throw new Error(failure.error ?? "Plugin did not activate");
  };
  try {
    const installed = await installLocalPlugin({ source: options.packageDirectory, targetRoot: join(directory, "plugins"), sourceType: "user" });
    await trustPlugin(join(directory, "trust.json"), installed.root); await open();
  } catch (error) { try { await host?.close(); } finally { await rm(directory, { recursive: true, force: true }); } throw error; }
  return {
    submit: input => assertOpen().submit(input),
    async wait(runId, timeoutMs = 15000) {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new Error("Invalid test timeout");
      const current = assertOpen(), deadline = Date.now() + timeoutMs;
      for (;;) {
        assertOpen(); const run = current.store.getRun(runId); if (!run) throw new Error("Test Run not found");
        const tasks = current.store.tasks(runId);
        if (["succeeded", "failed", "paused", "cancelled"].includes(run.status)) {
          const root = tasks.find(task => !task.parentTaskId);
          return { run, tasks, ...(root?.resultRef ? { result: await current.runtime.artifacts.get<JsonValue>(root.resultRef) } : {}) };
        }
        if (Date.now() >= deadline) throw new Error("Plugin task test timed out");
        await current.runtime.tick(); await Bun.sleep(10);
      }
    },
    request: (ref, request) => assertOpen().plugins.request(ref, request),
    connect: (descriptor, configuration) => {
      const channels = assertOpen().plugins.channels; if (!channels) throw new Error("No plugin channels");
      return channels.connect(descriptor, configuration);
    },
    async restart() {
      const previous = assertOpen(); transitioning = true;
      try { await previous.close(); host = undefined; await open(); }
      finally { transitioning = false; }
    },
    async close() {
      if (closed) return; if (transitioning) throw new Error("Plugin test host is restarting"); closed = true;
      try { await host?.close(); } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    },
  };
}
