import type { PermissionMode } from "../core/permissions";
import type { ModelEvent } from "../providers/types";
import { addUsage, EMPTY_USAGE, type UsageTotals } from "../services/usage/cost";
import type { TodoItem } from "../tools/interaction";
import type { ToolProgressData } from "../core/tool";
import {
  createTranscriptEntry,
  reviseTranscriptEntry,
  type TranscriptEntry,
} from "./transcript/model";

export type TuiMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string }
  | { role: "system"; text: string; tone: "info" | "error" };

export type TuiTool = {
  id: string;
  name: string;
  input: unknown;
  status: "running" | "completed" | "failed";
  output?: string;
  startedAt?: number;
  durationMs?: number;
  progress?: ToolProgressData;
};

export type TuiState = {
  model: string;
  permissionMode: PermissionMode;
  messages: TuiMessage[];
  tools: TuiTool[];
  todos: TodoItem[];
  streamingText: string;
  busy: boolean;
  usage: UsageTotals;
  lastInputTokens: number;
  contextWindowTokens: number;
  transcript: TranscriptEntry[];
  nextTranscriptSequence: number;
};

export type TuiAction =
  | { type: "submit"; text: string }
  | { type: "command-start"; text: string }
  | {
      type: "command-complete";
      message?: string;
      model?: string;
      contextWindowTokens?: number;
      permissionMode?: PermissionMode;
      resetSession?: boolean;
      restoredMessages?: TuiMessage[];
      restoredTranscript?: TranscriptEntry[];
    }
  | { type: "model-event"; event: ModelEvent }
  | { type: "tool-start"; id: string; name: string; input: unknown; startedAt?: number }
  | { type: "tool-progress"; id: string; data: ToolProgressData }
  | { type: "tool-finish"; id: string; output: string; isError: boolean; durationMs?: number }
  | { type: "permission-mode-change"; mode: PermissionMode }
  | { type: "turn-complete" }
  | { type: "turn-error"; message: string };

export function createTuiState(
  model: string,
  permissionMode: PermissionMode,
  initial?: {
    transcript?: TranscriptEntry[];
    usage?: UsageTotals;
    contextWindowTokens?: number;
  },
): TuiState {
  const transcript = initial?.transcript ? structuredClone(initial.transcript) : [];
  return {
    model,
    permissionMode,
    messages: [],
    tools: [],
    todos: [],
    streamingText: "",
    busy: false,
    usage: initial?.usage ? { ...initial.usage } : { ...EMPTY_USAGE },
    lastInputTokens: 0,
    contextWindowTokens: initial?.contextWindowTokens ?? 0,
    transcript,
    nextTranscriptSequence: transcript.reduce(
      (next, entry) => Math.max(next, entry.sequence + 1),
      0,
    ),
  };
}

function appendTranscript(
  state: TuiState,
  input: Parameters<typeof createTranscriptEntry>[1],
  id?: string,
): Pick<TuiState, "transcript" | "nextTranscriptSequence"> {
  return {
    transcript: [...state.transcript, createTranscriptEntry(state.nextTranscriptSequence, input, id)],
    nextTranscriptSequence: state.nextTranscriptSequence + 1,
  };
}

