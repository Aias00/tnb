import { expect, test } from "bun:test";
import React from "react";
import chalk from "chalk";
import { Terminal } from "@xterm/headless";
import { PassThrough, Writable } from "node:stream";
import { render, AlternateScreen } from "../../src/ui/ink/index";
import { TuiApp, type TuiTurn } from "../../src/ui/app";

async function until(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for TUI state");
    await Bun.sleep(10);
  }
}

test("queues prompts without losing drafts and navigates slash commands", async () => {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const terminal = new Terminal({ cols: 120, rows: 30, allowProposedApi: true });
  const screen = () => Array.from({ length: terminal.rows }, (_, i) => terminal.buffer.active.getLine(terminal.buffer.active.baseY + i)?.translateToString(true) ?? "").join("\n");
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) { terminal.write(chunk.toString(), done); } }), { isTTY: true, columns: 120, rows: 30 });
  const turns: TuiTurn[] = [];
  const commands: string[] = [];
  const finish: Array<() => void> = [];
  const app = await render(<AlternateScreen><TuiApp model="test-model" permissionMode="default" sessionIdFactory={() => "test"} runCommand={async (request) => { commands.push(request.name); return { message: "command complete" }; }} stdout={stdout as unknown as NodeJS.WriteStream} runTurn={(turn) => {
    turns.push(turn);
    return new Promise<void>((resolve) => finish.push(resolve));
  }} /></AlternateScreen>, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false, exitOnCtrlC: false });
  const send = async (text: string) => { stdin.write(text); await Bun.sleep(40); };
  try {
    await send("first"); await send("\r");
    await until(() => turns.length === 1);
    await send("\u001b[200~a\nb\nc\nd\u001b[201~"); await send("\r");
    await send("third"); await send("\r");
    await until(() => screen().includes("2 queued"));
    expect(turns).toHaveLength(1);
    await send("unfinished draft");
    finish[0]!();
    await until(() => turns.length === 2);
    expect(turns[1]!.input.expanded).toBe("a\nb\nc\nd");
    expect(Object.keys(turns[1]!.input.pastedContents)).toHaveLength(1);
    await until(() => screen().includes("unfinished draft"));
    finish[1]!();
    await until(() => turns.length === 3);
    expect(turns[2]!.input.expanded).toBe("third");
    await until(() => screen().includes("enter queue"));
    await send("\u001b");
    await until(() => turns[2]!.signal.aborted);
    finish[2]!();
    await until(() => screen().includes("enter send"));
    await send("\r");
    await until(() => turns.length === 4);
    expect(turns[3]!.input.expanded).toBe("unfinished draft");
    finish[3]!();
    await until(() => screen().includes("enter send"));
    await send("/mo");
    await send("\u001b[B");
    await send("\r");
    await until(() => screen().includes("/models"));
    expect(commands).toHaveLength(0);
    await send("\r");
    await until(() => commands.length === 1);
    expect(commands).toEqual(["models"]);
    expect(turns).toHaveLength(4);
  } finally {
    for (const resolve of finish) resolve();
    app.unmount(); app.cleanup(); stdin.destroy(); stdout.destroy(); terminal.dispose();
  }
});

async function interactive(options: Partial<import("../../src/ui/app").TuiAppOptions> = {}) {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const terminal = new Terminal({ cols: 120, rows: 34, allowProposedApi: true });
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) { terminal.write(chunk.toString(), done); } }), { isTTY: true, columns: 120, rows: 34 });
  const app = await render(<AlternateScreen><TuiApp model="test" permissionMode="default" sessionIdFactory={() => "interaction"} runTurn={async () => {}} {...options} stdout={stdout as unknown as NodeJS.WriteStream} /></AlternateScreen>, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false, exitOnCtrlC: false });
  return {
    async send(value: string) { stdin.write(value); await Bun.sleep(40); },
    async corruptDisplay() { stdout.write("\u001b[1;1HSTALE_GHOST_ROW"); await Bun.sleep(30); },
    async repaint() { const { default: instances } = await import("../../src/ui/ink/instances"); instances.get(stdout as unknown as NodeJS.WriteStream)?.forceRedraw(); await Bun.sleep(50); },
    async resize(columns: number, rows: number) { stdout.columns = columns; stdout.rows = rows; terminal.resize(columns, rows); stdout.emit("resize"); await Bun.sleep(60); },
    screen: () => Array.from({ length: terminal.rows }, (_, i) => terminal.buffer.active.getLine(terminal.buffer.active.baseY + i)?.translateToString(true) ?? "").join("\n"),
    colorOf(text: string) {
      for (let row = 0; row < terminal.rows; row++) {
        const line = terminal.buffer.active.getLine(terminal.buffer.active.baseY + row);
        const index = line?.translateToString(true).indexOf(text) ?? -1;
        if (index >= 0) return line?.getCell(index)?.getFgColor();
      }
      return undefined;
    },
    close() { app.unmount(); app.cleanup(); stdin.destroy(); stdout.destroy(); terminal.dispose(); },
  };
}

