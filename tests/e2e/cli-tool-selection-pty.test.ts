import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { ptyCommand } from "../helpers/pty-command";

test("full CLI TUI retains an explicit provider-facing tool restriction", async () => {
  const root = await mkdtemp(join(tmpdir(), "tnb-cli-tools-")), cwd = join(root, "work"), configDir = join(root, "config");
  await mkdir(cwd); await mkdir(configDir);
  const requested = Promise.withResolvers<string[]>();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { tools?: Array<{ function: { name: string } }> };
    requested.resolve(body.tools?.map(tool => tool.function.name) ?? []);
    return new Response('data: {"choices":[{"delta":{"content":"SELECTION_DONE"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  } });
  await writeFile(join(configDir, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: String(server.url) + "v1", apiKey: "fixture", models: [{ id: "fixture", contextWindow: 32000, maxTokens: 256 }] } } }));
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const command = [process.execPath, resolve(import.meta.dir, "../../src/entrypoints/cli.ts"), "--provider", "fixture", "--model", "fixture", "--tools", "read"].map(quote).join(" ");
  const pidFile = join(root, "terminal.pid");
  const wrapped = `echo $$ > ${quote(pidFile)}; exec ${command}`;
  const terminal = ptyCommand(join(root, "terminal.log"), ["/bin/sh", "-c", wrapped]);
  const child = spawn(terminal.file, terminal.args, {
    cwd, env: { ...process.env, TNB_HOME: configDir, TERM: "xterm-256color" }, detached: true, stdio: ["pipe", "pipe", "pipe"],
  });
  let output = ""; child.stdout.on("data", chunk => { output += chunk.toString(); }); child.stderr.resume();
  const exited = new Promise<number | null>(resolve => child.once("close", resolve));
  const deadline = Date.now() + 10000;
  async function until(check: () => boolean) { while (!check()) { if (Date.now() > deadline) throw new Error(`TUI timeout: ${output.slice(-600)}`); await Bun.sleep(10); } }
  try {
    await until(() => output.includes("\u001b[?2004h"));
    child.stdin.write("\u001b[200~Inspect this project without tools.\u001b[201~");
    await until(() => output.replaceAll("\u001b[1C", " ").includes("Inspect this project without tools.")); child.stdin.write("\r");
    const tools = await Promise.race([requested.promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("No TUI model request")), 8000))]);
    expect(tools).toEqual(["read"]);
    await until(() => output.includes("SELECTION_DONE")); await Bun.sleep(50);
    child.stdin.write("\u001b[200~/exit\u001b[201~");
    await until(() => output.includes("/exit")); await Bun.sleep(100); child.stdin.write("\r");
    await until(() => output.includes("\u001b[?1049l")); child.stdin.end();
    expect(await exited).toBe(0);
  } finally {
    if (child.exitCode === null) { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }
    const pid = Number(await readFile(pidFile, "utf8").catch(() => ""));
    if (pid > 0) { try { process.kill(pid, "SIGKILL"); } catch {} }
    await server.stop(true); await rm(root, { recursive: true, force: true });
  }
}, 15000);
