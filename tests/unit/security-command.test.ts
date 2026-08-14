import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runSecurityScanCommand } from "../../src/services/security/command";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("security-scan command", () => {
  test("prints command help without scanning", async () => {
    let stdout = "";
    expect(await runSecurityScanCommand({
      argv: ["security-scan", "--help"],
      cwd: await workspace(),
      stdout: { write: (text) => { stdout += text; } },
      stderr: { write: () => undefined },
    })).toBe(0);
    expect(stdout).toContain("Usage: tnb security-scan");
    expect(stdout).toContain("--base <commit>");
    expect(stdout).toContain("--exclude <path>");
  });

  test("accepts base/path filters and emits structured JSON", async () => {
    const root = await workspace();
    await mkdir(join(root, "src"), { recursive: true });
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "tnb@example.invalid"]);
    await git(root, ["config", "user.name", "tnb test"]);
    await writeFile(join(root, "src", "safe.ts"), "export const safe = true;\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-qm", "base"]);
    const baseCommit = (await git(root, ["rev-parse", "HEAD"])).trim();
    await writeFile(join(root, "src", "unsafe.ts"), 'const password = "super-secret-value";\n');

    let stdout = "";
    expect(await runSecurityScanCommand({
      argv: ["security-scan", "--base", baseCommit, "--path-glob", "src/**/*.ts", "--json"],
      cwd: root,
      stdout: { write: (text) => { stdout += text; } },
      stderr: { write: () => undefined },
    })).toBe(2);

    expect(JSON.parse(stdout)).toMatchObject({
      scannedFiles: 1,
      scope: {
        mode: "diff",
        baseCommit,
        pathGlob: "src/**/*.ts",
      },
      findings: [
        {
          rule: "generic-secret",
          source: "builtin",
          path: "src/unsafe.ts",
        },
      ],
    });
  });
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tnb-security-command-"));
  roots.push(root);
  return root;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(stderr);
  return stdout;
}
