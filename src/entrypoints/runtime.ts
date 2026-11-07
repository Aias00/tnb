import { buildInfo, sameBuild } from "../services/update/build-info";
import { agentNamespace } from "../agent/execution";
import { readDomainSubmission } from "../services/cli/domain-submission";
import { readJsonDocument } from "../services/cli/json-document";
import { validateCapabilityCommand, validateCapabilityRequest } from "../services/runtime/capabilities";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { runtimePaths, runtimeRequest, serveDurableRuntime } from "../services/runtime/server";
import { ensureRuntime, assertConversationOwner, restartRuntime } from "../services/runtime/client";
import { parseDeadline, extensionMilliseconds } from "../services/runtime/limits";
import type { DurableRun } from "../services/runtime/types";
import { registerCleanup } from "../utils/cleanup-registry";
import { withOfflineRuntime, backupRuntime, checkRuntimeBackup, restoreRuntime, pruneRuntime, runtimeStorageUsage } from "../services/runtime/maintenance";

const HELP = `Usage: tnb runtime <submit|adapters|capabilities|execute|status|result|list|events|questions|answer|limits|pause|resume|cancel|reconcile|start|restart|serve|stop|backup|backup-check|restore|prune|storage|plugins|version> [options]

followup [run-id] --text "requirements" [--task ID] [--input-id ID]
  Select an unresolved input with --resolve-input ID --revision N and a run-id.
routing [--cwd PATH] [--pending] [--before-input ID]  Show decisions, prioritizing pending clarification.
submit <objective> [--cwd PATH] [--mode single|auto|multi] [--allow-write] [--allow-shell]
  [--check COMMAND]... [--allow-workspace PATH]... [--skill NAME]... [--mcp-tool NAME]... [--provider ID] [--model ID]
  [--max-budget-usd N] [--max-turns N] [--deadline ISO-DATE] [--command-id ID] [--no-start]
submit <objective> --adapter descriptor.json --namespace NAME [--mode single|auto|multi]
  [--max-turns N] [--max-retries N] [--max-model-requests N] [--compact-threshold N]
  [--max-budget-usd N] [--deadline ISO-DATE] [--provider ID] [--model ID] [--command-id ID] [--no-start]
  Explicit domain submission; does not accept Coding directory, Shell, check, Skill or MCP flags.
adapters  List current Adapter identities/configuration schemas; never starts the owner.
capabilities <list|grants|command.json>  Check/publish immutable capabilities and administer exact consumer grants; see docs/guides/published-capabilities.md.
execute request.json  Execute a published capability as Owner; requires an explicitly started owner.
list|followup|routing [--namespace NAME]  Select a domain scope instead of a file workspace.
status|result|events|pause|resume|cancel <run-id>  (result accepts --task TASK-ID)
questions <run-id>  Show outstanding questions and their versions.
answer <run-id> --question ID --answer TEXT --version N  Answer without changing permissions.
limits <run-id> [--extend-hours N | --deadline ISO-DATE] [--max-budget-usd N] [--revision N]
  Requires a fully paused Run. Budget is the total ceiling; usage/reservations remain.
  Updating limits does not resume the Run or change its tools, model or permissions.
reconcile <run-id> --task TASK-ID --operation OPERATION-ID --result CONFIRMED-RESULT
serve  Run the local owner in the foreground (normally started on demand).
start / restart  Start or explicitly drain/restart the persistent service.
version  Compare CLI and running service builds; never starts the service.
stop   Drain and stop the service; accepted tasks remain recoverable.
backup <directory> / restore <directory> / prune <run-id>  Offline maintenance; stop the service first.
backup-check <directory>  Read-only verification of saved evidence and plugin assets; never starts the owner.
storage  Show state size and free disk space.
plugins  Show the running host's built-in and installed domain plugin generations.
plugins --references  Explain current Run/task/Source retention and startup collection status.
plugins --check  Inspect local recovery bytes, trust, approval/ABI and pinned declarations; never runs plugin code.

All actions accept --config-dir PATH. Submitting starts a persistent local service;
closing the client does not cancel accepted work. Checks are explicitly authorized
verification commands and may be rerun after interruption. Coding tasks require checks.
Shell and checks require a native sandbox; network access is blocked. single forbids
delegation; auto/multi can delegate bounded read-only work to authorized workspaces.
Reconciliation asserts an already observed external result and never reruns the action.
`;

