import { describe, expect, test } from "bun:test";

import {
  createTuiState,
  reduceTuiState,
} from "../../src/ui/tui-state";

describe("TUI state", () => {
  test("builds one streaming assistant response from model deltas", () => {
    let state = createTuiState("claude-sonnet-4-6", "default");
    state = reduceTuiState(state, { type: "submit", text: "Inspect the project" });
    state = reduceTuiState(state, {
      type: "model-event",
      event: { type: "text", index: 0, text: "I found " },
    });
    state = reduceTuiState(state, {
      type: "model-event",
      event: { type: "text", index: 0, text: "two files." },
    });

    expect(state.busy).toBe(true);
    expect(state.streamingText).toBe("I found two files.");
    const streaming = state.transcript.at(-1)!;
    expect(streaming.kind).toBe("assistant");

    state = reduceTuiState(state, { type: "turn-complete" });
    expect(state.busy).toBe(false);
    expect(state.streamingText).toBe("");
    expect(state.messages).toEqual([
      { role: "user", text: "Inspect the project" },
      { role: "assistant", text: "I found two files." },
    ]);
    const committed = state.transcript.at(-1)!;
    expect(committed.id).toBe(streaming.id);
    expect(committed.revision).toBe(streaming.revision + 1);
  });

  test("tracks tool execution through completion", () => {
    let state = reduceTuiState(
      createTuiState("gpt-4o", "acceptEdits"),
      { type: "submit", text: "Read package.json" },
    );
    state = reduceTuiState(state, {
      type: "tool-start",
      id: "call-1",
      name: "read",
      input: { path: "package.json" },
    });

    const startedTool = state.transcript.find((entry) => entry.kind === "tool")!;
    state = reduceTuiState(state, {
      type: "tool-finish",
      id: "call-1",
      output: "contents",
      isError: false,
    });

    expect(state.tools).toEqual([
      {
        id: "call-1",
        name: "read",
        input: { path: "package.json" },
        status: "completed",
        output: "contents",
      },
    ]);
    const finishedTool = state.transcript.find((entry) => entry.kind === "tool")!;
    expect(finishedTool.id).toBe(startedTool.id);
    expect(finishedTool.revision).toBe(startedTool.revision + 1);
    expect(state.transcript.map(({ kind }) => kind)).toEqual(["user", "tool"]);
  });

  test("keeps transient tool progress on the ordered tool entry", () => {
    let state = reduceTuiState(createTuiState("test", "default"), {
      type: "tool-start",
      id: "bash-1",
      name: "bash",
      input: { command: "printf hello" },
      startedAt: 100,
    });
    state = reduceTuiState(state, {
      type: "tool-progress",
      id: "bash-1",
      data: { output: "hello", fullOutput: "hello", totalLines: 1, totalBytes: 5 },
    });
    const entry = state.transcript[0]!;
    expect(entry.kind).toBe("tool");
    if (entry.kind !== "tool") throw new Error("expected tool entry");
    expect(entry.progress).toEqual({ output: "hello", fullOutput: "hello", totalLines: 1, totalBytes: 5 });
    expect(entry.revision).toBe(1);
  });

  test("preserves restored transcript order and resets sequence state", () => {
    let state = reduceTuiState(createTuiState("test", "default"), {
      type: "command-complete",
      resetSession: true,
      restoredTranscript: [
        { id: "u", sequence: 0, revision: 0, kind: "user", text: "inspect" },
        { id: "t", sequence: 1, revision: 1, kind: "tool", toolUseId: "call", name: "read", input: {}, status: "completed", output: "ok" },
        { id: "a", sequence: 2, revision: 0, kind: "assistant", text: "done", streaming: false },
      ],
    });
    expect(state.transcript.map(({ kind }) => kind)).toEqual(["user", "tool", "assistant"]);
    expect(state.nextTranscriptSequence).toBe(3);

    state = reduceTuiState(state, { type: "command-complete", resetSession: true });
    expect(state.transcript).toEqual([]);
    expect(state.nextTranscriptSequence).toBe(0);
  });

  test("starts a directly resumed TUI with its transcript and accumulated usage", () => {
    const transcript = [
      { id: "u", sequence: 0, revision: 0, kind: "user" as const, text: "inspect" },
      { id: "a", sequence: 1, revision: 0, kind: "assistant" as const, text: "done", streaming: false },
    ];
    const state = createTuiState("test", "default", {
      transcript,
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 10,
        cacheCreationInputTokens: 5,
        costUsd: 0.01,
      },
    });

    expect(state.transcript).toEqual(transcript);
    expect(state.nextTranscriptSequence).toBe(2);
    expect(state.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 5,
      costUsd: 0.01,
    });
  });

  test("keeps the latest todo_write list as visible session progress", () => {
    const state = reduceTuiState(createTuiState("test", "default"), {
      type: "tool-start",
      id: "todo-1",
      name: "todo_write",
      input: {
        todos: [
          {
            content: "Run tests",
            activeForm: "Running tests",
            status: "in_progress",
          },
        ],
      },
    });

    expect(state.todos).toEqual([
      {
        content: "Run tests",
        activeForm: "Running tests",
        status: "in_progress",
      },
    ]);
  });

  test("records an interrupted turn without committing empty assistant text", () => {
    let state = reduceTuiState(createTuiState("test", "default"), {
      type: "submit",
      text: "run tests",
    });
    state = reduceTuiState(state, { type: "turn-error", message: "Interrupted" });

    expect(state.busy).toBe(false);
    expect(state.messages).toEqual([
      { role: "user", text: "run tests" },
      { role: "system", text: "Interrupted", tone: "error" },
    ]);
  });

  test("updates the displayed runtime permission mode", () => {
    const state = reduceTuiState(createTuiState("test", "default"), {
      type: "permission-mode-change",
      mode: "plan",
    });
    expect(state.permissionMode).toBe("plan");
  });

  test("tracks the latest provider input against the active context window", () => {
    let state = createTuiState("test", "default", { contextWindowTokens: 200_000 });
    state = reduceTuiState(state, {
      type: "model-event",
      event: {
        type: "usage",
        usage: {
          inputTokens: 80_000,
          outputTokens: 1_000,
          cacheReadInputTokens: 10_000,
          cacheCreationInputTokens: 0,
        },
      },
    });
    expect(state.lastInputTokens).toBe(90_000);
    expect(state.contextWindowTokens).toBe(200_000);

    state = reduceTuiState(state, {
      type: "command-complete",
      model: "larger-model",
      contextWindowTokens: 300_000,
    });
    expect(state).toMatchObject({ model: "larger-model", contextWindowTokens: 300_000, lastInputTokens: 90_000 });
  });
});
