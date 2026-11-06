import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initializePlugin } from "../src/services/plugins/development";

const root = await mkdtemp(join(tmpdir(), "tnb-compiled-plugin-"));
const executable = resolve(import.meta.dir, "../dist", process.platform === "win32" ? "tnb.exe" : "tnb");
try {
  for (const kind of ["application", "channel"] as const) {
    const directory = join(root, kind); await initializePlugin(directory, kind, "compiled-process", { execution: "process" });
    const child = Bun.spawn([executable, "plugins", "test", directory, "--yes"], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0 || !JSON.parse(stdout).ok) throw new Error(`Compiled ${kind} process validation failed: ${stdout}\n${stderr}`);
    process.stdout.write(`Compiled ${kind} process plugin passed\n`);
  }
} finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