test("queue panel previews, removes and restores editable structured pastes", async () => {
  const turns: TuiTurn[] = [];
  let finish = () => {};
  const ui = await interactive({ runTurn: turn => { turns.push(turn); return new Promise<void>(resolve => { finish = resolve; }); } });
  try {
    await ui.send("start"); await ui.send("\r");
    await ui.send("\u001b[200~alpha\nbeta\ngamma\ndelta\u001b[201~"); await ui.send("\r");
    await ui.send("remove me"); await ui.send("\r");
    await ui.send("\u0011");
    await until(() => ui.screen().includes("Queued prompts · 2 saved"));
    expect(ui.screen()).toContain("alpha");
    await ui.send("\u001b[B"); await ui.send("d");
    expect(ui.screen()).toContain("Y 确认");
    expect(ui.screen()).toContain("Queued prompts · 2 saved");
    await ui.send("y");
    expect(ui.screen()).toContain("Queued prompts · 1 saved");
    // While the panel is open a completed turn must not drain the queue.
    finish(); await Bun.sleep(60);
    expect(turns).toHaveLength(1);
    await ui.send("e");
    await until(() => ui.screen().includes("[Pasted text #1"));
    await ui.send("\r");
    await until(() => turns.length === 2);
    expect(turns[1]!.input.expanded).toBe("alpha\nbeta\ngamma\ndelta");
    expect(turns[1]!.input.pastedContents[1]?.type).toBe("text");
  } finally { finish(); ui.close(); }
});

test("queue edit refuses to overwrite an existing draft", async () => {
  let finish = () => {};
  const ui = await interactive({ runTurn: () => new Promise<void>(resolve => { finish = resolve; }) });
  try {
    await ui.send("start"); await ui.send("\r");
    await ui.send("queued"); await ui.send("\r");
    await ui.send("valuable draft"); await ui.send("\u0011"); await ui.send("e");
    expect(ui.screen()).toContain("Keep or clear the current draft");
    expect(ui.screen()).toContain("1 saved");
    await ui.send("\u0011");
    expect(ui.screen()).toContain("valuable draft");
  } finally { finish(); ui.close(); }
});

test("Ctrl+Q and task workbench share one durable queue and retain the original while editing", async () => {
  const turns: TuiTurn[] = [], finish = Promise.withResolvers<void>();
  let saved: import("../../src/ui/workbench").QueuedInput[] = [];
  const ui = await interactive({ queueStorage: { load: async () => structuredClone(saved), save: async (_session, rows) => { saved = structuredClone([...rows]); } },
    runTurn: async turn => { turns.push(turn); if (turns.length === 1) await finish.promise; } });
  try {
    await ui.send("start"); await ui.send("\r");
    await ui.send("shared input"); await ui.send("\r");
    await until(() => saved[0]?.state === "pending"); const id = saved[0]!.id;
    await ui.send("\u0011"); await until(() => ui.screen().includes("Queued prompts · 1 saved"));
    await ui.send("\u0011"); await ui.send("\u0014"); await ui.send("\t"); await ui.send("\t");
    await until(() => ui.screen().includes("任务工作台 · 排队输入")); expect(ui.screen()).toContain("shared input");
    await ui.send("e"); await until(() => saved[0]?.state === "draft");
    expect(saved[0]).toMatchObject({ id, input: { expanded: "shared input" } });
    await ui.send(" amended"); await ui.send("\r"); await until(() => saved[0]?.state === "pending");
    expect(saved).toHaveLength(1); expect(saved[0]!.id).toBe(id);
    await ui.send("\u0011"); await until(() => ui.screen().includes("shared input amended"));
    finish.resolve(); await Bun.sleep(60); expect(turns).toHaveLength(1);
    await ui.send("\u0011"); await until(() => turns.length === 2 && saved.length === 0);
    expect(turns[1]!.input.expanded).toBe("shared input amended");
  } finally { finish.resolve(); ui.close(); }
});

test("custom editor and image shortcuts work and disabled defaults stay disabled", async () => {
  const { DEFAULT_KEYBINDINGS } = await import("../../src/ui/keybindings");
  const turns: TuiTurn[] = [];
  let images = 0, editors = 0;
  const ui = await interactive({
    keybindings: { ...DEFAULT_KEYBINDINGS, externalEditor: "ctrl+l", pasteImage: "ctrl+p" },
    editInput: async () => { editors++; return { content: "edited prompt" }; },
    pasteImage: async () => { images++; return "screen.png"; },
    runTurn: async turn => { turns.push(turn); },
  });
  try {
    await ui.send("\u0007"); await ui.send("\u0016");
    expect(editors).toBe(0); expect(images).toBe(0);
    await ui.send("\u000c"); await ui.send("\u0010"); await ui.send("\r");
    await until(() => turns.length === 1);
    expect(editors).toBe(1); expect(images).toBe(1);
    expect(turns[0]!.input.expanded).toContain("edited prompt");
    expect(turns[0]!.input.pastedContents[1]?.type).toBe("image");
  } finally { ui.close(); }
});

