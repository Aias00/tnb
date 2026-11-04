import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { gitRoot, runGit } from "./command";

export type ReviewFile = { path: string; status: string; previousPath?: string; added: number; removed: number; patch: string; binary: boolean };
export type WorkingTreeReview = { root: string; files: ReviewFile[]; total: number };

export function parseGitStatus(output: string): Array<Pick<ReviewFile, "path" | "status" | "previousPath">> {
  const fields = output.split("\0");
  const files: Array<Pick<ReviewFile, "path" | "status" | "previousPath">> = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    if (!field) continue;
    const status = field.slice(0, 2);
    const path = field.slice(3);
    const previousPath = /[RC]/.test(status) ? fields[++i] : undefined;
    files.push({ path, status, ...(previousPath ? { previousPath } : {}) });
  }
  return files;
}

export async function loadWorkingTreeReview(cwd: string, selectedPath?: string): Promise<WorkingTreeReview> {
  const root = await gitRoot(cwd);
  const status = await runGit(root, ["-c", "core.quotepath=false", "status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const entries = parseGitStatus(status.stdout);
  if (selectedPath && !entries.some(entry => entry.path === selectedPath)) throw new Error(`No current change for ${selectedPath}`);
  const selected = selectedPath ? entries.filter(entry => entry.path === selectedPath) : entries.slice(0, 100);
  const head = await runGit(root, ["rev-parse", "--verify", "HEAD"], { allowFailure: true });
  const files: ReviewFile[] = [];
  for (const entry of selected) {
    let patch = "", binary = false;
    if (entry.status === "??" || head.exitCode !== 0) {
      const path = join(root, entry.path);
      const info = await lstat(path).catch(() => undefined);
      if (!info?.isFile()) patch = "Preview unavailable for a directory or symbolic link.";
      else {
        const file = await open(path, "r");
        try {
          const data = Buffer.alloc(64 * 1024);
          const { bytesRead } = await file.read(data, 0, data.length, 0);
          const bytes = data.subarray(0, bytesRead);
          binary = bytes.includes(0);
          const text = bytes.toString("utf8");
          const lines = text ? text.replace(/\n$/, "").split("\n") : [];
          patch = binary ? "Binary file · text preview unavailable." : [
            `--- /dev/null`, `+++ b/${entry.path}`, `@@ -0,0 +${lines.length ? 1 : 0},${lines.length} @@`,
            ...lines.map(line => `+${line}`),
            ...(text && !text.endsWith("\n") ? ["\\ No newline at end of file"] : []),
            ...(info.size > bytesRead ? ["[preview truncated at 64 KiB]"] : []),
          ].join("\n");
        } finally { await file.close(); }
      }
    } else {
      const result = await runGit(root, ["--no-pager", "diff", "--no-ext-diff", "--no-textconv", "--no-color", "HEAD", "--", entry.path, ...(entry.previousPath ? [entry.previousPath] : [])]);
      patch = result.stdout.trimEnd() || "No textual diff (mode, index or conflict metadata changed).";
      binary = /^Binary files |^GIT binary patch/m.test(patch);
    }
    let added = 0, removed = 0, inHunk = false;
    for (const line of patch.split("\n")) {
      if (line.startsWith("diff --git")) inHunk = false;
      if (line.startsWith("@@")) inHunk = true;
      else if (inHunk && line.startsWith("+")) added++;
      else if (inHunk && line.startsWith("-")) removed++;
    }
    files.push({ ...entry, binary, added, removed, patch: patch.length > 100_000 ? `${patch.slice(0, 100_000)}\n[preview truncated at 100,000 characters]` : patch });
  }
  return { root, files, total: entries.length };
}
