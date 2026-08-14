import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertToolPathInsideAllowedRoots,
  assertToolPathInsideWorkspace,
} from "../../src/utils/workspace-path";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("workspace tool path guard", () => {
  test("allows a nested write when its missing parents remain under the workspace", async () => {
    const workspace = await temporaryDirectory("tnb-workspace-");

    await expect(
      assertToolPathInsideWorkspace(workspace, "new/nested/file.txt", "write"),
    ).resolves.toBeUndefined();
  });

  test("blocks reads through a symlink that resolves outside the workspace", async () => {
    const workspace = await temporaryDirectory("tnb-workspace-");
    const outside = await temporaryDirectory("tnb-outside-");
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(join(outside, "secret.txt"), join(workspace, "link.txt"));

    await expect(
      assertToolPathInsideWorkspace(workspace, "link.txt", "read"),
    ).rejects.toThrow("outside the workspace");
  });

  test("blocks writes through a symlinked parent outside the workspace", async () => {
    const workspace = await temporaryDirectory("tnb-workspace-");
    const outside = await temporaryDirectory("tnb-outside-");
    await mkdir(join(outside, "target"));
    await symlink(join(outside, "target"), join(workspace, "linked"));

    await expect(
      assertToolPathInsideWorkspace(workspace, "linked/file.txt", "write"),
    ).rejects.toThrow("outside the workspace");
  });

  test("accepts an approved root through its canonical macOS path", async () => {
    const root = await temporaryDirectory("tnb-root-");
    const approved = await temporaryDirectory("tnb-approved-");
    const file = join(approved, "shared.txt");
    await writeFile(file, "shared");

    await expect(assertToolPathInsideAllowedRoots(root, file, "read", [approved])).resolves.toBeUndefined();
  });
});
