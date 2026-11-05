import { readFile } from "node:fs/promises";
import { assertPluginActive, isPluginActive } from "./policy";
import { consumePluginLines, pluginToolLimits, readPluginText, type PluginToolLimits } from "./io";
import { requestPluginHttp } from "./http";
import { pluginHttpTarget } from "./network";

import { defineTool, type AgentTool } from "../../core/tool";
import {
  assertPluginContributionPath,
  type ExternalPluginToolContribution,
  type LoadedPlugin,
} from "./loader";

const MAX_PLUGIN_TOOL_OUTPUT_CHARS = 100_000;

type PendingRequest = { resolve(value: string): void; reject(error: Error): void };
type StdioRuntime = {
  process: ManagedProcess; pending: Map<string, PendingRequest>; nextId: number;
  generation: string; done: Promise<void>;
};
type OwnedCall = { generation: string; controller: AbortController; done: Promise<string> };
type ManagedProcess = { child: Bun.PipedSubprocess; signal: AbortSignal; stop(reason: Error): Promise<void> };

export class PluginToolRuntimeManager {
  private readonly processes = new Map<string, StdioRuntime>();
  private readonly retired = new Set<string>();
  private readonly calls = new Set<OwnedCall>();
  private readonly stopping = new Map<string, Promise<void>>();
  private readonly stopEpochs = new Map<string, number>();
  private readonly limits: Readonly<PluginToolLimits>;
  private closing?: Promise<void>;
  private closed = false;

  constructor(private readonly env: Record<string, string | undefined>, limits: Partial<PluginToolLimits> = {}) {
    this.limits = pluginToolLimits(limits);
  }

  async startEager(plugins: readonly LoadedPlugin[]): Promise<void> {
    if (this.closed) throw new Error("Plugin tool runtime is closed");
    for (const plugin of plugins) {
      if (!isPluginActive(plugin)) continue;
      const generation = this.generation(plugin);
      const epoch = this.stopEpochs.get(generation) ?? 0;
      await this.stopping.get(generation);
      if (this.closed) throw new Error("Plugin tool runtime is closed");
      if ((this.stopEpochs.get(generation) ?? 0) !== epoch) throw new Error("Plugin activation was superseded by a stop request");
      this.retired.delete(generation);
      try {
        for (const contribution of plugin.toolContributions) {
          if (contribution.type === "external" && contribution.lifecycle.transport === "stdio" && contribution.lifecycle.start === "eager") {
            await this.ensureStdio(plugin, contribution);
            this.assertAdmitted(plugin);
          }
        }
      } catch (error) {
        try { await this.stopPlugin(plugin); } catch (cleanup) { throw new AggregateError([error, cleanup], "Plugin eager activation and cleanup failed"); }
        throw error;
      }
    }
  }

