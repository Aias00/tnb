import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { digestJson, encodeJson, integer, text } from "../runtime/json";
import type { CollaborationConfig, Source } from "./types";

const allowedConfiguration = new Set(["workspace", "allowedWorkspaces", "allowWrite", "allowShell", "checks", "provider", "model", "maxCostUsd", "maxTurns", "maxRetries", "compactThreshold", "maxModelRequests"]);
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected collaboration configuration object");
  return value as Record<string, any>;
}
function keys(value: Record<string, any>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("Unknown collaboration configuration field");
}
function names(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error(`Invalid ${label}`);
  return value.map(item => text(item, label, 128));
}
export function sourceIdentity(source: Source): string {
  return digestJson({ id: source.id, type: source.type, github: source.github, webhook: source.webhook, timer: source.timer, channel: source.channel, options: source.options });
}
export async function parseCollaborationConfig(value: unknown): Promise<CollaborationConfig> {
  encodeJson(value, 64 * 1024);
  const root = object(value); keys(root, ["enabled", "sources", "listen"]);
  if (typeof root.enabled !== "boolean" || !Array.isArray(root.sources) || root.sources.length > 32) throw new Error("Invalid collaboration profile");
  const ids = new Set<string>(); const sources: Source[] = [];
  for (const raw of root.sources) {
    const source = object(raw); keys(source, ["id", "type", "actors", "controllers", "configuration", "mode", "pollIntervalMs", "github", "webhook", "timer", "channel", "options"]);
    if (typeof source.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(source.id) || ids.has(source.id)) throw new Error("Invalid or duplicate Source ID");
    ids.add(source.id);
    if (!["github", "webhook", "timer", "plugin"].includes(source.type)) throw new Error("Unknown collaboration Source type");
    const actors = names(source.actors, "Source actors"), controllers = names(source.controllers, "Source controllers");
    const config = object(source.configuration);
    if (Object.keys(config).some(key => !allowedConfiguration.has(key)) || !isAbsolute(config.workspace ?? "")) throw new Error("Source requires a fixed absolute Coding workspace");
    const workspace = await realpath(config.workspace);
    const workspaces = config.allowedWorkspaces ?? [workspace];
    if (!Array.isArray(workspaces) || workspaces.length > 16 || workspaces.some(p => typeof p !== "string" || !isAbsolute(p))) throw new Error("Invalid allowed workspaces");
    const allowedWorkspaces = await Promise.all(workspaces.map(p => realpath(p)));
    if (!allowedWorkspaces.includes(workspace)) throw new Error("Source workspace must be explicitly authorized");
    if (typeof config.allowWrite !== "boolean" || typeof config.allowShell !== "boolean" || !Array.isArray(config.checks) || config.checks.length > 64) throw new Error("Explicit Source permissions and checks are required");
    config.checks.forEach((check: string) => text(check, "Source check", 4096));
    if (config.allowWrite && !config.checks.length || config.allowShell && !config.allowWrite) throw new Error("Coding writes require checks; Shell requires write authority");
    if (config.maxCostUsd !== undefined && (typeof config.maxCostUsd !== "number" || !Number.isFinite(config.maxCostUsd) || config.maxCostUsd <= 0)) throw new Error("Invalid Source budget");
    for (const key of ["provider", "model"]) if (config[key] !== undefined) text(config[key], key, 128);
    const mode = source.mode ?? "auto"; if (!["single", "auto", "multi"].includes(mode)) throw new Error("Invalid Source execution mode");
    const entry: Source = { id: source.id, type: source.type, actors, controllers, mode,
      pollIntervalMs: integer(source.pollIntervalMs ?? 15000, "Source polling interval", 1000, 86400000),
      configuration: { ...config, workspace, allowedWorkspaces, strategyVersion: 2,
        maxTurns: integer(config.maxTurns ?? 200, "Source turn limit", 1, 2000),
        maxRetries: integer(config.maxRetries ?? 3, "Source retry limit", 0, 10),
        compactThreshold: integer(config.compactThreshold ?? 24000, "Source compaction threshold", 1000, 10000000),
        maxModelRequests: integer(config.maxModelRequests ?? 256, "Source request limit", 4, 10000) } as Source["configuration"] };
    for (const type of ["github", "webhook", "timer"]) if (source[type] !== undefined && type !== source.type && !(source.type === "timer" && type === "webhook")) throw new Error("Source transport does not match type");
    if (entry.type === "github") {
      const git = object(source.github); keys(git, ["repository", "tokenEnv"]);
      if (typeof git.repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(git.repository) || git.repository.includes("..")) throw new Error("Invalid GitHub repository");
      entry.github = { repository: git.repository, tokenEnv: environmentName(git.tokenEnv) };
    }
    if (entry.type === "webhook" || entry.type === "timer") {
      const hook = object(source.webhook); keys(hook, ["secretEnv", "outboundUrl"]);
      const url = new URL(hook.outboundUrl);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error("Invalid outbound webhook URL; put credentials in the environment");
      if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Remote webhooks require HTTPS");
      entry.webhook = { secretEnv: environmentName(hook.secretEnv), outboundUrl: url.href };
    }
    if (entry.type === "timer") {
      const timer = object(source.timer); keys(timer, ["everyMs", "objective", "thread"]);
      entry.timer = { everyMs: integer(timer.everyMs, "Timer interval", 60000, 365 * 86400000), objective: text(timer.objective, "Timer objective", 4000), thread: text(timer.thread, "Timer thread", 128) };
      if (!actors.includes("timer")) throw new Error("Timer Source must explicitly authorize the timer actor");
    }
    if (entry.type === "plugin") {
      const channel = object(source.channel); keys(channel, ["id", "version", "plugin"]);
      if (typeof channel.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(channel.id)) throw new Error("Invalid plugin channel ID");
      text(channel.version, "channel version", 128);
      if (channel.plugin !== undefined) {
        const identity = object(channel.plugin); keys(identity, ["name", "version", "fingerprint"]);
        text(identity.name, "channel plugin name", 64); text(identity.version, "channel plugin version", 128);
        if (typeof identity.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(identity.fingerprint)) throw new Error("Invalid channel plugin provenance");
      }
      entry.channel = structuredClone(channel) as Source["channel"];
      encodeJson(source.options ?? {}, 32 * 1024); entry.options = source.options ?? {};
    } else if (source.channel !== undefined || source.options !== undefined) throw new Error("Custom channel configuration requires type plugin");
    sources.push(entry);
  }
  let listen: CollaborationConfig["listen"];
  if (root.listen !== undefined) {
    const input = object(root.listen); keys(input, ["hostname", "port"]);
    if (!["127.0.0.1", "::1"].includes(input.hostname)) throw new Error("Webhook ingress must bind a loopback address; use an authenticated bridge/proxy");
    listen = { hostname: input.hostname, port: integer(input.port, "Webhook port", 1, 65535) };
  }
  if (root.enabled && sources.some(source => source.type === "webhook") && !listen) throw new Error("Webhook Sources require a loopback listen endpoint");
  return { enabled: root.enabled, sources, ...(listen ? { listen } : {}) };
}
function environmentName(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value)) throw new Error("Credentials must reference an environment variable name");
  return value;
}
export async function loadCollaborationConfig(configDir: string): Promise<CollaborationConfig> {
  const path = join(configDir, "collaboration.json");
  let content: string;
  try {
    if ((await stat(path)).size > 64 * 1024) throw new Error("Collaboration configuration exceeds size limit");
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { enabled: false, sources: [] };
    throw error;
  }
  return parseCollaborationConfig(JSON.parse(content));
}
