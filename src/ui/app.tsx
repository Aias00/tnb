import { CompactionNotices } from "../services/compact/notice";
import { AwayRecap } from "../services/notifications/away-recap";
import TerminalFocusContext from "./ink/components/TerminalFocusContext";
import { IdleNotifications, type IdleNotice } from "../services/notifications/idle";
import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
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
import { PromptInputController } from "./prompt-input/PromptInput";
import { applyPromptEditorAction, createPromptEditorState } from "./prompt-input/editor-state";
import { expandPromptReferences } from "./prompt-input/references";
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
import { durableUserQuestion, displayQuestionText, questionNoticeKey, type QuestionInbox, type ConnectionStatus } from "../services/runtime/attention";
import type { TaskManager } from "../services/tasks/manager";
import type { ScheduleManager } from "../services/scheduler/manager";
import type { ShellRuntimeSnapshot, ShellSessionManager } from "../services/shell/manager";
import type { ExternalEditorResult } from "./external-editor";
import { DEFAULT_KEYBINDINGS, matchesKeybinding, type KeybindingMap } from "./keybindings";
import { EMPTY_USAGE, type UsageTotals } from "../services/usage/cost";
import type { TranscriptEntry } from "./transcript/model";
import { InputQueue, type InputQueueStorage } from "./input-queue";
import { workbenchItems, runDetailLines, type WorkbenchTab } from "./workbench";
import { RuntimeRequestError } from "../services/runtime/server";
import type { RunDetail } from "../services/runtime/presentation";
import { watchWorkspaceBranch } from "./workspace-status";
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
  /** Authoritative ledger snapshot, delivered before its model usage event. */
  onUsage(usage: UsageTotals, sessionUsage?: UsageTotals): void;
  onToolEvent(event: ToolExecutionEvent): void;
  permissionPrompt: PermissionController["request"];
  questionPrompt: AskUser;
  onPermissionModeChange(mode: PermissionMode): void;
  onActivity?(phase: "working" | "compacting"): void;
  onCompaction?(preTokens: number, postTokens: number, info?: import("../services/compact/notice").CompactionInfo): void;
};