  async call(plugin: LoadedPlugin, contribution: ExternalPluginToolContribution, input: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    this.assertAdmitted(plugin); signal.throwIfAborted();
    if (this.calls.size >= this.limits.maxConcurrentCalls) throw new Error("Plugin tool concurrent call limit reached");
    const body = JSON.stringify(input);
    if (Buffer.byteLength(body) > this.limits.maxInputBytes) throw new Error(`Plugin tool input exceeds ${this.limits.maxInputBytes} byte limit`);
    const admittedInput = JSON.parse(body) as Record<string, unknown>;
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error(`Plugin tool call exceeded ${this.limits.timeoutMs}ms deadline; effects may already have occurred`)), this.limits.timeoutMs);
    const call: OwnedCall = { generation: this.generation(plugin), controller, done: Promise.resolve("") };
    // Register ownership before any transport can start an effect.
    call.done = Promise.resolve().then(async () => {
      this.assertAdmitted(plugin); controller.signal.throwIfAborted();
      try {
        if (contribution.lifecycle.transport === "oneshot") return await runOneShotTool(plugin, contribution, body, this.env, controller.signal, this.limits);
        if (contribution.lifecycle.transport === "http") return await runHttpTool(plugin, contribution, admittedInput, controller.signal, this.limits);
        if (contribution.lifecycle.transport !== "stdio") throw new Error(`Plugin ${plugin.name} tool ${contribution.id} cannot use ${contribution.lifecycle.transport} as an external transport`);
        return await this.callStdio(plugin, contribution, admittedInput, controller.signal);
      } catch (error) { controller.signal.throwIfAborted(); throw error; }
    }).finally(() => { clearTimeout(timer); signal.removeEventListener("abort", abort); this.calls.delete(call); });
    this.calls.add(call);
    return call.done;
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      this.closing = this.drain();
    }
    return this.closing;
  }

  stopPlugin(plugin: LoadedPlugin): Promise<void> {
    const generation = this.generation(plugin);
    this.stopEpochs.set(generation, (this.stopEpochs.get(generation) ?? 0) + 1);
    this.retired.add(generation);
    let stopping = this.stopping.get(generation);
    if (!stopping) {
      stopping = this.drain(generation).finally(() => this.stopping.delete(generation));
      this.stopping.set(generation, stopping);
    }
    return stopping;
  }

  private async drain(generation?: string): Promise<void> {
    const reason = new Error("Plugin tool generation is stopped; effects may already have occurred");
    const calls = [...this.calls].filter(call => !generation || call.generation === generation);
    for (const call of calls) call.controller.abort(reason);
    const settledCalls = Promise.allSettled(calls.map(call => call.done));
    const runtimes = [...this.processes.values()].filter(runtime => !generation || runtime.generation === generation);
    const cleanup = await Promise.allSettled(runtimes.map(runtime => this.stopRuntime(runtime, reason)));
    await settledCalls;
    // A concurrent close must also join an already draining generation.
    if (!generation) cleanup.push(...await Promise.allSettled([...this.stopping.values()]));
    const errors = cleanup.filter(result => result.status === "rejected").map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, "Plugin tool runtime cleanup failed");
  }

  private generation(plugin: LoadedPlugin): string { return JSON.stringify([plugin.root, plugin.fingerprint ?? null]); }
  private key(plugin: LoadedPlugin, contribution: ExternalPluginToolContribution): string { return JSON.stringify([this.generation(plugin), contribution.id]); }
  private assertAdmitted(plugin: LoadedPlugin): void {
    assertPluginActive(plugin);
    if (this.closed || this.retired.has(this.generation(plugin))) throw new Error(`Plugin ${plugin.name} tool generation is stopped`);
  }

  private async stopRuntime(runtime: StdioRuntime, error: Error): Promise<void> {
    for (const request of runtime.pending.values()) request.reject(error);
    runtime.pending.clear();
    await runtime.process.stop(error);
    await runtime.done;
  }

  private async callStdio(plugin: LoadedPlugin, contribution: ExternalPluginToolContribution, input: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const runtime = await this.ensureStdio(plugin, contribution);
    this.assertAdmitted(plugin); signal.throwIfAborted();
    if (this.processes.get(this.key(plugin, contribution)) !== runtime || runtime.process.signal.aborted) throw new Error(`Plugin ${plugin.name} tool generation is stopped`);
    const id = `${process.pid}-${runtime.nextId++}`;
    const request = JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: contribution.id, input } });
    if (Buffer.byteLength(request) > this.limits.maxInputBytes) throw new Error(`Plugin tool request exceeds ${this.limits.maxInputBytes} byte limit`);
    const abort = () => { void this.stopRuntime(runtime, errorValue(signal.reason)); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      return await new Promise<string>((resolve, reject) => {
        runtime.pending.set(id, { resolve, reject });
        try { runtime.process.child.stdin.write(`${request}\n`); } catch (error) { runtime.pending.delete(id); reject(error); }
      });
    } finally {
      signal.removeEventListener("abort", abort);
      if (signal.aborted || runtime.process.signal.aborted) await this.stopRuntime(runtime, errorValue(signal.reason ?? runtime.process.signal.reason));
    }
  }

  private async ensureStdio(plugin: LoadedPlugin, contribution: ExternalPluginToolContribution): Promise<StdioRuntime> {
    this.assertAdmitted(plugin);
    const key = this.key(plugin, contribution), existing = this.processes.get(key);
    if (existing) {
      if (!existing.process.signal.aborted) return existing;
      await existing.done;
      this.assertAdmitted(plugin);
      // Another caller may have replaced it while cleanup was awaited.
      return this.ensureStdio(plugin, contribution);
    }
    if (this.processes.size >= this.limits.maxStdioProcesses) throw new Error("Plugin stdio process limit reached");
    const process = spawnPluginProcess(plugin, contribution, this.env, this.limits);
    const runtime: StdioRuntime = { process, pending: new Map(), nextId: 1, generation: this.generation(plugin), done: Promise.resolve() };
    this.processes.set(key, runtime);
    let failure: Error | undefined;
    const fail = (error: unknown) => {
      failure ??= errorValue(error);
      for (const request of runtime.pending.values()) request.reject(failure);
      runtime.pending.clear(); void process.stop(failure);
    };
    // Both streams start draining immediately. Diagnostics never accumulate until exit.
    const stdout = consumePluginLines(process.child.stdout, this.limits, process.signal, line => this.handleLine(plugin, contribution, runtime, line)).catch(fail);
    const stderr = readPluginText(process.child.stderr, this.limits.maxStderrBytes, "stderr", process.signal).catch(fail);
    runtime.done = Promise.all([process.child.exited, stdout, stderr]).then(([exitCode, , diagnostic]) => {
      if (this.processes.get(key) === runtime) this.processes.delete(key);
      const error = failure ?? new Error(`Plugin ${plugin.name} tool runtime ${contribution.id} exited with code ${exitCode}${diagnostic?.trim() ? `: ${truncate(diagnostic.trim())}` : ""}`);
      for (const request of runtime.pending.values()) request.reject(error);
      runtime.pending.clear();
    });
    await Promise.resolve();
    if (process.signal.aborted || process.child.exitCode !== null) { await runtime.done; throw failure ?? new Error(`Plugin ${plugin.name} tool runtime ${contribution.id} failed to start`); }
    return runtime;
  }

  private handleLine(plugin: LoadedPlugin, contribution: ExternalPluginToolContribution, runtime: StdioRuntime, line: string): void {
    let message: unknown;
    try { message = JSON.parse(line); } catch { return; }
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    const record = message as Record<string, unknown>;
    const id = typeof record.id === "string" || typeof record.id === "number" ? String(record.id) : undefined;
    if (!id) return;
    const pending = runtime.pending.get(id);
    if (!pending) return;
    runtime.pending.delete(id);
    const result = record.error !== undefined ? formatProtocolValue(record.error) : normalizeProtocolResult(record.result);
    if (Buffer.byteLength(result) > this.limits.maxOutputBytes) pending.reject(new Error(`Plugin tool result exceeds ${this.limits.maxOutputBytes} byte limit`));
    else if (record.error !== undefined) pending.reject(new Error(`Plugin ${plugin.name} tool ${contribution.id}: ${truncate(result)}`));
    else pending.resolve(truncate(result));
  }
}

