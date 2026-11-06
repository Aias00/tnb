import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import figures from "figures";
import stripAnsi from "strip-ansi";
import { Box, ScrollBox, Text, type DOMElement, type ScrollBoxHandle, useInput } from "./ink/index";

import type { PermissionAskRequest, PermissionMode, PermissionPromptDecision } from "../core/permissions";
import { Markdown } from "./markdown";
import type { UsageTotals } from "../services/usage/cost";
import type { TuiState } from "./tui-state";
import { TranscriptViewport, type TranscriptViewportController } from "./transcript/TranscriptViewport";
import { measureTranscriptHeight } from "./transcript/layout";
import type { RefObject } from "react";
import { TranscriptEntryView } from "./transcript/entry-view";
import type { UserQuestion } from "../tools/interaction";
import type { TaskRecord } from "../services/tasks/manager";
import { WorkbenchView } from "./workbench-view";
import { permissionDetails } from "./permission-details";
import { parseRecommendedLabel } from "./question-label";
import wrapAnsi from "wrap-ansi";
import type { ExternalSlashCommand, SLASH_COMMANDS } from "./slash-commands";
import type { ManagementView } from "./slash-commands";
import type { McpActivity } from "./mcp-activity-controller";
import type { TranscriptSearchState } from "./transcript/search";
import type { ShellRuntimeSnapshot } from "../services/shell/manager";
import type { InputHistorySearch } from "./input-buffer";
import { buildPromptLayout, promptContentColumns, type PromptLayout } from "./input/prompt-layout";
import { DEFAULT_KEYBINDINGS, type KeybindingMap } from "./keybindings";
import { KeybindingProvider, useKeybindingLabel } from "./keybinding-context";
import type { PromptInputSubmit } from "./prompt-input/types";
import { ACTIVITY_FRAMES, activityLabel as waitingLabel } from "./activity";
import { Ansi } from "./ink/Ansi";
import { AccentProvider, UI_COLORS, useAccent } from "./theme";

export type TuiViewProps = {
  invocationBudgetUsd?: number;
  state: TuiState;
  keybindings?: KeybindingMap;
  input: string;
  cursor: number;
  columns: number;
  rows?: number;
  permission?: PermissionAskRequest;
  permissionSelection?: PermissionPromptDecision;
  question?: UserQuestion;
  questionSelection?: number;
  questionSelected?: ReadonlySet<number>;
  questionOtherInput?: string;
  commandSuggestions?: Array<(typeof SLASH_COMMANDS)[number] | ExternalSlashCommand>;
  inputCompletions?: string[];
  inputCompletionIndex?: number;
  completionNotice?: string;
  commandSuggestionIndex?: number;
  queuedPromptCount?: number;
  queuedPrompts?: readonly PromptInputSubmit[];
  queuePanel?: boolean;
  queueSelection?: number;
  queueStates?: readonly ("pending" | "uncertain" | "draft")[];
  queueConfirming?: boolean;
  entryExpansion?: Readonly<Record<string, boolean>>;
  onToggleEntry?(id: string): void;
  activityLabel?: string;
  turnStartedAt?: number;
  sessionFilter?: string;
  sessionFilterEditing?: boolean;
  tasks?: readonly TaskRecord[];
  durableQuestionCount?: number;
  workbench?: Omit<React.ComponentProps<typeof WorkbenchView>, "height" | "width">;
  permissionOffset?: number;
  queuedInputCount?: number;
  inputTarget?: string;
  inputSending?: boolean;
  workspaceLabel?: string;
  backgroundSummary?: string;
  runtimeConnectionMessage?: string;
  management?: ManagementView;
  managementSelection?: number;
  managementDetailOnly?: boolean;
  sessionAction?: { type: "rename" | "delete"; input: string };
  vimMode?: boolean;
  vimInsert?: boolean;
  primaryColor?: "magenta" | "cyan" | "blue" | "green";
  mcpActivity?: McpActivity;
  transcriptViewportRef?: RefObject<TranscriptViewportController | null>;
  verboseTranscript?: boolean;
  transcriptSearch?: TranscriptSearchState;
  historySearch?: InputHistorySearch;
  selectedTranscriptEntryId?: string;
  shellRuntimes?: readonly ShellRuntimeSnapshot[];
  shellPanel?: boolean;
  shellSelection?: number;
  shellInput?: string;
  onPromptClick?(row: number, column: number, maxVisibleLines?: number): void;
};

