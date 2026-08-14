import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { loadProviderCatalog, resolveProviderSelection } from "../../providers/config";
import { createConfiguredTransport, type ReasoningEffort } from "../../providers/factory";
import type { ModelTransport, TokenUsage } from "../../providers/types";
import { loadAgents } from "../agents/loader";
import { loadMcpConfig } from "../mcp/config";
import { SessionStore } from "../session/storage";
import { CheckpointManager } from "../checkpoint/manager";
import { loadSettings } from "../settings/load";
import {
  getSandboxAvailability,
  type SandboxSettings,
} from "../sandbox/macos";
import { loadSkills, parseSkillMarkdown } from "../skills/loader";
import { bundledSkills } from "../skills/bundled";
import { loadPlugins } from "../plugins/loader";
import { pluginTrustStorePath, revokePluginTrust, trustPlugin } from "../plugins/trust";
import {
  installLocalPlugin,
  loadPluginRuntimeCache,
  removeInstalledPlugin,
} from "../plugins/management";
import {
  configuredMarketplaceSources,
  installMarketplacePlugin,
  loadPluginMarketplace,
  updateMarketplacePlugin,
} from "../plugins/marketplace";
import { HookRunner } from "../hooks/runner";
import {
  listManagedWorktreeJobs,
  removeManagedWorktreeJob,
} from "../worktree/manager";

type Writer = { write(text: string): unknown };

export type ManagementCommandOptions = {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd: string;
  stdout: Writer;
  stderr: Writer;
  configDir?: string;
  transportFactory?: (selection: ReturnType<typeof resolveProviderSelection>, effort?: ReasoningEffort) => ModelTransport;
};

export type DoctorCheck = {
  name: string;
  status: "ok" | "warning" | "error";
  detail: string;
};

export const CLI_HELP = `Usage: tnb [options] [command]

Coding agent with direct, configurable model providers.

Options:
  -p, --print <prompt>            Run one non-interactive Agent turn
  --provider <id>                Select a configured provider
  --model <id>                   Select a configured model
  --thinking <level>             off|minimal|low|medium|high|xhigh
  --fast                         Use Anthropic same-model fast inference (Opus 4.6)
  -a, --attachment <path>       Attach a file to a print-mode prompt (repeatable)
  -w, --worktree [name]         Run the session in a managed Git worktree
  --branch <name>               qoder-compatible worktree name (requires --worktree)
  -s, --sandbox                 Run shell commands in the configured sandbox
  --permission-mode <mode>       default|acceptEdits|auto|dontAsk|plan|yolo
  --yolo                         Bypass permission prompts when policy permits
  --dangerously-skip-permissions Compatibility alias for --yolo
  --add-dir <directory>         Add an approved workspace root (repeatable)
  --session-id <id>             Use a specific ID for a new session
  --fork-session                Fork history when resuming or continuing
  -n, --name <name>             Set the session display name
  --mcp-config <file-or-json>   Add session MCP servers (repeatable)
  --strict-mcp-config           Use only servers from --mcp-config
  --settings <file-or-json>     Merge temporary highest-priority settings
  --agents <json>               Add session-only Agent profiles
  --agent <name>                Run the main thread with an Agent profile
  -c, --continue                 Continue the latest workspace session
  -r, --resume [session-id]      Resume by ID; without ID open the TUI picker
  --output-format <format>       text|json|stream-json (print mode)
  --input-format <format>        text|stream-json (print mode)
  --replay-user-messages        Echo stream-json user records to stdout
  --include-hook-events         Include Hook lifecycle records in stream-json
  --include-partial-messages    Include text/reasoning/tool-input stream deltas
  --max-turns <count>           Stop after this many model turns
  --max-budget-usd <amount>     Stop when the current invocation exceeds this cost
  --fallback-model <id>         Use another configured model if the primary fails before output
  --json-schema <schema>        Require a final structured object matching JSON Schema
  --init                        Run Setup:init Hooks before the session
  --init-only                   Run Setup:init and SessionStart Hooks, then exit
  --maintenance                 Run Setup:maintenance Hooks before the session
  --allowed-tools <names>       Restrict tools (repeatable or comma-separated)
  --disallowed-tools <names>    Remove tools (repeatable or comma-separated)
  --tools <names>               Select exposed tools; "default" keeps all
  --system-prompt <text>        Replace the built-in coding-agent prompt
  --system-prompt-file <path>   Replace the prompt from a UTF-8 file
  --append-system-prompt <text> Append instructions to the system prompt
  --append-system-prompt-file <path>
                                 Append instructions from a UTF-8 file
  -V, --version                  Print version
  -h, --help                     Show help

Commands:
  models                         List configured providers and models
  provider                       Add, inspect, or remove custom providers
  config [list|get|set|unset|path]
                                 Inspect or edit settings
  status                         Show effective local configuration
  doctor                         Validate local runtime and configuration
  sessions                       List workspace sessions
  jobs                           List and remove local worktree jobs
  rm <job-id>                    Remove a local worktree job
  rollback [checkpoint-id]       List or restore workspace checkpoints
  goal-loop <objective>          Run a persistent autonomous goal to completion
  goal-loop-stop [session-id]    Pause a running/persisted goal loop
  security-scan [paths...]       Run local deterministic SAST checks
  feedback                       Submit feedback to a configured endpoint
  update                         Check or install a verified CLI release
  remote-control                 Run the bidirectional stdio control protocol
  ide                            Discover and control local IDE bridges
  completion <shell>             Print Bash, Zsh, or Fish completion script
  skills                         List discovered skills
  plugins                        Manage local plugins and marketplaces
  agents                         List discovered Agent profiles
  hooks                          List configured lifecycle hooks
  mcp                            Manage and inspect MCP servers

Run tnb <command> --help for command-specific usage.
`;