test("tool expansion is per card and never submits the current draft", async () => {
  const { createTranscriptEntry } = await import("../../src/ui/transcript/model");
  let turns = 0;
  const ui = await interactive({ initialTranscript: [
    createTranscriptEntry(0, { kind: "tool", toolUseId: "a", name: "bash", input: {}, status: "completed", output: "a1\na2\na3\na4\nONLY_A_TAIL" }),
    createTranscriptEntry(1, { kind: "tool", toolUseId: "b", name: "bash", input: {}, status: "completed", output: "b1\nb2\nb3\nb4\nONLY_B_TAIL" }),
  ], runTurn: async () => { turns++; } });
  try {
    await ui.send("do not send");
    await ui.send("\u001b[1;3A"); await ui.send("\u001b[13;3u");
    await until(() => ui.screen().includes("ONLY_B_TAIL"));
    expect(ui.screen()).not.toContain("ONLY_A_TAIL");
    expect(turns).toBe(0);
    expect(ui.screen()).toContain("do not send");
    await ui.send("\u001b[1;3A"); await ui.send("\u001b[13;3u");
    await until(() => ui.screen().includes("ONLY_A_TAIL"));
    await ui.send("\u001b[13;3u");
    expect(ui.screen()).not.toContain("ONLY_A_TAIL");
  } finally { ui.close(); }
});

test("session search filters by prompt and resumes the visible selection", async () => {
  const commands: string[] = [];
  const ui = await interactive({ initialManagement: { kind: "sessions", title: "Resume", items: [
    { id: "one", label: "First", preview: ["fix database"], command: "/resume one" },
    { id: "two", label: "Second", preview: ["fix network"], command: "/resume two" },
  ] }, runCommand: async request => { commands.push(`${request.name} ${request.argument}`); return { message: "Resumed", resetSession: true, sessionId: "two", resumeSession: true }; } });
  try {
    await ui.send("/"); await ui.send("network"); await ui.send("\r");
    expect(ui.screen()).toContain("Second");
    expect(ui.screen()).not.toContain("First");
    await ui.send("\r");
    await until(() => commands.length === 1);
    expect(commands).toEqual(["resume two"]);
  } finally { ui.close(); }
});

test("activity shows waiting, thinking, tool execution, elapsed time and cancellation", async () => {
  let turn: TuiTurn | undefined;
  let finish = () => {};
  const ui = await interactive({ runTurn: value => { turn = value; return new Promise<void>(resolve => { finish = resolve; }); } });
  try {
    await ui.send("test status"); await ui.send("\r");
    expect(ui.screen()).toContain("Requesting model");
    turn!.onModelEvent({ type: "thinking", index: 0, thinking: "reasoning" });
    await until(() => ui.screen().includes("Thinking"));
    turn!.onModelEvent({ type: "tool-start", index: 0, id: "r", name: "read" });
    await until(() => ui.screen().includes("Preparing read"));
    turn!.onModelEvent({ type: "tool-input", index: 0, json: '{"path":"test"}' });
    await until(() => ui.screen().includes("Preparing read arguments"));
    turn!.onToolEvent({ type: "tool-execution-start", id: "r", name: "read", input: {}, startedAt: Date.now() });
    await until(() => ui.screen().includes("Running read"));
    expect(ui.screen()).toMatch(/· \d+s/);
    turn!.onToolEvent({ type: "tool-execution-end", id: "r", name: "read", output: "okay", isError: false, durationMs: 1 });
    await until(() => ui.screen().includes("Requesting model"));
    await ui.send("\u001b");
    await until(() => ui.screen().includes("Cancelling…"));
    expect(turn!.signal.aborted).toBe(true);
    finish();
    await until(() => ui.screen().includes("Interrupted"));
  } finally { finish(); ui.close(); }
});


test("Markdown headings, list markers and inline code follow the selected accent", async () => {
  const { createTranscriptEntry } = await import("../../src/ui/transcript/model");
  const previousColorLevel = chalk.level;
  chalk.level = 1;
  const ui = await interactive({ theme: "blue", initialTranscript: [createTranscriptEntry(0, { kind: "assistant", text: "# HeadingToken\n\n- ListToken\n\n`CodeToken`", streaming: false })] });
  try {
    await until(() => ui.screen().includes("HeadingToken"));
    expect(ui.colorOf("HeadingToken")).toBe(4);
    expect(ui.colorOf("•")).toBe(4);
    expect(ui.colorOf("CodeToken")).toBe(4);
  } finally { ui.close(); chalk.level = previousColorLevel; }
});


test("editing shortcuts and forward Delete act on the real prompt", async () => {
  const turns: TuiTurn[] = [];
  const ui = await interactive({ runTurn: async turn => { turns.push(turn); } });
  try {
    await ui.send("hello world"); await ui.send("\u0017"); await ui.send("\u0019");
    await ui.send("\u0001"); await ui.send("\u001b[3~");
    await ui.send("\u0005"); await ui.send("\u007f");
    await ui.send("\u0015"); await ui.send("\u0019");
    await ui.send("\r");
    await until(() => turns.length === 1);
    expect(turns[0]!.input.expanded).toBe("ello worl");
  } finally { ui.close(); }
});