export const TuiView = memo(function TuiView({
  invocationBudgetUsd,
  state,
  keybindings = DEFAULT_KEYBINDINGS,
  input,
  cursor,
  columns,
  rows = 24,
  permission,
  permissionSelection = "allow",
  question,
  questionSelection = 0,
  questionSelected = new Set<number>(),
  questionOtherInput,
  commandSuggestions = [],
  inputCompletions = [],
  inputCompletionIndex = 0,
  completionNotice,
  commandSuggestionIndex = 0,
  queuedPromptCount = 0,
  queuedPrompts = [],
  queuePanel = false,
  queueSelection = 0,
  queueStates = [],
  queueConfirming = false,
  entryExpansion = {},
  onToggleEntry,
  activityLabel = "Working…",
  turnStartedAt,
  sessionFilter = "",
  sessionFilterEditing = false,
  tasks = [],
  durableQuestionCount = 0,
  workbench,
  permissionOffset = 0,
  queuedInputCount = 0,
  inputTarget,
  inputSending = false,
  workspaceLabel,
  backgroundSummary,
  runtimeConnectionMessage,
  management,
  managementSelection = 0,
  managementDetailOnly = false,
  sessionAction,
  vimMode = false,
  vimInsert = true,
  primaryColor = "cyan",
  mcpActivity,
  transcriptViewportRef,
  verboseTranscript = false,
  transcriptSearch,
  historySearch,
  selectedTranscriptEntryId,
  shellRuntimes = [],
  shellPanel = false,
  shellSelection = 0,
  shellInput,
  onPromptClick,
}: TuiViewProps) {
  const [newerRows, setNewerRows] = useState(0);
  const updateViewportStatus = useCallback((viewport: { scrollTop: number; contentHeight: number; viewportHeight: number }) => {
    setNewerRows(Math.max(0, viewport.contentHeight - viewport.viewportHeight - viewport.scrollTop));
  }, []);
  const menuLimit = Math.max(1, Math.min(8, Math.floor(rows / 4)));
  const suggestionCount = commandSuggestions.length || inputCompletions.length;
  const suggestionRows = suggestionCount ? Math.min(menuLimit, suggestionCount) + 1 : completionNotice ? 1 : 0;
  const queueRows = !queuePanel && queuedPrompts.length ? (rows < 18 ? 1 : Math.min(2, queuedPrompts.length) + 1) : 0;
  const promptMode = vimMode ? (vimInsert ? "INSERT" : "NORMAL") : undefined;
  const contentColumns = promptContentColumns(columns, promptMode);
  const taskRows = (state.todos.length ? Math.min(3, state.todos.length) + 4 + Number(state.todos.length > 3) : 0)
    + (tasks.length ? Math.min(3, tasks.length) + 4 + Number(tasks.length > 3) : 0);
  const activityRows = Number(state.busy) + Number(Boolean(state.busy && mcpActivity && !permission && !question && !activityLabel.startsWith("Cancelling")));
  const infoRows = Number(Boolean(backgroundSummary)) + Number(Boolean(durableQuestionCount)) + Number(Boolean(inputTarget)) + Number(Boolean(runtimeConnectionMessage));
  const activityBudget = Math.max(0, Math.min(taskRows + activityRows + infoRows, rows - suggestionRows - queueRows - 7));
  const auxiliaryRows = 1 + activityBudget + (transcriptSearch ? 3 : 0) + (historySearch ? 3 : 0);
  const maxPromptLines = Math.max(1, Math.min(6, Math.floor(rows / 3), rows - suggestionRows - queueRows - auxiliaryRows - 5));
  const promptLayout = buildPromptLayout({
    text: input,
    offset: cursor,
    terminalColumns: columns,
    maxVisibleLines: maxPromptLines,
    prefixColumns: columns - contentColumns,
  });
  const transcriptHeight = measureTranscriptHeight({ terminalRows: rows, promptLayout, suggestionRows: suggestionRows + queueRows, auxiliaryRows });
  return (
    <KeybindingProvider value={keybindings}>
    <AccentProvider value={primaryColor}>
    <Box width={columns} height={rows} overflow="hidden" flexDirection="column" paddingX={1}>
      {!management && !shellPanel && !workbench && !queuePanel ? (
        <Box flexGrow={1} flexBasis={0} overflow="hidden" flexDirection="column" marginTop={1}>
          {transcriptViewportRef
            ? <TranscriptViewport ref={transcriptViewportRef} entries={state.transcript} width={Math.max(1, columns - 2)} height={transcriptHeight} theme={primaryColor} verbose={verboseTranscript} entryExpansion={entryExpansion} onToggleEntry={onToggleEntry} {...(selectedTranscriptEntryId ? { selectedEntryId: selectedTranscriptEntryId } : {})} onStateChange={updateViewportStatus} />
            : <Box height={transcriptHeight} overflow="hidden" flexDirection="column">
                {state.transcript.slice(-Math.max(1, Math.floor(transcriptHeight / 3))).map((entry) => <TranscriptEntryView key={entry.id} entry={entry} verbose={entryExpansion[entry.id] ?? verboseTranscript} selected={entry.id === selectedTranscriptEntryId} />)}
              </Box>}
          <Box flexDirection="column" flexShrink={0} height={activityBudget} overflow="hidden">
            {state.busy ? <>
              <WorkingStatus label={activityLabel} startedAt={turnStartedAt} color={primaryColor} />
              {mcpActivity && !permission && !question && !activityLabel.startsWith("Cancelling") ? <McpActivityRow activity={mcpActivity} color={primaryColor} /> : null}
            </> : null}
            {backgroundSummary ? <Text color={primaryColor} wrap="truncate-end">{backgroundSummary}</Text> : null}
            {durableQuestionCount ? <Text color="yellow" wrap="truncate-end">{durableQuestionCount} 个长任务问题待你决定 · Ctrl+T → 待决定</Text> : null}
            {inputTarget ? <Text color={primaryColor} wrap="truncate-end">{inputTarget}</Text> : null}
            {runtimeConnectionMessage ? <Text color="yellow" wrap="truncate-end">{runtimeConnectionMessage}</Text> : null}
            {state.todos.length ? <TodoList todos={state.todos} /> : null}
            {tasks.length ? <TaskList tasks={tasks} /> : null}
          </Box>
        </Box>
      ) : null}
      {permission ? (
        <PermissionDialog request={permission} selection={permissionSelection} offset={permissionOffset} width={columns} height={rows} />
      ) : question ? (
        <QuestionDialog
          question={question}
          selection={questionSelection}
          selected={questionSelected}
          {...(questionOtherInput !== undefined ? { otherInput: questionOtherInput } : {})}
        />
      ) : workbench ? <WorkbenchView {...workbench} width={Math.max(12, columns - 2)} height={Math.max(8, rows - 2)} /> : management ? (
        <ManagementDialog
          view={management}
          selection={managementSelection}
          {...(sessionAction ? { sessionAction } : {})}
          maxItems={Math.max(3, Math.min(7, rows - 16))}
          columns={columns}
          height={Math.max(6, rows - 2)}
          filter={sessionFilter}
          filterEditing={sessionFilterEditing}
          detailOnly={managementDetailOnly}
        />
      ) : queuePanel ? (
        <QueuePanel prompts={queuedPrompts} states={queueStates} confirming={queueConfirming} selection={queueSelection} columns={columns} rows={rows} notice={completionNotice} />
      ) : shellPanel ? (
        <ShellRuntimePanel runtimes={shellRuntimes} selection={shellSelection} {...(shellInput !== undefined ? { input: shellInput } : {})} />
      ) : (
        <>
          {queuedPrompts.length ? <Box flexDirection="column" paddingX={1}>
            {(rows < 18 ? [] : queuedPrompts.slice(0, 2)).map((prompt, index) => <Text key={index} dimColor wrap="truncate-end">{index + 1}. {prompt.display.replace(/\s+/g, " ").slice(0, Math.max(10, columns - 12))}</Text>)}
            <Text dimColor wrap="truncate-end">{queuedPrompts.length} queued · {keybindings.promptQueue ?? "disabled"} preview/edit/remove</Text>
          </Box> : null}
          {transcriptSearch ? <TranscriptSearchBar search={transcriptSearch} color={primaryColor} /> : null}
          {historySearch ? <HistorySearchBar search={historySearch} color={primaryColor} /> : null}
          {commandSuggestions.length ? <CommandSuggestions commands={commandSuggestions} maxItems={menuLimit} selection={commandSuggestionIndex} color={primaryColor} /> : null}
          {!commandSuggestions.length && inputCompletions.length ? <InputCompletions values={inputCompletions} maxItems={menuLimit} selection={inputCompletionIndex} color={primaryColor} /> : null}
          {!commandSuggestions.length && !inputCompletions.length && completionNotice ? <CompletionNotice message={completionNotice} /> : null}
          {!transcriptSearch && !historySearch ? <PromptInputView
            layout={promptLayout}
            disabled={inputSending}
            color={primaryColor}
            {...(promptMode ? { mode: promptMode } : {})}
            {...(onPromptClick ? { onClick: (row, column) => onPromptClick(row, column, maxPromptLines) } : {})}
          /> : null}
        </>
      )}
      <StatusLine
        invocationUsage={state.invocationUsage}
        invocationBudgetUsd={invocationBudgetUsd}
        model={state.model}
        permissionMode={state.permissionMode}
        busy={state.busy}
        usage={state.usage}
        lastInputTokens={state.lastInputTokens}
        contextWindowTokens={state.contextWindowTokens}
        modal={Boolean(permission || question || management || transcriptSearch || historySearch || shellPanel || queuePanel || workbench)}
        {...(workspaceLabel ? { workspaceLabel } : {})}
        transcriptOffset={newerRows}
        verboseTranscript={verboseTranscript}
        queuedPromptCount={queuedPromptCount}
      />
    </Box>
    </AccentProvider>
    </KeybindingProvider>
  );
});

