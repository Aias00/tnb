import { spawn } from "node:child_process";
import type { SandboxRuntime } from "./types";

/** A launch probe, not a proof of isolation. Native integration tests check effects. */
export async function probeSandboxRuntime(runtime: SandboxRuntime, cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  const wrapped = process.platform === "win32"
    ? runtime.wrap(process.execPath, ["-e", "process.exit(0)"], cwd)
    : runtime.wrap("/bin/sh", ["-c", "exit 0"], cwd);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(wrapped.file, wrapped.args, { cwd, env, stdio: ["ignore", "ignore", "pipe"] });
    let diagnostic = "";
    child.stderr.on("data", (chunk) => { diagnostic = (diagnostic + String(chunk)).slice(-4096); });
    const timer = setTimeout(() => { child.kill(); }, 5_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Sandbox launch probe failed (${runtime.command}, exit ${code}): ${diagnostic.trim()}`));
    });
  });
}
