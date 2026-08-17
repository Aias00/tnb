import React, {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { AlternateScreen, render, useApp, useInput, useSearchHighlight, useSelection } from "./ink/index";

import type { ToolExecutionEvent } from "../core/agent-loop";
import type { PermissionMode, PermissionPromptDecision } from "../core/permissions";
import type { ModelEvent } from "../providers/types";
import { applyInputKey, createInputBuffer, searchInputHistory, type InputBuffer, type InputHistorySearch } from "./input-buffer";
import { promptContentColumns } from "./input/prompt-layout";
import { PermissionController } from "./permission-controller";
import { QuestionController } from "./question-controller";
import { McpActivityController } from "./mcp-activity-controller";
import { TuiView } from "./tui";
import { createTuiState, reduceTuiState } from "./tui-state";
import type { TranscriptViewportController } from "./transcript/TranscriptViewport";
import { useCopyOnSelect } from "./use-copy-on-select";
import { mapTranscriptInput } from "./transcript/input";
import { moveTranscriptMatch, searchTranscript, transcriptEntryText, type TranscriptSearchState } from "./transcript/search";
import type { AskUser } from "../tools/interaction";
import type { TaskManager } from "../services/tasks/manager";
import type { ScheduleManager } from "../services/scheduler/manager";
import type { ShellRuntimeSnapshot, ShellSessionManager } from "../services/shell/manager";
import type { ExternalEditorResult } from "./external-editor";
import { DEFAULT_KEYBINDINGS, matchesKeybinding, type KeybindingMap } from "./keybindings";
import type { UsageTotals } from "../services/usage/cost";
import type { TranscriptEntry } from "./transcript/model";
import {
  parseSlashCommand,
  slashCommandHelp,
  suggestSlashCommands,
  type SlashCommandRequest,
  type SlashCommandResult,
  type ExternalSlashCommand,
  type ManagementView,
} from "./slash-commands";

export type TuiTurn = {
  prompt: string;
  sessionId: string;
  resume: boolean;
  signal: AbortSignal;
  onModelEvent(event: ModelEvent): void;
  onToolEvent(event: ToolExecutionEvent): void;
  permissionPrompt: PermissionController["request"];
  questionPrompt: AskUser;
  onPermissionModeChange(mode: PermissionMode): void;
};

export type TuiAppOptions = {
  model: string;
  permissionMode: PermissionMode;
  permissionController?: PermissionController;
  questionController?: QuestionController;
  mcpActivityController?: McpActivityController;
  taskManager?: TaskManager;
  scheduleManager?: ScheduleManager;
  shellManager?: ShellSessionManager;
  sessionIdFactory(): string;
  runTurn(turn: TuiTurn): Promise<void>;
  runCommand?(request: SlashCommandRequest): Promise<SlashCommandResult>;
  externalCommands?: readonly ExternalSlashCommand[] | (() => readonly ExternalSlashCommand[]);
  completeInput?(input: string, signal: AbortSignal): Promise<string[]>;
  pasteImage?(): Promise<string | undefined>;
  displayImage?(path: string): Promise<void>;
  editInput?(value: string): Promise<ExternalEditorResult>;
  keybindings?: KeybindingMap;
  vimMode?: boolean;
  theme?: "magenta" | "cyan" | "blue" | "green";
  contextWindowTokens?: number;
  initialManagement?: ManagementView;
  initialResume?: boolean;
  initialTranscript?: TranscriptEntry[];
  initialInputHistory?: string[];
  initialUsage?: UsageTotals;
  stdout?: NodeJS.WriteStream;
};

export type RunTuiOptions = TuiAppOptions & {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  fullscreen?: boolean;
  resumeHint?: () => string | undefined | Promise<string | undefined>;
};

export async function runTui(options: RunTuiOptions): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const fullscreen = options.fullscreen ?? true;
  const instance = await render(
    fullscreen
      ? <AlternateScreen><TuiApp {...options} stdout={stdout} /></AlternateScreen>
      : <TuiApp {...options} stdout={stdout} />,
    {
      ...(options.stdin ? { stdin: options.stdin } : {}),
      stdout,
      ...(options.stderr ? { stderr: options.stderr } : {}),
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  await instance.waitUntilExit();
  const resumeHint = await options.resumeHint?.();
  if (resumeHint) stdout.write(resumeHint);
  return 0;
}

export function formatResumeHint(sessionId: string): string {
  return `\nResume this session with:\ntnb --resume ${sessionId}\n`;
}

export function TuiApp(options: TuiAppOptions) {
  const { exit } = useApp();
  const selection = useSelection();
  useCopyOnSelect(selection);
  const searchHighlight = useSearchHighlight();
  const keybindings = options.keybindings ?? DEFAULT_KEYBINDINGS;
  const stdout = options.stdout ?? process.stdout;
  const sessionId = useRef(options.sessionIdFactory());
  const ownedPermissionController = useRef(new PermissionController()).current;
  const permissionController = options.permissionController ?? ownedPermissionController;
  const ownedQuestionController = useRef(new QuestionController()).current;
  const questionController = options.questionController ?? ownedQuestionController;
  const permission = useSyncExternalStore(
    permissionController.subscribe,
    permissionController.current,
    permissionController.current,
  );
  const question = useSyncExternalStore(
    questionController.subscribe,
    questionController.current,
    questionController.current,
  );
  const mcpActivity = useSyncExternalStore(
    options.mcpActivityController?.subscribe ?? emptySubscribe,
    options.mcpActivityController?.current ?? emptyActivity,
    options.mcpActivityController?.current ?? emptyActivity,
  );
  const tasks = useSyncExternalStore(
    options.taskManager?.subscribe ?? emptySubscribe,
    options.taskManager?.current ?? emptyTasks,
    options.taskManager?.current ?? emptyTasks,
  );
  const [permissionSelection, setPermissionSelection] = useState<PermissionPromptDecision>("allow");
  const [questionSelection, setQuestionSelection] = useState(0);
  const [questionSelected, setQuestionSelected] = useState<Set<number>>(() => new Set());
  const [questionOther, setQuestionOther] = useState<InputBuffer | undefined>();
  const [management, setManagement] = useState<ManagementView | undefined>(options.initialManagement);
  const [managementSelection, setManagementSelection] = useState(0);
  const [sessionAction, setSessionAction] = useState<{ type: "rename" | "delete"; input: InputBuffer } | undefined>();
  const [scheduledPrompts, setScheduledPrompts] = useState<string[]>([]);
  const [shellPanel, setShellPanel] = useState(false);
  const [shellSelection, setShellSelection] = useState(0);
  const [shellInput, setShellInput] = useState<InputBuffer | undefined>();
  const [shellRuntimes, setShellRuntimes] = useState<ShellRuntimeSnapshot[]>([]);
  const initialInput = useRef(restoreInputHistory(options.initialInputHistory ?? [])).current;
  const [state, dispatch] = useReducer(
    reduceTuiState,
    createTuiState(options.model, options.permissionMode, {
      ...(options.initialTranscript ? { transcript: options.initialTranscript } : {}),
      ...(options.initialUsage ? { usage: options.initialUsage } : {}),
      ...(options.contextWindowTokens ? { contextWindowTokens: options.contextWindowTokens } : {}),
    }),
  );
  const [history, setHistory] = useState<string[]>(initialInput.history);
  const transcriptViewportRef = useRef<TranscriptViewportController | null>(null);
  const [buffer, setBuffer] = useState<InputBuffer>(initialInput.buffer);
  const [historySearch, setHistorySearch] = useState<InputHistorySearch | undefined>();
  const [inputCompletions, setInputCompletions] = useState<{ values: string[]; index: number } | undefined>();
  const [completionNotice, setCompletionNotice] = useState<string | undefined>();
  const completionController = useRef<AbortController | undefined>(undefined);
  const [vimMode, setVimMode] = useState(options.vimMode === true);
  const [theme, setTheme] = useState(options.theme ?? "magenta");
  const [verboseTranscript, setVerboseTranscript] = useState(false);
  const [transcriptSearch, setTranscriptSearch] = useState<TranscriptSearchState | undefined>();
  const [selectedTranscriptEntryId, setSelectedTranscriptEntryId] = useState<string | undefined>();
  const [vimInsert, setVimInsert] = useState(!options.vimMode);
  const bufferRef = useRef(buffer);
  const [terminalSize, setTerminalSize] = useState(() => ({
    columns: stdout.columns || 80,
    rows: stdout.rows || 24,
  }));
  const abortController = useRef<AbortController | undefined>(undefined);
  const lastCtrlCPress = useRef(0);
  const ctrlCExitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hasRun = useRef(options.initialResume === true);
  const editorActive = useRef(false);
  const imageToolPaths = useRef(new Map<string, string>());

  useEffect(() => {
    const updateSize = () => setTerminalSize({
      columns: stdout.columns || 80,
      rows: stdout.rows || 24,
    });
    stdout.on("resize", updateSize);
    return () => {
      stdout.off("resize", updateSize);
    };
  }, [stdout]);

  useEffect(() => () => {
    abortController.current?.abort();
    completionController.current?.abort();
    if (ctrlCExitTimer.current) clearTimeout(ctrlCExitTimer.current);
    permissionController.resolve("deny");
    questionController.reject(new Error("User interface closed before the question was answered"));
  }, [permissionController, questionController]);

  useEffect(() => {
    setQuestionSelection(0);
    setQuestionSelected(new Set());
    setQuestionOther(undefined);
  }, [question]);

  useEffect(() => {
    setManagementSelection(0);
    setSessionAction(undefined);
  }, [management]);

  useEffect(() => {
    if (!transcriptSearch) return;
    const matches = searchTranscript(state.transcript, transcriptSearch.query);
    const currentId = transcriptSearch.matches[transcriptSearch.index];
    const index = currentId ? Math.max(0, matches.indexOf(currentId)) : 0;
    setTranscriptSearch((current) => current ? { ...current, matches, index } : current);
  }, [state.transcript, transcriptSearch?.query]);

  useEffect(() => {
    searchHighlight.setQuery(transcriptSearch?.query ?? "");
    if (!transcriptSearch) searchHighlight.setPositions(null);
  }, [searchHighlight, transcriptSearch?.query]);

  useEffect(() => {
    if (!transcriptSearch) return;
    const selectedId = transcriptSearch.matches[transcriptSearch.index];
    setSelectedTranscriptEntryId(selectedId);
    if (selectedId) transcriptViewportRef.current?.reveal(selectedId);
  }, [transcriptSearch?.index, transcriptSearch?.matches]);

  const submit = useCallback((prompt: string) => {
    if (state.busy) return;
    transcriptViewportRef.current?.scroll("bottom");
    completionController.current?.abort();
    setInputCompletions(undefined);
    setCompletionNotice(undefined);
    const externalCommands = resolveExternalCommands(options.externalCommands);
    const parsedCommand = parseSlashCommand(prompt);
    const isExternal = parsedCommand.kind === "unknown" && externalCommands.some(
      (command) => command.name.toLowerCase() === parsedCommand.name.toLowerCase(),
    );
    if (parsedCommand.kind === "command" && parsedCommand.command.name === "exit") {
      exit();
      return;
    }
    const nextHistory = [...history, prompt];
    setHistory(nextHistory);
    const emptyBuffer = createInputBuffer("", nextHistory);
    bufferRef.current = emptyBuffer;
    setBuffer(emptyBuffer);
    if (parsedCommand.kind === "unknown" && !isExternal) {
      dispatch({ type: "command-start", text: prompt });
      dispatch({
        type: "command-complete",
        message: `Unknown command /${parsedCommand.name}. Run /help to list commands.`,
      });
      return;
    }
    if (parsedCommand.kind === "command") {
      setManagement(undefined);
      dispatch({ type: "command-start", text: prompt });
      if (parsedCommand.command.name === "help") {
        dispatch({ type: "command-complete", message: slashCommandHelp(externalCommands) });
        return;
      }
      if (!options.runCommand) {
        dispatch({ type: "command-complete", message: "Interactive commands are unavailable." });
        return;
      }
      const nextSessionId = options.sessionIdFactory();
      void options.runCommand({
        ...parsedCommand.command,
        sessionId: sessionId.current,
        nextSessionId,
      }).then((result) => {
        if (result.clipboardText !== undefined) {
          stdout.write(`\u001B]52;c;${Buffer.from(result.clipboardText).toString("base64")}\u0007`);
        }
        if (result.vimMode !== undefined) {
          setVimMode(result.vimMode);
          setVimInsert(!result.vimMode);
        }
        if (result.theme !== undefined) setTheme(result.theme);
        setManagement(result.management);
        if (result.resetSession) {
          sessionId.current = result.sessionId ?? nextSessionId;
          hasRun.current = result.resumeSession === true;
          const restored = restoreInputHistory(result.restoredInputHistory ?? []);
          setHistory(restored.history);
          bufferRef.current = restored.buffer;
          setBuffer(restored.buffer);
        }
        dispatch({ type: "command-complete", ...result });
      }).catch((error: unknown) => {
        dispatch({
          type: "turn-error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }
    dispatch({ type: "submit", text: prompt });
    const controller = new AbortController();
    abortController.current = controller;
    void options.runTurn({
      prompt,
      sessionId: sessionId.current,
      resume: hasRun.current,
      signal: controller.signal,
      onModelEvent(event) {
        dispatch({ type: "model-event", event });
      },
      onToolEvent(event) {
        if (event.type === "tool-execution-start") {
          if (event.name === "image_generate") {
            const input = typeof event.input === "object" && event.input !== null ? event.input as Record<string, unknown> : {};
            const path = typeof input.outputPath === "string"
              ? input.outputPath
              : typeof input.output_path === "string" ? input.output_path : undefined;
            if (path) imageToolPaths.current.set(event.id, path);
          }
          dispatch({
            type: "tool-start",
            id: event.id,
            name: event.name,
            input: event.input,
            startedAt: event.startedAt,
          });
        } else if (event.type === "tool-execution-progress") {
          dispatch({ type: "tool-progress", id: event.id, data: event.data });
        } else {
          dispatch({
            type: "tool-finish",
            id: event.id,
            output: event.output,
            isError: event.isError,
            durationMs: event.durationMs,
          });
          const imagePath = imageToolPaths.current.get(event.id);
          imageToolPaths.current.delete(event.id);
          if (!event.isError && imagePath) void options.displayImage?.(imagePath);
        }
      },
      permissionPrompt: permissionController.request,
      questionPrompt: questionController.request,
      onPermissionModeChange(mode) {
        dispatch({ type: "permission-mode-change", mode });
      },
    }).then(() => {
      hasRun.current = true;
      dispatch({ type: "turn-complete" });
    }).catch((error: unknown) => {
      dispatch({
        type: "turn-error",
        message: controller.signal.aborted
          ? "Interrupted"
          : error instanceof Error
            ? error.message
            : String(error),
      });
    }).finally(() => {
      if (abortController.current === controller) abortController.current = undefined;
    });
  }, [exit, history, options, permissionController.request, questionController, state.busy]);

  useEffect(() => options.scheduleManager?.subscribe((prompt, source) => {
    setScheduledPrompts((current) => [...current, `[Scheduled wakeup ${source}]\n${prompt}`]);
  }), [options.scheduleManager]);

  useEffect(() => {
    if (!shellPanel || !options.shellManager) return;
    const refresh = () => setShellRuntimes(options.shellManager!.runtimeSnapshots());
    refresh();
    const timer = setInterval(refresh, 500);
    timer.unref?.();
    return () => clearInterval(timer);
  }, [options.shellManager, shellPanel]);

  useEffect(() => {
    if (state.busy || permission || question || management || scheduledPrompts.length === 0) return;
    const [prompt, ...remaining] = scheduledPrompts;
    setScheduledPrompts(remaining);
    if (prompt) submit(prompt);
  }, [management, permission, question, scheduledPrompts, state.busy, submit]);

  useInput((input, key) => {
    const promptMode = vimMode ? (vimInsert ? "INSERT" : "NORMAL") : undefined;
    const promptColumns = promptContentColumns(terminalSize.columns, promptMode);
    if (permission) {
      if (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow) {
        const decisions: PermissionPromptDecision[] = permission.suggestedRule
          ? ["allow", "allow-session", "allow-project", "deny"]
          : ["allow", "deny"];
        setPermissionSelection((selection) => {
          const current = Math.max(0, decisions.indexOf(selection));
          const direction = key.leftArrow || key.upArrow ? -1 : 1;
          return decisions[(current + direction + decisions.length) % decisions.length]!;
        });
      } else if (key.return) {
        permissionController.resolve(permissionSelection);
        setPermissionSelection("allow");
      } else if (key.escape || (key.ctrl && input === "c")) {
        permissionController.resolve("deny");
        setPermissionSelection("allow");
      }
      return;
    }
    if (question) {
      if (questionOther) {
        if (key.escape) {
          setQuestionOther(undefined);
          return;
        }
        const next = applyInkInput(questionOther, input, key);
        setQuestionOther(next);
        if (next.submitted?.trim()) {
          const selected = [...questionSelected]
            .filter((index) => index < question.options.length)
            .map((index) => question.options[index]!.label);
          questionController.resolve([...selected, next.submitted.trim()].join(", "));
        }
        return;
      }
      const count = question.options.length + 1;
      if (key.upArrow || key.leftArrow) {
        setQuestionSelection((value) => (value + count - 1) % count);
      } else if (key.downArrow || key.rightArrow) {
        setQuestionSelection((value) => (value + 1) % count);
      } else if (key.escape || (key.ctrl && input === "c")) {
        questionController.reject(new Error("User declined to answer questions"));
      } else if (question.multiSelect && input === " ") {
        if (questionSelection === question.options.length) {
          setQuestionOther(createInputBuffer());
        } else {
          setQuestionSelected((current) => {
            const next = new Set(current);
            if (next.has(questionSelection)) next.delete(questionSelection);
            else next.add(questionSelection);
            return next;
          });
        }
      } else if (key.return) {
        if (questionSelection === question.options.length) {
          setQuestionOther(createInputBuffer());
        } else if (question.multiSelect) {
          const indexes = questionSelected.size ? [...questionSelected] : [questionSelection];
          questionController.resolve(indexes.sort().map((index) => question.options[index]!.label).join(", "));
        } else {
          questionController.resolve(question.options[questionSelection]!.label);
        }
      }
      return;
    }
    if (management) {
      const selected = management.items[managementSelection];
      if (sessionAction && selected) {
        if (key.escape) {
          setSessionAction(undefined);
          return;
        }
        if (sessionAction.type === "delete") {
          if (input.toLowerCase() === "y" || key.return) {
            setManagement(undefined);
            setSessionAction(undefined);
            submit(`/session-delete ${selected.id} --confirm`);
          } else if (input.toLowerCase() === "n") setSessionAction(undefined);
          return;
        }
        const next = applyInkInput(sessionAction.input, input, key);
        setSessionAction({ ...sessionAction, input: next });
        if (next.submitted?.trim()) {
          setManagement(undefined);
          setSessionAction(undefined);
          submit(`/session-rename ${selected.id} ${JSON.stringify(next.submitted.trim())}`);
        }
        return;
      }
      if (management.items.length === 0) {
        if (key.escape || (key.ctrl && input === "c")) setManagement(undefined);
        return;
      }
      if (key.upArrow || key.leftArrow) {
        setManagementSelection((value) => (value + management.items.length - 1) % management.items.length);
      } else if (key.downArrow || key.rightArrow) {
        setManagementSelection((value) => (value + 1) % management.items.length);
      } else if (key.escape || (key.ctrl && input === "c")) {
        setManagement(undefined);
      } else if (management.kind === "sessions" && input.toLowerCase() === "r" && selected) {
        setSessionAction({ type: "rename", input: createInputBuffer() });
      } else if (management.kind === "sessions" && input.toLowerCase() === "f" && selected) {
        setManagement(undefined);
        submit(`/session-fork ${selected.id}`);
      } else if (management.kind === "sessions" && input.toLowerCase() === "d" && selected && !selected.active) {
        setSessionAction({ type: "delete", input: createInputBuffer() });
      } else if (management.kind === "mcp" && input.toLowerCase() === "r") {
        setManagement(undefined);
        submit("/mcp reload");
      } else if (management.kind === "mcp" && input.toLowerCase() === "a" && selected?.badges?.includes("oauth")) {
        setManagement(undefined);
        submit(`/mcp auth ${selected.id}`);
      } else if (management.kind === "mcp" && input.toLowerCase() === "o" && selected?.badges?.includes("oauth")) {
        setManagement(undefined);
        submit(`/mcp logout ${selected.id}`);
      } else if (management.kind === "plugins" && input.toLowerCase() === "r") {
        setManagement(undefined);
        submit("/plugins reload");
      } else if (management.kind === "plugins" && input.toLowerCase() === "u" && selected) {
        setManagement(undefined);
        submit(`/plugins update ${selected.id}`);
      } else if (management.kind === "plugins" && input.toLowerCase() === "d" && selected) {
        setManagement(undefined);
        submit(`/plugins remove ${selected.id}`);
      } else if (management.kind === "skills" && input.toLowerCase() === "r") {
        setManagement(undefined);
        submit("/skills reload");
      } else if (management.kind === "marketplace" && input.toLowerCase() === "r") {
        setManagement(undefined);
        submit("/marketplace");
      } else if (management.kind === "doctor" && input.toLowerCase() === "r") {
        setManagement(undefined);
        submit("/doctor");
      } else if (input.toLowerCase() === "i" && selected?.inspectCommand) {
        setManagement(undefined);
        submit(selected.inspectCommand);
      } else if (key.return) {
        if (selected) {
          setManagement(undefined);
          submit(selected.command);
        }
      }
      return;
    }
    if (historySearch) {
      if (key.escape || (key.ctrl && input === "c")) {
        bufferRef.current = historySearch.original;
        setBuffer(historySearch.original);
        setHistorySearch(undefined);
      } else if (key.return) {
        setHistorySearch(undefined);
      } else if (matchesKeybinding(keybindings, "historySearch", input, key)) {
        const match = searchInputHistory(history, historySearch.query, historySearch.matchIndex ?? history.length)
          ?? searchInputHistory(history, historySearch.query);
        if (match) {
          const next = createInputBuffer(match.value, history);
          bufferRef.current = next;
          setBuffer(next);
          setHistorySearch({ ...historySearch, matchIndex: match.index });
        }
      } else if (key.backspace || key.delete) {
        const query = historySearch.query.slice(0, -1);
        const match = searchInputHistory(history, query);
        const next = match ? createInputBuffer(match.value, history) : historySearch.original;
        bufferRef.current = next;
        setBuffer(next);
        setHistorySearch({ ...historySearch, query, ...(match ? { matchIndex: match.index } : { matchIndex: undefined }) });
      } else if (input && !key.ctrl && !key.meta) {
        const query = `${historySearch.query}${input}`;
        const match = searchInputHistory(history, query);
        if (match) {
          const next = createInputBuffer(match.value, history);
          bufferRef.current = next;
          setBuffer(next);
        }
        setHistorySearch({ ...historySearch, query, ...(match ? { matchIndex: match.index } : { matchIndex: undefined }) });
      }
      return;
    }
    if (transcriptSearch) {
      if (key.escape || (key.ctrl && input === "c")) {
        setTranscriptSearch(undefined);
      } else if (key.return || key.downArrow) {
        setTranscriptSearch((current) => current ? moveTranscriptMatch(current, 1) : current);
      } else if (key.upArrow) {
        setTranscriptSearch((current) => current ? moveTranscriptMatch(current, -1) : current);
      } else if (key.backspace || key.delete) {
        setTranscriptSearch((current) => current ? { ...current, query: current.query.slice(0, -1) } : current);
      } else if (input && !key.ctrl && !key.meta) {
        setTranscriptSearch((current) => current ? { ...current, query: `${current.query}${input}` } : current);
      }
      return;
    }
    if (inputCompletions?.values.length && key.escape) {
      completionController.current?.abort();
      setInputCompletions(undefined);
      setCompletionNotice(undefined);
      return;
    }
    if (shellPanel) {
      const selected = shellRuntimes[shellSelection];
      if (shellInput && selected?.kind === "pty") {
        if (key.escape) setShellInput(undefined);
        else {
          const next = applyInkInput(shellInput, input, key);
          setShellInput(next);
          if (next.submitted !== undefined) {
            void options.shellManager?.writePty({ pid: selected.pid, chars: next.submitted, submit: true })
              .then(() => setShellRuntimes(options.shellManager?.runtimeSnapshots() ?? []));
            setShellInput(undefined);
          }
        }
        return;
      }
      if (key.escape || matchesKeybinding(keybindings, "toggleTasks", input, key)) setShellPanel(false);
      else if (key.upArrow) setShellSelection((value) => Math.max(0, value - 1));
      else if (key.downArrow) setShellSelection((value) => Math.min(Math.max(0, shellRuntimes.length - 1), value + 1));
      else if (input.toLowerCase() === "i" && selected?.kind === "pty" && selected.alive) setShellInput(createInputBuffer());
      else if (input.toLowerCase() === "k" && selected) {
        options.shellManager?.kill(selected.kind === "pty" ? selected.pid : selected.taskId);
        setShellRuntimes(options.shellManager?.runtimeSnapshots() ?? []);
      }
      return;
    }
    if (matchesKeybinding(keybindings, "toggleTasks", input, key) && options.shellManager) {
      setShellRuntimes(options.shellManager.runtimeSnapshots());
      setShellSelection(0);
      setShellPanel(true);
      return;
    }
    if (matchesKeybinding(keybindings, "transcriptSearch", input, key)) {
      setTranscriptSearch({ query: "", matches: [], index: 0 });
      return;
    }
    if (matchesKeybinding(keybindings, "historySearch", input, key)) {
      const original = bufferRef.current;
      const match = searchInputHistory(history, original.value);
      if (!match) {
        setCompletionNotice(history.length ? "No matching prompt history." : "Prompt history is empty.");
        return;
      }
      const next = createInputBuffer(match.value, history);
      bufferRef.current = next;
      setBuffer(next);
      setHistorySearch({ query: original.value, original, matchIndex: match.index });
      setCompletionNotice(undefined);
      return;
    }
    if (matchesKeybinding(keybindings, "externalEditor", input, key) && options.editInput && !state.busy && !editorActive.current) {
      editorActive.current = true;
      setCompletionNotice("Opening external editor…");
      void options.editInput(bufferRef.current.value).then((result) => {
        if (result.error) {
          setCompletionNotice(result.error);
          return;
        }
        if (result.content !== undefined) {
          const next = createInputBuffer(result.content, history);
          bufferRef.current = next;
          setBuffer(next);
        }
        setCompletionNotice(undefined);
      }).catch((error: unknown) => {
        setCompletionNotice(error instanceof Error ? error.message : String(error));
      }).finally(() => {
        editorActive.current = false;
      });
      return;
    }
    if (key.ctrl && key.shift && input.toLowerCase() === "c" && selection.hasSelection()) {
      selection.copySelection();
      return;
    }
    if (key.ctrl && key.shift && input.toLowerCase() === "c" && selectedTranscriptEntryId) {
      const selected = state.transcript.find((entry) => entry.id === selectedTranscriptEntryId);
      if (selected) stdout.write(`\u001B]52;c;${Buffer.from(transcriptEntryText(selected)).toString("base64")}\u0007`);
      return;
    }
    if (key.ctrl && input === "c") {
      if (state.busy) {
        abortController.current?.abort();
        return;
      }
      const now = Date.now();
      if (ctrlCExitTimer.current && now - lastCtrlCPress.current <= 800) {
        clearTimeout(ctrlCExitTimer.current);
        ctrlCExitTimer.current = undefined;
        setCompletionNotice(undefined);
        exit();
        return;
      }
      if (bufferRef.current.value) {
        const cleared = createInputBuffer("", history);
        bufferRef.current = cleared;
        setBuffer(cleared);
      }
      lastCtrlCPress.current = now;
      setCompletionNotice("Press Ctrl+C again to exit");
      if (ctrlCExitTimer.current) clearTimeout(ctrlCExitTimer.current);
      ctrlCExitTimer.current = setTimeout(() => {
        ctrlCExitTimer.current = undefined;
        setCompletionNotice((current) => current === "Press Ctrl+C again to exit" ? undefined : current);
      }, 800);
      return;
    }
    if (matchesKeybinding(keybindings, "toggleTranscript", input, key)) {
      setVerboseTranscript((value) => !value);
      return;
    }
    if (bufferRef.current.value && key.ctrl && (input === "u" || input === "d")) {
      const next = applyInkInput(bufferRef.current, input, key, { columns: promptColumns, scope: "main-prompt" });
      bufferRef.current = next;
      setBuffer(next);
      return;
    }
    const transcriptInput = mapTranscriptInput(
      input,
      key,
      transcriptViewportRef.current?.snapshot() ?? { scrollTop: 0, viewportHeight: 0, contentHeight: 0 },
    );
    if (transcriptInput.handled && transcriptInput.command) {
      transcriptViewportRef.current?.scroll(transcriptInput.command);
      return;
    }
    if (matchesKeybinding(keybindings, "pasteImage", input, key) && options.pasteImage && !state.busy) {
      void options.pasteImage().then((path) => {
        if (!path) {
          dispatch({ type: "turn-error", message: "The clipboard does not contain a PNG image." });
          return;
        }
        const next = applyInputKey(bufferRef.current, {
          name: "text",
          text: `${bufferRef.current.value ? " " : ""}[Image: ${path}]`,
          columns: promptColumns,
        });
        bufferRef.current = next;
        setBuffer(next);
        void options.displayImage?.(path);
      }).catch((error: unknown) => {
        dispatch({
          type: "turn-error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }
    if (key.escape && state.busy) {
      abortController.current?.abort();
      return;
    }
    if (vimMode && key.escape) {
      setVimInsert(false);
      return;
    }
    if (vimMode && !vimInsert) {
      const current = bufferRef.current;
      let next = current;
      if (input === "i") setVimInsert(true);
      else if (input === "I") {
        next = applyInputKey(current, { name: "home", columns: promptColumns });
        setVimInsert(true);
      }
      else if (input === "a") {
        next = applyInputKey(current, { name: "right", columns: promptColumns });
        setVimInsert(true);
      } else if (input === "A") {
        next = applyInputKey(current, { name: "end", columns: promptColumns });
        setVimInsert(true);
      } else if (input === "h") next = applyInputKey(current, { name: "left", columns: promptColumns });
      else if (input === "l") next = applyInputKey(current, { name: "right", columns: promptColumns });
      else if (input === "b") next = applyInputKey(current, { name: "word-left", columns: promptColumns });
      else if (input === "w") next = applyInputKey(current, { name: "word-right", columns: promptColumns });
      else if (input === "x") next = applyInputKey(current, { name: "delete", columns: promptColumns });
      else if (input === "X") next = applyInputKey(current, { name: "backspace", columns: promptColumns });
      else if (input === "D") next = applyInputKey(current, { name: "kill-line-end", columns: promptColumns });
      else if (input === "C") {
        next = applyInputKey(current, { name: "kill-line-end", columns: promptColumns });
        setVimInsert(true);
      } else if (input === "0") next = applyInputKey(current, { name: "home", columns: promptColumns });
      else if (input === "$") next = applyInputKey(current, { name: "end", columns: promptColumns });
      bufferRef.current = next;
      setBuffer(next);
      return;
    }

    if (key.tab) {
      const suggestion = suggestSlashCommands(
        bufferRef.current.value,
        resolveExternalCommands(options.externalCommands),
      )[0];
      if (suggestion) {
        const next = createInputBuffer(`${suggestion.usage.split(" ")[0]} `, history);
        bufferRef.current = next;
        setBuffer(next);
        setInputCompletions(undefined);
        setCompletionNotice(undefined);
        return;
      }
      if (inputCompletions?.values.length) {
        const index = (inputCompletions.index + 1) % inputCompletions.values.length;
        const next = createInputBuffer(inputCompletions.values[index]!, history);
        bufferRef.current = next;
        setBuffer(next);
        setInputCompletions({ ...inputCompletions, index });
        setCompletionNotice(undefined);
        return;
      }
      if (options.completeInput) {
        completionController.current?.abort();
        const controller = new AbortController();
        completionController.current = controller;
        void options.completeInput(bufferRef.current.value, controller.signal).then((values) => {
          if (controller.signal.aborted) return;
          if (!values.length) {
            setInputCompletions(undefined);
            setCompletionNotice("No completions for the current input.");
            return;
          }
          const next = createInputBuffer(values[0]!, history);
          bufferRef.current = next;
          setBuffer(next);
          setInputCompletions({ values, index: 0 });
          setCompletionNotice(undefined);
        }).catch((error: unknown) => {
          if (!controller.signal.aborted) dispatch({ type: "turn-error", message: error instanceof Error ? error.message : String(error) });
        });
      }
      return;
    }

    if (inputCompletions?.values.length && (key.upArrow || key.downArrow)) {
      const direction = key.upArrow ? -1 : 1;
      const index = (inputCompletions.index + direction + inputCompletions.values.length) % inputCompletions.values.length;
      const next = createInputBuffer(inputCompletions.values[index]!, history);
      bufferRef.current = next;
      setBuffer(next);
      setInputCompletions({ ...inputCompletions, index });
      setCompletionNotice(undefined);
      return;
    }

    completionController.current?.abort();
    setInputCompletions(undefined);
    setCompletionNotice(undefined);
    const next = applyInkInput(bufferRef.current, input, key, { columns: promptColumns, scope: "main-prompt" });
    bufferRef.current = next;
    setBuffer(next);
    if (next.submitted) submit(next.submitted);
  });

  return (
    <TuiView
      state={state}
      input={buffer.value}
      cursor={buffer.cursor}
      columns={terminalSize.columns}
      rows={terminalSize.rows}
      transcriptViewportRef={transcriptViewportRef}
      verboseTranscript={verboseTranscript}
      {...(selectedTranscriptEntryId ? { selectedTranscriptEntryId } : {})}
      {...(transcriptSearch ? { transcriptSearch } : {})}
      {...(historySearch ? { historySearch } : {})}
      commandSuggestions={suggestSlashCommands(
        buffer.value,
        resolveExternalCommands(options.externalCommands),
      )}
      {...(inputCompletions ? { inputCompletions: inputCompletions.values } : {})}
      inputCompletionIndex={inputCompletions?.index ?? 0}
      {...(completionNotice ? { completionNotice } : {})}
      tasks={tasks}
      shellRuntimes={shellRuntimes}
      shellPanel={shellPanel}
      shellSelection={shellSelection}
      {...(shellInput ? { shellInput: shellInput.value } : {})}
      {...(mcpActivity ? { mcpActivity } : {})}
      vimMode={vimMode}
      vimInsert={vimInsert}
      primaryColor={theme}
      {...(management ? { management, managementSelection } : {})}
      {...(sessionAction ? { sessionAction: { type: sessionAction.type, input: sessionAction.input.value } } : {})}
      {...(permission ? { permission, permissionSelection } : {})}
      {...(question
        ? {
            question,
            questionSelection,
            questionSelected,
            ...(questionOther ? { questionOtherInput: questionOther.value } : {}),
          }
        : {})}
    />
  );
}

const EMPTY_TASKS: readonly never[] = [];
const emptyTasks = () => EMPTY_TASKS;
const emptySubscribe = () => () => undefined;
const emptyActivity = () => undefined;

function resolveExternalCommands(
  commands: TuiAppOptions["externalCommands"],
): readonly ExternalSlashCommand[] {
  return typeof commands === "function" ? commands() : commands ?? [];
}

export function applyInkInput(
  buffer: InputBuffer,
  input: string,
  key: Parameters<Parameters<typeof useInput>[0]>[1],
  options: { columns?: number; scope?: "main-prompt" | "modal" | "pty" } = {},
): InputBuffer {
  const columns = options.columns;
  if (options.scope === "main-prompt") {
    if (key.ctrl && input === "a") return applyInputKey(buffer, { name: "home", columns });
    if (key.ctrl && input === "e") return applyInputKey(buffer, { name: "end", columns });
    if (key.ctrl && input === "k") return applyInputKey(buffer, { name: "kill-line-end", columns });
    if (key.ctrl && input === "u") return applyInputKey(buffer, { name: "kill-line-start", columns });
    if (key.ctrl && input === "w") return applyInputKey(buffer, { name: "kill-word", columns });
    if (key.ctrl && input === "y") return applyInputKey(buffer, { name: "yank", columns });
    if (key.meta && input === "y") return applyInputKey(buffer, { name: "yank-pop", columns });
  }
  if (key.return) return applyInputKey(buffer, { name: "enter", shift: key.shift, columns });
  if (key.leftArrow) return applyInputKey(buffer, { name: "left", columns });
  if (key.rightArrow) return applyInputKey(buffer, { name: "right", columns });
  if (key.home) return applyInputKey(buffer, { name: "home", columns });
  if (key.end) return applyInputKey(buffer, { name: "end", columns });
  if (key.upArrow) return applyInputKey(buffer, { name: "up", columns });
  if (key.downArrow) return applyInputKey(buffer, { name: "down", columns });
  // Ink 6 reports the DEL byte (0x7f), emitted by Backspace in common macOS
  // terminals, as `delete`. Treat both flags as backward deletion so the
  // physical Backspace key works consistently; Ctrl+D remains forward delete.
  if (key.backspace || key.delete) return applyInputKey(buffer, { name: "backspace", columns });
  if (key.ctrl && input === "d") return applyInputKey(buffer, { name: "delete", columns });
  if (input && !key.ctrl && !key.meta) return applyInputKey(buffer, { name: "text", text: input, columns });
  return buffer;
}

export function restoreInputHistory(history: string[]): { history: string[]; buffer: InputBuffer } {
  const restored = [...history];
  return { history: restored, buffer: createInputBuffer("", restored) };
}