function WorkingStatus({ label, startedAt, color }: { label: string; startedAt?: number; color: "cyan" | "magenta" | "blue" | "green" }) {
  const [now, setNow] = useState(Date.now());
  const phaseStartedAt = useRef(Date.now());
  useEffect(() => { phaseStartedAt.current = Date.now(); }, [label]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 120); return () => clearInterval(timer); }, []);
  const shown = waitingLabel(label, Math.max(0, (now - phaseStartedAt.current) / 1000));
  const frame = ACTIVITY_FRAMES[Math.floor(now / 120) % ACTIVITY_FRAMES.length];
  return <Text color={color} wrap="truncate-end">{frame} {shown}{startedAt ? ` · ${Math.max(0, Math.floor((now - startedAt) / 1000))}s` : ""}</Text>;
}

function QueuePanel({ prompts, states, confirming, selection, columns, rows, notice }: { prompts: readonly PromptInputSubmit[]; states: readonly string[]; confirming: boolean; selection: number; columns: number; rows: number; notice?: string }) {
  const accent = useAccent();
  const queueKey = useKeybindingLabel("promptQueue");
  const listRef = useRef<ScrollBoxHandle | null>(null);
  const previewRef = useRef<ScrollBoxHandle | null>(null);
  useInput((_input, key) => {
    if (key.pageDown) previewRef.current?.scrollBy(Math.max(1, Math.floor(rows / 3)));
    if (key.pageUp) previewRef.current?.scrollBy(-Math.max(1, Math.floor(rows / 3)));
  });
  const itemRefs = useRef(new Map<number, DOMElement>());
  useEffect(() => { const element = itemRefs.current.get(selection); if (element) listRef.current?.scrollToElement(element); previewRef.current?.scrollTo(0); }, [selection, prompts]);
  return <Box height={Math.max(6, rows - 2)} borderStyle="round" borderColor={UI_COLORS.border} paddingX={1} flexDirection="column">
    <Text bold color={accent}>Queued prompts · {prompts.length} saved</Text>
    <Text dimColor wrap="truncate-end">Execution pauses here after the current turn finishes.</Text>
    <ScrollBox ref={listRef} height={Math.max(1, Math.floor((rows - 7 - Number(Boolean(notice))) / 2))} flexDirection="column">
      {prompts.map((prompt, index) => <Box key={index} ref={element => { if (element) itemRefs.current.set(index, element); else itemRefs.current.delete(index); }}><Text wrap="truncate-end" color={selection === index ? accent : undefined}>{selection === index ? figures.pointer : " "} {index + 1}. {states[index] === "uncertain" ? "[未确认，先核对] " : states[index] === "draft" ? "[编辑中，原输入保留] " : ""}{prompt.display.replace(/\s+/g, " ").slice(0, Math.max(10, columns - 12))}</Text></Box>)}
      {!prompts.length ? <Text dimColor>No pending prompts.</Text> : null}
    </ScrollBox>
    {prompts[selection] ? <ScrollBox ref={previewRef} height={Math.max(1, Math.ceil((rows - 7 - Number(Boolean(notice))) / 2))}><Text>{prompts[selection]!.expanded}</Text></ScrollBox> : null}
    {notice ? <Text color="yellow" wrap="truncate-end">{notice}</Text> : null}
    <Text dimColor={!confirming} color={confirming ? "red" : undefined} wrap="truncate-end">{confirming ? "删除这条排队输入？ · Y 确认 / Esc 取消" : `↑/↓ select · Enter/E edit · D/Delete remove · PgUp/PgDn preview · ${queueKey}/Esc close`}</Text>
  </Box>;
}