test("file menu accepts at the cursor without submitting or losing paste data", async () => {
  const turns: TuiTurn[] = [];
  const ui = await interactive({ completeInput: async (input, _signal, cursor) => {
    const { workspaceCompletionToken } = await import("../../src/ui/file-completion");
    const token = workspaceCompletionToken(input, cursor);
    return token ? [input.slice(0, token.start) + "@src/widget.ts" + input.slice(token.end)] : [];
  }, runTurn: async turn => { turns.push(turn); } });
  try {
    await ui.send("\u001b[200~one\ntwo\nthree\nfour\u001b[201~");
    await ui.send(" read @wi suffix");
    // Move the cursor from the sentence end back to the file reference.
    await ui.send("\u001b[D".repeat(7));
    await until(() => ui.screen().includes("@src/widget.ts"));
    await ui.send("\r");
    expect(turns).toHaveLength(0);
    await ui.send(" more"); await ui.send("\r");
    await until(() => turns.length === 1);
    expect(turns[0]!.input.expanded).toBe("one\ntwo\nthree\nfour read @src/widget.ts more suffix");
    expect(turns[0]!.input.pastedContents[1]?.type).toBe("text");
  } finally { ui.close(); }
});

test("late completion results cannot overwrite newer input", async () => {
  let resolveOld: ((values: string[]) => void) | undefined;
  const turns: TuiTurn[] = [];
  const ui = await interactive({ completeInput: () => new Promise(resolve => { resolveOld ??= resolve; }), runTurn: async turn => { turns.push(turn); } });
  try {
    await ui.send("read @wi");
    await until(() => Boolean(resolveOld));
    await ui.send("x");
    resolveOld!(["read @wrong.ts"]);
    await Bun.sleep(80);
    expect(ui.screen()).not.toContain("@wrong.ts");
    await ui.send("\r");
    await until(() => turns.length === 1);
    expect(turns[0]!.input.expanded).toBe("read @wix");
  } finally { ui.close(); }
});

test("small terminal keeps selected completions, prompt and footer visible through resize", async () => {
  const ui = await interactive({ completeInput: async input => Array.from({ length: 20 }, (_, i) => input.replace(/@.*/, `@file-${i}.ts`)) });
  try {
    await ui.resize(42, 12);
    await ui.send("read @file");
    await until(() => ui.screen().includes("@file-0.ts"));
    await ui.send("\u001b[B".repeat(15));
    expect(ui.screen()).toContain("@file-15.ts");
    expect(ui.screen()).toContain("read @file");
    expect(ui.screen().split("\n").at(-1)).toContain("test");
    await ui.resize(90, 24);
    expect(ui.screen()).toContain("@file-15.ts");
    await ui.send("\u001b");
    expect(ui.screen()).toContain("read @file");
  } finally { ui.close(); }
});

test("change review browses files and opens full detail without invoking a model", async () => {
  let turns = 0;
  const ui = await interactive({ initialManagement: { kind: "diff", title: "Review workspace changes", items: [
    { id: "one.ts", label: "one.ts", command: '/diff "one.ts"', description: "+1 −1", diffPreview: "@@ -1 +1 @@\n-old-one\n+new-one" },
    { id: "two.ts", label: "two.ts", command: '/diff "two.ts"', description: "+1 −1", diffPreview: "@@ -1 +1 @@\n-old-two\n+new-two" },
  ] }, runTurn: async () => { turns++; } });
  try {
    await ui.send("\u001b[B");
    expect(ui.screen()).toContain("+new-two");
    expect(ui.screen()).not.toContain("+new-one");
    await ui.send("\r");
    expect(ui.screen()).toContain("+new-two");
    await ui.send("\u001b");
    await until(() => ui.screen().includes("one.ts"));
    expect(turns).toBe(0);
    await ui.resize(45, 18);
    await ui.send("\r");
    expect(ui.screen()).toContain("+new-two");
  } finally { ui.close(); }
});

