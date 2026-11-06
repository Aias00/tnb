import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "../../src/services/git/command";
import { WorkspaceChangeObserver } from "../../src/services/git/observe";
test("observations distinguish command windows from intervening changes without claiming causation", async () => {
  const root = await mkdtemp(join(tmpdir(), "tnb-observe-"));
  try {
    await runGit(root, ["init"]); await writeFile(join(root, "file.txt"), "baseline"); await runGit(root, ["add", "."]);
    const observer = new WorkspaceChangeObserver(), before = await observer.begin(root);
    await writeFile(join(root, "file.txt"), "inside-window");
    const observed = await observer.end(root, before);
    expect(observed.changes[0]).toMatchObject({ path: "file.txt", window: "during-command" }); expect(observed.partial).toBe(false);
    await writeFile(join(root, "file.txt"), "between-commands");
    const next = await observer.begin(root), after = await observer.end(root, next);
    expect(after.changes).toHaveLength(1); expect(after.changes[0]?.window).toBe("between-commands");
    await writeFile(join(root, "file.txt"), "a".repeat(300000));
    const limited = await observer.end(root, await observer.begin(root));
    expect(limited.partial).toBe(true); expect(limited.changes.some(change => change.path === "file.txt")).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
