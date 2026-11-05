import { openSync, closeSync, statSync, renameSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimePaths, runtimeRequest } from "./server";
import { lock } from "../../utils/lockfile";

/** Start the same executable as a detached owner; all clients use one authenticated service. */
export function assertConversationOwner(health: { capabilities?: { conversationHandoff?: boolean } }): void {
  if (!health.capabilities?.conversationHandoff) throw new RuntimeUnavailable("The runtime owner needs an update/restart for conversational handoff. Stop the existing runtime service, then retry");
}
export async function ensureRuntime(configDir: string, env: Record<string, string | undefined>, conversation = false): Promise<void> {
  let starting = false;
  try {
    const health = await runtimeRequest(configDir, "/health") as { ready?: boolean; error?: string; capabilities?: { conversationHandoff?: boolean } };
    if (conversation) assertConversationOwner(health);
    if (health.error) throw new RuntimeUnavailable(health.error);
    if (health.ready) return;
    starting = true;
  } catch (error) { if (error instanceof RuntimeUnavailable) throw error; }
  const paths = await runtimePaths(configDir);
  if (!starting) {
    try { if (statSync(join(paths.root, "service.log")).size > 4 * 1024 * 1024) renameSync(join(paths.root, "service.log"), join(paths.root, "service.log.1")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const log = openSync(join(paths.root, "service.log"), "a", 0o600);
    const argv = Bun.main.startsWith("/$bunfs/") ? [] : [fileURLToPath(new URL("../../entrypoints/cli.ts", import.meta.url))];
    try {
      const owner = spawn(process.execPath, [...argv, "runtime", "serve", "--config-dir", configDir],
        { env: env as NodeJS.ProcessEnv, detached: true, stdio: ["ignore", log, log] }); owner.unref();
    } finally { closeSync(log); }
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const health = await runtimeRequest(configDir, "/health") as { ready?: boolean; capabilities?: { conversationHandoff?: boolean } };
      if (conversation) assertConversationOwner(health);
      if (health.ready) return;
    } catch (error) { if (error instanceof RuntimeUnavailable) throw error; }
    await Bun.sleep(100);
  }
  throw new Error(`Runtime did not start; inspect ${join(paths.root, "service.log")}`);
}
class RuntimeUnavailable extends Error {}

/** Explicit user operation; ordinary notification subscribers never restart the owner. */
export async function restartRuntime(configDir: string, env: Record<string, string | undefined>): Promise<void> {
  let running = false;
  try { await runtimeRequest(configDir, "/health"); running = true; } catch { /* Starting a stopped owner is also a restart. */ }
  if (running) await runtimeRequest(configDir, "/command", { action: "stop", commandId: crypto.randomUUID() });
  const paths = await runtimePaths(configDir);
  const release = await lock(paths.root, { realpath: true, stale: 5000, update: 1000, retries: { retries: 100, factor: 1, minTimeout: 100, maxTimeout: 100 } });
  await release();
  await ensureRuntime(configDir, env);
}
