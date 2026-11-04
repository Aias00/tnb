import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { runtimePaths, runtimeRequest, serveDurableRuntime } from "../services/runtime/server";
import { ensureRuntime, assertConversationOwner } from "../services/runtime/client";
import type { DurableRun } from "../services/runtime/types";
import { registerCleanup } from "../utils/cleanup-registry";
import { withOfflineRuntime, backupRuntime, restoreRuntime, pruneRuntime, runtimeStorageUsage } from "../services/runtime/maintenance";

const HELP = `Usage: tnb runtime <submit|status|result|list|events|questions|answer|pause|resume|cancel|reconcile|serve|stop|backup|restore|prune|storage> [options]

submit <objective> [--cwd PATH] [--mode single|auto|multi] [--allow-write] [--allow-shell]
  [--check COMMAND]... [--allow-workspace PATH]... [--provider ID] [--model ID]
  [--max-budget-usd N] [--max-turns N] [--command-id ID] [--no-start]
status|result|events|pause|resume|cancel <run-id>  (result accepts --task TASK-ID)
questions <run-id>  Show outstanding questions and their versions.
answer <run-id> --question ID --answer TEXT --version N  Answer without changing permissions.
reconcile <run-id> --task TASK-ID --operation OPERATION-ID --result CONFIRMED-RESULT
serve  Run the local owner in the foreground (normally started on demand).
stop   Drain and stop the service; accepted tasks remain recoverable.
backup <directory> / restore <directory> / prune <run-id>  Offline maintenance; stop the service first.
storage  Show state size and free disk space.

All actions accept --config-dir PATH. Submitting starts a persistent local service;
closing the client does not cancel accepted work. Checks are explicitly authorized
verification commands and may be rerun after interruption. Coding tasks require checks.
Shell and checks require a native sandbox; network access is blocked. single forbids
delegation; auto/multi can delegate bounded read-only work to authorized workspaces.
Reconciliation asserts an already observed external result and never reruns the action.
`;