function ShellRuntimePanel({ runtimes, selection, input }: { runtimes: readonly ShellRuntimeSnapshot[]; selection: number; input?: string }) {
  const selected = runtimes[selection];
  const output = selected?.kind === "pty" ? selected.screen : selected?.output;
  const accent = useAccent();
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={UI_COLORS.border} paddingX={1}>
      <Text bold color={accent}>Background tasks & PTY sessions</Text>
      {runtimes.length ? runtimes.map((runtime, index) => (
        <Text key={runtime.kind === "pty" ? `pty-${runtime.pid}` : runtime.taskId} {...(index === selection ? { color: accent } : {})} bold={index === selection}>
          {index === selection ? figures.pointer : " "} {runtime.kind === "pty" ? `PTY ${runtime.pid} · ${runtime.alive ? "running" : "exited"} · ${runtime.command}` : `${runtime.taskId} · ${runtime.status} · ${runtime.command}`}
        </Text>
      )) : <Text dimColor>No background tasks or PTY sessions.</Text>}
      {output ? <Box flexDirection="column" marginTop={1}><Text bold>Output</Text><Text dimColor>{output.split("\n").slice(-8).join("\n")}</Text></Box> : null}
      {input !== undefined ? <Text color={accent}>Input: {input}<Text inverse> </Text></Text> : null}
      <Text dimColor>↑/↓ select · I send PTY input · K stop · Ctrl+T/Esc close</Text>
    </Box>
  );
}

function TranscriptSearchBar({ search, color }: { search: TranscriptSearchState; color: "magenta" | "cyan" | "blue" | "green" }) {
  const position = search.matches.length ? `${search.index + 1}/${search.matches.length}` : "0/0";
  return (
    <Box borderStyle="single" borderColor={color} paddingX={1} justifyContent="space-between">
      <Text><Text color={color}>Search: </Text>{search.query}<Text inverse> </Text></Text>
      <Text dimColor>{position} · Enter/↑/↓ next · Esc close · Ctrl+Shift+C copy</Text>
    </Box>
  );
}

function HistorySearchBar({ search, color }: { search: InputHistorySearch; color: "magenta" | "cyan" | "blue" | "green" }) {
  return (
    <Box borderStyle="single" borderColor={color} paddingX={1} flexDirection="column">
      <Text><Text color={color}>Reverse search: </Text>{search.query}<Text inverse> </Text></Text>
      <Text dimColor>{search.matchIndex === undefined ? "No match" : "Ctrl+R older · Enter accept · Esc restore"}</Text>
    </Box>
  );
}

