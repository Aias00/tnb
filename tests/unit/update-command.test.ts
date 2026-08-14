import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runUpdateCommand } from "../../src/services/update/command";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("self update command", () => {
  test("atomically swaps the current and previous binaries during rollback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tnb-update-"));
    directories.push(directory);
    const executable = join(directory, "tnb");
    await writeFile(executable, "current");
    await writeFile(`${executable}.previous`, "previous");
    let stdout = "";
    let stderr = "";

    const exitCode = await runUpdateCommand({
      argv: ["update", "--rollback"],
      env: { TNB_EXECUTABLE: executable },
      stdout: { write: (text) => void (stdout += text) },
      stderr: { write: (text) => void (stderr += text) },
      currentVersion: "0.1.0",
      executable,
    });

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Rolled back tnb");
    expect(await readFile(executable, "utf8")).toBe("previous");
    expect(await readFile(`${executable}.previous`, "utf8")).toBe("current");
  });
});
