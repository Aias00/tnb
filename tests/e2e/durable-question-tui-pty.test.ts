// Exercise the actual terminal dialog: push while idle, preserve a draft, and
// withdraw another client's question without turning a stale keypress into an answer.
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const macTest = process.platform === "darwin" ? test : test.skip;
async function terminal() {
  const root = await mkdtemp(join(tmpdir(), "tnb-question-pty-")), trigger = join(root, "trigger");
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const child = spawn("sh", ["-c", `cat | script -q -F ${quote(join(root, "terminal.log"))} ${quote(process.execPath)} ${quote(resolve(import.meta.dir, "../fixtures/durable-question-tui.tsx"))}`], {
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
  const push = (action: string) => writeFile(trigger, action);
  async function close() {
    try {
      if (child.exitCode === null) {
        await send("\u0003"); await seen("Press Ctrl+C again to exit"); await send("\u0003"); child.stdin.end();
        expect(await exited).toBe(0);
      }
      await reading; await errors; expect(error).toBe("");
    } finally { if (child.exitCode === null) child.kill(); await rm(root, { recursive: true, force: true }); }
  }
  await seen("\u001b[?2004h");
  return { seen, send, contents, push, close, until, output: () => output };
}

macTest("a pushed decision opens the TUI selector and Enter directly submits the selected answer", async () => {
  const t = await terminal();
  try {
    await t.push("ask"); await t.seen("选择数据库"); await t.seen("SQLite");
    await t.send("\r"); await t.until(async () => (await t.contents(".answers")) === "SQLite\n");
    await t.seen("回答已保存"); expect(await t.contents(".turns")).toBe("");
  } finally { await t.close(); }
}, 12000);

macTest("a pushed decision preserves typed input and waits for the foreground turn before asking", async () => {
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

macTest("withdrawing a question closes its dialog and leaves the conversation usable", async () => {
  const t = await terminal();
  try {
    await t.push("ask"); await t.seen("选择数据库");
    await t.push("withdraw"); await Bun.sleep(100);
    await t.send("still chatting"); await t.seen("still chatting"); await t.send("\r");
    await t.until(async () => (await t.contents(".turns")) === "still chatting\n");
    expect(await t.contents(".answers")).toBe("");
  } finally { await t.close(); }
}, 12000);

macTest("withdrawing the first question automatically presents the next queued decision", async () => {
  const t = await terminal();
  try {
    await t.push("ask-two"); await t.seen("选择数据库");
    await t.push("withdraw-first"); await t.seen("选择缓存");
    await t.send("\r"); await t.until(async () => (await t.contents(".answers")) === "Redis\n");
  } finally { await t.close(); }
}, 12000);
