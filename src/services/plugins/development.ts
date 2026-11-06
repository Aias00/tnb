import { processPluginTemplate } from "./process-template";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { loadPluginDirectory, assertPluginContributionPath } from "./loader";
import { computePluginTreeSha256, trustPlugin } from "./trust";
import { installLocalPlugin } from "./management";
import { pluginTemplate, PLUGIN_TEMPLATES, type PluginTemplate } from "./templates";
import { openAgentRuntime } from "../../agent/runtime";
import { validateDomainDescriptor, type DomainDescriptor, type JsonValue } from "../../agent/domain";
import type { ContributionReference, ChannelDescriptor, ChannelMessage } from "../../agent/extensions";
import { digestJson } from "../runtime/json";
import type { Operation } from "../runtime/journal";
import { typescriptPluginTemplate } from "./typescript-template";
import packageJson from "../../../package.json";

type TaskScenario = { kind: "task"; objective: string; adapter: DomainDescriptor; expect: { reportIncludes: string; tools?: string[] } };
type RequestScenario = { kind: "request"; contribution: ContributionReference & { kind: "application" | "interface" }; path: string; method: "GET" | "POST"; body?: JsonValue; expect: { status: number; json?: JsonValue; textIncludes?: string } };
type ChannelScenario = { kind: "channel"; channel: ChannelDescriptor; configuration: JsonValue; message: ChannelMessage; expect: { receipt: string; events?: number } };
export type PluginTestSpecification = { version: 1; scenarios: Array<TaskScenario | RequestScenario | ChannelScenario> };
export type PluginValidation = { ok: boolean; directory: string; plugin?: { name: string; version?: string; fingerprint: string }; checks: Array<{ phase: string; ok: boolean; detail: string }>; requirements: { services: string[]; contributions: ContributionReference[] }; scenarios: number };
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096;
const keys = (value: Record<string, any>, allowed: string[]) => { if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("Unknown plugin test field"); };
const reference = (value: unknown): boolean => object(value) && text(value.id) && text(value.version) && !value.plugin && Object.keys(value).every(key => ["kind", "id", "version"].includes(key));

export async function readPluginTests(directory: string): Promise<PluginTestSpecification | undefined> {
  let bytes: string;
  const path = join(directory, "plugin.test.json");
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new Error("plugin.test.json must be a regular file of at most 64 KiB");
    bytes = await readFile(path, "utf8");
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const value: unknown = JSON.parse(bytes);
  if (!object(value) || value.version !== 1 || !Array.isArray(value.scenarios) || value.scenarios.length < 1 || value.scenarios.length > 32) throw new Error("plugin.test.json requires version 1 and one to 32 scenarios");
  keys(value, ["version", "scenarios"]);
  for (const row of value.scenarios) {
    if (!object(row) || !object(row.expect)) throw new Error("Every plugin test scenario requires kind and expect");
    if (row.kind === "task") {
      keys(row, ["kind", "objective", "adapter", "expect"]); keys(row.expect, ["reportIncludes", "tools"]);
      if (!text(row.objective) || !text(row.expect.reportIncludes) || row.adapter?.plugin) throw new Error("Task tests require objective, unpinned adapter and expect.reportIncludes");
      validateDomainDescriptor(row.adapter);
      if (row.expect.tools !== undefined && (!Array.isArray(row.expect.tools) || row.expect.tools.length > 32 || row.expect.tools.some((name: unknown) => !text(name)))) throw new Error("expect.tools must be an array of tool names");
    } else if (row.kind === "request") {
      keys(row, ["kind", "contribution", "path", "method", "body", "expect"]); keys(row.expect, ["status", "json", "textIncludes"]);
      if (!reference(row.contribution) || !["application", "interface"].includes(row.contribution.kind) || !["GET", "POST"].includes(row.method)
        || !text(row.path) || !row.path.startsWith("/") || row.path.startsWith("//") || !Number.isInteger(row.expect.status) || row.expect.status < 100 || row.expect.status > 599
        || row.expect.textIncludes !== undefined && !text(row.expect.textIncludes) || row.method === "GET" && row.body !== undefined) throw new Error("Invalid request scenario or expectation");
    } else if (row.kind === "channel") {
      keys(row, ["kind", "channel", "configuration", "message", "expect"]); keys(row.expect, ["receipt", "events"]);
      if (!reference(row.channel) || !object(row.message) || !text(row.message.id) || !text(row.message.thread) || !text(row.message.text)
        || row.configuration === undefined || !text(row.expect.receipt) || row.expect.events !== undefined && (!Number.isInteger(row.expect.events) || row.expect.events < 0 || row.expect.events > 1000)) throw new Error("Invalid channel scenario or expectation");
      keys(row.message, ["id", "thread", "text", "ticketId"]);
    } else throw new Error("Supported plugin test kinds: task, request, channel");
  }
  return value as PluginTestSpecification;
}