export type TuiAppOptions = {
  notify?(kind: IdleNotice["kind"]): void;
  keybindingWarnings?: readonly string[];
  invocationBudgetUsd?: number;
  model: string;
  permissionMode: PermissionMode;
  permissionController?: PermissionController;
  questionController?: QuestionController;
  durableQuestions?: QuestionInbox;
  workspace?(): string;
  queueStorage?: InputQueueStorage;
  mcpActivityController?: McpActivityController;
  taskManager?: TaskManager;
  scheduleManager?: ScheduleManager;
  shellManager?: ShellSessionManager;
  sessionIdFactory(): string;
  runTurn(turn: TuiTurn): Promise<void>;
  runCommand?(request: SlashCommandRequest): Promise<SlashCommandResult>;
  externalCommands?: readonly ExternalSlashCommand[] | (() => readonly ExternalSlashCommand[]);
  onCompletionAccepted?(original: string, candidate: string, cursor: number): void;
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

// Terminal packets may contain several keys before React renders the next frame.
function useImmediateState<T>(initial: T) {
  const [value, publish] = useState(initial), current = useRef(initial);
  const update = useCallback((next: T | ((old: T) => T)) => {
    current.current = typeof next === "function" ? (next as (old: T) => T)(current.current) : next;
    publish(current.current);
  }, []);
  return [value, update, current] as const;
}

export function TuiApp(options: TuiAppOptions) {
  const { exit } = useApp();
  const selection = useSelection();
  useCopyOnSelect(selection);
  const searchHighlight = useSearchHighlight();
  const keybindings = options.keybindings ?? DEFAULT_KEYBINDINGS;
  const stdout = options.stdout ?? process.stdout;
  const sessionId = useRef(options.sessionIdFactory());
  const inputQueue = useMemo(() => new InputQueue(sessionId.current, options.queueStorage), [sessionId.current, options.queueStorage]);
  const queuedInputs = useSyncExternalStore(inputQueue.subscribe, inputQueue.current, inputQueue.current);
  const turnRunning = useRef(false), queueClaiming = useRef(false), sendingInput = useRef(false);
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
  const durableQuestions = useSyncExternalStore(options.durableQuestions?.subscribe ?? emptySubscribe,
    options.durableQuestions?.current ?? emptyTasks, options.durableQuestions?.current ?? emptyTasks);
  const runNotifications = useSyncExternalStore(options.durableQuestions?.subscribe ?? emptySubscribe,
    options.durableQuestions?.notifications ?? emptyTasks, options.durableQuestions?.notifications ?? emptyTasks);
  const durableRuns = useSyncExternalStore(options.durableQuestions?.subscribe ?? emptySubscribe,
    options.durableQuestions?.runs ?? emptyTasks, options.durableQuestions?.runs ?? emptyTasks);
  const runtimeConnection = useSyncExternalStore(options.durableQuestions?.subscribe ?? emptySubscribe,
    options.durableQuestions?.connection ?? onlineConnection, options.durableQuestions?.connection ?? onlineConnection);
  const displayedRunNotifications = useRef(new Set<string>());
  const activeDurableQuestion = useRef<{ key: string; controller: AbortController; answering: boolean } | undefined>(undefined);
  const questionUiMounted = useRef(true);
  const announcedDurableQuestions = useRef(new Set<string>());
  const [durablePromptEpoch, setDurablePromptEpoch] = useState(0);
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
  const questionSelectionRef = useRef(0);
  const [questionSelected, setQuestionSelected] = useState<Set<number>>(() => new Set());
  const [questionOther, setQuestionOther] = useState<InputBuffer | undefined>();
  const [management, setManagement] = useState<ManagementView | undefined>(options.initialManagement);
  const [managementSelection, setManagementSelection] = useState(0);
  const [workbench, setWorkbench, workbenchRef] = useImmediateState(false), [workbenchTab, setWorkbenchTab, workbenchTabRef] = useImmediateState<WorkbenchTab>("tasks");
  const [workbenchSelection, setWorkbenchSelection, workbenchSelectionRef] = useImmediateState(0), [workbenchDetail, setWorkbenchDetail] = useState(false), [workbenchOffset, setWorkbenchOffset] = useState(0);
  const [workbenchBusy, setWorkbenchBusy, workbenchBusyRef] = useImmediateState(false), [workbenchError, setWorkbenchError] = useState<string | undefined>();
  const [workbenchResult, setWorkbenchResult] = useState<RunDetail | undefined>();
  const [confirmation, setConfirmation, confirmationRef] = useImmediateState<{ kind: "cancel" | "shell" | "delete"; id: string } | undefined>(undefined);
  const panelRequest = useRef(0);
  const controlRetry = useRef<{ runId: string; action: "pause" | "resume" | "cancel"; revision: number; commandId: string } | undefined>(undefined);
  const [inputTarget, setInputTarget] = useState<{ runId: string; title: string; workspace: string } | undefined>();
  const followupRetry = useRef<{ id: string; runId: string; text: string } | undefined>(undefined);
  const [inputSending, setInputSending] = useState(false);
  const [restoredDraft, setRestoredDraft] = useState<{ input: PromptInputSubmit; nonce: string; queueId?: string } | undefined>();
  const [requestedDecision, setRequestedDecision] = useState<string | undefined>();
  const decisionDrafts = useRef(new Map<string, { selection: number; selected: Set<number>; other?: InputBuffer }>());
  const [permissionOffset, setPermissionOffset] = useState(0);
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
  const warningSignature = JSON.stringify(options.keybindingWarnings ?? []);
  useEffect(() => {
    for (const warning of options.keybindingWarnings ?? []) dispatch({ type: "notice", noticeId: `keybinding:${warning}`, message: `Shortcut warning: ${warning}` });
  }, [warningSignature]);
  const [history, setHistory] = useState<string[]>(initialInput.history);
  const [promptHistory, setPromptHistory] = useState<PromptHistoryEntry[]>(initialPromptHistory);
  const transcriptViewportRef = useRef<TranscriptViewportController | null>(null);
  const [buffer, setBuffer] = useState<InputBuffer>(initialInput.buffer);
  const [historySearch, setHistorySearch] = useState<InputHistorySearch | undefined>();
  const [inputCompletions, setInputCompletions] = useState<{ values: string[]; index: number; original: string; cursor: number } | undefined>();
  const [queuePanel, setQueuePanel] = useState(false);
  const [queueSelection, setQueueSelection] = useState(0);
  const [sessionFilter, setSessionFilter] = useState("");
  const [sessionFilterEditing, setSessionFilterEditing] = useState(false);
  const [entryExpansion, setEntryExpansion] = useState<Record<string, boolean>>({});
  const [cancelling, setCancelling] = useState(false);
  const [turnStartedAt, setTurnStartedAt] = useState<number>();
  const [phase, setPhase] = useState("Requesting model");
  const compactionNotices = useRef(new CompactionNotices()).current;
  const foreground = state.busy ? {
    title: [...state.transcript].reverse().find(entry => entry.kind === "user")?.text ?? "当前终端执行",
    phase: cancelling ? "正在取消" : permission ? "等待授权" : question ? "等待回答" : state.activity === "compacting" ? "整理上下文" : phase,
  } : undefined;
  const workItems = workbenchItems(workbenchTab, { runs: durableRuns, questions: durableQuestions, queue: queuedInputs, tasks, shells: shellRuntimes, foreground });
  const visibleManagement = management ? filterSessionView(management, sessionFilter) : undefined;
  const queuedPrompts = useMemo(() => queuedInputs.map((item) => item.input), [queuedInputs]);
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
  const editorSnapshot = useRef<PromptEditorState>(createPromptEditorState(buffer.value));
  const terminalSize = useContext(TerminalSizeContext) ?? { columns: stdout.columns || 80, rows: stdout.rows || 24 };
  const abortController = useRef<AbortController | undefined>(undefined);
  const editorActive = useRef(false);
  const lastCtrlCPress = useRef(0);
  const ctrlCExitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hasRun = useRef(options.initialResume === true);
  const imageToolPaths = useRef(new Map<string, string>());
  const workspacePath = options.workspace?.() ?? process.cwd();
  const [branch, setBranch] = useState("");
  useEffect(() => {
    let closed = false, release = () => {};
    void watchWorkspaceBranch(workspacePath, (value) => { if (!closed) setBranch(displayQuestionText(value)); }).then((stop) => { if (closed) stop(); else release = stop; });
    return () => { closed = true; release(); };
  }, [workspacePath]);
  const restoringDecision = useRef(false);
  const restoredQueue = useRef<InputQueue | undefined>(undefined);
  useEffect(() => { void inputQueue.load().catch((error) => dispatch({ type: "notice", message: `排队输入恢复失败：${String(error)}；原文件保留。` })); }, [inputQueue]);
  useEffect(() => {
    if (!inputQueue.ready || restoredQueue.current === inputQueue) return;
    restoredQueue.current = inputQueue;
    const item = queuedInputs.find((row) => row.state === "draft" && row.workspace === workspacePath);
    if (item && !bufferRef.current.value) { const draft = createInputBuffer(item.input.display, history); bufferRef.current = draft; setBuffer(draft); setRestoredDraft({ input: item.input, nonce: item.id, queueId: item.id }); }
  }, [inputQueue, queuedInputs, workspacePath]);
  useEffect(() => { setPermissionOffset(0); }, [permission]);
  useEffect(() => {
    panelRequest.current++; setWorkbenchResult(undefined); setWorkbenchDetail(false); setInputTarget(undefined); setRestoredDraft(undefined); controlRetry.current = undefined;
  }, [workspacePath, sessionId.current]);
  useEffect(() => {
    const keys = new Set(durableQuestions.map(questionNoticeKey));
    for (const key of decisionDrafts.current.keys()) if (!keys.has(key)) decisionDrafts.current.delete(key);
  }, [durableQuestions]);

  useEffect(() => {
    for (const notice of runNotifications) {
      if (!displayedRunNotifications.current.has(notice.noticeId)) {
        displayedRunNotifications.current.add(notice.noticeId); dispatch({ type: "notice", message: displayQuestionText(notice.message), noticeId: notice.noticeId });
      }
    }
  }, [runNotifications, runtimeConnection, options.durableQuestions]);
  useEffect(() => {
    if (runtimeConnection.state !== "online") return;
    for (const notice of runNotifications) if (state.transcript.some((entry) => entry.id === `runtime-notice:${notice.noticeId}`)) {
      // Acknowledge after the notice is committed to the view, never when merely received.
      void options.durableQuestions?.acknowledge?.(notice).catch(() => undefined);
    }
  }, [runNotifications, runtimeConnection, options.durableQuestions, state.transcript]);

  useEffect(() => {
    const fresh = durableQuestions.filter((notice) => !announcedDurableQuestions.current.has(questionNoticeKey(notice)));
    if (fresh.length) {
      fresh.forEach((notice) => announcedDurableQuestions.current.add(questionNoticeKey(notice)));
      dispatch({ type: "notice", message: `${durableQuestions.length} 个长任务问题需要你决定，当前输入和操作会保留。` });
    }
    const active = activeDurableQuestion.current;
    if (active) {
      if (!active.answering && (runtimeConnection.state !== "online" || !durableQuestions.some((notice) => questionNoticeKey(notice) === active.key))) active.controller.abort();
      return;
    }
    if (!options.durableQuestions || runtimeConnection.state !== "online" || state.busy || permission || question || questionController.current() || management
      || workbench || queuePanel || shellPanel || historySearch || transcriptSearch || editorActive.current || (!requestedDecision && buffer.value.length)) return;
    const notice = requestedDecision ? durableQuestions.find((row) => questionNoticeKey(row) === requestedDecision) : options.durableQuestions.next();
    if (!notice) { if (requestedDecision) setRequestedDecision(undefined); return; }
    setRequestedDecision(undefined);
    const pending = { key: questionNoticeKey(notice), controller: new AbortController(), answering: false };
    activeDurableQuestion.current = pending;
    void questionController.request(durableUserQuestion(notice), pending.controller.signal).then(async (answer) => {
      if (pending.controller.signal.aborted) return;
      pending.answering = true;
      const result = await options.durableQuestions!.answer(notice, answer);
      decisionDrafts.current.delete(pending.key);
      if (!pending.controller.signal.aborted) dispatch({ type: "notice", message: result.message ?? (result.paused ? "回答已保存；任务保持暂停，恢复后继续。" : "回答已保存，长任务会继续执行。") });
    }).catch((error: unknown) => {
      if (pending.controller.signal.aborted) return;
      options.durableQuestions!.dismiss(notice);
      dispatch({ type: "notice", message: error instanceof Error && error.message === "User declined to answer questions"
        ? "问题仍然保留，稍后可用 /task questions 处理；重新打开对话也会再次提醒。"
        : `回答未提交：${error instanceof Error ? error.message : String(error)}。请核对当前问题后重试。` });
    }).finally(() => {
      if (activeDurableQuestion.current === pending) activeDurableQuestion.current = undefined;
      if (questionUiMounted.current) setDurablePromptEpoch((value) => value + 1);
    });
  }, [durableQuestions, options.durableQuestions, state.busy, permission, question, questionController, management, workbench, requestedDecision,
    queuePanel, shellPanel, historySearch, transcriptSearch, buffer.value, durablePromptEpoch, runtimeConnection]);

  useEffect(() => {
    questionUiMounted.current = true;
    return () => { questionUiMounted.current = false; activeDurableQuestion.current?.controller.abort(); };
  }, []);
  const focus = useContext(TerminalFocusContext);
  const awayRecap = useRef(new AwayRecap()).current;
  useEffect(() => {
    const recap = awayRecap.focus(focus.isTerminalFocused, Number(Boolean(permission)) + Number(Boolean(question)) + durableQuestions.length + runNotifications.length);
    if (recap) dispatch({ type: "notice", message: recap });
  }, [focus.isTerminalFocused, awayRecap]);
  const focusRef = useRef(focus.isTerminalFocused); focusRef.current = focus.isTerminalFocused;
  const notificationCallback = useRef(options.notify); notificationCallback.current = options.notify;
  const idleNotifications = useRef(new IdleNotifications(kind => notificationCallback.current?.(kind))).current;
  const permissionNotice = useRef({ value: permission, id: crypto.randomUUID() });
  if (permissionNotice.current.value !== permission) permissionNotice.current = { value: permission, id: crypto.randomUUID() };
  const questionNotice = useRef({ value: question, id: crypto.randomUUID() });
  if (questionNotice.current.value !== question) questionNotice.current = { value: question, id: crypto.randomUUID() };
  useEffect(() => {
    const notices: IdleNotice[] = [];
    if (permission) notices.push({ id: `permission:${permissionNotice.current.id}`, kind: "permission" });
    if (question) notices.push({ id: `question:${questionNotice.current.id}`, kind: "question" });
    if (durableQuestions.length) notices.push({ id: `questions:${durableQuestions.map(item => questionNoticeKey(item)).join(",")}`, kind: "question" });
    if (runNotifications.length) notices.push({ id: `background:${runNotifications.map(item => item.noticeId).join(",")}`, kind: "background" });
    idleNotifications.sync(notices);
  }, [permission, question, durableQuestions, runNotifications, idleNotifications]);
  useEffect(() => { const timer = setInterval(() => idleNotifications.tick(focusRef.current), 500); return () => { clearInterval(timer); idleNotifications.close(); }; }, [idleNotifications]);
  const preparingTool = useRef<string | undefined>(undefined);
  const invocationSequence = useRef(0);
  const usageSessionEpoch = useRef(0);

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
    const draft = activeDurableQuestion.current && decisionDrafts.current.get(activeDurableQuestion.current.key);
    restoringDecision.current = true;
    questionSelectionRef.current = draft?.selection ?? 0;
    setQuestionSelection(draft?.selection ?? 0);
    setQuestionSelected(draft?.selected ?? new Set());
    setQuestionOther(draft?.other ?? (question?.options.length === 0 ? createInputBuffer() : undefined));
  }, [question]);
  useEffect(() => {
    if (restoringDecision.current) { restoringDecision.current = false; return; }
    const active = activeDurableQuestion.current;
    if (active && question) decisionDrafts.current.set(active.key, { selection: questionSelection, selected: new Set(questionSelected), other: questionOther });
  }, [question, questionSelection, questionSelected, questionOther]);

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

  const submit = useCallback((submitted: string | PromptInputSubmit, queuedId?: string, preserveDraft = false) => {
    if (sendingInput.current || (!queuedId && queueClaiming.current)) return;
    const structured: PromptInputSubmit = typeof submitted === "string"
      ? { display: submitted, expanded: submitted, mode: "prompt", pastedContents: {} }
      : submitted;
    const prompt = structured.expanded;
    const clearSubmitted = () => {
      if (bufferRef.current.value.trim() !== structured.display.trim()) return;
      const empty = createInputBuffer("", history); bufferRef.current = empty; setBuffer(empty);
    };
    if (inputTarget && !queuedId) {
      if (structured.mode !== "prompt" || prompt.startsWith("/")) { setCompletionNotice("补充模式只接收文字；Esc 返回普通对话。"); return; }
      if (!options.durableQuestions?.followup || workspacePath !== inputTarget.workspace) { setCompletionNotice("后台或工作区已变化，请重新选择任务。"); return; }
      const retry = followupRetry.current;
      const delivery = retry?.runId === inputTarget.runId && retry.text === prompt ? retry : { id: `ui-input:${crypto.randomUUID()}`, runId: inputTarget.runId, text: prompt };
      followupRetry.current = delivery; sendingInput.current = true; setInputSending(true);
      void options.durableQuestions.followup(delivery.runId, prompt, delivery.id).then(async () => {
        if (restoredDraft?.queueId) { await inputQueue.remove(restoredDraft.queueId); setRestoredDraft(undefined); }
        clearSubmitted(); setInputTarget(undefined); followupRetry.current = undefined;
        dispatch({ type: "notice", message: `补充已保存到「${inputTarget.title}」，待安全工具边界送达；可在 Ctrl+T 查看送达状态。` });
      }).catch((error) => setCompletionNotice(`补充未确认，草稿保留；Enter 用同一身份重试：${String(error)}`))
        .finally(() => { sendingInput.current = false; setInputSending(false); });
      return;
    }
    if (restoredDraft?.queueId && !queuedId) {
      sendingInput.current = true; setInputSending(true);
      void inputQueue.requeue(restoredDraft.queueId, structured, workspacePath).then(() => { clearSubmitted(); setRestoredDraft(undefined); setCompletionNotice("编辑后的输入已保存排队。"); })
        .catch((error) => setCompletionNotice(`输入未重新派发，草稿保留：${String(error)}`)).finally(() => { sendingInput.current = false; setInputSending(false); });
      return;
    }
    if (!queuedId && (state.busy || turnRunning.current || queuedInputs[0]?.state === "pending")) {
      if (prompt.trimStart().startsWith("/")) { setCompletionNotice("命令请在前台结束后执行；Ctrl+T 可随时管理后台任务，普通文字可排队。"); return; }
      sendingInput.current = true; setInputSending(true);
      void inputQueue.enqueue(structured, workspacePath).then(() => {
        clearSubmitted(); setCompletionNotice("对话输入已保存排队 · Ctrl+T → 排队输入可取回编辑；未发送给后台任务。");
      }).catch((error) => setCompletionNotice(`排队失败，草稿保留：${String(error)}`)).finally(() => { sendingInput.current = false; setInputSending(false); });
      return;
    }
    if (state.busy || turnRunning.current) return;
    transcriptViewportRef.current?.scroll("bottom");
    completionController.current?.abort();
    setInputCompletions(undefined);
    setCompletionNotice(undefined);
    const externalCommands = resolveExternalCommands(options.externalCommands);
    const parsedCommand = parseSlashCommand(prompt);
    if (!queuedId && parsedCommand.kind === "command" && ["longtask", "tasks"].includes(parsedCommand.command.name) && !parsedCommand.command.argument.trim()) {
      setWorkbench(true); setWorkbenchTab("tasks"); setWorkbenchSelection(0); setWorkbenchDetail(false); clearSubmitted(); return;
    }
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
    if (!queuedId && !preserveDraft) {
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
        if (result.inputReference) {
          const base = editorSnapshot.current.value === bufferRef.current.value ? editorSnapshot.current : createPromptEditorState(bufferRef.current.value);
          const value = applyPromptEditorAction({ ...base, cursorOffset: bufferRef.current.cursor }, { type: "paste-text", text: `${base.value ? "\n" : ""}${result.inputReference.text}`, threshold: 0 });
          const input: PromptInputSubmit = { display: value.value, expanded: expandPromptReferences(value.value, value.pastedContents).expanded, mode: "prompt", pastedContents: value.pastedContents };
          setRestoredDraft({ input, nonce: crypto.randomUUID() });
          const next = { ...createInputBuffer(value.value, history), cursor: value.cursorOffset }; bufferRef.current = next; setBuffer(next);
        }
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
          usageSessionEpoch.current += 1;
          setQueuePanel(false); setEntryExpansion({}); setSelectedTranscriptEntryId(undefined);
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
    turnRunning.current = true;
    compactionNotices.reset();
    setCancelling(false);
    setTurnStartedAt(Date.now());
    setPhase("Requesting model");
    preparingTool.current = undefined;
    dispatch({ type: "submit", text: structured.display, input: structuredClone(structured) });
    const controller = new AbortController();
    abortController.current = controller;
    const releaseForeground = () => {
      if (abortController.current === controller) {
        abortController.current = undefined;
        turnRunning.current = false;
      }
    };
    const invocation = ++invocationSequence.current;
    const invocationSession = sessionId.current;
    const invocationEpoch = usageSessionEpoch.current;
    let reportedUsage: UsageTotals = { ...EMPTY_USAGE };
    void options.runTurn({
      input: structured,
      sessionId: sessionId.current,
      resume: hasRun.current,
      signal: controller.signal,
      onUsage(usage, sessionUsage) {
        const delta: UsageTotals = {
          inputTokens: Math.max(0, usage.inputTokens - reportedUsage.inputTokens),
          outputTokens: Math.max(0, usage.outputTokens - reportedUsage.outputTokens),
          cacheReadInputTokens: Math.max(0, usage.cacheReadInputTokens - reportedUsage.cacheReadInputTokens),
          cacheCreationInputTokens: Math.max(0, usage.cacheCreationInputTokens - reportedUsage.cacheCreationInputTokens),
          costUsd: Math.max(0, usage.costUsd - reportedUsage.costUsd),
        };
        reportedUsage = { inputTokens: reportedUsage.inputTokens + delta.inputTokens, outputTokens: reportedUsage.outputTokens + delta.outputTokens,
          cacheReadInputTokens: reportedUsage.cacheReadInputTokens + delta.cacheReadInputTokens, cacheCreationInputTokens: reportedUsage.cacheCreationInputTokens + delta.cacheCreationInputTokens, costUsd: reportedUsage.costUsd + delta.costUsd };
        if (sessionId.current === invocationSession && (sessionUsage || usageSessionEpoch.current === invocationEpoch)) dispatch({
          type: "ledger-usage", usage: reportedUsage, delta, sessionUsage,
          currentInvocation: invocationSequence.current === invocation && usageSessionEpoch.current === invocationEpoch,
        });
      },
      onModelEvent(event) {
        if (event.type === "retry") setPhase(event.phase === "waiting"
          ? `${event.reason === "rate-limit" ? "Rate limited" : event.reason === "connection" ? "Connection failed" : "Provider unavailable"}${event.status ? ` (${event.status})` : ""} · retry ${event.retry}/${event.maxRetries} in ${Math.ceil(event.delayMs / 1000)}s`
          : `Retrying model · ${event.retry}/${event.maxRetries}`);
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
          awayRecap.toolFinished(event.isError);
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
      onActivity(phase) { dispatch({ type: "activity", phase }); },
      onCompaction(preTokens, postTokens, info) { const message = compactionNotices.message(preTokens, postTokens, info); if (message) dispatch({ type: "notice", message }); },
    }).then(async () => {
      hasRun.current = true;
      if (queuedId && !controller.signal.aborted) await inputQueue.remove(queuedId);
      releaseForeground();
      idleNotifications.add({ id: `finished:${invocation}`, kind: "finished" });
      dispatch(controller.signal.aborted ? { type: "turn-error", message: "Interrupted" } : { type: "turn-complete" });
    }).catch((error: unknown) => {
      releaseForeground();
      idleNotifications.add({ id: `finished:${invocation}`, kind: "finished" });
      dispatch({
        type: "turn-error",
        message: controller.signal.aborted
          ? "Interrupted"
          : error instanceof Error
            ? error.message
            : String(error),
      });
    });
  }, [exit, history, options, permissionController.request, questionController, state.busy, inputQueue, queuedInputs, workspacePath, inputTarget, restoredDraft]);

  useEffect(() => {
    const first = queuedInputs[0];
    if (!first || first.state !== "pending" || first.workspace !== workspacePath || state.busy || turnRunning.current || queueClaiming.current || sendingInput.current
      || workbench || queuePanel || shellPanel || historySearch || transcriptSearch || permission || question || management || inputTarget || !inputQueue.ready) return;
    queueClaiming.current = true;
    void inputQueue.claim(first.id, workspacePath).then((item) => {
      if (!questionUiMounted.current || sessionId.current !== item.sessionId || (options.workspace?.() ?? process.cwd()) !== item.workspace) return;
      submit(item.input, item.id);
    }).catch((error) => dispatch({ type: "notice", message: `排队输入没有派发：${String(error)}` })).finally(() => { queueClaiming.current = false; });
  }, [queuedInputs, workspacePath, state.busy, inputSending, workbench, queuePanel, shellPanel, historySearch, transcriptSearch, permission, question, management, inputTarget, inputQueue, submit]);

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
    if (!token?.at || permission || question || management || workbench || queuePanel || historySearch || transcriptSearch || shellPanel || dismissedCompletion.current === `${buffer.cursor}:${buffer.value}`) return;
    const timer = setTimeout(() => requestCompletions(true), 120);
    return () => { clearTimeout(timer); completionController.current?.abort(); };
  }, [buffer.value, buffer.cursor, permission, question, management, workbench, queuePanel, historySearch, transcriptSearch, shellPanel, requestCompletions]);

  useEffect(() => options.scheduleManager?.subscribe((prompt, source) => {
    setScheduledPrompts((current) => [...current, `[Scheduled wakeup ${source}]\n${prompt}`]);
  }), [options.scheduleManager]);

  useEffect(() => {
    if ((!shellPanel && !workbench) || !options.shellManager) return;
    const refresh = () => setShellRuntimes(options.shellManager!.runtimeSnapshots());
    refresh();
    const timer = setInterval(refresh, 500);
    timer.unref?.();
    return () => clearInterval(timer);
  }, [options.shellManager, shellPanel, workbench]);

  useEffect(() => { setCommandSuggestionIndex(0); }, [buffer.value]);

  useEffect(() => {
    if (state.busy || turnRunning.current || permission || question || management || workbench || queuePanel || shellPanel || historySearch || transcriptSearch || queuedInputs.length || scheduledPrompts.length === 0) return;
    const [prompt, ...remaining] = scheduledPrompts;
    setScheduledPrompts(remaining);
    if (prompt) submit(prompt, undefined, true);
  }, [management, permission, question, workbench, queuePanel, shellPanel, historySearch, transcriptSearch, queuedInputs.length, scheduledPrompts, state.busy, submit]);

  const controlRun = (action: "pause" | "resume" | "cancel") => {
    const items = workbenchItems(workbenchTabRef.current, { runs: durableRuns, questions: durableQuestions, queue: queuedInputs, tasks, shells: shellRuntimes, foreground });
    const run = items[Math.min(workbenchSelectionRef.current, Math.max(0, items.length - 1))]?.run;
    if (!run || !options.durableQuestions?.control || workbenchBusyRef.current) return;
    if (action === "resume" && run.reason === "unknown-effects") { setWorkbenchError("先核对未知操作的影响；Enter 查看操作详情，L 准备状态查询命令。"); return; }
    const old = controlRetry.current;
    const request = old?.runId === run.runId && old.action === action ? old : { runId: run.runId, action, revision: run.revision, commandId: `ui-control:${crypto.randomUUID()}` };
    controlRetry.current = request; setWorkbenchBusy(true); setWorkbenchError(undefined);
    void options.durableQuestions.control(run.runId, action, request.revision, request.commandId).then(() => {
      controlRetry.current = undefined; dispatch({ type: "notice", message: `已记录 ${action} 请求：${run.title}；排空状态以任务面板为准。` });
    }).catch((error) => {
      if (error instanceof RuntimeRequestError && error.status >= 400 && error.status < 500) {
        controlRetry.current = undefined; setWorkbenchError(`请求被拒绝，请核对最新任务状态后重试：${error.message}`);
      } else setWorkbenchError(`请求未确认，原身份保留；再次按同一操作可重试：${String(error)}`);
    }).finally(() => setWorkbenchBusy(false));
  };

  useInput((input, key, event) => {
    idleNotifications.interaction();
    const promptMode = vimMode ? (vimInsert ? "INSERT" : "NORMAL") : undefined;
    const promptColumns = promptContentColumns(terminalSize.columns, promptMode);
    if (permission) {
      if (key.pageDown || key.pageUp) setPermissionOffset((offset) => Math.max(0, offset + (key.pageDown ? 6 : -6)));
      else if (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow) {
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
        questionSelectionRef.current = (questionSelectionRef.current + count - 1) % count;
        setQuestionSelection(questionSelectionRef.current);
      } else if (key.downArrow || key.rightArrow) {
        questionSelectionRef.current = (questionSelectionRef.current + 1) % count;
        setQuestionSelection(questionSelectionRef.current);
      } else if (key.escape || (key.ctrl && input === "c")) {
        questionController.reject(new Error("User declined to answer questions"));
      } else if (question.multiSelect && input === " ") {
        const selectedIndex = questionSelectionRef.current;
        if (selectedIndex === question.options.length) {
          setQuestionOther(createInputBuffer());
        } else {
          setQuestionSelected((current) => {
            const next = new Set(current);
            if (next.has(selectedIndex)) next.delete(selectedIndex);
            else next.add(selectedIndex);
            return next;
          });
        }
      } else if (key.return) {
        const selectedIndex = questionSelectionRef.current;
        if (selectedIndex === question.options.length) {
          setQuestionOther(createInputBuffer());
        } else if (question.multiSelect) {
          const indexes = questionSelected.size ? [...questionSelected] : [selectedIndex];
          questionController.resolve(indexes.sort().map((index) => question.options[index]!.label).join(", "));
        } else {
          questionController.resolve(question.options[selectedIndex]!.label);
        }
      }
      return;
    }
    if (workbenchRef.current) {
      const workItems = workbenchItems(workbenchTabRef.current, { runs: durableRuns, questions: durableQuestions, queue: queuedInputs, tasks, shells: shellRuntimes, foreground });
      const workbenchSelection = workbenchSelectionRef.current, confirmation = confirmationRef.current;
      const selected = workItems[Math.min(workbenchSelection, Math.max(0, workItems.length - 1))];
      const close = () => { panelRequest.current++; setWorkbench(false); setConfirmation(undefined); };
      if (workbenchBusyRef.current) { if (key.escape) close(); return; }
      if (confirmation) {
        if (key.escape || input.toLowerCase() === "n") setConfirmation(undefined);
        else if (input.toLowerCase() === "y") {
          setConfirmation(undefined);
          if (selected?.id !== confirmation.id) { setWorkbenchError("任务选择已变化，没有提交操作。"); return; }
          if (confirmation.kind === "cancel") controlRun("cancel");
          else if (confirmation.kind === "shell" && selected.shell) { options.shellManager?.kill(selected.shell.kind === "pty" ? selected.shell.pid : selected.shell.taskId); setShellRuntimes(options.shellManager?.runtimeSnapshots() ?? []); }
          else if (confirmation.kind === "delete" && selected.queued) void inputQueue.remove(selected.queued.id).catch((error) => setWorkbenchError(String(error)));
        }
        return;
      }
      if (key.escape || matchesKeybinding(keybindings, "toggleTasks", input, key)) {
        if (workbenchDetail) { setWorkbenchDetail(false); setWorkbenchOffset(0); } else close(); return;
      }
      if (key.tab) { setWorkbenchTab((tab) => tab === "tasks" ? "decisions" : tab === "decisions" ? "queue" : "tasks"); setWorkbenchSelection(0); setWorkbenchDetail(false); setWorkbenchError(undefined); return; }
      if (key.pageDown || key.pageUp || (workbenchDetail && (key.upArrow || key.downArrow))) {
        setWorkbenchOffset((offset) => Math.max(0, offset + (key.pageDown ? 10 : key.pageUp ? -10 : key.downArrow ? 1 : -1))); return;
      }
      if (key.upArrow || key.downArrow) { setWorkbenchSelection((value) => workItems.length ? (value + (key.downArrow ? 1 : -1) + workItems.length) % workItems.length : 0); setWorkbenchResult(undefined); return; }
      if (!selected) return;
      if (selected.shell && input.toLowerCase() === "i") {
        setShellSelection(Math.max(0, shellRuntimes.indexOf(selected.shell))); setShellInput(undefined); close(); setShellPanel(true); return;
      }
      if (key.return) {
        if (selected.decision) { setRequestedDecision(questionNoticeKey(selected.decision)); close(); return; }
        setWorkbenchDetail(true); setWorkbenchOffset(0); setWorkbenchError(undefined);
        if (selected.run && options.durableQuestions?.inspect) {
          const request = ++panelRequest.current; setWorkbenchBusy(true);
          void options.durableQuestions.inspect(selected.run.runId).then((result) => { if (request === panelRequest.current) setWorkbenchResult(result); })
            .catch((error) => { if (request === panelRequest.current) setWorkbenchError(String(error)); }).finally(() => setWorkbenchBusy(false));
        }
        return;
      }
      if (selected.queued && input.toLowerCase() === "e") {
        if (bufferRef.current.value) { setWorkbenchError("当前编辑器已有草稿，请先发送或清空；排队内容没有删除。"); return; }
        sendingInput.current = true; setWorkbenchBusy(true);
        void inputQueue.edit(selected.queued.id, workspacePath).then((item) => {
          if ((options.workspace?.() ?? process.cwd()) !== item.workspace || sessionId.current !== item.sessionId) return;
          const draft = createInputBuffer(item.input.display, history); bufferRef.current = draft; setBuffer(draft); setRestoredDraft({ input: item.input, nonce: crypto.randomUUID(), queueId: item.id }); close();
        }).catch((error) => setWorkbenchError(String(error))).finally(() => { sendingInput.current = false; setWorkbenchBusy(false); }); return;
      }
      if (selected.queued && input.toLowerCase() === "d") { setConfirmation({ kind: "delete", id: selected.id }); return; }
      if (selected.shell && input.toLowerCase() === "k") { setConfirmation({ kind: "shell", id: selected.id }); return; }
      if (selected.run) {
        if (input.toLowerCase() === "p") controlRun("pause");
        else if (input.toLowerCase() === "r") controlRun("resume");
        else if (input.toLowerCase() === "x") setConfirmation({ kind: "cancel", id: selected.id });
        else if (input.toLowerCase() === "f") {
          if (!["active", "paused", "pausing"].includes(selected.run.status)) { setWorkbenchError("终态任务不能追加要求，请显式创建后续任务。"); return; }
          setInputTarget({ runId: selected.run.runId, workspace: selected.run.workspace, title: selected.run.title }); close();
        } else if (input.toLowerCase() === "l") {
          if (bufferRef.current.value) { setWorkbenchError("当前已有草稿，先保存草稿再准备控制命令。"); return; }
          const command = selected.run.reason === "unknown-effects" ? `/task status ${selected.run.runId}`
            : `/task limits ${selected.run.runId} --revision ${selected.run.revision} `;
          const draft = createInputBuffer(command, history); bufferRef.current = draft; setBuffer(draft); close();
          setCompletionNotice("控制命令已放入编辑器；填入明确决定后提交，不会自动提高预算或核对结果。");
        }
      }
      return;
    }
    if (queuePanel) {
      if (sendingInput.current) return;
      const selected = queuedInputs[queueSelection];
      const confirmation = confirmationRef.current;
      if (confirmation) {
        if (key.escape || input.toLowerCase() === "n") setConfirmation(undefined);
        else if (input.toLowerCase() === "y") {
          setConfirmation(undefined);
          if (confirmation.kind !== "delete" || confirmation.id !== selected?.id) { setCompletionNotice("排队项已变化，没有删除。"); return; }
          sendingInput.current = true; setInputSending(true);
          void inputQueue.remove(selected.id).then(() => setQueueSelection(index => Math.max(0, index - 1)))
            .catch(error => setCompletionNotice(String(error))).finally(() => { sendingInput.current = false; setInputSending(false); });
        }
        return;
      }
      if (key.escape || key.ctrl && input === "c" || matchesKeybinding(keybindings, "promptQueue", input, key)) setQueuePanel(false);
      else if (key.upArrow) setQueueSelection(index => Math.max(0, index - 1));
      else if (key.downArrow) setQueueSelection(index => Math.min(Math.max(0, queuedPrompts.length - 1), index + 1));
      else if ((key.backspace || key.delete || input.toLowerCase() === "d") && selected) {
        setConfirmation({ kind: "delete", id: selected.id });
      } else if ((key.return || input.toLowerCase() === "e") && selected) {
        if (bufferRef.current.value) { setCompletionNotice("Keep or clear the current draft before editing a queued prompt."); return; }
        sendingInput.current = true; setInputSending(true);
        void inputQueue.edit(selected.id, workspacePath).then((item) => {
          if ((options.workspace?.() ?? process.cwd()) !== item.workspace || sessionId.current !== item.sessionId) return;
          const next = createInputBuffer(item.input.display, history); bufferRef.current = next; setBuffer(next);
          setRestoredDraft({ input: item.input, nonce: crypto.randomUUID(), queueId: item.id }); setQueueSelection(0); setQueuePanel(false);
        }).catch(error => setCompletionNotice(String(error))).finally(() => { sendingInput.current = false; setInputSending(false); });
      }
      return;
    }
    if (management && visibleManagement) {
      if (management.kind === "diff" || management.kind === "compactions") {
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
          if (selected.draftText !== undefined) {
            if (bufferRef.current.value) { setCompletionNotice("草稿已有内容，请先保存或清空。"); return; }
            const next = createInputBuffer(selected.draftText, history); bufferRef.current = next; setBuffer(next);
            setCompletionNotice("历史文本已放入草稿；不含媒体附件，检查后再发送。");
          } else if (selected.draftReference) {
            const value = [bufferRef.current.value, selected.draftReference].filter(Boolean).join(" ");
            const next = { ...bufferRef.current, value, cursor: value.length };
            bufferRef.current = next; setBuffer(next);
            setCompletionNotice("引用已加入草稿；编辑后再发送。");
          } else submit(selected.command);
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
        const items = workbenchItems("tasks", { runs: durableRuns, questions: durableQuestions, queue: queuedInputs, tasks, shells: shellRuntimes, foreground });
        const index = items.findIndex((item) => item.shell === selected);
        setShellPanel(false); setWorkbench(true); setWorkbenchTab("tasks"); setWorkbenchSelection(Math.max(0, index)); setWorkbenchDetail(false);
        if (items[index]) setConfirmation({ kind: "shell", id: items[index]!.id });
      }
      return;
    }
    if (matchesKeybinding(keybindings, "toggleTasks", input, key)) {
      setShellRuntimes(options.shellManager?.runtimeSnapshots() ?? []);
      setShellSelection(0);
      setWorkbench(true); setWorkbenchTab("tasks"); setWorkbenchSelection(0); setWorkbenchDetail(false); setWorkbenchError(undefined);
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
    if (inputSending) return;
    if (key.escape && inputTarget) { event.stopImmediatePropagation(); setInputTarget(undefined); setCompletionNotice("已返回普通对话，草稿保留。"); return; }
    if (key.escape && state.busy) { event.stopImmediatePropagation(); setCancelling(true); abortController.current?.abort(); return; }
    if (matchesKeybinding(keybindings, "redraw", input, key) && !matchesKeybinding(keybindings, "externalEditor", input, key) && !matchesKeybinding(keybindings, "pasteImage", input, key)) {
      inkInstances.get(stdout)?.forceRedraw(); return;
    }
    if (matchesKeybinding(keybindings, "promptQueue", input, key)) {
      setConfirmation(undefined); setCompletionNotice(undefined); setQueueSelection(0); setQueuePanel(true); return;
    }
    if (matchesKeybinding(keybindings, "previousMessage", input, key) || matchesKeybinding(keybindings, "nextMessage", input, key)) {
      const entries = state.transcript;
      if (!entries.length) return;
      const current = entries.findIndex(entry => entry.id === selectedTranscriptEntryId);
      const previous = matchesKeybinding(keybindings, "previousMessage", input, key);
      const index = current < 0 ? entries.length - 1 : (current + (previous ? -1 : 1) + entries.length) % entries.length;
      const id = entries[index]!.id; setSelectedTranscriptEntryId(id); transcriptViewportRef.current?.reveal(id); return;
    }
    if (matchesKeybinding(keybindings, "editMessage", input, key)) {
      const selected = state.transcript.find(entry => entry.id === selectedTranscriptEntryId);
      if (selected?.kind !== "user") { setCompletionNotice("先选择一条用户消息再编辑复用。"); return; }
      if (bufferRef.current.value) { setCompletionNotice("草稿已有内容，请先保存或清空。"); return; }
      if (!selected.input && /\[(?:Pasted|Image)/i.test(selected.text)) { setCompletionNotice("这条历史消息缺少附件快照，请从输入历史恢复。"); return; }
      const next = createInputBuffer(selected.text, history); bufferRef.current = next; setBuffer(next);
      if (selected.input) setRestoredDraft({ input: structuredClone(selected.input), nonce: crypto.randomUUID() });
      setCompletionNotice("消息已放回草稿；原对话保留，发送后作为新输入。"); return;
    }
    if (matchesKeybinding(keybindings, "copyToolInput", input, key)) {
      const selected = state.transcript.find(entry => entry.id === selectedTranscriptEntryId);
      if (selected?.kind === "tool") stdout.write(`\u001B]52;c;${Buffer.from(typeof selected.input === "string" ? selected.input : JSON.stringify(selected.input) ?? "").toString("base64")}\u0007`);
      return;
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
        try { options.onCompletionAccepted?.(inputCompletions.original, value, inputCompletions.cursor); } catch { /* Ranking cannot block input. */ }
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
    editorSnapshot.current = structuredClone(editor);
    const next: InputBuffer = { ...bufferRef.current, value: editor.value, cursor: editor.cursorOffset };
    bufferRef.current = next;
    setBuffer(next);
    setVimInsert(editor.vimMode === "INSERT");
  };

  return (
    <>
      <PromptInputController
        keybindings={keybindings}
        active={!inputSending && !workbench && !permission && !question && !management && !queuePanel && !historySearch && !transcriptSearch && !shellPanel}
        maxVisibleLines={Math.max(1, Math.min(6, Math.floor(terminalSize.rows / 3)))}
        columns={promptContentColumns(terminalSize.columns, vimMode ? (vimInsert ? "INSERT" : "NORMAL") : undefined)}
        value={buffer.value}
        cursorOffset={buffer.cursor}
        history={promptHistory}
        vimEnabled={vimMode}
        completionActive={Boolean(inputCompletions?.values.length) || suggestSlashCommands(buffer.value, resolveExternalCommands(options.externalCommands)).length > 0}
        {...(options.pasteImage ? { pasteImage: options.pasteImage } : {})}
        {...(options.editInput ? { editInput: async (value: string) => {
          editorActive.current = true;
          try { return await options.editInput!(value); }
          finally { editorActive.current = false; if (questionUiMounted.current) setDurablePromptEpoch(epoch => epoch + 1); }
        } } : {})}
        onChange={updatePromptEditor}
        onSubmit={submit}
        {...(restoredDraft ? { restoredInput: restoredDraft } : {})}
        onNotice={(message) => setCompletionNotice(message)}
        {...(promptMouse ? { mousePosition: promptMouse } : {})}
      />
    <TuiView
      invocationBudgetUsd={options.invocationBudgetUsd}
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
      queueStates={queuedInputs.map(item => item.state)}
      queueConfirming={queuePanel && confirmation?.kind === "delete"}
      entryExpansion={entryExpansion}
      onToggleEntry={(id) => { setSelectedTranscriptEntryId(id); setEntryExpansion(current => ({ ...current, [id]: !(current[id] ?? verboseTranscript) })); }}
      activityLabel={cancelling ? "Cancelling…" : permission ? "Waiting for permission" : question ? "Waiting for your answer" : state.activity === "compacting" ? "整理上下文… 输入仍可排队" : state.tools.some(tool => tool.status === "running") ? phase : phase.startsWith("Running ") ? "Requesting model" : phase}
      turnStartedAt={turnStartedAt}
      sessionFilter={sessionFilter}
      sessionFilterEditing={sessionFilterEditing}
      managementDetailOnly={managementDetailOnly}
      {...(completionNotice ? { completionNotice } : {})}
      tasks={tasks}
      {...(workbench ? { workbench: { tab: workbenchTab, items: workItems, selection: workbenchSelection, offset: workbenchOffset, busy: workbenchBusy,
        ...(workbenchDetail ? { detail: [...(workItems[workbenchSelection]?.lines ?? []), ...(workbenchResult && workItems[workbenchSelection]?.run?.runId === workbenchResult.run.runId ? ["", ...runDetailLines(workbenchResult)] : [])] } : {}),
        ...(workbenchError ? { error: workbenchError } : {}), ...(confirmation ? { confirming: confirmation.kind === "delete" ? "删除这条排队输入？" : confirmation.kind === "shell" ? "终止这个 Shell/PTY？" : "取消选定长任务并停止后续派发？" } : {}) } } : {})}
      permissionOffset={permissionOffset}
      queuedInputCount={queuedInputs.length}
      {...(inputTarget ? { inputTarget: `补充到「${inputTarget.title}」· ${inputTarget.runId.slice(0, 8)} · Esc 返回对话` } : {})}
      inputSending={inputSending}
      workspaceLabel={`${workspacePath}${branch ? ` (${branch})` : ""}`}
      {...(durableRuns.some((run) => !["succeeded", "failed", "cancelled"].includes(run.status)) ? { backgroundSummary: (() => {
        const run = durableRuns.find((row) => !["succeeded", "failed", "cancelled"].includes(row.status))!;
        return `后台 ${run.runId.slice(0, 8)} · ${run.mode} · ${run.phase} · ${run.budget.requests}/${run.budget.limit ?? "—"} 请求 · Ctrl+T 查看`;
      })() } : {})}
      durableQuestionCount={durableQuestions.length}
      {...(["offline", "stopped", "incompatible", "unauthorized"].includes(runtimeConnection.state) ? { runtimeConnectionMessage: runtimeConnection.message } : {})}
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
const ONLINE_CONNECTION: ConnectionStatus = { state: "online", message: "" };
const onlineConnection = () => ONLINE_CONNECTION;

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