function McpActivityRow({
  activity,
  color,
}: {
  activity: McpActivity;
  color: "magenta" | "cyan" | "blue" | "green";
}) {
  if (activity.type === "cancelled") {
    return (
      <Text color="yellow">
        {figures.warning} MCP {activity.serverName} cancelled
        {activity.reason ? `: ${activity.reason}` : ""}
      </Text>
    );
  }
  const amount = activity.total === undefined
    ? `${activity.progress}`
    : `${activity.progress}/${activity.total}`;
  return (
    <Text color={color} wrap="truncate-end">
      {figures.star} MCP {activity.serverName} {amount}
      {activity.message ? ` · ${activity.message}` : ""}
    </Text>
  );
}

function ManagementDialog({
  view,
  selection,
  maxItems,
  columns,
  height,
  sessionAction,
  filter = "",
  filterEditing = false,
  detailOnly = false,
}: {
  view: ManagementView;
  selection: number;
  maxItems: number;
  columns: number;
  height: number;
  sessionAction?: { type: "rename" | "delete"; input: string };
  filter?: string;
  filterEditing?: boolean;
  detailOnly?: boolean;
}) {
  const selected = view.items[selection];
  const itemScrollRef = useRef<ScrollBoxHandle | null>(null);
  const previewScrollRef = useRef<ScrollBoxHandle | null>(null);
  const itemRefs = useRef(new Map<string, DOMElement>());
  useInput((_input, key) => {
    if (key.pageDown) previewScrollRef.current?.scrollBy(Math.max(1, height - 6));
    if (key.pageUp) previewScrollRef.current?.scrollBy(-Math.max(1, height - 6));
  });
  useEffect(() => {
    const item = view.items[selection];
    const element = item ? itemRefs.current.get(item.id) : undefined;
    if (element) itemScrollRef.current?.scrollToElement(element, -1);
    previewScrollRef.current?.scrollTo(0);
  }, [selection, view.items]);
  const listWidth = (view.kind === "sessions" || view.kind === "diff") && columns >= 80
    ? Math.max(28, Math.floor(columns * 0.38))
    : columns - 4;
  const showSidePreview = columns >= 80 && !detailOnly;
  const detail = selected ? <ManagementDetail view={view} item={selected} /> : <Text dimColor>No item selected.</Text>;
  const accent = useAccent();
  return (
    <Box height={height} flexDirection="column" borderStyle="round" borderColor={UI_COLORS.border} paddingX={1}>
      <Text bold color={accent} wrap="truncate-end">{view.title}</Text>
      {view.description ? <Text dimColor wrap="truncate-end">{view.description}</Text> : null}
      {view.kind === "sessions" ? <Text color={accent}>Search: {filter || (filterEditing ? "" : "/ to filter by title, prompt or ID")}{filterEditing ? <Text inverse> </Text> : null}</Text> : null}
      <Box flexDirection={showSidePreview ? "row" : "column"} flexGrow={1} minHeight={3} marginTop={1} gap={1}>
        {!detailOnly ? <ScrollBox ref={itemScrollRef} width={listWidth} flexGrow={showSidePreview ? 0 : 1} flexDirection="column">
          {view.items.length ? view.items.map((item, index) => (
            <Box key={item.id} ref={element => {
              if (element) itemRefs.current.set(item.id, element);
              else itemRefs.current.delete(item.id);
            }} flexDirection="column" flexShrink={0}>
              <Text wrap="truncate-end" {...(selection === index ? { color: accent } : {})} bold={selection === index}>
                {selection === index ? figures.pointer : " "} {item.active ? figures.tick : " "} {item.label}
              </Text>
              {selection === index && view.kind === "sessions" && item.sessionMetadata ? (
                <Box flexDirection="column" paddingLeft={4}>
                  <Text dimColor wrap="truncate-end">{item.sessionMetadata.messageCount} messages</Text>
                  <Text dimColor wrap="truncate-end">{new Date(item.sessionMetadata.lastModified).toLocaleString("sv-SE", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</Text>
                  <Text dimColor wrap="truncate-end">ID: {item.id}</Text>
                </Box>
              ) : selection === index && item.description ? <Box paddingLeft={4}><Text dimColor wrap="truncate-end">{item.description}</Text></Box> : null}
            </Box>
          )) : <Text dimColor>No items available.</Text>}
        </ScrollBox> : null}
        {showSidePreview || detailOnly ? (
          <ScrollBox ref={previewScrollRef} flexGrow={1} flexDirection="column">
            {detail}
          </ScrollBox>
        ) : null}
      </Box>
      {!showSidePreview && !detailOnly ? <ScrollBox ref={previewScrollRef} flexGrow={1} flexDirection="column" marginTop={1}>{detail}</ScrollBox> : null}
      {sessionAction?.type === "rename" ? <Text color={accent}>New title: {sessionAction.input}<Text inverse> </Text></Text> : null}
      {sessionAction?.type === "delete" ? <Text color="red">Delete this session? y/Enter confirm · n/Esc cancel</Text> : null}
      <Text dimColor wrap="truncate-end">
        {view.items.length
          ? `${managementActions(view.kind, selected)}↑/↓ select · Enter ${managementEnterLabel(view.kind)} · Esc close${view.items.length > maxItems ? ` · ${selection + 1}/${view.items.length}` : ""}`
          : "Esc close"}
      </Text>
    </Box>
  );
}

function managementActions(kind: ManagementView["kind"], item?: ManagementView["items"][number]): string {
  if (kind === "diff") return "R refresh · Enter full preview/back · PgUp/PgDn preview · ";
  if (kind === "sessions") return "/ search · PgUp/PgDn preview · R rename · F fork · D delete · ";
  const parts: string[] = [];
  if (kind === "mcp") {
    parts.push("R reload");
    if (item?.badges?.includes("oauth")) parts.push("A auth", "O logout");
  }
  if (kind === "plugins") parts.push("R reload", "U update", "D remove");
  if (kind === "marketplace") parts.push("R refresh");
  if (kind === "skills") parts.push("R reload");
  if (kind === "doctor") parts.push("R rerun");
  if (item?.inspectCommand) parts.push("I inspect");
  return parts.length ? `${parts.join(" · ")} · ` : "";
}

function managementEnterLabel(kind: ManagementView["kind"]): string {
  if (kind === "diff") return "expand";
  if (kind === "mcp" || kind === "plugins") return "toggle";
  if (kind === "marketplace") return "install";
  if (kind === "doctor") return "rerun";
  if (kind === "sessions") return "resume";
  return "inspect";
}

function ManagementDetail({
  view,
  item,
}: {
  view: ManagementView;
  item: ManagementView["items"][number];
}) {
  const accent = useAccent();
  if (view.kind === "diff") return <Box flexDirection="column">
    <Text bold>{item.label}</Text>
    {item.description ? <Text dimColor>{item.description}</Text> : null}
    <GitPatchPreview patch={item.diffPreview ?? "No patch available."} accent={accent} />
  </Box>;
  const previewLabel = item.transcriptPreview?.length
    ? "Conversation preview"
    : item.preview?.length
      ? "Session input history"
      : undefined;
  return (
    <Box flexDirection="column">
      {view.kind === "sessions" && previewLabel ? (
        <>
          <Text bold>{previewLabel}</Text>
          {item.transcriptPreview?.length
            ? item.transcriptPreview.map((entry) => <TranscriptEntryView key={`${item.id}-${entry.id}`} entry={entry} />)
            : item.preview?.map((input, index) => <Text key={`${item.id}-preview-${index}`} dimColor>  {figures.bullet} {input}</Text>)}
        </>
      ) : (
        <>
          <Text bold>Selected item</Text>
          <Text bold>{item.label}</Text>
          {item.description ? <Text dimColor>{item.description}</Text> : null}
          {view.kind === "doctor" ? <Text>{doctorSummary(item)}</Text> : null}
          {item.badges?.length ? <Text>{item.badges.join(" · ")}</Text> : null}
          <Text bold>Primary action</Text>
          <Text>{item.command}</Text>
          {item.inspectCommand ? (
            <>
              <Text bold>Inspect</Text>
              <Text>{item.inspectLabel ?? item.inspectCommand}</Text>
            </>
          ) : null}
          {item.details?.map((detail, index) => <Text key={`${item.id}-detail-${index}`}>{detail}</Text>)}
          {!item.details?.length && !item.inspectCommand ? <Text dimColor>No additional details available.</Text> : null}
        </>
      )}
    </Box>
  );
}

function GitPatchPreview({ patch, accent }: { patch: string; accent: "cyan" | "blue" | "green" | "magenta" }) {
  let inHunk = false;
  return <Box flexDirection="column">{stripAnsi(patch).split("\n").map((line, index) => {
    if (line.startsWith("diff --git")) inHunk = false;
    const header = line.startsWith("@@");
    if (header) inHunk = true;
    const color = header ? accent : inHunk && line.startsWith("+") ? "green" : inHunk && line.startsWith("-") ? "red" : undefined;
    return <Text key={index} color={color} dimColor={line.startsWith("diff ") || line.startsWith("index ")}>{line || " "}</Text>;
  })}</Box>;
}

function TaskList({ tasks }: { tasks: readonly TaskRecord[] }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginBottom={1} flexShrink={0}>
      <Text bold>Task runtime</Text>
      {tasks.slice(0, 3).map((task) => {
        const running = task.status === "running" || task.status === "in_progress";
        const successful = task.status === "completed";
        const icon = successful ? figures.tick : running ? figures.pointer : task.status === "pending" ? figures.circle : figures.cross;
        const color = successful ? "green" : running ? "cyan" : task.status === "pending" ? "gray" : "red";
        return (
          <Text key={task.id} color={color} wrap="truncate-end">
            {icon} #{task.id} [{task.status}] {running && task.activeForm ? task.activeForm : task.subject}
            {task.owner ? ` · ${task.owner}` : ""}
            {typeof task.metadata?.teamName === "string" ? ` · team ${task.metadata.teamName}` : ""}
          </Text>
        );
      })}
      {tasks.length > 3 ? <Text dimColor>+{tasks.length - 3} tasks · /tasks</Text> : null}
    </Box>
  );
}

function CommandSuggestions({
  commands,
  selection,
  maxItems,
  color,
}: {
  commands: Array<(typeof SLASH_COMMANDS)[number] | ExternalSlashCommand>;
  maxItems: number;
  selection: number;
  color: "magenta" | "cyan" | "blue" | "green";
}) {
  const start = Math.max(0, Math.min(selection - Math.floor(maxItems / 2), commands.length - maxItems));
  return (
    <Box flexDirection="column" paddingX={1}>
      {commands.slice(start, start + maxItems).map(({ name, description }, offset) => { const index = start + offset; return (
        <Text
          key={name}
          wrap="truncate-end"
          dimColor={index !== selection}
          {...(index === selection ? { color } : {})}
        >
          {index === selection ? figures.pointer : " "} /{name} — {description}
        </Text>
      ); })}
      <Text dimColor wrap="truncate-end">↑/↓ select · Tab/Enter complete · {selection + 1}/{commands.length}</Text>
    </Box>
  );
}

function InputCompletions({
  values,
  selection,
  maxItems,
  color,
}: {
  values: string[];
  maxItems: number;
  selection: number;
  color: "magenta" | "cyan" | "blue" | "green";
}) {
  const start = Math.max(0, Math.min(selection - Math.floor(maxItems / 2), values.length - maxItems));
  return (
    <Box flexDirection="column" paddingX={1}>
      {values.slice(start, start + maxItems).map((value, offset) => { const index = start + offset; return (
        <Text key={value} wrap="truncate-end" dimColor={index !== selection} {...(index === selection ? { color } : {})}>
          {index === selection ? figures.pointer : " "} {value}
        </Text>
      ); })}
      <Text dimColor wrap="truncate-end">↑/↓ select · Tab/Enter accept · Esc dismiss · {selection + 1}/{values.length}</Text>
    </Box>
  );
}

function CompletionNotice({ message }: { message: string }) {
  return (
    <Box paddingX={1}>
      <Text dimColor wrap="truncate-end">{message}</Text>
    </Box>
  );
}

function TodoList({ todos, total = todos.length }: { todos: TuiState["todos"]; total?: number }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginBottom={1} flexShrink={0}>
      <Text bold>Tasks</Text>
      {todos.slice(0, 3).map((todo, index) => {
        const icon = todo.status === "completed" ? figures.tick : todo.status === "in_progress" ? figures.pointer : figures.circle;
        const color = todo.status === "completed" ? "green" : todo.status === "in_progress" ? "cyan" : "gray";
        return <Text key={`${index}-${todo.content}`} color={color} wrap="truncate-end">{icon} {todo.status === "in_progress" ? todo.activeForm : todo.content}</Text>;
      })}
      {todos.length > 3 ? <Text dimColor>+{todos.length - 3} tasks</Text> : null}
    </Box>
  );
}