export async function initializePlugin(directory: string, template: PluginTemplate, name = basename(resolve(directory)), options: { language?: "javascript" | "typescript"; sdkTarball?: string; execution?: "in-process" | "process" } = {}) {
  if (!PLUGIN_TEMPLATES.includes(template)) throw new Error("--template must be agent, application or channel");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) throw new Error("Use --name with a valid plugin name (letters, numbers, _ or -; at most 64 characters)");
  if (options.execution === "process" && template === "agent") throw new Error("Process execution currently supports application and channel templates");
  const target = resolve(directory);
  let sdkTarball: string | undefined;
  if (options.language === "typescript") {
    const filename = `tnb-plugin-sdk-${packageJson.version}.tgz`;
    const candidates = options.sdkTarball ? [resolve(options.sdkTarball)] : [join(dirname(process.execPath), filename), resolve(import.meta.dir, "../../../dist", filename)];
    for (const candidate of candidates) if (candidate.endsWith(".tgz") && await Bun.file(candidate).exists() && (await lstat(candidate)).isFile()) { sdkTarball = candidate; break; }
    if (!sdkTarball) throw new Error("Plugin SDK tarball not found; build it with bun run sdk:setup && bun run sdk:build, or pass --sdk /path/to/sdk.tgz");
  }
  await mkdir(dirname(target), { recursive: true });
  await mkdir(target, { mode: 0o700 }); // Deliberately refuses existing paths, including empty directories and symlinks.
  try {
    const files = sdkTarball ? typescriptPluginTemplate(name, template, sdkTarball, options.execution) : options.execution === "process" ? processPluginTemplate(name, template) : pluginTemplate(name, template);
    for (const [path, content] of Object.entries(files)) { await mkdir(dirname(join(target, path)), { recursive: true }); await writeFile(join(target, path), content, { flag: "wx" }); }
    return { directory: target, name, template, language: options.language ?? "javascript", files: Object.keys(files), ...(sdkTarball ? { sdkTarball } : {}) };
  } catch (error) { await rm(target, { recursive: true, force: true }); throw error; }
}

