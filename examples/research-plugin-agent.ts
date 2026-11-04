/** Explicitly installs and trusts ONLY this repository's bundled offline demonstration. */
import { cp, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openAgentRuntime } from "../src/agent/runtime";
import { researchTask } from "../src/adapters/research";
import { installLocalPlugin } from "../src/services/plugins/management";
import { loadPlugins } from "../src/services/plugins/loader";
import { trustPlugin } from "../src/services/plugins/trust";

const directory = resolve(process.argv[2] ?? await mkdtemp(join(tmpdir(), "tnb-plugin-demo-")));
const pluginRoot = join(directory, "plugins"), trustStorePath = join(directory, "plugin-trust.json");
const roots = [{ directory: pluginRoot, source: "user" as const }];
if (!(await loadPlugins(roots)).plugins.some(plugin => plugin.name === "offline-research")) {
  const stage = join(directory, "build"); await mkdir(stage, { recursive: true });
  const output = await Bun.build({ entrypoints: [fileURLToPath(new URL("plugins/research/index.ts", import.meta.url))], target: "bun", outdir: stage, naming: "index.mjs" });
  if (!output.success) throw new AggregateError(output.logs, "Plugin demo build failed");
  await cp(new URL("plugins/research/plugin.json", import.meta.url), join(stage, "plugin.json"));
  const plugin = await installLocalPlugin({ source: stage, targetRoot: pluginRoot, sourceType: "user" });
  await trustPlugin(trustStorePath, plugin.root);
}
const host = await openAgentRuntime({ directory: join(directory, "runtime"), plugins: { roots, trustStorePath } });
try {
  const { run, tasks } = await host.submit({ commandId: "plugin-demo-v1", namespace: "research/demo", objective: "Summarize the recovery rule with evidence",
    adapter: researchTask(["demo/plugin"]), mode: "single" });
  const end = Date.now() + 10000;
  while (!["succeeded", "failed", "paused"].includes(host.store.getRun(run.runId)!.status)) {
    if (Date.now() > end) throw new Error("Plugin demo timed out"); await host.runtime.tick(); await Bun.sleep(10);
  }
  const task = host.store.getTask(tasks[0]!.taskId)!;
  if (host.store.getRun(run.runId)!.status !== "succeeded") throw new Error(task.error ?? "Task did not succeed");
  process.stdout.write(JSON.stringify({ directory, runId: run.runId, taskId: task.taskId, model: "offline scripted fixture; no external model calls",
    plugins: host.plugins.list(), descriptor: host.runtime.configuration(run.runId).domain, result: await host.runtime.artifacts.get(task.resultRef!) }, null, 2) + "\n");
} finally { await host.close(); }
