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
  const app = await render(<TuiApp model="test-model" permissionMode="default" sessionIdFactory={() => "test"} runCommand={async (request) => { commands.push(request.name); return { message: "command complete" }; }} stdout={stdout as unknown as NodeJS.WriteStream} runTurn={(turn) => {
    turns.push(turn);
    return new Promise<void>((resolve) => finish.push(resolve));
  }} />, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false, exitOnCtrlC: false });
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