export async function runRuntimeCommand(options: { argv: string[]; cwd: string; env: Record<string, string | undefined>;
  originSessionId?: string; stdout: { write(value: string): unknown }; stderr: { write(value: string): unknown } }): Promise<number> {
  const args = options.argv.slice(1); const action = args[0];
  const value = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const values = (name: string) => args.flatMap((item, index) => item === name && args[index + 1] ? [args[index + 1]!] : []);
  const configDir = resolve(value("--config-dir") ?? options.env.TNB_HOME ?? join(homedir(), ".tnb"));
  try {
    if (!action || args.includes("--help") || args.includes("-h")) { options.stdout.write(HELP); return 0; }
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
    if (action === "list") result = await runtimeRequest(configDir, "/runs");
    else if (action === "stop") result = await runtimeRequest(configDir, "/command", { action: "stop", commandId: randomUUID() });
    else if (["status", "events", "result", "questions"].includes(action)) result = await runtimeRequest(configDir, `/${action}?runId=${encodeURIComponent(args[1] ?? "")}&after=${value("--after") ?? "0"}&taskId=${encodeURIComponent(value("--task") ?? "")}`);
    else if (action === "submit") {
      const workspace = resolve(value("--cwd") ?? options.cwd);
      const maxCostUsd = value("--max-budget-usd") === undefined ? undefined : Number(value("--max-budget-usd"));
      if (maxCostUsd !== undefined && (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0)) throw new Error("Budget must be positive");
      const body = { action, commandId: value("--command-id") ?? randomUUID(), objective: args[1], mode: value("--mode") ?? "auto",
        configuration: { workspace, allowedWorkspaces: [workspace, ...values("--allow-workspace").map((path) => resolve(path))],
          allowWrite: args.includes("--allow-write"), allowShell: args.includes("--allow-shell"), checks: values("--check"),
          provider: value("--provider"), model: value("--model"), maxCostUsd, maxTurns: Number(value("--max-turns") ?? 200), maxRetries: 3, compactThreshold: 24000 } };
      if (options.originSessionId) Object.assign(body.configuration, { originSessionId: options.originSessionId });
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
  env: Record<string, string | undefined>; provider: string; model: string; sessionId: string };
export async function runRuntimeChatCommand(options: RuntimeChatOptions): Promise<string> {
  const args = options.args.length ? [...options.args] : ["list"]; const action = args[0]!;
  if (!["submit", "list", "status", "result", "events", "questions", "answer", "pause", "resume", "cancel", "storage"].includes(action)) throw new Error("/runtime supports submit, list, status, result, events, questions, answer, pause, resume, cancel and storage.");
  const valueFlags = new Set(["--cwd", "--mode", "--check", "--allow-workspace", "--provider", "--model", "--max-budget-usd", "--max-turns", "--command-id", "--config-dir", "--after", "--task", "--question", "--answer", "--version"]);
  const flags = new Set(["--allow-write", "--allow-shell", "--no-start", "--help", "-h"]);
  const hasTarget = ["submit", "status", "result", "events", "questions", "answer", "pause", "resume", "cancel"].includes(action);
  for (let index = hasTarget ? 2 : 1; index < args.length; index++) {
    const flag = args[index]!;
    if (valueFlags.has(flag)) { if (!args[index + 1] || args[index + 1]!.startsWith("--")) throw new Error(`${flag} requires a value`); index++; }
    else if (!flags.has(flag)) throw new Error(`Unexpected argument ${flag}; quote the objective and use supported runtime options`);
  }
  if (action === "submit") {
    if (!args[1] || args[1].startsWith("--")) throw new Error('Usage: /runtime submit "objective" [--mode auto] [--allow-write --check "command"]');
    if (!args.includes("--cwd")) args.push("--cwd", options.workspace);
    if (!args.includes("--provider")) args.push("--provider", options.provider);
    if (!args.includes("--model")) args.push("--model", options.model);
  }
  let output = ""; let error = "";
  const code = await runRuntimeCommand({ argv: ["runtime", ...args, "--config-dir", options.configDir], cwd: options.cwd,
    env: options.env, originSessionId: options.sessionId, stdout: { write: (value) => { output += value; } }, stderr: { write: (value) => { error += value; } } });
  if (code) throw new Error(error.trim());
  return action === "submit" ? `Durable task accepted; it continues in the background. Use /runtime status <run-id> or /runtime result <run-id>.\n${output.trim()}` : output.trim();
}

const LONG_TASK_HELP = `Long tasks · /longtask (aliases: /task, /long, /长任务)

/longtask "objective" [--mode single|auto|multi] [--allow-write] [--allow-shell]
  [--check "command"]... [--max-budget-usd N] [--max-turns N]
/longtask list
/longtask status|result|events|pause|resume|cancel [run-id]
/longtask questions [run-id]
/longtask answer [run-id] --question ID --answer "text" --version N

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
  const actions = new Set(["submit", "list", "status", "result", "events", "questions", "answer", "pause", "resume", "cancel"]);
  if (!actions.has(args[0]!)) args.unshift("submit");
  if (args[0] === "submit") {
    const flagAt = args.findIndex((value, index) => index > 0 && value.startsWith("--"));
    const boundary = flagAt < 0 ? args.length : flagAt;
    args = ["submit", args.slice(1, boundary).join(" "), ...args.slice(boundary)];
    const result = await runRuntimeChatCommand({ ...options, args });
    return result.replaceAll("/runtime status <run-id>", "/longtask status").replaceAll("/runtime result <run-id>", "/longtask result");
  }
  if (args[0] === "list" || !args[1] || args[1]!.startsWith("--")) {
    if (args[0] === "list") for (let index = 1; index < args.length; index += 2) {
      if (!["--cwd", "--config-dir"].includes(args[index]!) || !args[index + 1] || args[index + 1]!.startsWith("--")) throw new Error("Usage: /longtask list [--cwd PATH] [--config-dir PATH]");
    }
    const option = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
    const configDir = resolve(option("--config-dir") ?? options.configDir);
    const workspace = await realpath(resolve(option("--cwd") ?? options.workspace));
    assertConversationOwner(await runtimeRequest(configDir, "/health") as Parameters<typeof assertConversationOwner>[0]);
    const resource = `/runs?workspace=${encodeURIComponent(workspace)}`;
    const runs = await runtimeRequest(configDir, resource) as DurableRun[];
    if (args[0] === "list") {
      return runs.length ? JSON.stringify(runs, null, 2) : '当前工作区没有长任务。使用 /longtask "任务目标" 创建。';
    }
    const own = await runtimeRequest(configDir, `${resource}&sessionId=${encodeURIComponent(options.sessionId)}`) as DurableRun[];
    const run = own.at(-1) ?? runs.at(-1);
    if (!run) throw new Error('当前工作区没有长任务。使用 /longtask "任务目标" 创建。');
    args.splice(1, 0, run.runId);
  }
  return runRuntimeChatCommand({ ...options, args });
}
