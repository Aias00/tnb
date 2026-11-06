import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installLocalPlugin } from "../src/services/plugins/management";
import { trustPlugin, pluginTrustStorePath } from "../src/services/plugins/trust";
import { lock } from "../src/utils/lockfile";

const root = await mkdtemp(join(tmpdir(), "tnb-domain-product-")), configDir = join(root, "home"), plugin = join(root, "plugin");
const executable = resolve(import.meta.dir, "../dist", process.platform === "win32" ? "tnb.exe" : "tnb");
async function command(args: string[]) {
  const child = Bun.spawn([executable, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  let value: any; try { value = JSON.parse(stdout); } catch { /* Report bounded fixture output below. */ }
  if (code !== 0 || !value) throw new Error(`Compiled domain CLI: exit=${code}; stdout=${stdout}; stderr=${stderr}`);
  return value;
}
const runtime = (args: string[]) => command(["runtime", ...args, "--config-dir", configDir]);
let started = false;
try {
  await command(["plugins", "init", plugin, "--name", "compiled-domain", "--json"]);
  if (process.platform === "win32") {
    // Execution still needs the POSIX artifact durability barrier; verify CLI preflight on Windows.
    const child = Bun.spawn([executable, "runtime", "submit", "Read", "--adapter", join(plugin, "task.json"), "--namespace", "probe", "--allow-shell", "--config-dir", configDir], { stdout: "pipe", stderr: "pipe" });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (code !== 1 || !stderr.includes("Domain submission does not accept --allow-shell")) throw new Error("Compiled domain preflight did not reject Coding authority");
    process.stdout.write("Compiled domain template and authority preflight passed (Windows)\n");
  } else {
    await mkdir(configDir);
    const installed = await installLocalPlugin({ source: plugin, targetRoot: join(configDir, "plugins"), sourceType: "user" });
    await trustPlugin(pluginTrustStorePath(configDir), installed.root);
    // Real detached owner startup uses the compiled executable, not the source checkout.
    await runtime(["start"]); started = true;
    const catalog = await runtime(["adapters"]);
    if (!catalog.some((row: any) => row.id === "compiled-domain" && row.submission === "domain")) throw new Error("Installed domain is missing from the product catalog");
    const args = ["submit", "Read the authorized message", "--adapter", join(plugin, "task.json"), "--namespace", "probe", "--mode", "single", "--command-id", "compiled-probe", "--no-start"];
    const submitted = await runtime(args), runId = submitted.run.runId;
    const deadline = Date.now() + 15000;
    for (;;) {
      const status = await runtime(["status", runId]);
      if (status.run.status === "succeeded") break;
      if (["failed", "paused", "cancelled"].includes(status.run.status) || Date.now() >= deadline) throw new Error(`Compiled domain task did not succeed: ${JSON.stringify(status)}`);
      await Bun.sleep(20);
    }
    if (!JSON.stringify(await runtime(["result", runId])).includes("Verified: Hello from my plugin")) throw new Error("Compiled domain task has no accepted message evidence");
    if ((await runtime(args)).run.runId !== runId || (await runtime(["list", "--namespace", "probe"])).length !== 1) throw new Error("Compiled domain replay created another task");
    process.stdout.write("Compiled domain catalog, detached owner, execution, receipt replay and result passed\n");
  }
} finally {
  if (started) {
    await runtime(["stop"]);
    const release = await lock(join(configDir, "runtime"), { realpath: true, stale: 5000, update: 1000, retries: { retries: 100, minTimeout: 100, maxTimeout: 100, factor: 1 } });
    await release();
  }
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
