import { spawn } from "node:child_process";
import type { SandboxRuntime } from "./types";

/** A launch probe, not a proof of isolation. Native integration tests check effects. */
export async function probeSandboxRuntime(runtime: SandboxRuntime, cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const wrapped = process.platform === "win32"
    ? runtime.wrap(process.execPath, ["-e", "process.exit(0)"], cwd)
    : runtime.wrap("/bin/sh", ["-c", "exit 0"], cwd);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(wrapped.file, wrapped.args, { cwd, env, stdio: ["ignore", "ignore", "pipe"] });
    let diagnostic = "";
    let failure: unknown;
    child.stderr.on("data", (chunk) => { diagnostic = (diagnostic + String(chunk)).slice(-4096); });
    const timer = setTimeout(() => {
      failure = new Error(`Sandbox launch probe timed out (${runtime.command})`);
      child.kill("SIGKILL");
    }, process.platform === "win32" ? 15_000 : 5_000); // PowerShell's cold C# job-object harness needs startup time.
    const abort = () => { failure = signal?.reason ?? new Error("Sandbox probe cancelled"); child.kill("SIGKILL"); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.once("error", (error) => { failure = error; });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code === 0) resolve();
      else reject(new Error(`Sandbox launch probe failed (${runtime.command}, exit ${code}): ${diagnostic.trim()}`));
    });
  });
}