test("theme changes, clear and a new waiting turn do not leave stale prompt/footer rows", async () => {
  const { createTranscriptEntry } = await import("../../src/ui/transcript/model");
  let finish = () => {};
  const ui = await interactive({ initialTranscript: [createTranscriptEntry(0, { kind: "assistant", text: "| 层面 | 技术 |\n|---|---|\n| runtime | Bun and TypeScript |", streaming: false })],
    runCommand: async request => request.name === "theme" ? { theme: "magenta", message: "Theme changed to magenta." } : { resetSession: true, message: "Started new session." },
    runTurn: () => new Promise<void>(resolve => { finish = resolve; }),
  });
  try {
    await ui.resize(60, 14);
    await ui.send("/theme magenta"); await ui.send("\r");
    await until(() => ui.screen().includes("Theme changed"));
    await ui.send("/clear"); await ui.send("\r");
    await until(() => ui.screen().includes("Started new session"));
    expect(ui.screen()).not.toContain("Bun and TypeScript");
    await ui.send("clear"); await ui.send("\r");
    await until(() => ui.screen().includes("Requesting model"));
    await Bun.sleep(250);
    expect(ui.screen().match(/enter queue/g)).toHaveLength(1);
    expect(ui.screen().match(/Requesting model/g)).toHaveLength(1);
    expect(ui.screen().match(/╭/g)).toHaveLength(1);
    expect(ui.screen().match(/╰/g)).toHaveLength(1);
    expect(ui.screen().split("\n").at(-1)).toContain("test");
    await ui.resize(100, 24);
    expect(ui.screen().match(/enter queue/g)).toHaveLength(1);
    expect(ui.screen().match(/╰/g)).toHaveLength(1);
    const normalize = (value: string) => value.replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, "*").replace(/· \d+s/g, "· Ns").split("\n").map(line => line.trimEnd()).join("\n");
    const incremental = normalize(ui.screen());
    await ui.repaint();
    expect(normalize(ui.screen())).toBe(incremental);
    await ui.corruptDisplay();
    expect(ui.screen()).toContain("STALE_GHOST_ROW");
    await ui.send("\u000c");
    expect(ui.screen()).not.toContain("STALE_GHOST_ROW");
    expect(ui.screen().match(/enter queue/g)).toHaveLength(1);
  } finally { finish(); ui.close(); }
});

test("ledger snapshots keep invocation limits separate from session totals and late background usage", async () => {
  const turns: TuiTurn[] = [];
  const finishes: Array<() => void> = [];
  const ui = await interactive({ invocationBudgetUsd: 3, runTurn: turn => { turns.push(turn); return new Promise<void>(resolve => finishes.push(resolve)); } });
  const usage = (costUsd: number) => ({ inputTokens: Math.round(costUsd * 1000), outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd });
  try {
    await ui.send("first"); await ui.send("\r");
    turns[0]!.onUsage(usage(1));
    turns[0]!.onModelEvent({ type: "usage", usage: usage(1) });
    await until(() => ui.screen().includes("会话 $1.0000"));
    expect(ui.screen()).toContain("本轮 $1.0000/$3.00");
    expect(ui.screen()).not.toContain("会话 $2.0000");
    finishes[0]!(); await until(() => ui.screen().includes("enter send"));
    await ui.send("second"); await ui.send("\r");
    turns[1]!.onUsage(usage(0.5));
    await until(() => ui.screen().includes("会话 $1.5000"));
    expect(ui.screen()).toContain("本轮 $0.5000/$3.00");
    turns[0]!.onUsage(usage(1.2));
    turns[0]!.onUsage(usage(1.1));
    turns[0]!.onUsage(usage(1.3));
    await until(() => ui.screen().includes("会话 $1.8000"));
    expect(ui.screen()).toContain("本轮 $0.5000/$3.00");
    turns[1]!.onUsage(usage(3.1));
    await until(() => ui.screen().includes("本轮 $3.1000/$3.00"));
    expect(ui.screen()).toContain("会话 $4.4000");
  } finally { for (const finish of finishes) finish(); ui.close(); }
});

test("a restored ledger rejects late snapshots from a previous activation of the same session", async () => {
  const turns: TuiTurn[] = [];
  const finishes: Array<() => void> = [];
  const snapshot = (costUsd: number) => ({ inputTokens: 100, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd });
  const ui = await interactive({ sessionIdFactory: () => "same-session", runTurn: turn => { turns.push(turn); return new Promise<void>(resolve => finishes.push(resolve)); },
    runCommand: async () => ({ resetSession: true, resumeSession: true, sessionId: "same-session", restoredUsage: snapshot(5) }),
  });
  try {
    await ui.send("first"); await ui.send("\r");
    turns[0]!.onUsage(snapshot(1));
    finishes[0]!(); await until(() => ui.screen().includes("enter send"));
    await ui.send("/resume same-session"); await ui.send("\r");
    await until(() => ui.screen().includes("会话 $5.0000"));
    turns[0]!.onUsage(snapshot(2)); await Bun.sleep(30);
    expect(ui.screen()).toContain("会话 $5.0000");
    turns[0]!.onUsage(snapshot(2), snapshot(6));
    await until(() => ui.screen().includes("会话 $6.0000"));
    expect(ui.screen()).not.toContain("本轮 $2.0000");
    await ui.send("new turn"); await ui.send("\r");
    turns[1]!.onUsage(snapshot(0.5));
    await until(() => ui.screen().includes("会话 $6.5000"));
  } finally { for (const finish of finishes) finish(); ui.close(); }
});

