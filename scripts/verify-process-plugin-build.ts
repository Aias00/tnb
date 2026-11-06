import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initializePlugin } from "../src/services/plugins/development";

const root = await mkdtemp(join(tmpdir(), "tnb-compiled-plugin-"));
const executable = resolve(import.meta.dir, "../dist", process.platform === "win32" ? "tnb.exe" : "tnb");
async function run(args: string[]) {
  const child = Bun.spawn([executable, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  let value: any; try { value = JSON.parse(stdout); } catch { /* Report the actual exit/output below. */ }
  if (code !== 0 || !value) throw new Error(`Compiled CLI ${JSON.stringify(args)}: exit=${code}; stdout=${JSON.stringify(stdout)}; stderr=${JSON.stringify(stderr)}`);
  return value;
}
try {
  if ((await run(["--version", "--json"])).mode !== "compiled") throw new Error("Executable did not identify as the compiled CLI");
  for (const kind of ["application", "channel"] as const) {
    const directory = join(root, kind); await initializePlugin(directory, kind, "compiled-process", { execution: "process" });
    const report = await run(["plugins", "test", directory, "--yes"]);
    if (!report.ok) throw new Error(`Compiled ${kind} process validation failed: ${JSON.stringify(report)}`);
    process.stdout.write(`Compiled ${kind} process plugin passed\n`);
  }
} finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
