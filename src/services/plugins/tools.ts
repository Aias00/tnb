import { readFile } from "node:fs/promises";

import { defineTool, type AgentTool } from "../../core/tool";
import {
  assertPluginContributionPath,
  type ExternalPluginToolContribution,
  type LoadedPlugin,
} from "./loader";

const MAX_PLUGIN_TOOL_OUTPUT_CHARS = 100_000;

type PendingRequest = {
  resolve(value: string): void;
  reject(error: Error): void;
};

type StdioRuntime = {
  child: Bun.PipedSubprocess;
  pending: Map<string, PendingRequest>;
  nextId: number;
};

export class PluginToolRuntimeManager {
  private readonly processes = new Map<string, StdioRuntime>();

  constructor(private readonly env: Record<string, string | undefined>) {}

  async startEager(plugins: readonly LoadedPlugin[]): Promise<void> {
    for (const plugin of plugins) {
      for (const contribution of plugin.toolContributions) {
        if (
          contribution.type === "external" && contribution.lifecycle.transport === "stdio" &&
          contribution.lifecycle.start === "eager"
        ) await this.ensureStdio(plugin, contribution);
      }
    }
  }

  async call(
    plugin: LoadedPlugin,
    contribution: ExternalPluginToolContribution,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string> {
    if (contribution.lifecycle.transport === "oneshot") {
      return runOneShotTool(plugin, contribution, input, this.env, signal);
    }
    if (contribution.lifecycle.transport === "http") {
      return runHttpTool(plugin, contribution, input, signal);
    }
    if (contribution.lifecycle.transport !== "stdio") {
      throw new Error(`Plugin ${plugin.name} tool ${contribution.id} cannot use ${contribution.lifecycle.transport} as an external transport`);
    }
    signal.throwIfAborted();
    const runtime = await this.ensureStdio(plugin, contribution);
    const id = `${process.pid}-${runtime.nextId++}`;
    return await new Promise<string>((resolve, reject) => {
      const abort = () => {
        runtime.pending.delete(id);
        runtime.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } })}\n`);
        reject(signal.reason instanceof Error ? signal.reason : new Error("Plugin tool request aborted"));
      };
      runtime.pending.set(id, {
        resolve(value) {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        reject(error) {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      });
      signal.addEventListener("abort", abort, { once: true });
      runtime.child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: contribution.id, input },
      })}\n`);
    });
  }

  async close(): Promise<void> {
    const runtimes = [...this.processes.values()];
    this.processes.clear();
    await Promise.all(runtimes.map((runtime) => stopRuntime(runtime)));
  }

  async stopPlugin(plugin: LoadedPlugin): Promise<void> {
    const entries = [...this.processes.entries()].filter(([key]) => key.startsWith(`${plugin.root}\0`));
    for (const [key] of entries) this.processes.delete(key);
    await Promise.all(entries.map(([, runtime]) => stopRuntime(runtime)));
  }

  private async ensureStdio(
    plugin: LoadedPlugin,
    contribution: ExternalPluginToolContribution,
  ): Promise<StdioRuntime> {
    const key = `${plugin.root}\0${contribution.id}`;
    const existing = this.processes.get(key);
    if (existing) return existing;
    const child = Bun.spawn([contribution.command, ...contribution.args], {
      cwd: plugin.root,
      env: definedEnvironment(this.env),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const runtime: StdioRuntime = { child, pending: new Map(), nextId: 1 };
    this.processes.set(key, runtime);
    void consumeLines(child.stdout, (line) => this.handleLine(plugin, contribution, runtime, line));
    void child.exited.then(async (exitCode) => {
      this.processes.delete(key);
      const stderr = await new Response(child.stderr).text();
      const error = new Error(
        `Plugin ${plugin.name} tool runtime ${contribution.id} exited with code ${exitCode}${stderr.trim() ? `: ${truncate(stderr.trim())}` : ""}`,
      );
      for (const request of runtime.pending.values()) request.reject(error);
      runtime.pending.clear();
    });
    await Promise.resolve();
    if (child.exitCode !== null) throw new Error(`Plugin ${plugin.name} tool runtime ${contribution.id} failed to start`);
    return runtime;
  }

  private handleLine(
    plugin: LoadedPlugin,
    contribution: ExternalPluginToolContribution,
    runtime: StdioRuntime,
    line: string,
  ): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    const record = message as Record<string, unknown>;
    const id = typeof record.id === "string" || typeof record.id === "number" ? String(record.id) : undefined;
    if (!id) return;
    const pending = runtime.pending.get(id);
    if (!pending) return;
    runtime.pending.delete(id);
    if (record.error !== undefined) {
      pending.reject(new Error(`Plugin ${plugin.name} tool ${contribution.id}: ${formatProtocolValue(record.error)}`));
    } else {
      pending.resolve(truncate(normalizeProtocolResult(record.result)));
    }
  }
}

async function stopRuntime(runtime: StdioRuntime): Promise<void> {
  for (const request of runtime.pending.values()) request.reject(new Error("Plugin runtime stopped"));
  runtime.pending.clear();
  runtime.child.stdin.end();
  runtime.child.kill();
  await runtime.child.exited.catch(() => undefined);
}

async function consumeLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline).replace(/\r$/, "");
        buffered = buffered.slice(newline + 1);
        if (line) onLine(line);
      }
    }
    buffered += decoder.decode();
    if (buffered.trim()) onLine(buffered.trim());
  } finally {
    reader.releaseLock();
  }
}

export async function createExternalPluginTools(
  plugins: LoadedPlugin[],
  env: Record<string, string | undefined>,
  runtime = new PluginToolRuntimeManager(env),
): Promise<AgentTool[]> {
  const tools: AgentTool[] = [];
  const names = new Set<string>();
  for (const plugin of plugins) {
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

async function runOneShotTool(
  plugin: LoadedPlugin,
  contribution: ExternalPluginToolContribution,
  input: Record<string, unknown>,
  env: Record<string, string | undefined>,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const child = Bun.spawn([contribution.command, ...contribution.args], {
    cwd: plugin.root,
    env: definedEnvironment(env),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const abort = () => child.kill();
  signal.addEventListener("abort", abort, { once: true });
  try {
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    signal.throwIfAborted();
    if (exitCode !== 0) {
      throw new Error(
        `Plugin ${plugin.name} tool ${contribution.id} exited with code ${exitCode}${stderr.trim() ? `: ${truncate(stderr.trim())}` : ""}`,
      );
    }
    const output = stdout.trim();
    if (!output) return "Plugin tool completed without output.";
    return truncate(normalizeToolOutput(output));
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function runHttpTool(
  plugin: LoadedPlugin,
  contribution: ExternalPluginToolContribution,
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  if (contribution.security.network === "none") {
    throw new Error(`Plugin ${plugin.name} tool ${contribution.id} must declare loopback or egress network access for HTTP transport`);
  }
  const response = await fetch(contribution.command, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: randomRequestId(), method: "tools/call", params: { name: contribution.id, input } }),
    signal,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Plugin ${plugin.name} tool ${contribution.id} HTTP ${response.status}: ${truncate(text)}`);
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    if (payload.error !== undefined) throw new Error(formatProtocolValue(payload.error));
    return truncate(normalizeProtocolResult(payload.result));
  } catch (error) {
    if (error instanceof SyntaxError) return truncate(text);
    throw error;
  }
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
  return typeof value === "string" ? value : JSON.stringify(value);
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
