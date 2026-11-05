import { expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, writeFile, rm, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CLI_COMMANDS } from "../../src/services/cli/commands";
import { SLASH_COMMANDS, parseSlashCommand } from "../../src/ui/slash-commands";
import { CLI_HELP } from "../../src/services/cli/management";

let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "tnb-routing-"));
  // Help and unknown-command errors must work without loading configuration.
  await writeFile(join(directory, "models.json"), "invalid json");
  await writeFile(join(directory, "settings.json"), "invalid json");
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

async function cli(argv: string[]) {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../src/entrypoints/cli.ts"), ...argv], {
    cwd: directory, env: { ...process.env, TNB_HOME: directory }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 5000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  } finally { clearTimeout(timer); }
}

for (const command of CLI_COMMANDS) test(`CLI recognizes ${command} --help without starting a session`, async () => {
  const result = await cli([command, "--help"]);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("Usage:");
  expect(result.stderr).toBe("");
});

test("unknown and slash-only shell commands fail explicitly rather than opening a new session", async () => {
  for (const name of ["resuem", "contineu", "diff", "/clear"]) {
    const result = await cli([name]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unknown command");
    expect(result.stderr).toContain("tnb --help");
  }
  expect((await readdir(directory)).sort()).toEqual(["models.json", "settings.json"]);
});

test("nested help never executes mutation or remote actions", async () => {
  for (const argv of [["provider", "remove", "sample", "--help"], ["mcp", "add", "sample", "--help"], ["update", "--rollback", "--help"], ["goal-loop-stop", "sample", "--help"]]) {
    const result = await cli(argv);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Usage:");
  }
});

test("a nested question version is routed to the answer command instead of printing the app version", async () => {
  const result = await cli(["runtime", "answer", "missing-run", "--version", "1"]);
  expect(result.code).toBe(1); expect(result.stderr).toContain("Answer requires --question"); expect(result.stdout).toBe("");
  for (const flag of ["--version", "-V"]) {
    const version = await cli([flag]); expect(version.code).toBe(0); expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  }
});

test("all built-in slash names and aliases resolve to a canonical command", () => {
  for (const command of SLASH_COMMANDS) {
    for (const name of [command.name, ...command.aliases]) {
      expect(parseSlashCommand(`/${name}`)).toMatchObject({ kind: "command", command: { name: command.name } });
    }
  }
});

test("documented top-level commands are registered", () => {
  const section = CLI_HELP.split("Commands:\n")[1]!.split("\nRun tnb")[0]!;
  for (const line of section.split("\n")) {
    const command = /^  ([a-z][a-z-]*)/.exec(line)?.[1];
    if (command) expect(CLI_COMMANDS as readonly string[]).toContain(command);
  }
});