test("real retry events switch the TUI between backoff, retry dispatch and normal output", async () => {
  let turn: TuiTurn | undefined, finish = () => {};
  const ui = await interactive({ runTurn: value => { turn = value; return new Promise<void>(resolve => { finish = resolve; }); } });
  try {
    await ui.send("retry test"); await ui.send("\r");
    turn!.onModelEvent({ type: "retry", phase: "waiting", retry: 2, maxRetries: 10, delayMs: 5000, status: 429, reason: "rate-limit" });
    await until(() => ui.screen().includes("Rate limited (429) · retry 2/10 in"));
    turn!.onModelEvent({ type: "retry", phase: "requesting", retry: 2, maxRetries: 10, delayMs: 5000, reason: "rate-limit" });
    await until(() => ui.screen().includes("Retrying model · 2/10"));
    turn!.onModelEvent({ type: "text", index: 0, text: "recovered" });
    await until(() => ui.screen().includes("Writing response"));
  } finally { finish(); ui.close(); }
});

test("reserved Ctrl+C still interrupts when a custom shortcut tries to claim it", async () => {
  const { DEFAULT_KEYBINDINGS } = await import("../../src/ui/keybindings");
  let turn: TuiTurn | undefined, finish = () => {};
  const ui = await interactive({ keybindings: { ...DEFAULT_KEYBINDINGS, pasteImage: "ctrl+c", historySearch: "ctrl+c" }, runTurn: value => { turn = value; return new Promise<void>(resolve => { finish = resolve; }); }, pasteImage: async () => { throw new Error("reserved key must not paste"); } });
  try {
    await ui.send("cancel test"); await ui.send("\r");
    await until(() => Boolean(turn));
    await ui.send("\u0003");
    expect(turn!.signal.aborted).toBe(true);
  } finally { finish(); ui.close(); }
});

test("IDE selection attaches to an editable draft without sending or losing existing paste data", async () => {
  const turns: TuiTurn[] = [];
  let resolveCommand!: (result: import("../../src/ui/slash-commands").SlashCommandResult) => void;
  const ui = await interactive({ runCommand: () => new Promise(resolve => { resolveCommand = resolve; }), runTurn: async turn => { turns.push(turn); } });
  try {
    await ui.send("/ide attach"); await ui.send("\r");
    await until(() => Boolean(resolveCommand));
    await ui.send("\u001b[200~draft one\ndraft two\ndraft three\ndraft four\u001b[201~");
    resolveCommand({ inputReference: { label: "src/demo.ts:1-2", text: "IDE selection snapshot · src/demo.ts:1-2\nselected code\nEnd IDE selection snapshot" }, message: "IDE selection added to draft" });
    await until(() => ui.screen().includes("IDE selection added to draft"));
    expect(turns).toHaveLength(0);
    await ui.send("\r"); await until(() => turns.length === 1);
    expect(turns[0]!.input.expanded).toContain("draft one\ndraft two\ndraft three\ndraft four");
    expect(turns[0]!.input.expanded).toContain("selected code");
    expect(Object.keys(turns[0]!.input.pastedContents)).toHaveLength(2);
  } finally { ui.close(); }
});

test("permission Diff stays pending during paging and preserves approval controls", async () => {
  const { PermissionController } = await import("../../src/ui/permission-controller");
  const controller = new PermissionController();
  const ui = await interactive({ permissionController: controller });
  const decision = controller.request({ tool: { name: "edit", risk: "write", isReadOnly: () => false }, input: { path: "src/demo.ts", oldText: "unchanged\nold value", newText: "unchanged\nnew value" }, message: "Approve patch" });
  try {
    await until(() => ui.screen().includes("修改预览"));
    expect(ui.screen()).toContain("- old value"); expect(ui.screen()).toContain("+ new value");
    await ui.send("\u001b[6~");
    expect(controller.current()).toBeDefined();
    await ui.send("\r"); expect(await decision).toBe("allow");
  } finally { controller.resolve("deny"); await decision; ui.close(); }
});

test("an unfocused terminal gets one generic idle approval notification", async () => {
  const { PermissionController } = await import("../../src/ui/permission-controller");
  const controller = new PermissionController(), seen: string[] = [];
  const ui = await interactive({ permissionController: controller, notify: kind => seen.push(kind) });
  const decision = controller.request({ tool: { name: "bash", risk: "execute", isReadOnly: () => false }, input: { command: "SECRET_COMMAND_CONTENT" }, message: "Approve" });
  try {
    await ui.send("\u001b[O");
    await until(() => seen.length === 1);
    expect(seen).toEqual(["permission"]);
    await Bun.sleep(600); expect(seen).toHaveLength(1);
    await ui.send("\u001b[I");
  } finally { controller.resolve("deny"); await decision; ui.close(); }
});

test("content search selection returns a reference to the draft without running a turn", async () => {
  const turns: TuiTurn[] = [];
  const ui = await interactive({ runTurn: async turn => { turns.push(turn); }, runCommand: async () => ({ management: { kind: "search", title: "Search matches", items: [{ id: "one", label: "a.ts:2", preview: ["2: target"], command: "", draftReference: '@"a.ts":2' }] } }) });
  try {
    await ui.send("/search target"); await ui.send("\r");
    await until(() => ui.screen().includes("Search matches"));
    await ui.send("\r"); await until(() => ui.screen().includes("引用已加入草稿"));
    expect(turns).toHaveLength(0); expect(ui.screen()).toContain('@"a.ts":2');
  } finally { ui.close(); }
});