/** Source checks use discovery's exact parser and never import, install or trust a plugin. */
export async function validatePluginPackage(directory: string): Promise<PluginValidation> {
  const report: PluginValidation = { ok: true, directory: resolve(directory), checks: [], requirements: { services: [], contributions: [] }, scenarios: 0 };
  try {
    const plugin = await loadPluginDirectory(directory);
    if (!plugin.manifestPath) throw new Error("A plugin.json or .tnb-plugin/plugin.json manifest is required for author validation");
    const fingerprint = await computePluginTreeSha256(plugin.root);
    report.directory = plugin.root; report.plugin = { name: plugin.name, version: plugin.version, fingerprint };
    report.checks.push({ phase: "manifest", ok: true, detail: "Manifest, API and host compatibility accepted by the real discovery parser" });
    const declarations = [...(plugin.adapterContributions ?? []).map(row => ({ ...row, kind: "adapter" as const })), ...(plugin.extensionContributions ?? [])];
    const identities = new Set<string>();
    const scanned = new Set<string>();
    for (const row of declarations) {
      const key = `${row.kind}:${row.id}@${row.version}`;
      if (identities.has(key)) throw new Error(`Duplicate contribution: ${key}`);
      identities.add(key);
      const entry = await assertPluginContributionPath(plugin, resolve(plugin.root, row.entry));
      if (!(await lstat(entry)).isFile()) throw new Error(`Entry must be a regular file: ${row.entry}`);
      if (!scanned.has(entry)) {
        const scan = new Bun.Transpiler({ loader: "js", target: "bun" }).scan(await readFile(entry, "utf8"));
        if (!scan.exports.includes("default")) throw new Error(`Entry must export a default factory: ${row.entry}`);
        scanned.add(entry);
      }
      report.checks.push({ phase: "entry", ok: true, detail: key });
    }
    for (const row of plugin.extensionContributions ?? []) {
      for (const service of row.services) if (!report.requirements.services.includes(service)) report.requirements.services.push(service);
      for (const dependency of row.requires) if (!identities.has(`${dependency.kind}:${dependency.id}@${dependency.version}`)) report.requirements.contributions.push(dependency);
    }
    const spec = await readPluginTests(plugin.root);
    report.scenarios = spec?.scenarios.length ?? 0;
    for (const scenario of spec?.scenarios ?? []) {
      const ref = scenario.kind === "task" ? { kind: "adapter", ...scenario.adapter } : scenario.kind === "channel" ? { kind: "channel", ...scenario.channel } : scenario.contribution;
      if (!identities.has(`${ref.kind}:${ref.id}@${ref.version}`)) throw new Error(`Scenario selects an undeclared contribution: ${ref.kind}:${ref.id}@${ref.version}`);
    }
    report.checks.push({ phase: "scenarios", ok: true, detail: spec ? `${report.scenarios} smoke scenarios parsed; execution requires plugins test --yes` : "No plugin.test.json; static validation only" });
  } catch (error) { report.ok = false; report.checks.push({ phase: "validation", ok: false, detail: error instanceof Error ? error.message : String(error) }); }
  return report;
}

