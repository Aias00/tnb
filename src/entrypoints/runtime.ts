import { randomUUID } from "node:crypto";
import { openSync, closeSync, statSync, renameSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { runtimePaths, runtimeRequest, serveDurableRuntime } from "../services/runtime/server";
import { registerCleanup } from "../utils/cleanup-registry";
import { withOfflineRuntime, backupRuntime, restoreRuntime, pruneRuntime, runtimeStorageUsage } from "../services/runtime/maintenance";

const HELP = `Usage: tnb runtime <submit|status|result|list|events|pause|resume|cancel|reconcile|serve|stop|backup|restore|prune|storage> [options]

submit <objective> [--cwd PATH] [--mode single|auto|multi] [--allow-write] [--allow-shell]
  [--check COMMAND]... [--allow-workspace PATH]... [--provider ID] [--model ID]
  [--max-budget-usd N] [--max-turns N] [--command-id ID] [--no-start]
status|result|events|pause|resume|cancel <run-id>  (result accepts --task TASK-ID)
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
  stdout: { write(value: string): unknown }; stderr: { write(value: string): unknown } }): Promise<number> {
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
    else if (["status", "events", "result"].includes(action)) result = await runtimeRequest(configDir, `/${action}?runId=${encodeURIComponent(args[1] ?? "")}&after=${value("--after") ?? "0"}&taskId=${encodeURIComponent(value("--task") ?? "")}`);
    else if (action === "submit") {
      const workspace = resolve(value("--cwd") ?? options.cwd);
      const maxCostUsd = value("--max-budget-usd") === undefined ? undefined : Number(value("--max-budget-usd"));
      if (maxCostUsd !== undefined && (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0)) throw new Error("Budget must be positive");
      const body = { action, commandId: value("--command-id") ?? randomUUID(), objective: args[1], mode: value("--mode") ?? "auto",
        configuration: { workspace, allowedWorkspaces: [workspace, ...values("--allow-workspace").map((path) => resolve(path))],
          allowWrite: args.includes("--allow-write"), allowShell: args.includes("--allow-shell"), checks: values("--check"),
          provider: value("--provider"), model: value("--model"), maxCostUsd, maxTurns: Number(value("--max-turns") ?? 200), maxRetries: 3, compactThreshold: 24000 } };
      try { result = await runtimeRequest(configDir, "/command", body); }
      catch (error) { throw new Error(`${error instanceof Error ? error.message : String(error)}. Retry identical input with --command-id ${body.commandId}`); }
    } else if (["pause", "resume", "cancel", "reconcile"].includes(action)) result = await runtimeRequest(configDir, "/command", {
      action, commandId: value("--command-id") ?? randomUUID(), runId: args[1], taskId: value("--task"), operationId: value("--operation"), result: value("--result"),
    });
    else throw new Error("Unknown runtime command");
    options.stdout.write(`${JSON.stringify(result, null, 2)}\n`); return 0;
  } catch (error) { options.stderr.write(`tnb runtime: ${error instanceof Error ? error.message : String(error)}\n`); return 1; }
}

async function ensureRuntime(configDir: string, env: Record<string, string | undefined>): Promise<void> {
  try { await runtimeRequest(configDir, "/health"); return; } catch { /* No live owner; start one. */ }
  const paths = await runtimePaths(configDir);
  try { if (statSync(join(paths.root, "service.log")).size > 4 * 1024 * 1024) renameSync(join(paths.root, "service.log"), join(paths.root, "service.log.1")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const log = openSync(join(paths.root, "service.log"), "a", 0o600);
  const argv = Bun.main.startsWith("/$bunfs/") ? [] : [Bun.main];
  try { const process = spawn(globalThis.process.execPath, [...argv, "runtime", "serve", "--config-dir", configDir],
    { env: env as NodeJS.ProcessEnv, detached: true, stdio: ["ignore", log, log] }); process.unref(); }
  finally { closeSync(log); }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { await runtimeRequest(configDir, "/health"); return; } catch { await Bun.sleep(100); }
  }
  throw new Error(`Runtime did not start; inspect ${join(paths.root, "service.log")}`);
}