function QuestionDialog({
  question,
  selection,
  selected,
  otherInput,
}: {
  question: UserQuestion;
  selection: number;
  selected: ReadonlySet<number>;
  otherInput?: string;
}) {
  const options = [...question.options, { label: "Other", description: "Enter a custom answer." }];
  const accent = useAccent();
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={UI_COLORS.border} paddingX={1}>
      <Text bold color={accent}>{question.header}</Text>
      <Text>{question.question}</Text>
      {otherInput !== undefined ? (
        <Box borderStyle="single" borderColor={UI_COLORS.border} paddingX={1} marginTop={1}>
          <Text>Other: {otherInput}<Text inverse> </Text></Text>
        </Box>
      ) : (
      <Box flexDirection="column" marginTop={1}>
        {options.map((option, index) => (
          <Text key={option.label} {...(selection === index ? { color: accent } : {})} bold={selection === index}>
            {selection === index ? figures.pointer : " "} {question.multiSelect ? (selected.has(index) ? "[x]" : "[ ]") : `${index + 1}.`} {parseRecommendedLabel(option.label).label}{parseRecommendedLabel(option.label).recommended ? " ★ 推荐" : ""} — {option.description}
          </Text>
        ))}
      </Box>
      )}
      <Text dimColor>{otherInput !== undefined ? "Enter confirm · Esc back" : question.multiSelect ? "↑/↓ move · Space toggle · Enter confirm · Esc cancel" : "↑/↓ select · Enter confirm · Esc cancel"}</Text>
    </Box>
  );
}