export type PluginSmokeReport = { ok: boolean; plugin?: PluginValidation["plugin"]; isolatedState: true; checks: Array<{ phase: string; ok: boolean; detail: string }> };
/** Explicit execution of trusted code, with a real private install/trust/owner and no user's settings. */
export async function testPluginPackage(directory: string): Promise<PluginSmokeReport> {
  const validation = await validatePluginPackage(directory);
  const report: PluginSmokeReport = { ok: false, plugin: validation.plugin, isolatedState: true, checks: [] };
  if (!validation.ok) { report.checks = validation.checks; return report; }
  if (!validation.scenarios) { report.checks.push({ phase: "scenarios", ok: false, detail: "Add plugin.test.json with at least one scenario before running tests" }); return report; }
  const root = await mkdtemp(join(tmpdir(), "tnb-plugin-test-"));
  let host: Awaited<ReturnType<typeof openAgentRuntime>> | undefined;
  let phase = "preparation";
  try {
    const installed = await installLocalPlugin({ source: validation.directory, targetRoot: join(root, "plugins"), sourceType: "user" });
    if (await computePluginTreeSha256(installed.root) !== validation.plugin!.fingerprint) throw new Error("Plugin changed during test preparation; validate and retry");
    const spec = (await readPluginTests(installed.root))!;
    if (process.platform === "win32" && spec.scenarios.some(row => row.kind === "task")) throw new Error("Agent execution tests currently require macOS/Linux artifact durability; static validate and application/channel tests support Windows");
    const trustStorePath = join(root, "trust.json"); await trustPlugin(trustStorePath, installed.root);
    phase = "activation";
    host = await openAgentRuntime({ directory: join(root, "runtime"), plugins: { roots: [{ directory: join(root, "plugins"), source: "user" }], trustStorePath, enabled: { [installed.name]: true } } });
    const packageState = host.plugins.list().find(row => row.name === installed.name);
    if (packageState?.status !== "active") throw new Error(packageState?.error ?? "Plugin did not register");
    const failed = host.plugins.extensions().find(row => row.status !== "active");
    if (failed) throw new Error(`${failed.kind}:${failed.id}@${failed.version}: ${failed.error ?? failed.status}. Declare host services/dependencies in a custom SDK test host when required`);
    report.checks.push({ phase: "activation", ok: true, detail: "Installed, trusted, registered and activated in temporary host state" });
    for (const [index, scenario] of spec.scenarios.entries()) {
      phase = `scenario-${index + 1}`;
      if (scenario.kind === "task") {
        const { run, tasks } = await host.submit({ commandId: `smoke-${index}`, namespace: "plugin-test", objective: scenario.objective, adapter: scenario.adapter, mode: "single" });
        const deadline = Date.now() + 15000;
        while (!["succeeded", "failed", "paused", "cancelled"].includes(host.store.getRun(run.runId)!.status)) {
          if (Date.now() > deadline) throw new Error(`Task scenario ${index + 1} timed out; inspect the adapter's worker/accept contract`);
          await host.runtime.tick(); await Bun.sleep(10);
        }
        const task = host.store.getTask(tasks[0]!.taskId)!;
        if (host.store.getRun(run.runId)!.status !== "succeeded" || !task.resultRef) throw new Error(task.error ?? `Task did not succeed: ${host.store.getRun(run.runId)!.status}`);
        const result = await host.runtime.artifacts.get<{ report: string }>(task.resultRef);
        if (!result.report.includes(scenario.expect.reportIncludes)) throw new Error(`Task scenario ${index + 1}: expected report fragment missing`);
        const operations = host.store.records<Operation>("operation", run.runId, task.taskId).map(row => row.value);
        for (const name of scenario.expect.tools ?? []) if (!operations.some(row => row.call.name === name && row.state === "settled" && row.effectOutcome === "confirmed" && row.outcome?.result.isError === false)) throw new Error(`Task scenario ${index + 1}: missing successful confirmed tool receipt: ${name}`);
      } else if (scenario.kind === "request") {
        const response = await host.plugins.request(scenario.contribution, new Request("http://plugin" + scenario.path, { method: scenario.method,
          ...(scenario.body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(scenario.body) } : {}) }));
        if (response.status !== scenario.expect.status) throw new Error(`Request scenario ${index + 1}: expected status ${scenario.expect.status}, received ${response.status}`);
        const body = await response.text();
        if (Object.hasOwn(scenario.expect, "json") && digestJson(JSON.parse(body)) !== digestJson(scenario.expect.json)) throw new Error(`Request scenario ${index + 1}: JSON expectation failed`);
        if (scenario.expect.textIncludes !== undefined && !body.includes(scenario.expect.textIncludes)) throw new Error(`Request scenario ${index + 1}: text expectation failed`);
      } else {
        const connection = await host.plugins.channels!.connect(scenario.channel, scenario.configuration);
        try {
          const signal = new AbortController().signal;
          if (scenario.expect.events !== undefined) {
            if (!connection.port.poll) throw new Error("Channel scenario requires a poll implementation");
            const first = await connection.port.poll(undefined, signal), next = await connection.port.poll(first.cursor, signal);
            if (first.events.length !== scenario.expect.events || next.events.length !== 0) throw new Error("Channel polling expectation failed or cursor redelivered the event");
          }
          if (await connection.port.send(scenario.message, signal) !== scenario.expect.receipt || await connection.port.send(scenario.message, signal) !== scenario.expect.receipt) throw new Error("Channel send/replay receipt expectation failed");
          if (!connection.port.find || await connection.port.find(scenario.message, signal) !== scenario.expect.receipt) throw new Error("Channel find expectation failed");
        } finally { await connection.close(); }
      }
      report.checks.push({ phase: `scenario-${index + 1}`, ok: true, detail: `${scenario.kind} scenario passed` });
    }
    report.ok = true;
  } catch (error) { report.checks.push({ phase, ok: false, detail: error instanceof Error ? error.message : String(error) }); }
  finally {
    try { await host?.close(); report.checks.push({ phase: "shutdown", ok: true, detail: "Host drained and closed" }); }
    catch (error) { report.ok = false; report.checks.push({ phase: "shutdown", ok: false, detail: error instanceof Error ? error.message : String(error) }); }
    if (process.platform === "win32") Bun.gc(true);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  return report;
}