test("selected user message is reused without auto-submit or overwriting a draft", async () => {
  const { DEFAULT_KEYBINDINGS } = await import("../../src/ui/keybindings");
  const turns: TuiTurn[] = [];
  const ui = await interactive({ keybindings: { ...DEFAULT_KEYBINDINGS, previousMessage: "meta+j" }, runTurn: async turn => { turns.push(turn); } });
  try {
    await ui.send("reuse this"); await ui.send("\r"); await until(() => turns.length === 1 && ui.screen().includes("enter send"));
    await ui.send("\u001bj"); await ui.send("\u001be");
    await until(() => ui.screen().includes("消息已放回草稿"));
    expect(turns).toHaveLength(1);
    await ui.send("\u001be"); await until(() => ui.screen().includes("草稿已有内容"));
    expect(turns).toHaveLength(1);
  } finally { ui.close(); }
});

test("child progress renders real tool state and return recap preserves the ongoing turn", async () => {
  let turn: TuiTurn | undefined, finish = () => {};
  const ui = await interactive({ runTurn: current => { turn = current; return new Promise<void>(resolve => { finish = resolve; }); } });
  try {
    await ui.send("work"); await ui.send("\r"); await until(() => Boolean(turn));
    turn!.onToolEvent({ type: "tool-execution-start", id: "child", name: "agent", input: { description: "Read files" }, startedAt: Date.now() });
    turn!.onToolEvent({ type: "tool-execution-progress", id: "child", name: "agent", data: { agentPhase: "tool", latestTool: "read", elapsedTimeSeconds: 3 } });
    await until(() => ui.screen().includes("Running tool") && ui.screen().includes("read"));
    await ui.send("\u001b[O");
    turn!.onToolEvent({ type: "tool-execution-end", id: "child", name: "agent", output: "done", isError: false, durationMs: 3000 });
    await ui.send("\u001b[I"); await until(() => ui.screen().includes("离开期间：1 次工具执行完成"));
    expect(turn!.signal.aborted).toBe(false);
  } finally { finish(); ui.close(); }
});

test("message reuse restores the original paste snapshot rather than a display placeholder", async () => {
  const { DEFAULT_KEYBINDINGS } = await import("../../src/ui/keybindings");
  const turns: TuiTurn[] = [];
  const ui = await interactive({ keybindings: { ...DEFAULT_KEYBINDINGS, previousMessage: "meta+j" }, runTurn: async turn => { turns.push(turn); } });
  try {
    await ui.send("\u001b[200~alpha\nbeta\ngamma\ndelta\u001b[201~"); await ui.send("\r");
    await until(() => turns.length === 1 && ui.screen().includes("enter send"));
    await ui.send("\u001bj"); await ui.send("\u001be"); await until(() => ui.screen().includes("消息已放回草稿"));
    await ui.send("\r"); await until(() => turns.length === 2);
    expect(turns[1]!.input.expanded).toBe(turns[0]!.input.expanded);
    expect(turns[1]!.input.pastedContents).toEqual(turns[0]!.input.pastedContents);
  } finally { ui.close(); }
});

test("history text selection does not auto-submit and compaction completion is visible", async () => {
  const turns: TuiTurn[] = [];
  const ui = await interactive({ runTurn: async turn => { turns.push(turn); turn.onCompaction?.(12000, 2000, { strategy: "full" }); }, runCommand: async () => ({ management: { kind: "search", title: "Workspace input history", items: [{ id: "old", label: "middle historical input", draftText: "middle historical input", command: "" }] } }) });
  try {
    await ui.send("/history middle"); await ui.send("\r"); await until(() => ui.screen().includes("Workspace input history"));
    await ui.send("\r"); await until(() => ui.screen().includes("历史文本已放入草稿"));
    expect(turns).toHaveLength(0); expect(ui.screen()).toContain("middle historical input");
    await ui.send("\r"); await until(() => turns.length === 1 && ui.screen().includes("已生成上下文摘要"));
    expect(ui.screen()).toContain("12,000 → 2,000");
  } finally { ui.close(); }
});

test("compaction summaries have a readable preview and expand without submitting another command", async () => {
  let commands = 0;
  const ui = await interactive({ runCommand: async () => { commands++; return { management: { kind: "compactions", title: "Context compaction boundaries", items: [{ id: "one", label: "Recorded boundary", description: "12000 → 2000 estimated tokens", details: ["## Preserved decisions\nKeep the original budget boundary."], command: "" }] } }; } });
  try {
    await ui.send("/compactions"); await ui.send("\r"); await until(() => ui.screen().includes("Preserved decisions"));
    expect(ui.screen()).toContain("Keep the original budget boundary.");
    await ui.send("\r"); expect(commands).toBe(1); expect(ui.screen()).toContain("Preserved decisions");
    await ui.send("\u001b"); expect(commands).toBe(1);
  } finally { ui.close(); }
});