function PromptInputView({ layout, mode, color, disabled = false, onClick }: { layout: PromptLayout; mode?: string; disabled?: boolean; color: "magenta" | "cyan" | "blue" | "green"; onClick?(row: number, column: number): void }) {
  return (
    <Box flexShrink={0} borderStyle="round" borderColor={UI_COLORS.border} paddingX={1} {...(onClick ? { onClick: (event) => {
      const modeColumns = mode ? `[${mode}] `.length : 0;
      onClick(Math.max(0, event.localRow - 1), Math.max(0, event.localCol - 4 - modeColumns));
    } } : {})}>
      {mode ? <Text color={mode === "NORMAL" ? "yellow" : "green"}>[{mode}] </Text> : null}
      <Text color={color} dimColor={disabled}>{figures.pointer} </Text>
      <Text dimColor={disabled}><Ansi>{layout.visibleText}</Ansi></Text>
    </Box>
  );
}

function PermissionDialog({ request, selection, offset, width, height }: { request: PermissionAskRequest; selection: PermissionPromptDecision; offset: number; width: number; height: number }) {
  const plan = request.tool.name === "exit_plan_mode" &&
    request.input && typeof request.input === "object" && "plan" in request.input &&
    typeof (request.input as { plan?: unknown }).plan === "string"
    ? (request.input as { plan: string }).plan
    : undefined;
  const lines = permissionDetails(request).flatMap((line) => wrapAnsi(line, Math.max(8, width - 6), { hard: true, wordWrap: false }).split("\n"));
  const page = Math.max(2, height - 10), start = Math.min(offset, Math.max(0, lines.length - page));
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">Permission required</Text>
      {lines.slice(start, start + page).map((line, index) => <Text key={index}>{line || " "}</Text>)}
      {plan ? <Text dimColor>计划内容可用 PgUp/PgDn 查看；不会因未显示的内容自动批准。</Text> : null}
      <Box marginTop={1} gap={2}>
        <Text {...(selection === "allow" ? { color: "green" as const } : {})} bold={selection === "allow"}>
          {selection === "allow" ? figures.pointer : " "} Allow once
        </Text>
        {request.suggestedRule ? (
          <Text {...(selection === "allow-session" ? { color: "green" as const } : {})} bold={selection === "allow-session"}>
            {selection === "allow-session" ? figures.pointer : " "} Allow for session
          </Text>
        ) : null}
        {request.suggestedRule ? (
          <Text {...(selection === "allow-project" ? { color: "green" as const } : {})} bold={selection === "allow-project"}>
            {selection === "allow-project" ? figures.pointer : " "} Always allow
          </Text>
        ) : null}
        <Text {...(selection === "deny" ? { color: "red" as const } : {})} bold={selection === "deny"}>
          {selection === "deny" ? figures.pointer : " "} Deny
        </Text>
      </Box>
      <Text dimColor>←/→ select · Enter confirm · Esc deny · PgUp/PgDn 全文 {start + 1}/{lines.length}</Text>
    </Box>
  );
}