export async function runRuntimeCommand(options: { argv: string[]; cwd: string; env: Record<string, string | undefined>;
  originSessionId?: string; sourceText?: string; stdout: { write(value: string): unknown }; stderr: { write(value: string): unknown } }): Promise<number> {
  const args = options.argv.slice(1); const action = args[0];
  const value = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const values = (name: string) => args.flatMap((item, index) => item === name && args[index + 1] ? [args[index + 1]!] : []);
  const configDir = resolve(value("--config-dir") ?? options.env.TNB_HOME ?? join(homedir(), ".tnb"));
  try {
    if (!action || args.includes("--help") || args.includes("-h")) { options.stdout.write(HELP); return 0; }
    if (action === "capabilities" || action === "execute") {
      if (!args[1] || args[1].startsWith("--")) throw new Error(`Usage: runtime ${action} ${action === "execute" ? "request.json" : "list|grants|command.json"} [--config-dir PATH]`);
      for (let i = 2; i < args.length; i += 2) if (args[i] !== "--config-dir" || !args[i + 1] || args[i + 1]!.startsWith("--") || i !== 2) throw new Error(`Unknown or duplicate ${action} option`);
      const document = action === "capabilities" && ["list", "grants"].includes(args[1]) ? { action: args[1] } : await readJsonDocument(resolve(options.cwd, args[1]), "Capability document");
      const input = action === "execute" ? validateCapabilityRequest(document) : validateCapabilityCommand(document);
      const health = await runtimeRequest(configDir, "/health") as { capabilities?: { publishedCapabilities?: boolean } };
      if (!health.capabilities?.publishedCapabilities) throw new Error("The running owner does not support published capabilities; explicitly restart after updating");
      const result = await runtimeRequest(configDir, action === "execute" ? "/capabilities/execute" : "/capabilities/command", input);
      options.stdout.write(JSON.stringify(result, null, 2) + "\n"); return 0;
    }
    const domainInput = action === "submit" && args.includes("--adapter") ? await readDomainSubmission(args, options.cwd, options.originSessionId) : undefined;
    if (action === "submit" && !domainInput && ["--namespace", "--max-retries", "--max-model-requests", "--compact-threshold"].some(flag => args.includes(flag))) throw new Error("Domain execution options require --adapter descriptor.json");
    if (args.includes("--namespace") && args.includes("--cwd")) throw new Error("Choose --namespace or --cwd");
    if (args.includes("--namespace") && (!value("--namespace") || value("--namespace")!.startsWith("--"))) throw new Error("--namespace requires a value");
    if (args.includes("--namespace") && !["submit", "list", "followup", "routing"].includes(action)) throw new Error("--namespace applies to submit, list, followup and routing");
    if (action === "adapters") for (let index = 1; index < args.length; index += 2) {
      if (args[index] !== "--config-dir" || !args[index + 1] || args[index + 1]!.startsWith("--")) throw new Error("Usage: runtime adapters [--config-dir PATH]");
    }
    const scope = async () => value("--namespace") !== undefined ? agentNamespace(value("--namespace")!) : realpath(resolve(options.cwd, value("--cwd") ?? options.cwd));
    if (action === "version") {
      const cli = buildInfo();
      let health: { ready?: boolean; pid?: number; build?: unknown };
      try { health = await runtimeRequest(configDir, "/health") as typeof health; }
      catch { throw new Error("Cannot read the running service build; it may be stopped or unavailable. Run 'tnb runtime start' explicitly to start it."); }
      const matches = sameBuild(cli, health.build);
      options.stdout.write(`${JSON.stringify({ cli, service: health.build ?? null, ready: health.ready, pid: health.pid, matches,
        ...(matches === false ? { notice: "CLI and service use different builds. Run tnb runtime restart when tasks can be drained." } : matches === null ? { notice: "Build comparison unavailable for source execution or an older service." } : {}) }, null, 2)}\n`);
      return 0;
    }
    if (action === "backup-check") {
      if (!args[1] || args[1].startsWith("--")) throw new Error("A backup directory is required");
      options.stdout.write(`${JSON.stringify(await checkRuntimeBackup(resolve(options.cwd, args[1])), null, 2)}\n`); return 0;
    }
    if (action === "start" || action === "restart") {
      if (action === "restart") await restartRuntime(configDir, options.env); else await ensureRuntime(configDir, options.env);
      options.stdout.write(`${JSON.stringify(await runtimeRequest(configDir, "/health"), null, 2)}\n`); return 0;
    }
    if (["backup", "restore", "prune", "storage"].includes(action)) {
      const paths = await runtimePaths(configDir);
      let result: unknown;
      if (action === "storage") result = await runtimeStorageUsage(paths.root);
      else {
        if (!args[1] || args[1].startsWith("--")) throw new Error("A maintenance target is required");
        if (action === "restore") { await restoreRuntime(resolve(args[1]), paths.root); result = { restored: true }; }
        else result = await withOfflineRuntime(paths.root, async (store) => {
          if (action === "backup") return { backup: await backupRuntime(store, paths.root, resolve(args[1]!)) };
          await pruneRuntime(store, paths.root, args[1]!); return { pruned: args[1] };
        });
      }
      options.stdout.write(`${JSON.stringify(result, null, 2)}\n`); return 0;
    }
    if (action === "serve") {
      const controller = new AbortController(); const abort = () => controller.abort();
      process.once("SIGINT", abort); process.once("SIGTERM", abort);
      const unregister = registerCleanup(async () => { abort(); await done; });
      const done = serveDurableRuntime({ configDir, env: options.env, signal: controller.signal,
        ready: () => { options.stdout.write("Durable runtime ready\n"); } });
      try { await done; } finally { unregister(); process.off("SIGINT", abort); process.off("SIGTERM", abort); }
      return 0;
    }
    if (action === "submit" && !args.includes("--no-start")) await ensureRuntime(configDir, options.env);
    let result: unknown;
    if (action === "adapters") {
      const health = await runtimeRequest(configDir, "/health") as { capabilities?: { domainCatalog?: boolean } };
      if (!health.capabilities?.domainCatalog) throw new Error("The running owner does not support the Adapter catalog; explicitly run tnb runtime restart after updating it");
      result = await runtimeRequest(configDir, "/adapters");
    }
    else if (action === "list") result = await runtimeRequest(configDir, args.includes("--namespace") ? `/runs?workspace=${encodeURIComponent(await scope())}` : "/runs");
    else if (action === "plugins") {
      if (args.includes("--check") && args.includes("--references")) throw new Error("Choose --check or --references");
      result = await runtimeRequest(configDir, args.includes("--check") ? "/plugins/recovery" : args.includes("--references") ? "/plugins/references" : "/plugins");
    }
    else if (action === "routing") {
      const query = new URLSearchParams({ workspace: await scope(), pending: String(args.includes("--pending")) });
      if (value("--before-input")) query.set("beforeInput", value("--before-input")!);
      result = await runtimeRequest(configDir, `/routing?${query}`);
    }
    else if (action === "followup") {
      const commandId = value("--command-id") ?? randomUUID();
      const workspace = await scope();
      const original = value("--text") ?? (value("--resolve-input") ? "Resolve original input" : undefined);
      if (!original) throw new Error("Followup requires --text or --resolve-input");
      result = await runtimeRequest(configDir, "/command", { action, commandId, workspace, runId: args[1] && !args[1].startsWith("--") ? args[1] : undefined,
        taskId: value("--task"), resolveInputId: value("--resolve-input"), expectedRevision: value("--revision") ? Number(value("--revision")) : undefined,
        source: { inputId: value("--input-id") ?? commandId, workspace, rawText: original, source: options.originSessionId ? "conversation" : "cli", sessionId: options.originSessionId } });
    }
    else if (action === "stop") result = await runtimeRequest(configDir, "/command", { action: "stop", commandId: randomUUID() });
    else if (["status", "events", "result", "questions"].includes(action)) result = await runtimeRequest(configDir, `/${action}?runId=${encodeURIComponent(args[1] ?? "")}&after=${value("--after") ?? "0"}&taskId=${encodeURIComponent(value("--task") ?? "")}`);
    else if (action === "submit") {
      if (domainInput) {
        const health = await runtimeRequest(configDir, "/health") as { capabilities?: { domainSubmission?: boolean } };
        if (!health.capabilities?.domainSubmission) throw new Error("The running owner does not support domain submission; explicitly run tnb runtime restart after updating it");
        try { result = await runtimeRequest(configDir, "/agent-tasks", domainInput); }
        catch (error) { throw new Error(`${error instanceof Error ? error.message : String(error)}. Retry identical input with --command-id ${domainInput.commandId}`); }
        options.stdout.write(`${JSON.stringify(result, null, 2)}\n`); return 0;
      }
      for (const flag of ["--skill", "--mcp-tool"]) {
        for (let index = 0; index < args.length; index++) if (args[index] === flag && (!args[index + 1] || args[index + 1]!.startsWith("--"))) throw new Error(`${flag} requires a value`);
      }
      const workspace = resolve(value("--cwd") ?? options.cwd);
      const maxCostUsd = value("--max-budget-usd") === undefined ? undefined : Number(value("--max-budget-usd"));
      if (maxCostUsd !== undefined && (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0)) throw new Error("Budget must be positive");
      const body = { action, commandId: value("--command-id") ?? randomUUID(), objective: args[1], mode: value("--mode") ?? "auto",
        deadline: value("--deadline") === undefined ? undefined : parseDeadline(value("--deadline")!),
        configuration: { workspace, allowedWorkspaces: [workspace, ...values("--allow-workspace").map((path) => resolve(path))],
          allowWrite: args.includes("--allow-write"), allowShell: args.includes("--allow-shell"), checks: values("--check"),
          ...(values("--skill").length ? { skills: values("--skill") } : {}), ...(values("--mcp-tool").length ? { mcpTools: values("--mcp-tool") } : {}),
          provider: value("--provider"), model: value("--model"), maxCostUsd, maxTurns: Number(value("--max-turns") ?? 200), maxRetries: 3, compactThreshold: 24000 } };
      if (options.originSessionId) Object.assign(body.configuration, { originSessionId: options.originSessionId });
      Object.assign(body, { successorOf: value("--successor"), source: { inputId: body.commandId, workspace: await realpath(workspace),
        rawText: options.sourceText ?? args[1], source: options.originSessionId ? "conversation" : "cli", sessionId: options.originSessionId } });
      try { result = await runtimeRequest(configDir, "/command", body); }
      catch (error) { throw new Error(`${error instanceof Error ? error.message : String(error)}. Retry identical input with --command-id ${body.commandId}`); }
    } else if (action === "limits") {
      for (let index = 2; index < args.length; index += 2) {
        if (!["--deadline", "--extend-hours", "--max-budget-usd", "--revision", "--command-id", "--config-dir"].includes(args[index]!)
          || !args[index + 1] || args[index + 1]!.startsWith("--")) throw new Error("Limits accept only deadline, extension, total budget, revision and command/config IDs, each with a value");
      }
      if (value("--deadline") !== undefined && value("--extend-hours") !== undefined) throw new Error("Choose --deadline or --extend-hours");
      const body = { action, runId: args[1], commandId: value("--command-id") ?? randomUUID(),
        deadline: value("--deadline") === undefined ? undefined : parseDeadline(value("--deadline")!),
        extendMs: value("--extend-hours") === undefined ? undefined : extensionMilliseconds(Number(value("--extend-hours"))),
        maxCostUsd: value("--max-budget-usd") === undefined ? undefined : Number(value("--max-budget-usd")),
        expectedRevision: value("--revision") === undefined ? undefined : Number(value("--revision")) };
      if (body.deadline === undefined && body.extendMs === undefined && body.maxCostUsd === undefined) throw new Error("Supply a deadline extension or total budget ceiling");
      if (body.expectedRevision !== undefined && (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1)) throw new Error("Invalid Run revision");
      try { result = await runtimeRequest(configDir, "/command", body); }
      catch (error) { throw new Error(`${error instanceof Error ? error.message : String(error)}. Retry identical input with --command-id ${body.commandId}`); }
    } else if (action === "answer") {
      const version = Number(value("--version"));
      if (!value("--question") || !value("--answer") || !Number.isSafeInteger(version) || version < 1) throw new Error("Answer requires --question ID --answer TEXT --version N; read questions first");
      const body = { action, commandId: value("--command-id") ?? randomUUID(), runId: args[1], waitId: value("--question"), answer: value("--answer"), expectedVersion: version };
      try { result = await runtimeRequest(configDir, "/command", body); }
      catch (error) { throw new Error(`${error instanceof Error ? error.message : String(error)}. Retry identical input with --command-id ${body.commandId}`); }
    } else if (["pause", "resume", "cancel", "reconcile"].includes(action)) result = await runtimeRequest(configDir, "/command", {
      action, commandId: value("--command-id") ?? randomUUID(), runId: args[1], taskId: value("--task"), operationId: value("--operation"), result: value("--result"),
    });
    else throw new Error("Unknown runtime command");
    options.stdout.write(`${JSON.stringify(result, null, 2)}\n`); return 0;
  } catch (error) { options.stderr.write(`tnb runtime: ${error instanceof Error ? error.message : String(error)}\n`); return 1; }
}

