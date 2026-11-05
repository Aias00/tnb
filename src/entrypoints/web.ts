import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { realpath } from "node:fs/promises";
import { ensureRuntime } from "../services/runtime/client";
import { runtimeRequest } from "../services/runtime/server";

const HELP = `Usage: tnb web [--cwd PATH] [--port N] [--config-dir PATH] [--json] [--no-start]

Launch the local web interface plugin for this workspace. The default port is random.
Prints a one-use browser link (valid for 60 seconds); the runtime key stays on the host.
The same durable owner keeps tasks running after the terminal or browser closes.
Run this command again to open another workspace or reconnect after owner restart.
Use tnb runtime stop to stop the owner; this also closes the web listener.
The durable owner currently requires macOS/Linux. No public-network listener is opened.
`;
export async function runWebCommand(options: { argv: string[]; cwd: string; env: Record<string, string | undefined>; stdout: { write(value: string): unknown }; stderr: { write(value: string): unknown } }): Promise<number> {
  const args = options.argv.slice(1);
  if (args.includes("--help") || args.includes("-h")) { options.stdout.write(HELP); return 0; }
  try {
    if (process.platform === "win32") throw new Error("The web workbench currently requires the macOS/Linux durable runtime owner");
    const values = new Map<string, string>(), flags = new Set<string>();
    for (let index = 0; index < args.length; index++) {
      const argument = args[index]!;
      if (["--json", "--no-start"].includes(argument)) { flags.add(argument); continue; }
      if (!["--cwd", "--port", "--config-dir"].includes(argument) || !args[index + 1] || args[index + 1]!.startsWith("--") || values.has(argument)) throw new Error(`Invalid web option: ${argument}`);
      values.set(argument, args[++index]!);
    }
    const port = values.has("--port") ? Number(values.get("--port")) : undefined;
    if (port !== undefined && (!Number.isSafeInteger(port) || port < 0 || port > 65535)) throw new Error("--port must be an integer between 0 and 65535");
    const configDir = resolve(values.get("--config-dir") ?? options.env.TNB_HOME ?? join(homedir(), ".tnb"));
    const workspace = await realpath(resolve(values.get("--cwd") ?? options.cwd));
    if (!flags.has("--no-start")) await ensureRuntime(configDir, options.env);
    const health = await runtimeRequest(configDir, "/health") as { capabilities?: { webWorkbench?: boolean } };
    if (!health.capabilities?.webWorkbench) throw new Error("Update the runtime owner and run tnb runtime restart before opening the web workbench");
    const extensions = await runtimeRequest(configDir, "/extensions") as Array<{ kind: string; id: string; version: string; status: string; error?: string }>;
    const web = extensions.find(item => item.kind === "interface" && item.id === "web" && item.version === "1");
    if (web?.status !== "active") throw new Error(`Web plugin unavailable: ${web?.error ?? "enable tnb-web and restart the runtime owner"}`);
    const result = await runtimeRequest(configDir, "/extensions/interface/web/1/launch", { workspace, ...(port !== undefined ? { port } : {}) }) as { url: string; workspace: string };
    options.stdout.write(flags.has("--json") ? JSON.stringify(result) + "\n" : `TNB 工作台 · ${result.workspace}\n${result.url}\n\n链接 60 秒内有效且只能使用一次。关闭网页不会取消任务。\n`); return 0;
  } catch (error) { options.stderr.write(`tnb web: ${error instanceof Error ? error.message : String(error)}\n`); return 1; }
}