function StatusLine({
  invocationUsage,
  invocationBudgetUsd,
  model,
  permissionMode,
  busy,
  usage,
  lastInputTokens,
  contextWindowTokens,
  modal,
  transcriptOffset,
  verboseTranscript,
  workspaceLabel,
  queuedPromptCount,
}: {
  invocationUsage: UsageTotals;
  invocationBudgetUsd?: number;
  model: string;
  permissionMode: PermissionMode;
  busy: boolean;
  usage: TuiState["usage"];
  lastInputTokens: number;
  contextWindowTokens: number;
  modal: boolean;
  transcriptOffset: number;
  verboseTranscript: boolean;
  workspaceLabel?: string;
  queuedPromptCount: number;
}) {
  const queueKey = useKeybindingLabel("promptQueue");
  const toggleKey = useKeybindingLabel("toggleTool");
  const allKey = useKeybindingLabel("toggleTranscript");
  const inputTokens = usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
  const cost = invocationBudgetUsd !== undefined || usage.costUsd || invocationUsage.costUsd ? ` · 本轮 $${invocationUsage.costUsd.toFixed(4)}${invocationBudgetUsd !== undefined ? `/$${invocationBudgetUsd.toFixed(2)}` : ""} · 会话 $${usage.costUsd.toFixed(4)}` : "";
  const context = contextLabel(lastInputTokens, contextWindowTokens);
  return (
    <Box flexShrink={0} height={2} flexDirection="column">
      <Text dimColor wrap="truncate-end">
        {modal
          ? "follow dialog controls"
          : transcriptOffset > 0
            ? `PgUp/PgDn · Shift+↑/↓ · Ctrl+End latest · ${transcriptOffset} newer`
            : busy
              ? `enter queue · esc interrupt · ${queuedPromptCount} queued · ${queueKey} manage`
              : `enter send · ${toggleKey} tool · ${allKey} all · ${queueKey} queue`}
      </Text>
      <Text wrap="truncate-end"><Text bold>{model}</Text><Text dimColor> · {permissionMode}{cost} · {context} · 前台 ↑{inputTokens.toLocaleString()} ↓{usage.outputTokens.toLocaleString()}{workspaceLabel ? ` · ${workspaceLabel.slice(-36)}` : ""}</Text></Text>
    </Box>
  );
}

function contextLabel(input: number, window: number): string {
  if (!input || !window) return "ctx —";
  const percentage = Math.min(100, input / window * 100);
  return `ctx ${percentage > 0 && percentage < 1 ? "<1" : percentage.toFixed(0)}%`;
}

function compactJson(value: unknown): string {
  const text = JSON.stringify(value);
  if (!text) return "";
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

function doctorSummary(item: ManagementView["items"][number]): string {
  const badge = item.badges?.find((value) => value === "ok" || value === "warning" || value === "error");
  if (!badge) return "Diagnostic check";
  return badge === "ok"
    ? "Diagnostic passed"
    : badge === "warning"
      ? "Diagnostic requires attention"
      : "Diagnostic failed";
}