function errorValue(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)); }

function spawnPluginProcess(plugin: LoadedPlugin, contribution: ExternalPluginToolContribution, env: Record<string, string | undefined>, limits: Readonly<PluginToolLimits>): ManagedProcess {
  const child = Bun.spawn([contribution.command, ...contribution.args], { cwd: plugin.root, env: definedEnvironment(env), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const controller = new AbortController(); let stopping: Promise<void> | undefined;
  return { child, signal: controller.signal, stop(reason) {
    if (!stopping) {
      controller.abort(reason);
      try { child.stdin.end(); } catch { /* The peer may already have closed stdin. */ }
      child.kill();
      const timer = setTimeout(() => child.kill("SIGKILL"), limits.killGraceMs);
      stopping = child.exited.then(() => {}).finally(() => clearTimeout(timer));
    }
    return stopping;
  } };
}

export async function createExternalPluginTools(
  plugins: LoadedPlugin[],
  env: Record<string, string | undefined>,
  runtime = new PluginToolRuntimeManager(env),
): Promise<AgentTool[]> {
  const tools: AgentTool[] = [];
  const names = new Set<string>();
  for (const plugin of plugins) {
    if (!isPluginActive(plugin)) continue;
    for (const contribution of plugin.toolContributions) {
      if (contribution.type !== "external") continue;
      const name = externalToolName(plugin.name, contribution.id);
      if (names.has(name)) throw new Error(`Duplicate external plugin tool name: ${name}`);
      names.add(name);
      tools.push(await createExternalPluginTool(plugin, contribution, name, runtime));
    }
  }
  return tools;
}

async function createExternalPluginTool(
  plugin: LoadedPlugin,
  contribution: ExternalPluginToolContribution,
  name: string,
  runtime: PluginToolRuntimeManager,
): Promise<AgentTool> {
  if (contribution.lifecycle.transport !== "http") {
    contribution = { ...contribution, command: await assertPluginContributionPath(plugin, contribution.command) };
  }
  const inputSchema = contribution.inputSchema ?? (
    contribution.inputSchemaPath
      ? parseInputSchema(
          await readFile(await assertPluginContributionPath(plugin, contribution.inputSchemaPath), "utf8"),
          contribution.inputSchemaPath,
        )
      : { type: "object", additionalProperties: true }
  );
  return defineTool<Record<string, unknown>>({
    name,
    description: contribution.description,
    inputSchema,
    validate(input) {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new Error(`${name} input must be an object`);
      }
      return input as Record<string, unknown>;
    },
    execute: (input, signal) => runtime.call(plugin, contribution, input, signal),
    access: contribution.security.access,
    isReadOnly: () => contribution.security.access === "read",
    isConcurrencySafe: () => contribution.security.access === "read",
    requiresApproval: () => contribution.security.approval === "always",
    permissionRuleContent: () => `${plugin.name}:${contribution.id}`,
  });
}

async function runOneShotTool(plugin: LoadedPlugin, contribution: ExternalPluginToolContribution, input: string,
  env: Record<string, string | undefined>, signal: AbortSignal, limits: Readonly<PluginToolLimits>): Promise<string> {
  signal.throwIfAborted();
  const process = spawnPluginProcess(plugin, contribution, env, limits);
  const abort = () => { void process.stop(errorValue(signal.reason)); };
  signal.addEventListener("abort", abort, { once: true });
  const stdout = readPluginText(process.child.stdout, limits.maxOutputBytes, "stdout", process.signal);
  const stderr = readPluginText(process.child.stderr, limits.maxStderrBytes, "stderr", process.signal);
  try {
    process.child.stdin.write(input); process.child.stdin.end();
    const [exitCode, output, diagnostic] = await Promise.all([process.child.exited, stdout, stderr]);
    signal.throwIfAborted();
    if (exitCode !== 0) throw new Error(`Plugin ${plugin.name} tool ${contribution.id} exited with code ${exitCode}${diagnostic.trim() ? `: ${truncate(diagnostic.trim())}` : ""}`);
    return output.trim() ? truncate(normalizeToolOutput(output.trim())) : "Plugin tool completed without output.";
  } catch (error) {
    await process.stop(errorValue(error));
    await Promise.allSettled([stdout, stderr]);
    signal.throwIfAborted(); throw error;
  } finally { signal.removeEventListener("abort", abort); }
}

async function runHttpTool(plugin: LoadedPlugin, contribution: ExternalPluginToolContribution, input: Record<string, unknown>,
  signal: AbortSignal, limits: Readonly<PluginToolLimits>): Promise<string> {
  const target = pluginHttpTarget(contribution.command, contribution.security.network);
  if (contribution.args.length) throw new Error("Plugin HTTP tools cannot use command args");
  const body = JSON.stringify({ jsonrpc: "2.0", id: randomRequestId(), method: "tools/call", params: { name: contribution.id, input } });
  if (Buffer.byteLength(body) > limits.maxInputBytes) throw new Error(`Plugin tool request exceeds ${limits.maxInputBytes} byte limit`);
  const { status, text } = await requestPluginHttp(target, body, limits.maxOutputBytes, signal);
  if (status < 200 || status >= 300) throw new Error(`Plugin ${plugin.name} tool ${contribution.id} HTTP ${status}: ${truncate(text)}`);
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    if (payload && payload.error !== undefined) throw new Error(formatProtocolValue(payload.error));
    return truncate(normalizeProtocolResult(payload?.result));
  } catch (error) { if (error instanceof SyntaxError) return truncate(text); throw error; }
}

