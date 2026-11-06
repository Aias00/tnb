import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { ShellSessionManager } from "../../src/services/shell/manager";
import { MAX_COMMAND_LOG_BYTES, MAX_RUNTIME_LOG_BYTES, ShellOutputLog } from "../../src/services/shell/output";
import { createShellTools } from "../../src/tools/shell";

const roots: string[] = [];
const managers: ShellSessionManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tnb-output-")); roots.push(root);
  const manager = new ShellSessionManager({ cwd: root, outputDir: join(root, "logs") });
  managers.push(manager);
  return { root, manager };
}
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const command = (script: string) => `${quote(process.execPath)} -e ${quote(script)}`;
async function until(check: () => boolean) {
  const deadline = Date.now() + 15000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Command did not finish");
    await Bun.sleep(10);
  }
}

test("large foreground output stays bounded, logs its full output and preserves exit status", async () => {
  const { manager } = await fixture();
  let peak = 0; let bytes = 0;
  const output = await manager.runForeground(command('process.stdout.write("x".repeat(300000)+"THE_END")'), 5000,
    new AbortController().signal, (progress) => { peak = Math.max(peak, progress.fullOutput?.length ?? 0); bytes = progress.totalBytes ?? 0; });
  expect(peak).toBeLessThanOrEqual(160000);
  expect(bytes).toBe(300007);
  expect(output.length).toBeLessThan(161000);
  expect(output).toContain("THE_END");
  expect(output).toContain("Complete output saved.");
  const path = /Log: (.+?)\. Complete/.exec(output)![1]!;
  expect((await stat(path)).size).toBe(300007);
});

test("large failed foreground output retains its error tail and nonzero exit", async () => {
  const { manager } = await fixture();
  await expect(manager.runForeground(command('process.stderr.write("x".repeat(300000)+"FAILED_END");process.exitCode=7'),
    5000, new AbortController().signal)).rejects.toThrow("FAILED_END");
});

for (const mode of ["foreground", "background"] as const) {
  test(`${mode} log quota discards extra output without killing or retrying command effects`, async () => {
    const { root, manager } = await fixture();
    const script = command('process.stdout.write("x".repeat(10*1024*1024)+"LAST_LINE");require("node:fs").writeFileSync("effect","once")');
    if (mode === "foreground") {
      const output = await manager.runForeground(script, 5000, new AbortController().signal);
      expect(output).toContain("LAST_LINE");
      expect(output).toContain("Log quota reached");
      const path = /Log: (.+?)\. Log quota/.exec(output)![1]!;
      expect((await stat(path)).size).toBe(MAX_COMMAND_LOG_BYTES);
    } else {
      const task = await manager.runBackground(script);
      await until(() => manager.task(task.taskId).status !== "running");
      const final = manager.task(task.taskId);
      expect(final.status).toBe("completed");
      expect(final.exitCode).toBe(0);
      expect(final.output.length).toBeLessThanOrEqual(160000);
      expect(final.output).toContain("LAST_LINE");
      expect(final.logTruncated).toBe(true);
      expect((await stat(final.outputPath)).size).toBe(MAX_COMMAND_LOG_BYTES);
      const tool = createShellTools(manager, {})[1]!;
      expect(await tool.execute(tool.validate({ task_id: task.taskId }), new AbortController().signal)).toContain("log_truncated: true");
    }
    expect(await readFile(join(root, "effect"), "utf8")).toBe("once");
  });
}

test("multiple command logs share a quota and honor disk backpressure", async () => {
  const { root } = await fixture();
  let available = 200000;
  const reserve = (requested: number) => { const count = Math.min(available, requested); available -= count; return count; };
  const source = new PassThrough(); source.resume();
  const first = await ShellOutputLog.create(join(root, "first.log"), reserve);
  first.append("x".repeat(180000), source);
  expect(source.isPaused()).toBe(true);
  await first.finish();
  expect(source.isPaused()).toBe(false);
  const second = await ShellOutputLog.create(join(root, "second.log"), reserve);
  second.append("y".repeat(50000), source);
  await second.finish();
  expect(first.truncated).toBe(false);
  expect(second.truncated).toBe(true);
  expect((await stat(first.path)).size + (await stat(second.path)).size).toBe(200000);
  source.destroy();
});

test("log write errors are recorded and release paused pipes without unhandled rejection", async () => {
  const { root } = await fixture();
  const source = new PassThrough(); source.resume();
  const log = await ShellOutputLog.create(join(root, "failed.log"), (bytes) => bytes);
  log.append("x".repeat(180000), source);
  log.writer.destroy(new Error("simulated disk failure"));
  await log.finish();
  expect(log.error).toBe("simulated disk failure");
  expect(source.isPaused()).toBe(false);
  source.destroy();
});

test("log quota preserves a valid UTF-8 prefix and never resumes after truncation", async () => {
  const { root } = await fixture();
  let remaining = 5;
  const log = await ShellOutputLog.create(join(root, "utf8.log"), (bytes) => {
    const count = Math.min(bytes, remaining); remaining -= count; return count;
  });
  const source = new PassThrough(); source.resume();
  log.append("a中😀z", source);
  log.append("must not appear", source);
  await log.finish();
  expect(await readFile(log.path, "utf8")).toBe("a中");
  expect(log.truncated).toBe(true);
  source.destroy();
});

test("exit observers cannot turn a completed command into a failed effect", async () => {
  const { manager } = await fixture();
  const task = await manager.runBackground(command('process.stdout.write("no newline")'), {
    onStdoutLine() { throw new Error("fixture line observer"); },
    onExit() { throw new Error("fixture exit observer"); },
  });
  await until(() => manager.task(task.taskId).status !== "running");
  const final = manager.task(task.taskId);
  expect(final.status).toBe("completed");
  expect(final.exitCode).toBe(0);
  expect(final.output).toContain("fixture line observer");
  expect(final.output).toContain("fixture exit observer");
});

test("real shell commands share the runtime log ceiling and keep completing after exhaustion", async () => {
  const { root, manager } = await fixture();
  const count = MAX_RUNTIME_LOG_BYTES / MAX_COMMAND_LOG_BYTES;
  for (let index = 0; index < count; index++) {
    const task = await manager.runBackground(command(`process.stdout.write("x".repeat(${MAX_COMMAND_LOG_BYTES}))`));
    await until(() => manager.task(task.taskId).status !== "running");
    expect(manager.task(task.taskId).status).toBe("completed");
  }
  const result = await manager.runForeground(command('process.stdout.write("still completed")'), 5000, new AbortController().signal);
  expect(result).toContain("still completed");
  expect(result).toContain("Log quota reached");
  const files = await readdir(join(root, "logs"));
  const sizes = await Promise.all(files.map(async (file) => (await stat(join(root, "logs", file))).size));
  expect(sizes.reduce((total, size) => total + size, 0)).toBe(MAX_RUNTIME_LOG_BYTES);
}, 60000);
