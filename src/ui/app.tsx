import React, {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
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
import { TerminalSizeContext } from "./ink/components/TerminalSizeContext";
import inkInstances from "./ink/instances";
import { workspaceCompletionToken, completionLabel, completionCursor } from "./file-completion";
import { filterSessionView } from "./session-filter";
import { createPromptEditorState } from "./prompt-input/editor-state";
import { PromptInputController } from "./prompt-input/PromptInput";
import type { PromptEditorState, PromptHistoryEntry, PromptInputSubmit } from "./prompt-input/types";
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
  input: PromptInputSubmit;
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
  completeInput?(input: string, signal: AbortSignal, cursor?: number): Promise<string[]>;
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
  initialInputHistory?: PromptHistoryEntry[];
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
  const [managementDetailOnly, setManagementDetailOnly] = useState(false);
  const [sessionAction, setSessionAction] = useState<{ type: "rename" | "delete"; input: InputBuffer } | undefined>();
  const [scheduledPrompts, setScheduledPrompts] = useState<string[]>([]);
  const [shellPanel, setShellPanel] = useState(false);
  const [shellSelection, setShellSelection] = useState(0);
  const [shellInput, setShellInput] = useState<InputBuffer | undefined>();
  const [shellRuntimes, setShellRuntimes] = useState<ShellRuntimeSnapshot[]>([]);
  const initialPromptHistory = useRef(options.initialInputHistory ?? []).current;
  const initialInput = useRef(restoreInputHistory(initialPromptHistory.map(({ display }) => display))).current;
  const [state, dispatch] = useReducer(
    reduceTuiState,
    createTuiState(options.model, options.permissionMode, {
      ...(options.initialTranscript ? { transcript: options.initialTranscript } : {}),
      ...(options.initialUsage ? { usage: options.initialUsage } : {}),
      ...(options.contextWindowTokens ? { contextWindowTokens: options.contextWindowTokens } : {}),
    }),
  );
  const [history, setHistory] = useState<string[]>(initialInput.history);
  const [promptHistory, setPromptHistory] = useState<PromptHistoryEntry[]>(initialPromptHistory);
  const transcriptViewportRef = useRef<TranscriptViewportController | null>(null);
  const [buffer, setBuffer] = useState<InputBuffer>(initialInput.buffer);
  const [historySearch, setHistorySearch] = useState<InputHistorySearch | undefined>();
  const [inputCompletions, setInputCompletions] = useState<{ values: string[]; index: number; original: string; cursor: number } | undefined>();
  const [queuePanel, setQueuePanel] = useState(false);
  const [queueSelection, setQueueSelection] = useState(0);
  const [restoredEditor, setRestoredEditor] = useState<PromptEditorState>();
  const [sessionFilter, setSessionFilter] = useState("");
  const [sessionFilterEditing, setSessionFilterEditing] = useState(false);
  const [entryExpansion, setEntryExpansion] = useState<Record<string, boolean>>({});
  const [cancelling, setCancelling] = useState(false);
  const [turnStartedAt, setTurnStartedAt] = useState<number>();
  const [phase, setPhase] = useState("Requesting model");
  const visibleManagement = management ? filterSessionView(management, sessionFilter) : undefined;
  const [queuedPrompts, setQueuedPrompts] = useState<PromptInputSubmit[]>([]);
  const [commandSuggestionIndex, setCommandSuggestionIndex] = useState(0);
  const [completionNotice, setCompletionNotice] = useState<string | undefined>();
  const completionController = useRef<AbortController | undefined>(undefined);
  const dismissedCompletion = useRef<string | undefined>(undefined);
  const [vimMode, setVimMode] = useState(options.vimMode === true);
  const [theme, setTheme] = useState(options.theme ?? "cyan");
  const [verboseTranscript, setVerboseTranscript] = useState(false);
  const [transcriptSearch, setTranscriptSearch] = useState<TranscriptSearchState | undefined>();
  const [selectedTranscriptEntryId, setSelectedTranscriptEntryId] = useState<string | undefined>();
  const [vimInsert, setVimInsert] = useState(!options.vimMode);
  const [promptMouse, setPromptMouse] = useState<{ row: number; column: number; nonce: number; maxVisibleLines?: number } | undefined>();
  const bufferRef = useRef(buffer);
  const terminalSize = useContext(TerminalSizeContext) ?? { columns: stdout.columns || 80, rows: stdout.rows || 24 };
  const abortController = useRef<AbortController | undefined>(undefined);
  const lastCtrlCPress = useRef(0);
  const ctrlCExitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hasRun = useRef(options.initialResume === true);
  const imageToolPaths = useRef(new Map<string, string>());
  const preparingTool = useRef<string | undefined>(undefined);

  // Structural transitions move the prompt/footer; never reuse their old pixels.
  useLayoutEffect(() => {
    inkInstances.get(stdout)?.invalidatePrevFrame();
  }, [stdout, state.busy, theme, management, queuePanel, shellPanel, permission, question]);

  useEffect(() => { setSessionFilter(""); setSessionFilterEditing(false); setManagementSelection(0); setManagementDetailOnly(false); }, [management]);
  useEffect(() => { if (!state.busy) { setCancelling(false); setTurnStartedAt(undefined); } }, [state.busy]);


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

  const submit = useCallback((submitted: string | PromptInputSubmit, fromQueue = false) => {
    const structured: PromptInputSubmit = typeof submitted === "string"
      ? { display: submitted, expanded: submitted, mode: "prompt", pastedContents: {} }
      : submitted;
    if (state.busy) {
      setQueuedPrompts((current) => [...current, structuredClone(structured)]);
      const empty = createInputBuffer("", history);
      bufferRef.current = empty;
      setBuffer(empty);
      setCompletionNotice(undefined);
      return;
    }
    const prompt = structured.expanded;
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
    const nextHistory = [...history, structured.display];
    setHistory(nextHistory);
    setPromptHistory((current) => [...current, {
      display: structured.display,
      mode: structured.mode,
      pastedContents: structuredClone(structured.pastedContents),
    }]);
    if (!fromQueue) {
      const emptyBuffer = createInputBuffer("", nextHistory);
      bufferRef.current = emptyBuffer;
      setBuffer(emptyBuffer);
    }
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
          setQueuedPrompts([]); setQueuePanel(false); setEntryExpansion({}); setSelectedTranscriptEntryId(undefined);
          sessionId.current = result.sessionId ?? nextSessionId;
          hasRun.current = result.resumeSession === true;
          const restored = restoreInputHistory(result.restoredInputHistory ?? []);
          setHistory(restored.history);
          setPromptHistory(restored.history.map((display) => ({ display, mode: "prompt", pastedContents: {} })));
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
    setCancelling(false);
    setTurnStartedAt(Date.now());
    setPhase("Requesting model");
    preparingTool.current = undefined;
    dispatch({ type: "submit", text: structured.display });
    const controller = new AbortController();
    abortController.current = controller;
    void options.runTurn({
      input: structured,
      sessionId: sessionId.current,
      resume: hasRun.current,
      signal: controller.signal,
      onModelEvent(event) {
        if (event.type === "text") setPhase("Writing response");
        if (event.type === "thinking") setPhase("Thinking");
        if (event.type === "tool-start") { preparingTool.current = event.name; setPhase(`Preparing ${event.name}`); }
        if (event.type === "tool-input") setPhase(preparingTool.current ? `Preparing ${preparingTool.current} arguments` : "Preparing tool arguments");
        if (event.type === "response-end") setPhase(event.reason === "tool-use" ? "Preparing tools" : "Finishing response");
        dispatch({ type: "model-event", event });
      },
      onToolEvent(event) {
        if (event.type === "tool-execution-start") {
          setPhase(`Running ${event.name}`);
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
      dispatch(controller.signal.aborted ? { type: "turn-error", message: "Interrupted" } : { type: "turn-complete" });
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

  const requestCompletions = useCallback((automatic = false) => {
    if (!options.completeInput) return;
    completionController.current?.abort();
    const controller = new AbortController();
    completionController.current = controller;
    const original = bufferRef.current.value;
    const cursor = bufferRef.current.cursor;
    void options.completeInput(original, controller.signal, cursor).then(values => {
      if (controller.signal.aborted || bufferRef.current.value !== original || bufferRef.current.cursor !== cursor) return;
      setInputCompletions(values.length ? { values, index: 0, original, cursor } : undefined);
      setCompletionNotice(values.length || automatic ? undefined : "No completions for the current input.");
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setCompletionNotice(error instanceof Error ? error.message : String(error));
    });
  }, [options.completeInput]);

  useEffect(() => {
    completionController.current?.abort();
    setInputCompletions(undefined);
    const token = workspaceCompletionToken(buffer.value, buffer.cursor);
    if (!token?.at || permission || question || management || queuePanel || historySearch || transcriptSearch || shellPanel || dismissedCompletion.current === `${buffer.cursor}:${buffer.value}`) return;
    const timer = setTimeout(() => requestCompletions(true), 120);
    return () => { clearTimeout(timer); completionController.current?.abort(); };
  }, [buffer.value, buffer.cursor, permission, question, management, queuePanel, historySearch, transcriptSearch, shellPanel, requestCompletions]);

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

  useEffect(() => { setCommandSuggestionIndex(0); }, [buffer.value]);

  useEffect(() => {
    if (state.busy || permission || question || management || queuePanel || !queuedPrompts.length) return;
    const [prompt, ...remaining] = queuedPrompts;
    setQueuedPrompts(remaining);
    if (prompt) submit(prompt, true);
  }, [management, permission, question, queuePanel, queuedPrompts, state.busy, submit]);

  useEffect(() => {
    if (state.busy || permission || question || management || queuePanel || queuedPrompts.length || scheduledPrompts.length === 0) return;
    const [prompt, ...remaining] = scheduledPrompts;
    setScheduledPrompts(remaining);
    if (prompt) submit(prompt, true);
  }, [management, permission, question, queuePanel, queuedPrompts.length, scheduledPrompts, state.busy, submit]);

  useInput((input, key, event) => {
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
    if (queuePanel) {
      if (key.escape || key.ctrl && input === "c" || matchesKeybinding(keybindings, "promptQueue", input, key)) setQueuePanel(false);
      else if (key.upArrow) setQueueSelection(index => Math.max(0, index - 1));
      else if (key.downArrow) setQueueSelection(index => Math.min(Math.max(0, queuedPrompts.length - 1), index + 1));
      else if ((key.backspace || key.delete || input.toLowerCase() === "d") && queuedPrompts[queueSelection]) {
        setQueuedPrompts(current => current.filter((_, index) => index !== queueSelection));
        setQueueSelection(index => Math.max(0, index - 1));
      } else if ((key.return || input.toLowerCase() === "e") && queuedPrompts[queueSelection]) {
        if (bufferRef.current.value) { setCompletionNotice("Keep or clear the current draft before editing a queued prompt."); return; }
        const prompt = queuedPrompts[queueSelection]!;
        const pastedContents = structuredClone(prompt.pastedContents);
        const editor = { ...createPromptEditorState(prompt.display), mode: prompt.mode, pastedContents, nextPasteId: Math.max(0, ...Object.keys(pastedContents).map(Number)) + 1 };
        setRestoredEditor(editor);
        const next = createInputBuffer(prompt.display, history);
        bufferRef.current = next; setBuffer(next);
        setQueuedPrompts(current => current.filter((_, index) => index !== queueSelection));
        setQueueSelection(0); setQueuePanel(false);
      }
      return;
    }
    if (management && visibleManagement) {
      if (management.kind === "diff") {
        if (key.escape && managementDetailOnly) { setManagementDetailOnly(false); return; }
        if (key.return) { setManagementDetailOnly(value => !value); return; }
        if (input.toLowerCase() === "r") { setManagement(undefined); submit(management.refreshCommand ?? "/diff"); return; }
      }
      if (management.kind === "sessions" && (sessionFilterEditing || input === "/")) {
        if (!sessionFilterEditing) setSessionFilterEditing(true);
        else if (key.escape) { setSessionFilter(""); setSessionFilterEditing(false); setManagementSelection(0); }
        else if (key.return) setSessionFilterEditing(false);
        else if (key.backspace || key.delete) { setSessionFilter(value => Array.from(value).slice(0, -1).join("")); setManagementSelection(0); }
        else if (input && !key.ctrl && !key.meta) { setSessionFilter(value => value + input); setManagementSelection(0); }
        return;
      }
      const selected = visibleManagement.items[managementSelection];
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
      if (visibleManagement.items.length === 0) {
        if (key.escape || (key.ctrl && input === "c")) { setManagement(undefined); }
        return;
      }
      if (key.upArrow || key.leftArrow) {
        setManagementSelection((value) => (value + visibleManagement.items.length - 1) % visibleManagement.items.length);
      } else if (key.downArrow || key.rightArrow) {
        setManagementSelection((value) => (value + 1) % visibleManagement.items.length);
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
      dismissedCompletion.current = `${bufferRef.current.cursor}:${bufferRef.current.value}`;
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
    if (matchesKeybinding(keybindings, "redraw", input, key) && !matchesKeybinding(keybindings, "externalEditor", input, key) && !matchesKeybinding(keybindings, "pasteImage", input, key)) {
      inkInstances.get(stdout)?.forceRedraw(); return;
    }
    if (matchesKeybinding(keybindings, "promptQueue", input, key)) {
      setQueueSelection(0); setQueuePanel(true); return;
    }
    if (matchesKeybinding(keybindings, "previousTool", input, key) || matchesKeybinding(keybindings, "nextTool", input, key)) {
      const tools = state.transcript.filter(entry => entry.kind === "tool");
      if (!tools.length) return;
      const current = tools.findIndex(entry => entry.id === selectedTranscriptEntryId);
      const previous = matchesKeybinding(keybindings, "previousTool", input, key);
      const index = current < 0 ? tools.length - 1 : (current + (previous ? -1 : 1) + tools.length) % tools.length;
      const id = tools[index]!.id;
      setSelectedTranscriptEntryId(id); transcriptViewportRef.current?.reveal(id); return;
    }
    if (matchesKeybinding(keybindings, "toggleTool", input, key)) {
      const selected = state.transcript.find(entry => entry.id === selectedTranscriptEntryId && entry.kind === "tool") ?? [...state.transcript].reverse().find(entry => entry.kind === "tool");
      if (selected) { setSelectedTranscriptEntryId(selected.id); setEntryExpansion(current => ({ ...current, [selected.id]: !(current[selected.id] ?? verboseTranscript) })); }
      return;
    }
    if (matchesKeybinding(keybindings, "toggleTranscript", input, key)) {
      setVerboseTranscript(value => !value); setEntryExpansion({}); return;
    }
    const promptControllerActive = !permission && !question && !management && !queuePanel && !historySearch && !transcriptSearch && !shellPanel;
    if (promptControllerActive && inputCompletions?.values.length && !event.keypress.isPasted && (key.upArrow || key.downArrow || key.tab || key.return && !key.shift)) {
      if (key.upArrow || key.downArrow) {
        const direction = key.upArrow ? -1 : 1;
        setInputCompletions(current => current ? { ...current, index: (current.index + direction + current.values.length) % current.values.length } : current);
      } else {
        const value = inputCompletions.values[inputCompletions.index]!;
        const next = { ...createInputBuffer(value, history), cursor: completionCursor(inputCompletions.original, value, inputCompletions.cursor) };
        bufferRef.current = next; setBuffer(next);
        dismissedCompletion.current = value.slice(0, next.cursor).endsWith("/") ? undefined : `${next.cursor}:${value}`;
        setInputCompletions(undefined); setCompletionNotice(undefined);
      }
      return;
    }
    const commands = suggestSlashCommands(bufferRef.current.value, resolveExternalCommands(options.externalCommands));
    if (promptControllerActive && commands.length && !event.keypress.isPasted && (key.upArrow || key.downArrow || key.tab || key.return && !key.shift)) {
      if (key.upArrow || key.downArrow) {
        setCommandSuggestionIndex((current) => (current + (key.upArrow ? -1 : 1) + commands.length) % commands.length);
      } else {
        const command = commands[commandSuggestionIndex] ?? commands[0]!;
        // Exact commands still submit on Enter; prefixes complete before execution.
        if (key.return && bufferRef.current.value.trim() === `/${command.name}`) submit(bufferRef.current.value);
        else {
          const next = createInputBuffer(`${command.usage.split(" ")[0]} `, history);
          bufferRef.current = next;
          setBuffer(next);
        }
      }
      return;
    }
    if (key.escape && state.busy) {
      setCancelling(true);
      abortController.current?.abort();
      return;
    }
    if (promptControllerActive && (matchesKeybinding(keybindings, "externalEditor", input, key) || matchesKeybinding(keybindings, "pasteImage", input, key))) return;
    if (promptControllerActive && promptControllerOwnsInput(input, key, event.keypress.isPasted, Boolean(inputCompletions?.values.length), bufferRef.current.value.length > 0)) {
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
        setCancelling(true);
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
      requestCompletions();
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

  const updatePromptEditor = (editor: PromptEditorState) => {
    const next: InputBuffer = { ...bufferRef.current, value: editor.value, cursor: editor.cursorOffset };
    bufferRef.current = next;
    setBuffer(next);
    setVimInsert(editor.vimMode === "INSERT");
  };

  return (
    <>
      <PromptInputController
        keybindings={keybindings}
        restoreState={restoredEditor}
        active={!permission && !question && !management && !queuePanel && !historySearch && !transcriptSearch && !shellPanel}
        maxVisibleLines={Math.max(1, Math.min(6, Math.floor(terminalSize.rows / 3)))}
        columns={promptContentColumns(terminalSize.columns, vimMode ? (vimInsert ? "INSERT" : "NORMAL") : undefined)}
        value={buffer.value}
        cursorOffset={buffer.cursor}
        history={promptHistory}
        vimEnabled={vimMode}
        completionActive={Boolean(inputCompletions?.values.length) || suggestSlashCommands(buffer.value, resolveExternalCommands(options.externalCommands)).length > 0}
        {...(options.pasteImage ? { pasteImage: options.pasteImage } : {})}
        {...(options.editInput ? { editInput: options.editInput } : {})}
        onChange={updatePromptEditor}
        onSubmit={submit}
        onNotice={(message) => setCompletionNotice(message)}
        {...(promptMouse ? { mousePosition: promptMouse } : {})}
      />
    <TuiView
      keybindings={keybindings}
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
      {...(inputCompletions ? { inputCompletions: inputCompletions.values.map(value => completionLabel(inputCompletions.original, value, inputCompletions.cursor)) } : {})}
      inputCompletionIndex={inputCompletions?.index ?? 0}
      commandSuggestionIndex={commandSuggestionIndex}
      queuedPromptCount={queuedPrompts.length}
      queuedPrompts={queuedPrompts}
      queuePanel={queuePanel}
      queueSelection={queueSelection}
      entryExpansion={entryExpansion}
      onToggleEntry={(id) => { setSelectedTranscriptEntryId(id); setEntryExpansion(current => ({ ...current, [id]: !(current[id] ?? verboseTranscript) })); }}
      activityLabel={cancelling ? "Cancelling…" : permission ? "Waiting for permission" : question ? "Waiting for your answer" : state.tools.some(tool => tool.status === "running") ? phase : phase.startsWith("Running ") ? "Requesting model" : phase}
      turnStartedAt={turnStartedAt}
      sessionFilter={sessionFilter}
      sessionFilterEditing={sessionFilterEditing}
      managementDetailOnly={managementDetailOnly}
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
      onPromptClick={(row, column, maxVisibleLines) => setPromptMouse((current) => ({ row, column, maxVisibleLines, nonce: (current?.nonce ?? 0) + 1 }))}
      {...(visibleManagement ? { management: visibleManagement, managementSelection } : {})}
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
    </>
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

function promptControllerOwnsInput(
  input: string,
  key: Parameters<Parameters<typeof useInput>[0]>[1],
  pasted: boolean,
  completionActive: boolean,
  hasPrompt: boolean,
): boolean {
  if (completionActive && (key.upArrow || key.downArrow || key.tab || key.return || key.escape)) return false;
  if (key.ctrl && ["c", "f", "o", "r", "t"].includes(input)) return false;
  if (key.ctrl && (input === "u" || input === "d") && !hasPrompt) return false;
  return pasted || key.return || key.escape || key.leftArrow || key.rightArrow || key.upArrow || key.downArrow ||
    key.home || key.end || key.backspace || key.delete || key.ctrl || key.meta || Boolean(input);
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
