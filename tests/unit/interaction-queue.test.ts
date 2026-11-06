import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InputQueue, FileInputQueueStorage } from "../../src/ui/input-queue";
import { watchWorkspaceBranch } from "../../src/ui/workspace-status";
import { permissionDetails } from "../../src/ui/permission-details";
import { parseRecommendedLabel } from "../../src/ui/question-label";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function directory() { const path = await mkdtemp(join(tmpdir(), "tnb-ui-queue-")); roots.push(path); return path; }
const input = (text: string) => ({ display: text, expanded: text, mode: "prompt" as const, pastedContents: {} });

test("saved queue survives reopen, preserves paste metadata and never treats a claimed item as unstarted", async () => {
  const directoryPath = await directory(); const storage = new FileInputQueueStorage(directoryPath); const queue = new InputQueue("session", storage); await queue.load();
  const item = await queue.enqueue({ ...input("[paste #1]"), expanded: "original text", pastedContents: { 1: { id: 1, type: "text", content: "original text" } } }, "/work/a");
  await expect(queue.claim(item.id, "/work/b")).rejects.toThrow("工作区");
  await queue.claim(item.id, "/work/a");
  const restored = new InputQueue("session", storage); await restored.load();
  expect(restored.current()[0]).toMatchObject({ id: item.id, state: "uncertain", input: { expanded: "original text", pastedContents: { 1: { content: "original text" } } } });
  await expect(restored.claim(item.id, "/work/a")).rejects.toThrow();
  expect((await restored.remove(item.id)).input.expanded).toBe("original text");
  const empty = new InputQueue("session", storage); await empty.load(); expect(empty.current()).toEqual([]);
});
test("concurrent enqueues retain all identities and a failed durable save acknowledges none", async () => {
  const queue = new InputQueue("session", new FileInputQueueStorage(await directory())); await queue.load();
  await Promise.all(Array.from({ length: 10 }, (_, index) => queue.enqueue(input(`item-${index}`), "/work")));
  expect(new Set(queue.current().map((row) => row.id)).size).toBe(10);
  const failed = new InputQueue("failed", { load: async () => [], save: async () => { throw new Error("disk full"); } }); await failed.load();
  await expect(failed.enqueue(input("keep draft"), "/work")).rejects.toThrow("disk full"); expect(failed.current()).toEqual([]);
  await expect(queue.enqueue(input("/task cancel"), "/work")).rejects.toThrow("格式");
});
test("taking back an input retains a durable draft across reopen and only explicit resubmission makes it pending", async () => {
  const storage = new FileInputQueueStorage(await directory()), queue = new InputQueue("session", storage); await queue.load();
  const item = await queue.enqueue(input("original"), "/work"); await queue.edit(item.id, "/work");
  const reopened = new InputQueue("session", storage); await reopened.load();
  expect(reopened.current()[0]).toMatchObject({ id: item.id, state: "draft", input: { expanded: "original" } });
  await expect(reopened.claim(item.id, "/work")).rejects.toThrow();
  await expect(reopened.requeue(item.id, input("edited"), "/other")).rejects.toThrow();
  await reopened.requeue(item.id, input("edited"), "/work");
  expect((await reopened.claim(item.id, "/work")).input.expanded).toBe("edited");
});
test("permission details preserve the complete command and distinguish the stored rule scope", () => {
  const command = "echo " + "x".repeat(400) + " FINAL_MARKER";
  const lines = permissionDetails({ tool: { name: "bash", risk: "execute", isReadOnly: () => false }, input: { command, cwd: "/work" }, message: "Approval", suggestedRule: "Bash(echo *)" });
  expect(lines.join("\n")).toContain(command); expect(lines.join("\n")).toContain("/work"); expect(lines.join("\n")).toContain("Bash(echo *)");
  expect(parseRecommendedLabel("SQLite（推荐）")).toEqual({ label: "SQLite", recommended: true });
});
test("workspace branch presentation follows worktree metadata without spawning git", async () => {
  const root = await directory(), workspace = join(root, "work"), metadata = join(root, "metadata"); await mkdir(workspace); await mkdir(metadata);
  await writeFile(join(workspace, ".git"), "gitdir: ../metadata\n"); await writeFile(join(metadata, "HEAD"), "ref: refs/heads/main\n");
  const values: string[] = []; const close = await watchWorkspaceBranch(workspace, (value) => values.push(value));
  try {
    expect(values).toEqual(["main"]); await writeFile(join(metadata, "HEAD"), "ref: refs/heads/next\n");
    const end = Date.now() + 2000; while (!values.includes("next") && Date.now() < end) await Bun.sleep(20);
    expect(values).toContain("next");
  } finally { close(); }
});

test("edit permission preview reuses real line diff with context and scope warning", async () => {
  const { permissionPreview } = await import("../../src/ui/permission-details");
  const rows = permissionPreview({ tool: { name: "edit", risk: "write", isReadOnly: () => false }, input: { path: "src/a.ts", oldText: "same\nold", newText: "same\nnew", replaceAll: true }, message: "Review", suggestedRule: "Edit(src/a.ts)" });
  expect(rows.some(row => row.kind === "context" && row.text.includes("same"))).toBe(true);
  expect(rows.find(row => row.kind === "removed")?.text).toContain("- old");
  expect(rows.find(row => row.kind === "added")?.text).toContain("+ new");
  expect(rows.map(row => row.text).join("\n")).toContain("替换所有匹配");
});

test("write approval renders proposed additions without inventing an existing-file diff", async () => {
  const { permissionPreview } = await import("../../src/ui/permission-details");
  const rows = permissionPreview({ tool: { name: "write", risk: "write", isReadOnly: () => false }, input: { path: "new.ts", content: "const newValue = 1;" }, message: "Review" });
  expect(rows.some(row => row.kind === "added" && row.text.includes("+ const newValue"))).toBe(true);
  expect(rows.map(row => row.text).join("\n")).toContain("不代表完整覆盖差异");
});