/** Direct user slash commands inherit the active conversation's workspace and selected model. */
export type RuntimeChatOptions = { args: string[]; cwd: string; workspace: string; configDir: string;
  env: Record<string, string | undefined>; provider: string; model: string; sessionId: string; sourceText?: string };
export async function runRuntimeChatCommand(options: RuntimeChatOptions): Promise<string> {
  const args = options.args.length ? [...options.args] : ["list"]; const action = args[0]!;
  if (!["followup", "routing", "submit", "adapters", "list", "status", "result", "events", "questions", "answer", "limits", "pause", "resume", "cancel", "storage", "version", "start", "restart", "stop", "plugins", "backup-check"].includes(action)) throw new Error("/runtime supports submit, adapters, list, status, result, events, questions, answer, limits, pause, resume, cancel, storage, start, restart, stop, plugins, version and backup-check.");
  const valueFlags = new Set(["--adapter", "--namespace", "--max-retries", "--max-model-requests", "--compact-threshold", "--before-input", "--text", "--input-id", "--resolve-input", "--successor", "--cwd", "--mode", "--check", "--skill", "--mcp-tool", "--allow-workspace", "--provider", "--model", "--max-budget-usd", "--max-turns", "--command-id", "--config-dir", "--after", "--task", "--question", "--answer", "--version", "--deadline", "--extend-hours", "--revision"]);
  const flags = new Set(["--references", "--pending", "--allow-write", "--allow-shell", "--no-start", "--help", "-h"]);
  if (action === "followup" && (!args[1] || args[1].startsWith("--"))) args.splice(1, 0, "");
  const hasTarget = ["followup", "submit", "status", "result", "events", "questions", "answer", "limits", "pause", "resume", "cancel", "backup-check"].includes(action);
  for (let index = hasTarget ? 2 : 1; index < args.length; index++) {
    const flag = args[index]!;
    if (action === "plugins" && flag === "--check") continue;
    if (valueFlags.has(flag)) { if (!args[index + 1] || args[index + 1]!.startsWith("--")) throw new Error(`${flag} requires a value`); index++; }
    else if (!flags.has(flag)) throw new Error(`Unexpected argument ${flag}; quote the objective and use supported runtime options`);
  }
  if (["followup", "routing"].includes(action) && !args.includes("--cwd") && !args.includes("--namespace")) args.push("--cwd", options.workspace);
  if (action === "submit") {
    if (!args[1] || args[1].startsWith("--")) throw new Error('Usage: /runtime submit "objective" [--mode auto] [--allow-write --check "command"]');
    if (!args.includes("--cwd") && !args.includes("--adapter")) args.push("--cwd", options.workspace);
    if (!args.includes("--provider")) args.push("--provider", options.provider);
    if (!args.includes("--model")) args.push("--model", options.model);
  }
  let output = ""; let error = "";
  const code = await runRuntimeCommand({ argv: ["runtime", ...args, ...(!args.includes("--config-dir") ? ["--config-dir", options.configDir] : [])], cwd: args.includes("--adapter") ? options.workspace : options.cwd,
    env: options.env, originSessionId: options.sessionId, sourceText: options.sourceText, stdout: { write: (value) => { output += value; } }, stderr: { write: (value) => { error += value; } } });
  if (code) throw new Error(error.trim());
  return action === "submit" ? `Durable task accepted; it continues in the background. Use /runtime status <run-id> or /runtime result <run-id>.\n${output.trim()}` : output.trim();
}