export async function runRollbackCommand(options: ManagementCommandOptions): Promise<number> {
  try {
    const configDir = resolveConfigDir(options);
    const manager = new CheckpointManager(configDir);
    const id = options.argv[1];
    if (!id || id === "list") {
      const records = await manager.list(options.cwd);
      if (options.argv.includes("--json")) options.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
      else if (!records.length) options.stdout.write("No checkpoints found.\n");
      else for (const record of records) {
        options.stdout.write(`${record.id}\t${record.createdAt}\t${record.automatic ? "automatic" : "manual"}\t${record.label}\n`);
      }
      return 0;
    }
    if (id === "--help" || id === "-h" || id === "help") {
      options.stdout.write(`Usage: tnb rollback [checkpoint-id] [--yes] [--force] [--files-only]

With no checkpoint id, lists checkpoints for the current Git workspace.
Restoring requires --yes. Automatic turn checkpoints also rewind their linked
conversation unless --files-only is supplied.
`);
      return 0;
    }
    if (!options.argv.includes("--yes")) throw new Error("rollback requires --yes because it replaces workspace files");
    const record = await manager.rollback(options.cwd, id, options.argv.includes("--force"));
    let conversation = "";
    if (!options.argv.includes("--files-only") && record.sessionId && record.sessionCwd && record.messageCount !== undefined) {
      const session = new SessionStore({
        configDir,
        cwd: record.sessionCwd,
        sessionId: record.sessionId,
      });
      const state = await session.readState();
      if (record.messageCount > state.messages.length) {
        throw new Error(`Checkpoint conversation boundary exceeds session ${record.sessionId}`);
      }
      await session.appendRewindBoundary(state.messages.slice(0, record.messageCount));
      conversation = ` and rewound session ${record.sessionId}`;
    }
    options.stdout.write(`Restored checkpoint ${record.id}: ${record.label}${conversation}\n`);
    return 0;
  } catch (error) {
    options.stderr.write(`tnb: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export async function runJobsCommand(options: ManagementCommandOptions): Promise<number> {
  try {
    const directRemove = options.argv[0] === "rm";
    const requestedAction = options.argv[1];
    const action = directRemove ? "rm" : !requestedAction || requestedAction.startsWith("-") ? "list" : requestedAction;
    if (action === "--help" || action === "-h" || action === "help") {
      options.stdout.write(`Usage: tnb jobs [list|show <id>|rm <id>] [options]
       tnb rm <id> --yes [--discard-changes]

Lists tnb-managed Git worktrees for the current repository.

Options:
  --json                 Emit machine-readable JSON
  --yes                  Confirm worktree removal
  --discard-changes      Permit deletion when changes or unique commits exist
`);
      return 0;
    }
    if (action === "list") {
      const jobs = await listManagedWorktreeJobs(options.cwd);
      if (options.argv.includes("--json") || optionValue(options.argv, "--output-format") === "json") {
        options.stdout.write(`${JSON.stringify(jobs, null, 2)}\n`);
      } else if (jobs.length === 0) {
        options.stdout.write("No local worktree jobs.\n");
      } else {
        options.stdout.write("ID\tCHANGES\tCOMMITS\tBRANCH\tPATH\n");
        for (const job of jobs) {
          options.stdout.write(`${job.id}\t${job.changedFiles}\t${job.uniqueCommits}\t${job.branch}\t${job.path}\n`);
        }
      }
      return 0;
    }
    if (action === "show") {
      const id = options.argv[2];
      if (!id) throw new Error("jobs show requires a job ID");
      const job = (await listManagedWorktreeJobs(options.cwd)).find((candidate) => candidate.id === id);
      if (!job) throw new Error(`No managed worktree job found with ID: ${id}`);
      options.stdout.write(`${JSON.stringify(job, null, 2)}\n`);
      return 0;
    }
    if (action === "rm" || action === "remove") {
      const id = directRemove ? options.argv[1] : options.argv[2];
      if (!id) throw new Error(`${directRemove ? "rm" : `jobs ${action}`} requires a job ID`);
      if (!options.argv.includes("--yes")) throw new Error("worktree job removal requires --yes");
      const job = await removeManagedWorktreeJob(options.cwd, id, {
        discardChanges: options.argv.includes("--discard-changes"),
      });
      options.stdout.write(`Removed worktree job ${job.id} (${job.path})\n`);
      return 0;
    }
    throw new Error(`Unknown jobs command: ${action}`);
  } catch (error) {
    options.stderr.write(`tnb: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export async function runConfigCommand(options: ManagementCommandOptions): Promise<number> {
  try {
    if (options.argv.includes("--help") || options.argv.includes("-h")) {
      options.stdout.write(`Usage: tnb config [list|get|set|unset|path] [key] [value]

Edits ~/.tnb/settings.json by default. Add --project to use
<workspace>/.tnb/settings.local.json. Keys use dotted paths.

Examples:
  tnb config get permissions.defaultMode
  tnb config set permissions.defaultMode '"acceptEdits"'
  tnb config set security.disableYolo true --project
  tnb config unset security.disableYolo
`);
      return 0;
    }
    const path = settingsPath(options);
    const action = options.argv[1] ?? "list";
    if (action === "path") {
      options.stdout.write(`${path}\n`);
      return 0;
    }
    const document = await readJsonObject(path);
    if (action === "list") {
      options.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
      return 0;
    }
    const key = options.argv[2];
    if (!key) throw new Error(`config ${action} requires a dotted key`);
    const segments = parseKey(key);
    if (action === "get") {
      const value = getPath(document, segments);
      if (value === undefined) return 1;
      options.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
      return 0;
    }
    if (action === "set") {
      const raw = options.argv[3];
      if (raw === undefined) throw new Error("config set requires a JSON value");
      setPath(document, segments, parseConfigValue(raw));
      await beforeSettingsChange(options, path);
      await writeJsonAtomic(path, document);
      options.stdout.write(`Updated ${key} in ${path}\n`);
      return 0;
    }
    if (action === "unset") {
      if (!deletePath(document, segments)) return 1;
      await beforeSettingsChange(options, path);
      await writeJsonAtomic(path, document);
      options.stdout.write(`Removed ${key} from ${path}\n`);
      return 0;
    }
    throw new Error(`Unknown config command: ${action}`);
  } catch (error) {
    options.stderr.write(`tnb: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export async function runStatusCommand(options: ManagementCommandOptions): Promise<number> {
  try {
    const configDir = resolveConfigDir(options);
    const [catalog, settings, sessions] = await Promise.all([
      loadProviderCatalog({ configDir, env: options.env }),
      loadSettings({ configDir, cwd: options.cwd }),
      SessionStore.list({ configDir, cwd: options.cwd }),
    ]);
    const providerId = optionValue(options.argv, "--provider") ?? options.env.TNB_PROVIDER ?? settings.provider ?? "anthropic";
    const modelId = optionValue(options.argv, "--model") ?? options.env.TNB_MODEL ?? settings.model;
    const selection = resolveProviderSelection(catalog, providerId, modelId);
    const status = {
      configDir,
      workspace: options.cwd,
      provider: selection.provider.id,
      api: selection.provider.api,
      baseUrl: selection.provider.baseUrl,
      model: selection.model.id,
      credentials: selection.provider.apiKey ? "configured" : "not configured",
      permissionMode: settings.permissions?.defaultMode ?? "default",
      disableYolo: settings.security?.disableYolo === true || settings.permissions?.disableBypassPermissionsMode === "disable",
      trustedWorkspace: settings.security?.trustedFolders?.includes(options.cwd) ?? false,
      sandbox: settings.tools?.sandbox ?? false,
      sessions: sessions.length,
    };
    if (options.argv.includes("--json") || optionValue(options.argv, "--output-format") === "json") {
      options.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    } else {
      options.stdout.write([
        `Workspace: ${status.workspace}`,
        `Config: ${status.configDir}`,
        `Provider: ${status.provider} (${status.api})`,
        `Endpoint: ${status.baseUrl}`,
        `Model: ${status.model}`,
        `Credentials: ${status.credentials}`,
        `Permission mode: ${status.permissionMode}`,
        `YOLO disabled by policy: ${status.disableYolo ? "yes" : "no"}`,
        `Workspace trusted: ${status.trustedWorkspace ? "yes" : "no"}`,
        `Sandbox: ${formatSandboxStatus(status.sandbox)}`,
        `Workspace sessions: ${status.sessions}`,
      ].join("\n") + "\n");
    }
    return 0;
  } catch (error) {
    options.stderr.write(`tnb: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function formatSandboxStatus(value: SandboxSettings | undefined): string {
  if (value === true) return "enabled (restrictive/open)";
  if (!value) return "disabled";
  if (value.enabled === false) return "disabled";
  return `enabled (${value.profile ?? "restrictive"}/${value.network ?? (value.networkAccess === false ? "blocked" : "open")})`;
}

export async function runProviderCommand(options: ManagementCommandOptions): Promise<number> {
  try {
    const action = options.argv[1] ?? "list";
    if (action === "--help" || action === "-h" || action === "help") {
      options.stdout.write(`Usage: tnb provider <list|show|add|set|use|test|remove|model> [id] [options]

Add options:
  --api <protocol>          anthropic-messages|openai-completions|openai-responses
  --base-url <url>          Provider API root
  --model <id>              Initial default model
  --api-key-env <name>      Store an environment-variable reference, never the secret
  --name <display-name>     Optional provider display name
  --context-window <tokens> Default: 128000
  --max-tokens <tokens>     Default: 16384
  --reasoning               Mark the model reasoning-capable
  --vision                  Mark the model vision-capable
  --pdf                     Mark the model PDF-capable
  --header <name=value>     Repeatable provider/model header
  --sampling <name=json>    Repeatable model sampling parameter
  --reasoning-effort        Endpoint accepts reasoning effort
  --thinking-format <type>  openai|deepseek|qwen|openrouter
  --compat-profile <name>   generic|glm|qwen|deepseek|openrouter
  --anthropic-required-tool-choice <mode>
                             any|auto for Anthropic-compatible gateways
  --max-tokens-field <name> max_tokens|max_completion_tokens

Examples:
  tnb provider add deepseek --api openai-completions --base-url https://api.deepseek.com/v1 --model deepseek-chat --api-key-env DEEPSEEK_API_KEY
  tnb provider show deepseek
  tnb provider use deepseek --model deepseek-chat
  tnb provider test deepseek --model deepseek-chat
  tnb provider test deepseek --tools --json
  tnb provider remove deepseek --yes
  tnb provider model add deepseek deepseek-reasoner --reasoning
  tnb provider model default deepseek deepseek-reasoner
`);
      return 0;
    }
    if (action === "list") return runProviderList(options);
    if (action === "model") return runProviderModelCommand(options);
    const id = options.argv[2];
    if (!id || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) {
      throw new Error(`provider ${action} requires a valid provider id`);
    }
    if (action === "use") {
      const catalog = await loadProviderCatalog({ configDir: resolveConfigDir(options), env: options.env });
      const requestedModel = optionValue(options.argv, "--model");
      const selection = resolveProviderSelection(catalog, id, requestedModel);
      const path = settingsPath(options);
      const settings = await readJsonObject(path);
      settings.provider = selection.provider.id;
      settings.model = selection.model.id;
      await beforeSettingsChange(options, path);
      await writeJsonAtomic(path, settings);
      options.stdout.write(`Default model set to ${selection.provider.id}/${selection.model.id} in ${path}\n`);
      return 0;
    }
    if (action === "test") return runProviderTest(options, id);
    const path = join(resolveConfigDir(options), "models.json");
    const document = await readJsonObject(path);
    const providers = objectOrEmpty(document.providers, `models.providers must be an object: ${path}`);
    if (action === "show") {
      const provider = providers[id];
      if (provider === undefined) throw new Error(`Custom provider not found: ${id}`);
      options.stdout.write(`${JSON.stringify(provider, null, 2)}\n`);
      return 0;
    }
    if (action === "remove") {
      if (!options.argv.includes("--yes")) throw new Error("provider remove requires --yes");
      if (!(id in providers)) throw new Error(`Custom provider not found: ${id}`);
      delete providers[id];
      document.providers = providers;
      await writeJsonAtomic(path, document);
      options.stdout.write(`Removed provider ${id} from ${path}\n`);
      return 0;
    }
    if (action === "set") {
      if (!(id in providers)) throw new Error(`Custom provider not found: ${id}`);
      const provider = objectOrEmpty(providers[id], `Provider ${id} must be an object`);
      let changed = false;
      const baseUrl = optionValue(options.argv, "--base-url");
      if (baseUrl) {
        validateHttpUrl(baseUrl, "--base-url");
        provider.baseUrl = baseUrl;
        changed = true;
      }
      const displayName = optionValue(options.argv, "--name");
      if (displayName) { provider.name = displayName; changed = true; }
      const apiKeyEnv = optionValue(options.argv, "--api-key-env");
      if (apiKeyEnv) {
        validateEnvironmentName(apiKeyEnv);
        provider.apiKey = `$${apiKeyEnv}`;
        changed = true;
      }
      if (options.argv.includes("--clear-api-key")) { delete provider.apiKey; changed = true; }
      const headers = assignmentObject(options.argv, "--header", false);
      if (headers) { provider.headers = { ...objectOrEmpty(provider.headers, `Provider ${id}.headers must be an object`), ...headers }; changed = true; }
      const compat = compatibilityOptions(options.argv);
      if (compat) { provider.compat = { ...objectOrEmpty(provider.compat, `Provider ${id}.compat must be an object`), ...compat }; changed = true; }
      if (!changed) throw new Error("provider set requires at least one setting option");
      providers[id] = provider;
      document.providers = providers;
      await writeJsonAtomic(path, document);
      options.stdout.write(`Updated provider ${id} in ${path}\n`);
      return 0;
    }
    if (action !== "add") throw new Error(`Unknown provider command: ${action}`);
    if (id in providers && !options.argv.includes("--force")) {
      throw new Error(`Provider ${id} already exists; pass --force to replace it`);
    }
    const api = requiredOption(options.argv, "--api");
    if (api !== "anthropic-messages" && api !== "openai-completions" && api !== "openai-responses") {
      throw new Error("--api must be anthropic-messages, openai-completions, or openai-responses");
    }
    const baseUrl = requiredOption(options.argv, "--base-url");
    validateHttpUrl(baseUrl, "--base-url");
    const model = requiredOption(options.argv, "--model");
    const apiKeyEnv = optionValue(options.argv, "--api-key-env");
    if (apiKeyEnv) validateEnvironmentName(apiKeyEnv);
    const contextWindow = positiveOption(options.argv, "--context-window", 128_000);
    const maxTokens = positiveOption(options.argv, "--max-tokens", 16_384);
    const displayName = optionValue(options.argv, "--name");
    providers[id] = {
      ...(displayName ? { name: displayName } : {}),
      api,
      baseUrl,
      ...(apiKeyEnv ? { apiKey: `$${apiKeyEnv}` } : {}),
      ...(assignmentObject(options.argv, "--header", false) ? { headers: assignmentObject(options.argv, "--header", false) } : {}),
      ...(compatibilityOptions(options.argv) ? { compat: compatibilityOptions(options.argv) } : {}),
      models: [{
        id: model,
        contextWindow,
        maxTokens,
        reasoning: options.argv.includes("--reasoning"),
        supportsVision: options.argv.includes("--vision"),
        supportsPdf: options.argv.includes("--pdf"),
        ...(assignmentObject(options.argv, "--sampling", true) ? { samplingParams: assignmentObject(options.argv, "--sampling", true) } : {}),
      }],
    };
    document.providers = providers;
    await writeJsonAtomic(path, document);
    options.stdout.write(`Added provider ${id} to ${path}\n`);
    return 0;
  } catch (error) {
    options.stderr.write(`tnb: ${errorMessage(error)}\n`);
    return 1;
  }
}

async function runProviderTest(options: ManagementCommandOptions, providerId: string): Promise<number> {
  const catalog = await loadProviderCatalog({ configDir: resolveConfigDir(options), env: options.env });
  const selection = resolveProviderSelection(catalog, providerId, optionValue(options.argv, "--model"));
  const effort = parseProviderTestEffort(optionValue(options.argv, "--thinking"));
  const transport = (options.transportFactory ?? createConfiguredTransport)(selection, effort);
  const toolProbe = options.argv.includes("--tools");
  const tools = toolProbe ? [{
    name: "provider_diagnostic",
    description: "Call this function exactly once to confirm tool-call streaming compatibility.",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string", const: "ok" } },
      required: ["value"],
      additionalProperties: false,
    },
  }] : [];
  let text = "";
  let toolName: string | undefined;
  let toolInput = "";
  let stopReason: string | undefined;
  let usage: TokenUsage | undefined;
  let eventCount = 0;
  for await (const event of transport.stream({
    model: selection.model.id,
    systemPrompt: "You are running a provider compatibility diagnostic. Follow the user request exactly and do not add commentary.",
    maxOutputTokens: Math.min(selection.model.maxTokens, 256),
    messages: [{
      role: "user",
      content: [{ type: "text", text: toolProbe ? "Call provider_diagnostic with value ok." : "Reply with exactly: OK" }],
    }],
    tools,
    ...(toolProbe ? { toolChoice: "required" as const } : {}),
  })) {
    eventCount += 1;
    if (event.type === "text") text += event.text;
    else if (event.type === "tool-start") toolName = event.name;
    else if (event.type === "tool-input") toolInput += event.json;
    else if (event.type === "usage") usage = event.usage;
    else if (event.type === "response-end") stopReason = event.reason;
  }
  if (!stopReason) throw new Error("Provider stream ended without a terminal response event");
  if (toolProbe && toolName !== "provider_diagnostic") {
    throw new Error(`Provider did not produce the required diagnostic tool call${toolName ? `; received ${toolName}` : ""}`);
  }
  if (!toolProbe && !text.trim()) throw new Error("Provider returned no text content");
  if (toolProbe) {
    let parsed: unknown;
    try { parsed = JSON.parse(toolInput); } catch { throw new Error("Provider returned malformed streamed tool arguments"); }
    if (typeof parsed !== "object" || parsed === null || (parsed as { value?: unknown }).value !== "ok") {
      throw new Error("Provider returned an unexpected diagnostic tool argument");
    }
  }
  const result = {
    ok: true,
    provider: selection.provider.id,
    api: selection.provider.api,
    endpoint: selection.provider.baseUrl,
    model: selection.model.id,
    probe: toolProbe ? "tool-use" : "text",
    stopReason,
    eventCount,
    ...(text.trim() ? { text: text.trim() } : {}),
    ...(toolName ? { toolCall: { name: toolName, input: JSON.parse(toolInput) as unknown } } : {}),
    ...(usage ? { usage } : {}),
  };
  if (options.argv.includes("--json") || optionValue(options.argv, "--output-format") === "json") {
    options.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    options.stdout.write(`Provider diagnostic passed: ${result.provider}/${result.model} (${result.api}, ${result.probe}, ${result.eventCount} events, stop=${result.stopReason})\n`);
  }
  return 0;
}

function parseProviderTestEffort(value: string | undefined): ReasoningEffort | undefined {
  if (value === undefined) return undefined;
  if (["off", "minimal", "low", "medium", "high", "xhigh"].includes(value)) return value as ReasoningEffort;
  throw new Error("--thinking must be off, minimal, low, medium, high, or xhigh");
}

async function runProviderModelCommand(options: ManagementCommandOptions): Promise<number> {
  const action = options.argv[2] ?? "list";
  const providerId = options.argv[3];
  if (!providerId) throw new Error(`provider model ${action} requires a provider id`);
  const path = join(resolveConfigDir(options), "models.json");
  const document = await readJsonObject(path);
  const providers = objectOrEmpty(document.providers, `models.providers must be an object: ${path}`);
  const provider = objectOrEmpty(providers[providerId], `Custom provider not found: ${providerId}`);
  if (!(providerId in providers)) throw new Error(`Custom provider not found: ${providerId}`);
  if (!Array.isArray(provider.models)) throw new Error(`Provider ${providerId}.models must be an array`);
  const models = provider.models.map((value, index) => objectOrEmpty(value, `Provider ${providerId}.models[${index}] must be an object`));
  if (action === "list") {
    const rows = models.map((model, index) => ({
      id: String(model.id),
      contextWindow: model.contextWindow ?? 128_000,
      maxTokens: model.maxTokens ?? 16_384,
      default: index === 0,
    }));
    writeRows(options, rows, (model) => `${model.id}${model.default ? " *" : ""}\t${String(model.contextWindow)}\t${String(model.maxTokens)}`);
    return 0;
  }
  const modelId = options.argv[4];
  if (!modelId) throw new Error(`provider model ${action} requires a model id`);
  const index = models.findIndex((model) => model.id === modelId);
  if (action === "default") {
    if (index < 0) throw new Error(`Unknown model for provider ${providerId}: ${modelId}`);
    const [selected] = models.splice(index, 1);
    models.unshift(selected!);
  } else if (action === "remove") {
    if (!options.argv.includes("--yes")) throw new Error("provider model remove requires --yes");
    if (index < 0) throw new Error(`Unknown model for provider ${providerId}: ${modelId}`);
    if (models.length === 1) throw new Error(`Provider ${providerId} must retain at least one model`);
    models.splice(index, 1);
  } else if (action === "add" || action === "set") {
    if (action === "set" && index < 0) throw new Error(`Unknown model for provider ${providerId}: ${modelId}`);
    if (action === "add" && index >= 0 && !options.argv.includes("--force")) throw new Error(`Model ${providerId}/${modelId} already exists; pass --force to replace it`);
    const existing = index >= 0 ? models[index]! : {};
    const model = action === "add"
      ? {
          id: modelId,
          contextWindow: positiveOption(options.argv, "--context-window", 128_000),
          maxTokens: positiveOption(options.argv, "--max-tokens", 16_384),
          reasoning: options.argv.includes("--reasoning"),
          supportsVision: options.argv.includes("--vision"),
          supportsPdf: options.argv.includes("--pdf"),
          ...(assignmentObject(options.argv, "--header", false) ? { headers: assignmentObject(options.argv, "--header", false) } : {}),
          ...(assignmentObject(options.argv, "--sampling", true) ? { samplingParams: assignmentObject(options.argv, "--sampling", true) } : {}),
          ...(compatibilityOptions(options.argv) ? { compat: compatibilityOptions(options.argv) } : {}),
        }
      : updateModel(existing, options.argv);
    if (index >= 0) models[index] = model;
    else models.push(model);
  } else {
    throw new Error(`Unknown provider model command: ${action}`);
  }
  provider.models = models;
  providers[providerId] = provider;
  document.providers = providers;
  await writeJsonAtomic(path, document);
  options.stdout.write(`Updated models for provider ${providerId} in ${path}\n`);
  return 0;
}

async function runProviderList(options: ManagementCommandOptions): Promise<number> {
  const catalog = await loadProviderCatalog({ configDir: resolveConfigDir(options), env: options.env });
  const rows = Object.values(catalog.providers).map((provider) => ({
    id: provider.id,
    name: provider.name,
    api: provider.api,
    baseUrl: provider.baseUrl,
    models: provider.models.map(({ id }) => id),
  }));
  writeRows(options, rows, (row) => `${row.id}\t${row.api}\t${row.models.join(", ")}\t${row.baseUrl}`);
  return 0;
}

export async function collectDoctorChecks(options: ManagementCommandOptions): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const configDir = resolveConfigDir(options);
  try {
    const catalog = await loadProviderCatalog({ configDir, env: options.env });
    checks.push({ name: "models", status: "ok", detail: `${Object.keys(catalog.providers).length} providers loaded` });
  } catch (error) {
    checks.push({ name: "models", status: "error", detail: errorMessage(error) });
  }
  try {
    const settings = await loadSettings({ configDir, cwd: options.cwd });
    checks.push({ name: "settings", status: "ok", detail: settings.warnings?.join("; ") || "valid" });
  } catch (error) {
    checks.push({ name: "settings", status: "error", detail: errorMessage(error) });
  }
  try {
    const mcp = await loadMcpConfig(options.env.TNB_MCP_CONFIG ?? join(configDir, "mcp.json"), options.env);
    checks.push({ name: "mcp", status: "ok", detail: `${Object.keys(mcp.mcpServers).length} servers configured` });
  } catch (error) {
    checks.push({ name: "mcp", status: "error", detail: errorMessage(error) });
  }
  checks.push(commandCheck("ripgrep", "rg", "required by grep and glob tools"));
  checks.push(commandCheck("node", options.env.TNB_NODE_PATH ?? "node", "required only for PTY shell mode"));
  try {
    const settings = await loadSettings({ configDir, cwd: options.cwd });
    const sandbox = getSandboxAvailability({
      settings: settings.tools?.sandbox,
      env: options.env,
    });
    checks.push({
      name: "sandbox",
      status: sandbox.supported ? "ok" : settings.tools?.sandbox ? "error" : "warning",
      detail: sandbox.supported
        ? `${sandbox.resolvedCommand ?? sandbox.requestedCommand} · ${sandbox.capabilities.filesystem} filesystem · network ${sandbox.capabilities.networkModes.join("/") || "blocked"}`
        : sandbox.reason ?? "sandbox unavailable",
    });
  } catch (error) {
    checks.push({ name: "sandbox", status: "error", detail: errorMessage(error) });
  }
  const hasCredential = Boolean(options.env.ANTHROPIC_API_KEY || options.env.OPENAI_API_KEY);
  checks.push({
    name: "credentials",
    status: hasCredential ? "ok" : "warning",
    detail: hasCredential ? "built-in provider credential found" : "no built-in provider API key found; custom keyless providers may still work",
  });
  return checks;
}

export async function runDoctorCommand(options: ManagementCommandOptions): Promise<number> {
  const checks = await collectDoctorChecks(options);
  const json = options.argv.includes("--json") || optionValue(options.argv, "--output-format") === "json";
  if (json) options.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
  else for (const check of checks) options.stdout.write(`${check.status.toUpperCase().padEnd(7)} ${check.name}: ${check.detail}\n`);
  return checks.some(({ status }) => status === "error") ? 1 : 0;
}

export async function runResourceListCommand(options: ManagementCommandOptions): Promise<number> {
  try {
    const configDir = resolveConfigDir(options);
    const command = options.argv[0];
    if (command === "sessions") {
      const action = options.argv[1] ?? "list";
      if (action === "--help" || action === "-h" || action === "help") {
        options.stdout.write(`Usage: tnb sessions [list|show|delete] [session-id]

  tnb sessions
  tnb sessions show <session-id> [--json]
  tnb sessions delete <session-id> --yes
`);
        return 0;
      }
      if (action === "show" || action === "delete") {
        const sessionId = options.argv[2];
        if (!sessionId) throw new Error(`sessions ${action} requires a session id`);
        const session = new SessionStore({ configDir, cwd: options.cwd, sessionId });
        if (action === "delete") {
          if (!options.argv.includes("--yes")) throw new Error("sessions delete requires --yes");
          await session.delete();
          options.stdout.write(`Deleted session ${sessionId}\n`);
          return 0;
        }
        const state = await session.readState();
        if (options.argv.includes("--json")) options.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
        else {
          for (const message of state.messages) {
            const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
            if (text) options.stdout.write(`${message.role}> ${text}\n\n`);
          }
        }
        return 0;
      }
      if (action !== "list") throw new Error(`Unknown sessions command: ${action}`);
      const sessions = await SessionStore.list({ configDir, cwd: options.cwd });
      if (options.argv.includes("--json")) options.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`);
      else for (const session of sessions) options.stdout.write(`${session.sessionId}\t${new Date(session.lastModified).toISOString()}\t${session.lastPrompt ?? session.firstPrompt ?? ""}\n`);
      return 0;
    }
    if (command === "skills") {
      const action = options.argv[1] ?? "list";
      if (action === "install" || action === "remove") {
        const sourceOrName = options.argv[2];
        if (!sourceOrName) throw new Error(`skills ${action} requires ${action === "install" ? "a source directory" : "a skill name"}`);
        const root = options.argv.includes("--project")
          ? join(options.cwd, ".tnb", "skills")
          : join(configDir, "skills");
        if (action === "install") {
          const source = resolve(sourceOrName);
          const info = await stat(source);
          if (!info.isDirectory()) throw new Error("Skill install source must be a directory containing SKILL.md");
          const markdown = await readFile(join(source, "SKILL.md"), "utf8");
          const skill = parseSkillMarkdown(markdown, join(source, "SKILL.md"));
          const target = join(root, skill.name);
          if (await pathExists(target)) throw new Error(`Skill already exists: ${skill.name}`);
          await mkdir(root, { recursive: true });
          await cp(source, target, { recursive: true, errorOnExist: true });
          options.stdout.write(`Installed skill ${skill.name} to ${target}\n`);
          return 0;
        }
        if (!options.argv.includes("--yes")) throw new Error("skills remove requires --yes");
        const target = join(root, validateResourceName(sourceOrName));
        if (!await pathExists(target)) throw new Error(`Skill not found: ${sourceOrName}`);
        await rm(target, { recursive: true });
        options.stdout.write(`Removed skill ${sourceOrName} from ${target}\n`);
        return 0;
      }
      if (action !== "list" && action !== "show") throw new Error("Usage: tnb skills [list|show <name>|install <dir>|remove <name> --yes] [--project]");
      const settings = await loadSettings({ configDir, cwd: options.cwd });
      const plugins = await loadPlugins([
        { directory: join(configDir, "plugins"), source: "user" },
        { directory: join(options.cwd, ".tnb", "plugins"), source: "project" },
      ], settings.enabledPlugins, { trustStorePath: pluginTrustStorePath(configDir) });
      const skills = await loadSkills([
        { directory: join(configDir, "skills"), source: "user" },
        { directory: join(options.cwd, ".tnb", "skills"), source: "project" },
        ...plugins.plugins.filter((plugin) => plugin.active).map((plugin) => ({ directory: plugin.skillsDir, source: "plugin" as const })),
      ], bundledSkills());
      const rows = skills.map(({ name, description, source, baseDir }) => ({ name, description, source, filePath: join(baseDir, "SKILL.md") }));
      if (action === "show") {
        const requested = options.argv[2];
        const skill = skills.find(({ name }) => name.toLowerCase() === requested?.toLowerCase());
        if (!skill) throw new Error(`Skill not found: ${requested ?? "(missing)"}`);
        options.stdout.write(`${JSON.stringify({ ...skill, filePath: join(skill.baseDir, "SKILL.md") }, null, 2)}\n`);
        return 0;
      }
      writeRows(options, rows, (row) => `${row.name}\t${row.source}\t${row.description}`);
      return 0;
    }
    if (command === "plugins") {
      const action = options.argv[1] ?? "list";
      if (action === "marketplace" || action === "search") {
        const sources = await configuredMarketplaceSources(configDir, options.env);
        if (!sources.length) throw new Error("No plugin marketplace configured; set TNB_PLUGIN_MARKETPLACE or ~/.tnb/marketplaces.json");
        const result = await loadPluginMarketplace(sources);
        const query = (action === "search" ? options.argv[2] : undefined)?.toLowerCase();
        const runtimeCache = await loadPluginRuntimeCache(join(configDir, "plugins", ".runtime"));
        const installed = await loadPlugins([
          { directory: join(configDir, "plugins"), source: "user" },
          { directory: join(options.cwd, ".tnb", "plugins"), source: "project" },
        ], {}, { trustStorePath: pluginTrustStorePath(configDir) });
        const rows = query
          ? result.plugins.filter((plugin) =>
            `${plugin.name} ${plugin.description ?? ""} ${plugin.tags?.join(" ") ?? ""} ${plugin.capabilities?.join(" ") ?? ""}`.toLowerCase().includes(query)
          )
          : result.plugins;
        const installedByName = new Map(installed.plugins.map((plugin) => [plugin.name.toLowerCase(), plugin]));
        writeRows(options, rows.map((plugin) => {
          const existing = installedByName.get(plugin.name.toLowerCase());
          const runtime = runtimeCache.get(plugin.name.toLowerCase());
          return {
            ...plugin,
            installed: Boolean(existing),
            installedVersion: existing?.version,
            installedScope: existing?.source,
            runtimeStatus: runtime?.latest.status,
          };
        }), (plugin) =>
          `${plugin.name}\t${plugin.version}\t${plugin.marketplace}\t${plugin.installed ? `${plugin.installedScope}:${plugin.installedVersion ?? "-"}` : "-"}\t${plugin.runtimeStatus ?? "-"}\t${plugin.description ?? plugin.repository}`
        );
        for (const error of result.errors) options.stderr.write(`tnb: ${error.source}: ${error.error}\n`);
        return result.errors.length && !rows.length ? 1 : 0;
      }
      if (["install", "update", "remove", "enable", "disable", "trust", "untrust"].includes(action)) {
        const sourceOrName = options.argv[2];
        if (!sourceOrName) throw new Error(`plugins ${action} requires an argument`);
        if (action === "trust" || action === "untrust") {
          if (!options.argv.includes("--yes")) throw new Error(`plugins ${action} requires --yes`);
          const settings = await loadSettings({ configDir, cwd: options.cwd });
          const result = await loadPlugins([
            { directory: join(configDir, "plugins"), source: "user" },
            { directory: join(options.cwd, ".tnb", "plugins"), source: "project" },
          ], settings.enabledPlugins, { trustStorePath: pluginTrustStorePath(configDir) });
          const plugin = result.plugins.find(({ name }) => name.toLowerCase() === sourceOrName.toLowerCase());
          if (!plugin) throw new Error(`Plugin not found: ${sourceOrName}`);
          if (action === "trust") {
            await trustPlugin(pluginTrustStorePath(configDir), plugin.root, plugin.fingerprint);
            options.stdout.write(`Trusted plugin ${plugin.name} at content fingerprint ${plugin.fingerprint}\n`);
          } else {
            await revokePluginTrust(pluginTrustStorePath(configDir), plugin.root);
            options.stdout.write(`Revoked trust for plugin ${plugin.name}\n`);
          }
          return 0;
        }
        if (action === "enable" || action === "disable") {
          const path = settingsPath(options);
          const document = await readJsonObject(path);
          const enabled = objectOrEmpty(document.enabledPlugins, `enabledPlugins must be an object: ${path}`);
          enabled[validateResourceName(sourceOrName)] = action === "enable";
          document.enabledPlugins = enabled;
          await writeJsonAtomic(path, document);
          options.stdout.write(`${action === "enable" ? "Enabled" : "Disabled"} plugin ${sourceOrName} in ${path}\n`);
          return 0;
        }
        const root = options.argv.includes("--project")
          ? join(options.cwd, ".tnb", "plugins")
          : join(configDir, "plugins");
        const sourceType = options.argv.includes("--project") ? "project" as const : "user" as const;
        if (action === "update") {
          const sources = await configuredMarketplaceSources(configDir, options.env);
          if (!sources.length) throw new Error("No plugin marketplace configured");
          const catalog = await loadPluginMarketplace(sources);
          const requested = catalog.plugins.find((plugin) => plugin.name.toLowerCase() === sourceOrName.toLowerCase());
          if (!requested) throw new Error(`Marketplace plugin not found: ${sourceOrName}`);
          const result = await updateMarketplacePlugin({ plugin: requested, targetRoot: root, sourceType });
          options.stdout.write(`Updated plugin ${result.plugin.name} from ${result.previousVersion ?? "unknown"} to ${result.plugin.version ?? requested.version}\n`);
          return 0;
        }
        if (action === "install") {
          if (options.argv.includes("--marketplace")) {
            const sources = await configuredMarketplaceSources(configDir, options.env);
            if (!sources.length) throw new Error("No plugin marketplace configured");
            const catalog = await loadPluginMarketplace(sources);
            const requested = catalog.plugins.find((plugin) => plugin.name.toLowerCase() === sourceOrName.toLowerCase());
            if (!requested) throw new Error(`Marketplace plugin not found: ${sourceOrName}`);
            if (await pathExists(join(root, requested.name))) throw new Error(`Plugin already exists: ${requested.name}`);
            const plugin = await installMarketplacePlugin({ plugin: requested, targetRoot: root, sourceType });
            await trustPlugin(pluginTrustStorePath(configDir), plugin.root);
            options.stdout.write(`Installed marketplace plugin ${plugin.name}@${plugin.version ?? requested.version} to ${plugin.root}\n`);
            return 0;
          }
          const source = resolve(sourceOrName);
          const plugin = await installLocalPlugin({ source, targetRoot: root, sourceType });
          await trustPlugin(pluginTrustStorePath(configDir), plugin.root);
          options.stdout.write(`Installed plugin ${plugin.name} to ${plugin.root}\n`);
          return 0;
        }
        if (!options.argv.includes("--yes")) throw new Error("plugins remove requires --yes");
        const name = validateResourceName(sourceOrName);
        const { target } = await removeInstalledPlugin({
          name,
          targetRoot: root,
          runtimeCacheRoot: join(configDir, "plugins", ".runtime"),
        });
        options.stdout.write(`Removed plugin ${sourceOrName} from ${target}\n`);
        return 0;
      }
      if (action === "show") {
        const requested = options.argv[2];
        if (!requested) throw new Error("plugins show requires a plugin name");
        const settings = await loadSettings({ configDir, cwd: options.cwd });
        const result = await loadPlugins([
          { directory: join(configDir, "plugins"), source: "user" },
          { directory: join(options.cwd, ".tnb", "plugins"), source: "project" },
        ], settings.enabledPlugins, { trustStorePath: pluginTrustStorePath(configDir) });
        const plugin = result.plugins.find(({ name }) => name.toLowerCase() === requested.toLowerCase());
        if (!plugin) throw new Error(`Plugin not found: ${requested}`);
        const configured = settings.enabledPlugins?.[plugin.name] ?? settings.enabledPlugins?.[plugin.name.toLowerCase()];
        const runtime = (await loadPluginRuntimeCache(join(configDir, "plugins", ".runtime"))).get(plugin.name.toLowerCase());
        options.stdout.write(`${JSON.stringify({
          name: plugin.name,
          version: plugin.version ?? null,
          description: plugin.description ?? null,
          source: plugin.source,
          scope: plugin.source,
          manifestVersion: plugin.manifestVersion,
          manifestPath: plugin.manifestPath ?? null,
          root: plugin.root,
          enabled: configured !== false,
          explicitlyEnabled: plugin.explicitlyEnabled,
          active: plugin.active,
          trust: plugin.trust,
          fingerprint: plugin.fingerprint ?? null,
          lifecycle: plugin.lifecycle,
          contributionSummary: plugin.contributionSummary,
          hooksPath: plugin.hooksPath ?? null,
          mcpPath: plugin.mcpPath ?? null,
          documentation: plugin.documentation ?? null,
          compatibility: plugin.compatibility ?? null,
          tools: plugin.toolContributions,
          runtime: runtime
            ? {
              sessions: runtime.sessions,
              latest: runtime.latest,
              versions: runtime.versions,
            }
            : null,
        }, null, 2)}\n`);
        return 0;
      }
      if (action !== "list") throw new Error("Usage: tnb plugins [list|show <name>|marketplace|search <query>|install <dir>|install <name> --marketplace|update <name>|remove <name> --yes|enable <name>|disable <name>|trust <name> --yes|untrust <name> --yes] [--project]");
      const settings = await loadSettings({ configDir, cwd: options.cwd });
      const result = await loadPlugins([
        { directory: join(configDir, "plugins"), source: "user" },
        { directory: join(options.cwd, ".tnb", "plugins"), source: "project" },
      ], settings.enabledPlugins, { trustStorePath: pluginTrustStorePath(configDir) });
      const runtimeCache = await loadPluginRuntimeCache(join(configDir, "plugins", ".runtime"));
      const rows = result.plugins.map((plugin) => ({
        name: plugin.name,
        version: plugin.version ?? null,
        source: plugin.source,
        scope: plugin.source,
        state: plugin.lifecycle.state,
        activation: plugin.lifecycle.activation,
        start: plugin.lifecycle.start,
        reload: plugin.lifecycle.reload,
        runtimeStatus: runtimeCache.get(plugin.name.toLowerCase())?.latest.status ?? null,
        trust: plugin.trust,
        manifestPath: plugin.manifestPath ?? null,
        description: plugin.description ?? plugin.root,
      }));
      writeRows(options, rows, (plugin) =>
        `${plugin.name}\t${plugin.version ?? "-"}\t${plugin.scope}\t${plugin.trust}\t${plugin.state}\t${plugin.activation}/${plugin.start}/${plugin.reload}\t${plugin.runtimeStatus ?? "-"}\t${plugin.description}`
      );
      for (const error of result.errors) options.stderr.write(`tnb: ${error.path}: ${error.error}\n`);
      return result.errors.length ? 1 : 0;
    }
    if (command === "agents") {
      const result = await loadAgents([
        { directory: join(configDir, "agents"), source: "user" },
        { directory: join(options.cwd, ".claude", "agents"), source: "claude-project" },
        { directory: join(options.cwd, ".tnb", "agents"), source: "project" },
      ]);
      const rows = result.agents.map(({ name, description, source, filePath }) => ({ name, description, source, filePath }));
      writeRows(options, rows, (row) => `${row.name}\t${row.source}\t${row.description}`);
      for (const error of result.errors) options.stderr.write(`tnb: ${error.path}: ${error.error}\n`);
      return result.errors.length ? 1 : 0;
    }
    if (command === "hooks") {
      const settings = await loadSettings({ configDir, cwd: options.cwd });
      const rows = Object.entries(settings.hooks ?? {}).flatMap(([event, groups]) =>
        (groups ?? []).flatMap((group) => group.hooks.map((hook) => ({
          event,
          matcher: group.matcher ?? "*",
          handler: hook.type === "command" ? hook.command : hook.type === "http" ? hook.url : `${hook.type}: ${hook.prompt}`,
        })))
      );
      writeRows(options, rows, (row) => `${row.event}\t${row.matcher}\t${row.handler}`);
      return 0;
    }
    throw new Error(`Unknown resource command: ${command}`);
  } catch (error) {
    options.stderr.write(`tnb: ${errorMessage(error)}\n`);
    return 1;
  }
}

function resolveConfigDir(options: ManagementCommandOptions): string {
  return options.configDir ?? options.env.TNB_HOME ?? join(homedir(), ".tnb");
}

function validateResourceName(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) throw new Error(`Invalid resource name: ${value}`);
  return value;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function settingsPath(options: ManagementCommandOptions): string {
  return options.argv.includes("--project")
    ? join(options.cwd, ".tnb", "settings.local.json")
    : join(resolveConfigDir(options), "settings.json");
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Configuration must be a JSON object: ${path}`);
    return value as Record<string, unknown>;
  } catch (error) {
    if (isMissing(error)) return {};
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

async function beforeSettingsChange(
  options: ManagementCommandOptions,
  filePath: string,
): Promise<void> {
  const settings = await loadSettings({ configDir: resolveConfigDir(options), cwd: options.cwd });
  if (!settings.hooks?.ConfigChange?.length) return;
  const runner = new HookRunner({
    hooks: settings.hooks,
    cwd: options.cwd,
    sessionId: randomUUID(),
    env: options.env,
    onError: (message) => options.stderr.write(`tnb hook: ${message}\n`),
  });
  const result = await runner.run("ConfigChange", {
    source: options.argv.includes("--project") ? "local_settings" : "user_settings",
    file_path: filePath,
  });
  if (result.blocked) throw new Error(result.reason ?? "ConfigChange hook blocked the settings update");
}

function parseKey(key: string): string[] {
  const segments = key.split(".");
  if (segments.some((segment) => !segment || segment === "__proto__" || segment === "prototype" || segment === "constructor")) {
    throw new Error(`Invalid configuration key: ${key}`);
  }
  return segments;
}

function getPath(root: Record<string, unknown>, segments: string[]): unknown {
  let current: unknown = root;
  for (const segment of segments) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function setPath(root: Record<string, unknown>, segments: string[], value: unknown): void {
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    const existing = current[segment];
    if (existing === undefined) current[segment] = {};
    else if (typeof existing !== "object" || existing === null || Array.isArray(existing)) throw new Error(`Cannot set a child of non-object key: ${segment}`);
    current = current[segment] as Record<string, unknown>;
  }
  current[segments.at(-1)!] = value;
}

function objectOrEmpty(value: unknown, message: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function deletePath(root: Record<string, unknown>, segments: string[]): boolean {
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    const child = current[segment];
    if (typeof child !== "object" || child === null || Array.isArray(child)) return false;
    current = child as Record<string, unknown>;
  }
  return delete current[segments.at(-1)!];
}

function parseConfigValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function optionValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function requiredOption(argv: string[], name: string): string {
  const value = optionValue(argv, name);
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

function positiveOption(argv: string[], name: string, fallback: number): number {
  const value = optionValue(argv, name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function validateHttpUrl(value: string, name: string): void {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`${name} must be an HTTP(S) URL`);
}

function validateEnvironmentName(value: string): void {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(value)) throw new Error("--api-key-env must be an uppercase environment variable name");
}

function optionValues(argv: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== name) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    values.push(value);
    index += 1;
  }
  return values;
}

function assignmentObject(argv: string[], name: string, parseJson: boolean): Record<string, unknown> | undefined {
  const assignments = optionValues(argv, name);
  if (!assignments.length) return undefined;
  const result: Record<string, unknown> = {};
  for (const assignment of assignments) {
    const separator = assignment.indexOf("=");
    if (separator < 1) throw new Error(`${name} values must use name=value`);
    const key = assignment.slice(0, separator);
    const raw = assignment.slice(separator + 1);
    if (!raw) throw new Error(`${name} values must not be empty`);
    if (!parseJson) result[key] = raw;
    else {
      try { result[key] = JSON.parse(raw); }
      catch { throw new Error(`${name} value for ${key} must be valid JSON`); }
    }
  }
  return result;
}

function compatibilityOptions(argv: string[]): Record<string, unknown> | undefined {
  const compat: Record<string, unknown> = {};
  const profile = optionValue(argv, "--compat-profile");
  if (profile) {
    if (!["generic", "glm", "qwen", "deepseek", "openrouter"].includes(profile)) {
      throw new Error("--compat-profile must be generic, glm, qwen, deepseek, or openrouter");
    }
    compat.profile = profile;
  }
  const flags: Array<[string, string]> = [
    ["--developer-role", "supportsDeveloperRole"],
    ["--reasoning-effort", "supportsReasoningEffort"],
    ["--stream-usage", "supportsUsageInStreaming"],
    ["--tool-result-name", "requiresToolResultName"],
    ["--assistant-after-tool-result", "requiresAssistantAfterToolResult"],
    ["--reasoning-content", "requiresReasoningContentOnAssistantMessages"],
  ];
  for (const [flag, field] of flags) if (argv.includes(flag)) compat[field] = true;
  const maxTokensField = optionValue(argv, "--max-tokens-field");
  if (maxTokensField) {
    if (maxTokensField !== "max_tokens" && maxTokensField !== "max_completion_tokens") throw new Error("--max-tokens-field must be max_tokens or max_completion_tokens");
    compat.maxTokensField = maxTokensField;
  }
  const thinkingFormat = optionValue(argv, "--thinking-format");
  if (thinkingFormat) {
    if (!["openai", "deepseek", "qwen", "openrouter"].includes(thinkingFormat)) throw new Error("--thinking-format must be openai, deepseek, qwen, or openrouter");
    compat.thinkingFormat = thinkingFormat;
  }
  const anthropicRequiredToolChoice = optionValue(argv, "--anthropic-required-tool-choice");
  if (anthropicRequiredToolChoice) {
    if (anthropicRequiredToolChoice !== "any" && anthropicRequiredToolChoice !== "auto") {
      throw new Error("--anthropic-required-tool-choice must be any or auto");
    }
    compat.anthropicRequiredToolChoice = anthropicRequiredToolChoice;
  }
  return Object.keys(compat).length ? compat : undefined;
}

function updateModel(existing: Record<string, unknown>, argv: string[]): Record<string, unknown> {
  const result = { ...existing };
  const contextWindow = optionValue(argv, "--context-window");
  const maxTokens = optionValue(argv, "--max-tokens");
  if (contextWindow) result.contextWindow = positiveOption(argv, "--context-window", 128_000);
  if (maxTokens) result.maxTokens = positiveOption(argv, "--max-tokens", 16_384);
  if (argv.includes("--reasoning")) result.reasoning = true;
  if (argv.includes("--vision")) result.supportsVision = true;
  if (argv.includes("--pdf")) result.supportsPdf = true;
  const headers = assignmentObject(argv, "--header", false);
  if (headers) result.headers = { ...objectOrEmpty(result.headers, "model headers must be an object"), ...headers };
  const sampling = assignmentObject(argv, "--sampling", true);
  if (sampling) result.samplingParams = { ...objectOrEmpty(result.samplingParams, "model samplingParams must be an object"), ...sampling };
  const compat = compatibilityOptions(argv);
  if (compat) result.compat = { ...objectOrEmpty(result.compat, "model compat must be an object"), ...compat };
  return result;
}

function commandCheck(name: string, executable: string, missingDetail: string) {
  const found = Bun.which(executable);
  return found
    ? { name, status: "ok" as const, detail: found }
    : { name, status: "warning" as const, detail: missingDetail };
}

function writeRows<T>(options: ManagementCommandOptions, rows: T[], format: (row: T) => string): void {
  if (options.argv.includes("--json")) options.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  else for (const row of rows) options.stdout.write(`${format(row)}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