export function reduceTuiState(state: TuiState, action: TuiAction): TuiState {
  if (action.type === "permission-mode-change") {
    return { ...state, permissionMode: action.mode };
  }
  if (action.type === "submit") {
    return {
      ...state,
      ...appendTranscript(state, { kind: "user", text: action.text }),
      messages: [...state.messages, { role: "user", text: action.text }],
      streamingText: "",
      busy: true,
    };
  }
  if (action.type === "command-start") {
    return {
      ...state,
      ...appendTranscript(state, { kind: "user", text: action.text }),
      messages: [...state.messages, { role: "user", text: action.text }],
      busy: true,
    };
  }
  if (action.type === "command-complete") {
    const messages = action.restoredMessages ?? (action.resetSession ? [] : state.messages);
    const restoredTranscript = action.restoredTranscript ?? (action.resetSession ? [] : state.transcript);
    const restoredNextSequence = restoredTranscript.reduce(
      (next, entry) => Math.max(next, entry.sequence + 1),
      0,
    );
    const baseState = {
      ...state,
      transcript: restoredTranscript,
      nextTranscriptSequence: action.restoredTranscript || action.resetSession
        ? restoredNextSequence
        : state.nextTranscriptSequence,
    };
    const systemUpdate = action.message
      ? appendTranscript(baseState, { kind: "system", text: action.message, tone: "info" })
      : {};
    return {
      ...baseState,
      ...systemUpdate,
      ...(action.model ? { model: action.model } : {}),
      ...(action.contextWindowTokens ? { contextWindowTokens: action.contextWindowTokens } : {}),
      ...(action.permissionMode ? { permissionMode: action.permissionMode } : {}),
      messages: action.message
        ? [...messages, { role: "system", text: action.message, tone: "info" }]
        : messages,
      tools: action.resetSession ? [] : state.tools,
      todos: action.resetSession ? [] : state.todos,
      streamingText: "",
      busy: false,
      usage: action.resetSession ? { ...EMPTY_USAGE } : state.usage,
      lastInputTokens: action.resetSession ? 0 : state.lastInputTokens,
    };
  }
  if (action.type === "model-event") {
    if (action.event.type === "usage") {
      const usage = addUsage(state.usage, action.event.usage);
      return {
        ...state,
        lastInputTokens: action.event.usage.inputTokens + action.event.usage.cacheReadInputTokens + action.event.usage.cacheCreationInputTokens,
        usage: {
          ...usage,
          costUsd: (state.usage.costUsd ?? 0) + (action.event.usage.costUsd ?? 0),
        },
      };
    }
    if (action.event.type !== "text") return state;
    const text = `${state.streamingText}${action.event.text}`;
    let draftIndex = -1;
    for (let index = state.transcript.length - 1; index >= 0; index -= 1) {
      const entry = state.transcript[index];
      if (entry?.kind === "assistant" && entry.streaming) {
        draftIndex = index;
        break;
      }
    }
    if (draftIndex >= 0) {
      return {
        ...state,
        streamingText: text,
        transcript: state.transcript.map((entry, index) => index === draftIndex && entry.kind === "assistant"
          ? reviseTranscriptEntry(entry, { text })
          : entry),
      };
    }
    return {
      ...state,
      streamingText: text,
      ...appendTranscript(state, { kind: "assistant", text, streaming: true }),
    };
  }
  if (action.type === "tool-start") {
    const todos = action.name === "todo_write" ? todoItems(action.input) : state.todos;
    const transcriptUpdate = action.name === "todo_write"
      ? {}
      : appendTranscript(state, {
          kind: "tool",
          toolUseId: action.id,
          name: action.name,
          input: action.input,
          status: "running",
          ...(action.startedAt === undefined ? {} : { startedAt: action.startedAt }),
        }, `tool-${action.id}`);
    return {
      ...state,
      ...transcriptUpdate,
      todos,
      tools: [
        ...state.tools,
        {
          id: action.id,
          name: action.name,
          input: action.input,
          status: "running",
          ...(action.startedAt === undefined ? {} : { startedAt: action.startedAt }),
        },
      ],
    };
  }
  if (action.type === "tool-progress") {
    return {
      ...state,
      transcript: state.transcript.map((entry) =>
        entry.kind === "tool" && entry.toolUseId === action.id
          ? reviseTranscriptEntry(entry, { progress: action.data })
          : entry),
      tools: state.tools.map((tool) => tool.id === action.id
        ? { ...tool, progress: action.data }
        : tool),
    };
  }
  if (action.type === "tool-finish") {
    return {
      ...state,
      transcript: state.transcript.map((entry) =>
        entry.kind === "tool" && entry.toolUseId === action.id
          ? reviseTranscriptEntry(entry, {
              status: action.isError ? "failed" : "completed",
              output: action.output,
              ...(action.durationMs === undefined ? {} : { durationMs: action.durationMs }),
            })
          : entry),
      tools: state.tools.map((tool) =>
        tool.id === action.id
          ? {
              ...tool,
              status: action.isError ? "failed" : "completed",
              output: action.output,
              ...(action.durationMs === undefined ? {} : { durationMs: action.durationMs }),
            }
          : tool,
      ),
    };
  }
  if (action.type === "turn-complete") {
    return {
      ...state,
      transcript: state.transcript.map((entry) => entry.kind === "assistant" && entry.streaming
        ? reviseTranscriptEntry(entry, { streaming: false })
        : entry),
      messages: state.streamingText
        ? [...state.messages, { role: "assistant", text: state.streamingText }]
        : state.messages,
      streamingText: "",
      busy: false,
    };
  }
  const committed = state.transcript.map((entry) => entry.kind === "assistant" && entry.streaming
    ? reviseTranscriptEntry(entry, { streaming: false })
    : entry);
  const withCommitted = { ...state, transcript: committed };
  return {
    ...withCommitted,
    ...appendTranscript(withCommitted, { kind: "system", text: action.message, tone: "error" }),
    messages: [
      ...state.messages,
      ...(state.streamingText
        ? [{ role: "assistant" as const, text: state.streamingText }]
        : []),
      { role: "system", text: action.message, tone: "error" },
    ],
    streamingText: "",
    busy: false,
  };
}

function todoItems(input: unknown): TodoItem[] {
  if (!input || typeof input !== "object" || !("todos" in input)) return [];
  const todos = (input as { todos?: unknown }).todos;
  if (!Array.isArray(todos)) return [];
  const valid = todos.filter((item): item is TodoItem => {
    if (!item || typeof item !== "object") return false;
    const value = item as Partial<TodoItem>;
    return typeof value.content === "string" &&
      typeof value.activeForm === "string" &&
      (value.status === "pending" || value.status === "in_progress" || value.status === "completed");
  });
  return valid.every(({ status }) => status === "completed") ? [] : valid;
}
