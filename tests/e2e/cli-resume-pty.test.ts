import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionStore } from "../../src/services/session/storage";

test.each(["picker", "direct"] as const)("tnb resume restores a conversation through %s mode", async (mode) => {
  const directory = await mkdtemp(join(tmpdir(), "tnb-resume-pty-"));
  const session = new SessionStore({ configDir: directory, cwd: directory, sessionId: "resume-existing" });
  await session.append([
    { role: "user", content: [{ type: "text", text: "PAST_PROMPT_TOKEN" }] },
    { role: "assistant", content: [{ type: "text", text: "PAST_ANSWER_TOKEN" }] },
  ]);
  const source = resolve(import.meta.dir, "../../src/entrypoints/cli.ts");
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const command = `(sleep 1; printf '\\r'; sleep 0.6; printf '\\003'; sleep 0.15; printf '\\003') | script -q ${quote(join(directory, "terminal.log"))} ${quote(process.execPath)} ${quote(source)} resume${mode === "direct" ? " resume-existing" : ""}`;
  const child = Bun.spawn(["sh", "-c", command], {
    cwd: directory,
    env: { ...process.env, TERM: "xterm-256color", TNB_HOME: directory, TNB_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "test-no-network", TNB_MODEL: "claude-sonnet-4-6" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  let output = "";
  const read = (async () => { for await (const chunk of child.stdout) output += Buffer.from(chunk).toString("utf8"); })();
  let errorText = "";
  const errors = new Response(child.stderr).text().then(value => { errorText = value; return value; });
  const text = () => (output + errorText).replace(/\u001b\[(\d+)C/g, (_match, count) => " ".repeat(Number(count)));
  try {
    await Promise.race([child.exited, Bun.sleep(8000).then(() => { throw new Error("Resume CLI did not exit"); })]);
    await read;
    expect(child.exitCode).toBe(0);
    expect(await errors).toBe("");
    if (mode === "picker") expect(text()).toContain("Resume session");
    expect(text()).toContain("PAST_ANSWER_TOKEN");
    expect(text()).toContain("PAST_PROMPT_TOKEN");
    expect(text()).toContain("tnb --resume resume-existing");
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
    await read;
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
