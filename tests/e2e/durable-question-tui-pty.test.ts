// Exercise the actual terminal dialog: push while idle, preserve a draft, and
// withdraw another client's question without turning a stale keypress into an answer.
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ptyCommand } from "../helpers/pty-command";

const terminalTest = process.platform === "darwin" || process.platform === "linux" ? test : test.skip;
async function terminal() {
  const root = await mkdtemp(join(tmpdir(), "tnb-question-pty-")), trigger = join(root, "trigger");
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const pidFile = join(root, "terminal.pid");
  const wrapped = `echo $$ > ${quote(pidFile)}; exec ${quote(process.execPath)} ${quote(resolve(import.meta.dir, "../fixtures/durable-question-tui.tsx"))}`;
  const command = ptyCommand(join(root, "terminal.log"), ["/bin/sh", "-c", wrapped]);
  const child = spawn(command.file, command.args, {
    cwd: resolve(import.meta.dir, "../.."), env: { ...process.env, TERM: "xterm-256color", TNB_QUESTION_FIXTURE: trigger }, stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "", error = "";
  const reading = (async () => { const decoder = new TextDecoder(); for await (const bytes of child.stdout) output += decoder.decode(bytes, { stream: true }); })();
  const errors = (async () => { for await (const bytes of child.stderr) error += bytes; })();
  const exited = new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
  async function until(predicate: () => boolean | Promise<boolean>) {
    const end = Date.now() + 4000;
    while (!await predicate()) { if (Date.now() > end || child.exitCode !== null) throw new Error(`Question UI timed out: ${error}; ${output.slice(-1000)}`); await Bun.sleep(10); }
  }
  const seen = (text: string) => until(() => output.includes(text));
  const send = (text: string) => new Promise<void>((resolve, reject) => { child.stdin.write(text, (error) => error ? reject(error) : resolve()); });
  const contents = (suffix: string) => readFile(trigger + suffix, "utf8").catch(() => "");
  const push = async (action: string) => {
    const response = await fetch(await contents(".control"), { method: "POST", body: action, signal: AbortSignal.timeout(4000) });
    expect(response.ok).toBe(true); await response.text();
  };
  async function close() {
    try {
      if (child.exitCode === null) {
        await push("withdraw"); await until(async () => (await contents(".actions")).trimEnd().endsWith("withdraw"));
        await send("\u0003"); await seen("Press Ctrl+C again to exit"); await send("\u0003"); child.stdin.end();
        expect(await exited).toBe(0);
      }
      await reading; await errors; expect(error).toBe("");
    } finally {
      child.stdin.end(); if (child.exitCode === null) child.kill();
      const pid = Number(await readFile(pidFile, "utf8").catch(() => "")); if (pid > 0) { try { process.kill(pid, "SIGKILL"); } catch {} }
      await rm(root, { recursive: true, force: true });
    }
  }
  await seen("\u001b[?2004h");
  return { seen, send, contents, push, close, until, output: () => output };
}

terminalTest("a pushed decision opens the TUI selector and Enter directly submits the selected answer", async () => {
  const t = await terminal();
  try {
    await t.push("ask"); await t.seen("选择数据库"); await t.seen("SQLite");
    await t.send("\r"); await t.until(async () => (await t.contents(".answers")) === "SQLite\n");
    await t.seen("回答已保存"); expect(await t.contents(".turns")).toBe("");
  } finally { await t.close(); }
}, 12000);

terminalTest("a pushed decision preserves typed input and waits for the foreground turn before asking", async () => {
  const t = await terminal();
  try {
    await t.send("keep my draft"); await t.seen("keep my draft");
    await t.push("ask"); await t.seen("长任务问题");
    expect(t.output()).not.toContain("选择数据库");
    await t.send("\r"); await t.until(async () => (await t.contents(".turns")) === "keep my draft\n");
    await t.seen("选择数据库"); await t.send("\u001b[B\r");
    await t.until(async () => (await t.contents(".answers")) === "Postgres\n");
  } finally { await t.close(); }
}, 12000);

terminalTest("withdrawing a question closes its dialog and leaves the conversation usable", async () => {
  const t = await terminal();
  try {
    await t.push("ask"); await t.seen("选择数据库");
    await t.push("withdraw"); await Bun.sleep(100);
    await t.send("still chatting"); await t.seen("still chatting"); await t.send("\r");
    await t.until(async () => (await t.contents(".turns")) === "still chatting\n");
    expect(await t.contents(".answers")).toBe("");
  } finally { await t.close(); }
}, 12000);

terminalTest("withdrawing the first question automatically presents the next queued decision", async () => {
  const t = await terminal();
  try {
    await t.push("ask-two"); await t.seen("选择数据库");
    await t.push("withdraw-first"); await t.seen("选择缓存");
    await t.send("\r"); await t.until(async () => (await t.contents(".answers")) === "Redis\n");
  } finally { await t.close(); }
}, 12000);

terminalTest("a completion notice renders automatically and acknowledges delivery without a chat turn", async () => {
  const t = await terminal();
  try {
    await t.push("done"); await t.seen("长任务已完成并通过验收");
    await t.until(async () => (await t.contents(".acks")) === "completed-one\n");
    expect(await t.contents(".turns")).toBe("");
  } finally { await t.close(); }
}, 12000);

terminalTest("offline status closes the question dialog and preserves new drafts until reconnection", async () => {
  const t = await terminal();
  try {
    await t.push("ask"); await t.seen("选择数据库");
    await t.push("offline"); await t.seen("后台服务离线");
    await t.send("offline draft"); await t.seen("offline draft");
    expect(await t.contents(".answers")).toBe("");
    const before = t.output().split("选择数据库").length;
    await t.push("online"); await t.until(async () => (await t.contents(".actions")).trimEnd().endsWith("online")); await t.send("\r");
    await t.until(async () => (await t.contents(".turns")) === "offline draft\n");
    await t.until(() => t.output().split("选择数据库").length > before);
    await t.send("\r"); await t.until(async () => (await t.contents(".answers")) === "SQLite\n");
  } finally { await t.close(); }
}, 12000);
