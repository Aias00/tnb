import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ShellSessionManager } from "../../src/services/shell/manager";
import { createShellTools } from "../../src/tools/shell";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createManager() {
  const root = await mkdtemp(join(tmpdir(), "tnb-shell-tool-"));
  roots.push(root);
  return new ShellSessionManager({
    cwd: root,
    outputDir: join(root, ".tnb", "shell"),
  });
}

describe("shell tool", () => {
  test("marks read-only POSIX commands as read-only", async () => {
    const manager = await createManager();
    const bash = createShellTools(manager, { TNB_SHELL: "/bin/zsh" }).find((tool) => tool.name === "bash");

    expect(bash).toBeDefined();
    expect(bash!.isReadOnly({ command: "pwd && git status" })).toBe(true);
    expect(bash!.isReadOnly({ command: "touch created.txt" })).toBe(false);

    await manager.close();
  });

  test("marks read-only PowerShell aliases as read-only", async () => {
    const manager = await createManager();
    const bash = createShellTools(manager, { TNB_SHELL: "pwsh.exe" }).find((tool) => tool.name === "bash");

    expect(bash).toBeDefined();
    expect(bash!.isReadOnly({ command: "dir src | select Name" })).toBe(true);
    expect(bash!.isReadOnly({ command: "New-Item -Path src/tmp -ItemType Directory" })).toBe(false);

    await manager.close();
  });

  test("rejects mutually exclusive background and PTY execution", async () => {
    const manager = await createManager();
    const bash = createShellTools(manager, { TNB_SHELL: "/bin/zsh" }).find((tool) => tool.name === "bash");

    expect(() =>
      bash!.validate({
        command: "pwd",
        run_in_background: true,
        pty: true,
      })
    ).toThrow("mutually exclusive");

    await manager.close();
  });
});