const LONG_TASK_HELP = `Long tasks · /longtask (aliases: /task, /long, /长任务)

/longtask "objective" [--mode single|auto|multi] [--allow-write] [--allow-shell]
  [--check "command"]... [--skill NAME]... [--mcp-tool NAME]... [--max-budget-usd N] [--max-turns N]
/longtask "objective" --adapter task.json --namespace NAME
/longtask followup [run-id] --text "additional requirements"
/longtask routing [--pending] [--before-input ID]
/longtask list [--namespace NAME]
/longtask status|result|events|pause|resume|cancel [run-id]
/longtask questions [run-id]
/longtask answer [run-id] --question ID --answer "text" --version N
/longtask limits [run-id] [--extend-hours N | --deadline ISO-DATE] [--max-budget-usd N]
  Pause first. Keeps recorded charges and stays paused until explicit resume.

Starts a durable background task using the current workspace and model.
Writing requires explicit --allow-write and replay-safe --check commands.
Without a run-id, controls select this conversation's latest task, then the
workspace's latest task. list shows this workspace's tasks. Use an explicit
run-id to select another task. Closing the conversation does not cancel work.
`;

/** A task-oriented slash entry point over the same runtime commands, not another executor. */
export async function runLongTaskChatCommand(options: RuntimeChatOptions): Promise<string> {
  let args = [...options.args];
  if (!args.length || args[0] === "help" || args.includes("--help") || args.includes("-h")) return LONG_TASK_HELP;
  const actions = new Set(["followup", "routing", "submit", "list", "status", "result", "events", "questions", "answer", "limits", "pause", "resume", "cancel"]);
  if (!actions.has(args[0]!)) args.unshift("submit");
  if (args[0] === "submit") {
    const flagAt = args.findIndex((value, index) => index > 0 && value.startsWith("--"));
    const boundary = flagAt < 0 ? args.length : flagAt;
    args = ["submit", args.slice(1, boundary).join(" "), ...args.slice(boundary)];
    const result = await runRuntimeChatCommand({ ...options, args });
    return result.replaceAll("/runtime status <run-id>", args.includes("--namespace") ? "/longtask status <run-id>" : "/longtask status")
      .replaceAll("/runtime result <run-id>", args.includes("--namespace") ? "/longtask result <run-id>" : "/longtask result");
  }
  if (["followup", "routing"].includes(args[0]!)) return runRuntimeChatCommand({ ...options, args });
  if (args[0] === "list" || !args[1] || args[1]!.startsWith("--")) {
    if (args[0] === "list") for (let index = 1; index < args.length; index += 2) {
      if (!["--cwd", "--namespace", "--config-dir"].includes(args[index]!) || !args[index + 1] || args[index + 1]!.startsWith("--")) throw new Error("Usage: /longtask list [--cwd PATH | --namespace NAME] [--config-dir PATH]");
    }
    const option = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
    const configDir = resolve(option("--config-dir") ?? options.configDir);
    if (args.includes("--namespace") && (!option("--namespace") || option("--namespace")!.startsWith("--"))) throw new Error("--namespace requires a value");
    if (args.includes("--namespace") && args.includes("--cwd")) throw new Error("Choose --namespace or --cwd");
    const workspace = option("--namespace") !== undefined ? agentNamespace(option("--namespace")!) : await realpath(resolve(option("--cwd") ?? options.workspace));
    assertConversationOwner(await runtimeRequest(configDir, "/health") as Parameters<typeof assertConversationOwner>[0]);
    const resource = `/runs?workspace=${encodeURIComponent(workspace)}`;
    const runs = await runtimeRequest(configDir, resource) as DurableRun[];
    if (args[0] === "list") {
      return runs.length ? JSON.stringify(runs, null, 2) : option("--namespace") !== undefined ? `命名空间 ${JSON.stringify(option("--namespace"))} 没有长任务。使用 /runtime adapters 查看可用业务。` : '当前工作区没有长任务。使用 /longtask "任务目标" 创建。';
    }
    const own = await runtimeRequest(configDir, `${resource}&sessionId=${encodeURIComponent(options.sessionId)}`) as DurableRun[];
    const run = own.at(-1) ?? runs.at(-1);
    if (!run) throw new Error('当前工作区没有长任务。使用 /longtask "任务目标" 创建。');
    const namespaceIndex = args.indexOf("--namespace"); if (namespaceIndex >= 0) args.splice(namespaceIndex, 2);
    args.splice(1, 0, run.runId);
  }
  return runRuntimeChatCommand({ ...options, args });
}
