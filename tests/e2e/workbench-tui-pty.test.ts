import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ptyCommand } from "../helpers/pty-command";
import { Terminal } from "@xterm/headless";
const terminalTest = ["darwin", "linux"].includes(process.platform) ? test : test.skip;
async function terminal() {
  const root = await mkdtemp(join(tmpdir(), "tnb-workbench-")), trigger = join(root, "trigger"), pidFile = join(root, "pid");
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const wrapped = `echo $$ > ${quote(pidFile)}; exec ${quote(process.execPath)} ${quote(resolve(import.meta.dir, "../fixtures/workbench-tui.tsx"))}`;
  const command = ptyCommand(join(root, "terminal.log"), ["/bin/sh", "-c", wrapped]);
  const child = spawn(command.file, command.args, { cwd: resolve(import.meta.dir, "../.."), env: { ...process.env, TERM: "xterm-256color", TNB_WORKBENCH_FIXTURE: trigger }, stdio: ["pipe", "pipe", "pipe"] });
  let output = "", error = "";
  const screen = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const visible = () => Array.from({ length: screen.rows }, (_, i) => screen.buffer.active.getLine(i)?.translateToString(true) ?? "").join("\n");
  const reading = (async () => { for await (const data of child.stdout) { const chunk = data.toString(); output += chunk; await new Promise<void>((done) => screen.write(chunk, done)); } })();
  const errors = (async () => { for await (const data of child.stderr) error += data.toString(); })();
  const exited = new Promise<void>((resolve, reject) => { child.once("close", () => resolve()); child.once("error", reject); });
  async function until(check: () => boolean | Promise<boolean>) { const end = Date.now() + 5000; while (!await check()) { if (Date.now() > end || child.exitCode !== null) throw new Error(`UI timeout: ${error}; ${output.slice(-1800)}`); await Bun.sleep(10); } }
  const send = (text: string) => new Promise<void>((resolve, reject) => child.stdin.write(text, (error) => error ? reject(error) : resolve()));
  const contents = (suffix: string) => readFile(trigger + suffix, "utf8").catch(() => "");
  const push = async (action: string) => { const response = await fetch(await contents(".control"), { method: "POST", body: action, signal: AbortSignal.timeout(4000) }); expect(response.ok).toBe(true); await response.text(); };
  const seen = (text: string) => until(() => visible().includes(text));
  const gone = (text: string) => until(() => !visible().includes(text));
  await until(() => output.includes("\u001b[?2004h"));
  const close = async () => {
    try {
      const control = await contents(".control");
      if (control) await fetch(control, { method: "POST", body: "close-shells", signal: AbortSignal.timeout(2000) }).catch(() => undefined);
      const pid = Number(await readFile(pidFile, "utf8").catch(() => "")); if (pid > 0) { try { process.kill(pid, "SIGKILL"); } catch {} }
      if (child.exitCode === null) { child.kill("SIGTERM"); await exited; } await reading; await errors;
    } finally {
      child.stdin.end(); const pid = Number(await readFile(pidFile, "utf8").catch(() => "")); if (pid > 0) { try { process.kill(pid, "SIGKILL"); } catch {} }
      screen.dispose(); await rm(root, { recursive: true, force: true });
    }
  };
  return { send, push, seen, gone, contents, until, close, output: () => output };
}
terminalTest("busy input queues without interrupting and preserves the unsent draft when queued work starts", async () => {
  const t = await terminal(); try {
    await t.send("hold"); await t.seen("hold"); await t.send("\r"); await t.until(async () => await t.contents(".turns") === "hold\n");
    await t.send("next"); await t.seen("next"); await t.send("\r"); await t.seen("对话输入已保存排队"); expect(await t.contents(".turns")).toBe("hold\n");
    await t.send("draft remains"); await t.seen("draft remains"); await t.push("release");
    await t.until(async () => await t.contents(".turns") === "hold\nnext\n");
    await t.send("\r"); await t.until(async () => await t.contents(".turns") === "hold\nnext\ndraft remains\n");
  } finally { await t.close(); }
}, 15000);
terminalTest("task controls preserve drafts, require cancellation confirmation and target the selected Run", async () => {
  const t = await terminal(); try {
    await t.send("preserved"); await t.seen("preserved"); await t.send("\u0014"); await t.seen("任务工作台");
    await t.send("x"); await t.seen("取消选定长任务"); await t.send("\u001b"); await t.gone("取消选定长任务"); expect(await t.contents(".controls")).toBe("");
    await t.send("p"); await t.until(async () => (await t.contents(".controls")).startsWith("pause run-one"));
    await t.seen("用户暂停"); await t.send("r"); await t.until(async () => (await t.contents(".controls")).includes("resume run-one")); await t.seen("待执行");
    await t.send("x"); await t.seen("取消选定长任务"); await t.send("y"); await t.until(async () => (await t.contents(".controls")).includes("cancel run-one"));
    await t.seen("已取消"); await t.send("\u001b"); await t.seen("preserved"); await t.send("\r"); await t.until(async () => await t.contents(".turns") === "preserved\n");
  } finally { await t.close(); }
}, 15000);
terminalTest("explicit task followup is acknowledged as saved and never becomes a foreground prompt", async () => {
  const t = await terminal(); try {
    await t.send("keep compatibility"); await t.seen("keep compatibility"); await t.send("\u0014"); await t.seen("任务工作台"); await t.send("f"); await t.seen("补充到"); await t.send("\r");
    await t.until(async () => await t.contents(".followups") === "keep compatibility\n"); await t.seen("待安全工具边界送达");
    expect(await t.contents(".turns")).toBe("");
  } finally { await t.close(); }
}, 15000);
terminalTest("navigation and a following control in the same terminal packet use the new selection", async () => {
  const t = await terminal(); try {
    await t.push("add-run"); await t.send("\u0014"); await t.seen("第二个任务");
    await t.send("\u001b[Bx"); await t.seen("取消选定长任务"); await t.send("y");
    await t.until(async () => (await t.contents(".controls")).startsWith("cancel run-two "));
    expect(await t.contents(".controls")).not.toContain("run-one");
  } finally { await t.close(); }
}, 15000);
terminalTest("permission paging exposes the end of the full command before a decision", async () => {
  const t = await terminal(); try {
    await t.send("approval"); await t.seen("approval"); await t.send("\r"); await t.seen("Review complete command");
    await t.send("\u001b[6~"); await t.send("\u001b[6~"); await t.send("\u001b[6~"); await t.seen("FINAL_COMMAND_MARKER");
    expect(await t.contents(".permissions")).toBe("");
    await t.send("\u001b"); await t.until(async () => await t.contents(".permissions") === "deny\n");
  } finally { await t.close(); }
}, 15000);
terminalTest("workbench retains real PTY output and input access and requires confirmation to stop it", async () => {
  const t = await terminal(); try {
    await t.push("start-pty"); await t.send("\u0014"); await t.seen("/bin/cat"); await t.send("\u001b[Bi"); await t.seen("Background tasks & PTY sessions");
    await t.send("i"); await t.seen("Input:"); await t.send("PTY_INPUT_MARKER"); await t.seen("PTY_INPUT_MARKER"); await t.send("\r");
    await t.gone("Input:"); await t.push("read-pty"); expect(await t.contents(".pty-output")).toContain("PTY_INPUT_MARKER");
    await t.send("k"); await t.seen("终止这个 Shell/PTY"); await t.send("\u001b"); await t.gone("终止这个 Shell/PTY");
    await t.push("read-pty"); expect(await t.contents(".pty-alive")).toBe("true");
    await t.send("k"); await t.seen("终止这个 Shell/PTY"); await t.send("y"); await t.gone("/bin/cat");
    const pid = Number(await t.contents(".pty-pid"));
    await t.until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  } finally { await t.close(); }
}, 15000);
terminalTest("manual decision center preserves a failed answer draft and the unrelated conversation draft", async () => {
  const t = await terminal(); try {
    await t.send("unsent draft"); await t.push("ask"); await t.push("fail-answer");
    await t.send("\u0014"); await t.seen("任务工作台"); await t.send("\t"); await t.seen("任务工作台 · 待决定"); await t.send("\r"); await t.seen("选择数据库");
    await t.seen("Other"); await t.send("\u001b[B\u001b[B\r"); await t.seen("Other:"); await t.send("custom decision"); await t.seen("custom decision"); await t.send("\r");
    await t.until(async () => await t.contents(".attempts") === "custom decision\n"); await t.seen("回答未提交");
    await t.send("\u0014"); await t.seen("任务工作台"); await t.send("\t"); await t.seen("任务工作台 · 待决定"); await t.send("\r"); await t.seen("custom decision"); await t.send("\r");
    await t.until(async () => await t.contents(".answers") === "custom decision\n");
    await t.send("\r"); await t.until(async () => await t.contents(".turns") === "unsent draft\n");
    expect(await t.contents(".attempts")).toBe("custom decision\ncustom decision\n");
  } finally { await t.close(); }
}, 15000);
