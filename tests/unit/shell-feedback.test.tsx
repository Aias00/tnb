import { expect, test } from "bun:test";
import React from "react";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import figures from "figures";
import { ShellSessionManager } from "../../src/services/shell/manager";
import { renderToString } from "../../src/ui/ink/index";
import { TranscriptEntryView } from "../../src/ui/transcript/entry-view";
import { createTranscriptEntry } from "../../src/ui/transcript/model";
import type { ToolProgressData } from "../../src/core/tool";

test("shell feedback reports real exit status, and exit zero is neutral even when output contains error text", async () => {
  const root = await mkdtemp(join(tmpdir(), "tnb-shell-feedback-"));
  const manager = new ShellSessionManager({ cwd: root, outputDir: join(root, "logs") });
  const progress: ToolProgressData[] = [];
  try {
    const output = await manager.runForeground("printf 'error: example diagnostic'; exit 0", 5000, new AbortController().signal, event => progress.push(event));
    expect(progress.at(-1)?.exitCode).toBe(0);
    const completed = createTranscriptEntry(1, { kind: "tool", toolUseId: "one", name: "bash", input: { command: "example" }, status: "completed", output, progress: progress.at(-1) });
    const frame = renderToString(<TranscriptEntryView entry={completed} />, { columns: 100 });
    expect(frame).toContain("exit 0"); expect(frame).toContain("error: example diagnostic"); expect(frame).not.toContain(figures.tick);
    await expect(manager.runForeground("printf 'failed command'; exit 7", 5000, new AbortController().signal, event => progress.push(event))).rejects.toThrow("Command exited with code 7");
    expect(progress.at(-1)?.exitCode).toBe(7);
    const failed = createTranscriptEntry(2, { kind: "tool", toolUseId: "two", name: "bash", input: {}, status: "failed", output: "failed command", progress: progress.at(-1) });
    const failure = renderToString(<TranscriptEntryView entry={failed} />, { columns: 100 });
    expect(failure).toContain("exit 7"); expect(failure).toContain(figures.cross);
  } finally { await manager.close(); await rm(root, { recursive: true, force: true }); }
});