function normalizeProtocolResult(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.content === "string") return record.content;
    if (Array.isArray(record.content)) {
      const text = record.content
        .filter((item): item is { type: "text"; text: string } =>
          Boolean(item) && typeof item === "object" && (item as { type?: unknown }).type === "text" &&
          typeof (item as { text?: unknown }).text === "string")
        .map((item) => item.text)
        .join("\n");
      if (text) return text;
    }
  }
  return formatProtocolValue(value);
}

function formatProtocolValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? "";
}

function randomRequestId(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function parseInputSchema(content: string, path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid plugin tool input schema: ${path}`, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Plugin tool input schema must be an object: ${path}`);
  }
  return parsed as Record<string, unknown>;
}

function normalizeToolOutput(output: string): string {
  try {
    const parsed = JSON.parse(output) as unknown;
    if (
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>).content === "string"
    ) {
      return (parsed as { content: string }).content;
    }
  } catch {
    // Plain stdout is the documented fallback when the command does not emit JSON.
  }
  return output;
}

function truncate(value: string): string {
  return value.length <= MAX_PLUGIN_TOOL_OUTPUT_CHARS
    ? value
    : `${value.slice(0, MAX_PLUGIN_TOOL_OUTPUT_CHARS)}\n… plugin tool output truncated`;
}

function externalToolName(pluginName: string, contributionId: string): string {
  const component = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "_");
  return `plugin__${component(pluginName)}__${component(contributionId)}`;
}

function definedEnvironment(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
