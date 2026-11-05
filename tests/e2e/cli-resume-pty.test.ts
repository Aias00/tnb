import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionStore } from "../../src/services/session/storage";
import { ptyCommand } from "../helpers/pty-command";

test.each(["picker", "direct"] as const)("tnb resume restores a conversation through %s mode", async (mode) => {
  const directory = await mkdtemp(join(tmpdir(), "tnb-resume-pty-"));
  const session = new SessionStore({ configDir: directory, cwd: directory, sessionId: "resume-existing" });
  await session.append([
    { role: "user", content: [{ type: "text", text: "PAST_PROMPT_TOKEN" }] },
    { role: "assistant", content: [{ type: "text", text: "PAST_ANSWER_TOKEN" }] },
  ]);
  const source = resolve(import.meta.dir, "../../src/entrypoints/cli.ts");
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const pidFile = join(directory, "terminal.pid");
  const wrapped = `echo $$ > ${quote(pidFile)}; exec ${quote(process.execPath)} ${quote(source)} resume${mode === "direct" ? " resume-existing" : ""}`;
  const command = ptyCommand(join(directory, "terminal.log"), ["/bin/sh", "-c", wrapped]);
  const child = Bun.spawn([command.file, ...command.args], {
    cwd: directory,
    env: { ...process.env, TERM: "xterm-256color", TNB_HOME: directory, TNB_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "test-no-network", TNB_MODEL: "claude-sonnet-4-6" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  let output = "";
  const read = (async () => { for await (const chunk of child.stdout) output += Buffer.from(chunk).toString("utf8"); })();
  let errorText = "";
  const errors = new Response(child.stderr).text().then(value => { errorText = value; return value; });
  const text = () => (output + errorText).replace(/\u001b\[(\d+)C/g, (_match, count) => " ".repeat(Number(count)));
  const seen = async (value: string, after = 0) => {
    const end = Date.now() + 4000;
    while (text().indexOf(value, after) < 0) {
      if (child.exitCode !== null || Date.now() > end) throw new Error(`Resume CLI did not render ${value}: ${text().slice(-1500)}`);
      await Bun.sleep(10);
    }
  };
  try {
    let inputReadyAfter = 0;
    if (mode === "picker") {
      await seen("Resume session"); await seen("\u001b[?2004h");
      inputReadyAfter = text().lastIndexOf("\u001b[?2004h") + "\u001b[?2004h".length;
      child.stdin.write("\r"); await child.stdin.flush();
    }
    await seen("PAST_ANSWER_TOKEN"); await seen("PAST_PROMPT_TOKEN");
    // Initial transcript paint precedes input mounting. Wait for this TUI's raw-mode acknowledgement.
    await seen("\u001b[?2004h", inputReadyAfter);
    child.stdin.write("\u0003"); await child.stdin.flush(); await seen("Press Ctrl+C again to exit");
    child.stdin.write("\u0003"); await child.stdin.flush(); child.stdin.end();
    await Promise.race([child.exited, Bun.sleep(8000).then(() => { throw new Error("Resume CLI did not exit"); })]);
    await read;
    expect(child.exitCode).toBe(0);
    expect(await errors).toBe("");
    if (mode === "picker") expect(text()).toContain("Resume session");
    expect(text()).toContain("PAST_ANSWER_TOKEN");
    expect(text()).toContain("PAST_PROMPT_TOKEN");
    expect(text()).toContain("tnb --resume resume-existing");
  } finally {
    child.stdin.end();
    const pid = Number(await readFile(pidFile, "utf8").catch(() => ""));
    if (pid > 0) { try { process.kill(pid, "SIGKILL"); } catch {} }
    if (child.exitCode === null) child.kill();
    await child.exited;
    await read;
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