test("task workbench includes the active foreground turn and removes it after completion", async () => {
  let turn: TuiTurn | undefined, finish = () => {};
  const ui = await interactive({ runTurn: current => { turn = current; return new Promise<void>(resolve => { finish = resolve; }); } });
  try {
    await ui.send("inspect the current repository"); await ui.send("\r"); await until(() => Boolean(turn));
    await ui.send("\u0014"); await until(() => ui.screen().includes("任务工作台"));
    expect(ui.screen()).toContain("前台对话"); expect(ui.screen()).toContain("inspect the current repository");
    expect(ui.screen()).not.toContain("当前没有任务");
    await ui.send("\r"); await until(() => ui.screen().includes("前台执行随当前终端会话运行"));
    finish(); await Bun.sleep(80); await ui.send("\u001b");
    await until(() => ui.screen().includes("当前没有后台任务或运行中的前台执行"));
    expect(turn!.signal.aborted).toBe(false);
  } finally { finish(); ui.close(); }
});

test("footer separates session totals from model context and silent cleanup does not add transcript notices", async () => {
  let turn: TuiTurn | undefined, finish = () => {};
  const ui = await interactive({ runTurn: current => { turn = current; return new Promise<void>(resolve => { finish = resolve; }); } });
  try {
    await ui.send("check footer"); await ui.send("\r"); await until(() => Boolean(turn));
    expect(ui.screen()).toContain("上下文 待获取"); expect(ui.screen()).toContain("会话累计"); expect(ui.screen()).not.toContain("前台 ↑");
    const rows = ui.screen().split("\n");
    expect(rows.findIndex(row => row.includes("test · default"))).not.toBe(rows.findIndex(row => row.includes("会话累计")));
    for (let i = 0; i < 5; i++) turn!.onCompaction?.(5000 - i, 4000 - i, { strategy: "microcompact" });
    await Bun.sleep(40); expect(ui.screen()).not.toContain("上下文已压缩"); expect(ui.screen()).not.toContain("查看摘要");
    turn!.onCompaction?.(12000, 2000, { strategy: "full" }); await until(() => ui.screen().includes("已生成上下文摘要"));
    turn!.onCompaction?.(12000, 2000, { strategy: "full" }); await Bun.sleep(40);
    expect(ui.screen().match(/已生成上下文摘要/g)).toHaveLength(1);
    await ui.resize(42, 12); expect(ui.screen()).toContain("enter queue"); expect(ui.screen().split("\n").at(-1)).toContain("test");
  } finally { finish(); ui.close(); }
});

test("resumed context displays history estimates, then request estimates and provider input without using cumulative totals", async () => {
  const { contextReport } = await import("../../src/services/compact/context-report");
  const report = contextReport({ messages: [{ role: "user", content: [{ type: "text", text: "saved context" }] }], contextWindow: 200000 });
  let turn: TuiTurn | undefined, finish=()=>{};
  const ui = await interactive({ contextWindowTokens: 200000, initialContextReport: report, initialUsage: { inputTokens:139128, outputTokens:265, cacheReadInputTokens:0, cacheCreationInputTokens:0, costUsd:0 }, runTurn: current => { turn=current; return new Promise<void>(resolve=>{finish=resolve;}); }, runCommand: async request => ({ resetSession: true, sessionId: request.nextSessionId, message: "cleared" }) });
  try {
    await until(() => ui.screen().includes("历史文本 ≈"));
    expect(ui.screen()).toContain("历史文本 ≈"); expect(ui.screen()).toContain("139,128"); expect(ui.screen()).not.toContain("上下文 待获取");
    await ui.send("continue"); await ui.send("\r"); await until(()=>Boolean(turn));
    turn!.onContextReport?.({ ...report, source:"request", estimatedInput:8000 }); await until(()=>ui.screen().includes("上下文 ≈4%"));
    turn!.onModelEvent({type:"usage",usage:{inputTokens:6000,cacheReadInputTokens:1000,cacheCreationInputTokens:0,outputTokens:0}}); await until(()=>ui.screen().includes("上下文 4%"));
    turn!.onModelEvent({type:"usage",usage:{inputTokens:0,cacheReadInputTokens:0,cacheCreationInputTokens:0,outputTokens:265}}); await Bun.sleep(40); expect(ui.screen()).not.toContain("待获取"); expect(ui.screen()).toContain("上下文 4%");
    finish(); await until(()=>ui.screen().includes("enter send"));
    await ui.send("/clear"); await ui.send("\r"); await until(()=>ui.screen().includes("cleared"));
    turn!.onContextReport?.({ ...report, source:"request", estimatedInput:100000 }); await Bun.sleep(40);
    expect(ui.screen()).toContain("上下文 待获取"); expect(ui.screen()).not.toContain("上下文 ≈50%");
  } finally { finish(); ui.close(); }
});
