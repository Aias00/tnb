import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import figures from "figures";
import { Box, ScrollBox, Text, type DOMElement, type ScrollBoxHandle } from "./ink/index";

import type { PermissionAskRequest, PermissionMode, PermissionPromptDecision } from "../core/permissions";
import { Markdown } from "./markdown";
import type { TuiState } from "./tui-state";
import { TranscriptViewport, type TranscriptViewportController } from "./transcript/TranscriptViewport";
import { measureTranscriptHeight } from "./transcript/layout";
import type { RefObject } from "react";
import { TranscriptEntryView } from "./transcript/entry-view";
import type { UserQuestion } from "../tools/interaction";
import type { TaskRecord } from "../services/tasks/manager";
import type { ExternalSlashCommand, SLASH_COMMANDS } from "./slash-commands";
import type { ManagementView } from "./slash-commands";
import type { McpActivity } from "./mcp-activity-controller";
import type { TranscriptSearchState } from "./transcript/search";
import type { ShellRuntimeSnapshot } from "../services/shell/manager";
import type { InputHistorySearch } from "./input-buffer";
import { buildPromptLayout, promptContentColumns, type PromptLayout } from "./input/prompt-layout";
import { Ansi } from "./ink/Ansi";

export type TuiViewProps = {
  state: TuiState;
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
  tasks?: readonly TaskRecord[];
  management?: ManagementView;
  managementSelection?: number;
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
};

export const TuiView = memo(function TuiView({
  state,
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
  tasks = [],
  management,
  managementSelection = 0,
  sessionAction,
  vimMode = false,
  vimInsert = true,
  primaryColor = "magenta",
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
}: TuiViewProps) {
  const [newerRows, setNewerRows] = useState(0);
  const updateViewportStatus = useCallback((viewport: { scrollTop: number; contentHeight: number; viewportHeight: number }) => {
    setNewerRows(Math.max(0, viewport.contentHeight - viewport.viewportHeight - viewport.scrollTop));
  }, []);
  const suggestionRows = commandSuggestions.length || (!commandSuggestions.length ? inputCompletions.length : 0);
  const promptMode = vimMode ? (vimInsert ? "INSERT" : "NORMAL") : undefined;
  const contentColumns = promptContentColumns(columns, promptMode);
  const promptLayout = buildPromptLayout({
    text: input,
    offset: cursor,
    terminalColumns: columns,
    prefixColumns: columns - contentColumns,
  });
  const transcriptHeight = measureTranscriptHeight({ terminalRows: rows, promptLayout, suggestionRows });
  return (
    <Box width={columns} height={rows} overflow="hidden" flexDirection="column" paddingX={1}>
      {!management && !shellPanel ? (
        <Box flexGrow={1} flexBasis={0} overflow="hidden" flexDirection="column" marginTop={1}>
          {transcriptViewportRef
            ? <TranscriptViewport ref={transcriptViewportRef} entries={state.transcript} width={Math.max(1, columns - 2)} height={transcriptHeight} theme={primaryColor} verbose={verboseTranscript} {...(selectedTranscriptEntryId ? { selectedEntryId: selectedTranscriptEntryId } : {})} onStateChange={updateViewportStatus} />
            : <Box height={transcriptHeight} overflow="hidden" flexDirection="column">
                {state.transcript.slice(-Math.max(1, Math.floor(transcriptHeight / 3))).map((entry) => <TranscriptEntryView key={entry.id} entry={entry} verbose={verboseTranscript} selected={entry.id === selectedTranscriptEntryId} />)}
              </Box>}
          <Box flexDirection="column" flexShrink={0}>
            {state.todos.length ? <TodoList todos={state.todos} /> : null}
            {tasks.length ? <TaskList tasks={tasks} /> : null}
            {state.busy && mcpActivity
              ? <McpActivityRow activity={mcpActivity} color={primaryColor} />
              : state.busy
                ? <Text color={primaryColor}>{figures.star} Working…</Text>
                : null}
          </Box>
        </Box>
      ) : null}
      {permission ? (
        <PermissionDialog request={permission} selection={permissionSelection} />
      ) : question ? (
        <QuestionDialog
          question={question}
          selection={questionSelection}
          selected={questionSelected}
          {...(questionOtherInput !== undefined ? { otherInput: questionOtherInput } : {})}
        />
      ) : management ? (
        <ManagementDialog
          view={management}
          selection={managementSelection}
          {...(sessionAction ? { sessionAction } : {})}
          maxItems={Math.max(3, Math.min(7, rows - 16))}
          columns={columns}
          height={Math.max(6, rows - 7)}
        />
      ) : shellPanel ? (
        <ShellRuntimePanel runtimes={shellRuntimes} selection={shellSelection} {...(shellInput !== undefined ? { input: shellInput } : {})} />
      ) : (
        <>
          {transcriptSearch ? <TranscriptSearchBar search={transcriptSearch} color={primaryColor} /> : null}
          {historySearch ? <HistorySearchBar search={historySearch} color={primaryColor} /> : null}
          {commandSuggestions.length ? <CommandSuggestions commands={commandSuggestions} color={primaryColor} /> : null}
          {!commandSuggestions.length && inputCompletions.length ? <InputCompletions values={inputCompletions} selection={inputCompletionIndex} color={primaryColor} /> : null}
          {!commandSuggestions.length && !inputCompletions.length && completionNotice ? <CompletionNotice message={completionNotice} /> : null}
          {!transcriptSearch && !historySearch ? <PromptInputView
            layout={promptLayout}
            disabled={state.busy}
            color={primaryColor}
            {...(promptMode ? { mode: promptMode } : {})}
          /> : null}
        </>
      )}
      <StatusLine
        model={state.model}
        permissionMode={state.permissionMode}
        busy={state.busy}
        usage={state.usage}
        lastInputTokens={state.lastInputTokens}
        contextWindowTokens={state.contextWindowTokens}
        modal={Boolean(permission || question || management || transcriptSearch || historySearch || shellPanel)}
        transcriptOffset={newerRows}
        verboseTranscript={verboseTranscript}
      />
    </Box>
  );
});

function ShellRuntimePanel({ runtimes, selection, input }: { runtimes: readonly ShellRuntimeSnapshot[]; selection: number; input?: string }) {
  const selected = runtimes[selection];
  const output = selected?.kind === "pty" ? selected.screen : selected?.output;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">Background tasks & PTY sessions</Text>
      {runtimes.length ? runtimes.map((runtime, index) => (
        <Text key={runtime.kind === "pty" ? `pty-${runtime.pid}` : runtime.taskId} {...(index === selection ? { color: "cyan" as const } : {})} bold={index === selection}>
          {index === selection ? figures.pointer : " "} {runtime.kind === "pty" ? `PTY ${runtime.pid} · ${runtime.alive ? "running" : "exited"} · ${runtime.command}` : `${runtime.taskId} · ${runtime.status} · ${runtime.command}`}
        </Text>
      )) : <Text dimColor>No background tasks or PTY sessions.</Text>}
      {output ? <Box flexDirection="column" marginTop={1}><Text bold>Output</Text><Text dimColor>{output.split("\n").slice(-8).join("\n")}</Text></Box> : null}
      {input !== undefined ? <Text color="cyan">Input: {input}<Text inverse> </Text></Text> : null}
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
    <Text color={color}>
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
}: {
  view: ManagementView;
  selection: number;
  maxItems: number;
  columns: number;
  height: number;
  sessionAction?: { type: "rename" | "delete"; input: string };
}) {
  const selected = view.items[selection];
  const itemScrollRef = useRef<ScrollBoxHandle | null>(null);
  const previewScrollRef = useRef<ScrollBoxHandle | null>(null);
  const itemRefs = useRef(new Map<string, DOMElement>());
  useEffect(() => {
    const item = view.items[selection];
    const element = item ? itemRefs.current.get(item.id) : undefined;
    if (element) itemScrollRef.current?.scrollToElement(element, -1);
    previewScrollRef.current?.scrollTo(0);
  }, [selection, view.items]);
  const listWidth = view.kind === "sessions" && columns >= 80
    ? Math.max(28, Math.floor(columns * 0.38))
    : columns - 4;
  const showSidePreview = columns >= 80;
  const detail = selected ? <ManagementDetail view={view} item={selected} /> : <Text dimColor>No item selected.</Text>;
  return (
    <Box height={height} flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text bold color="magenta">{view.title}</Text>
      {view.description ? <Text dimColor>{view.description}</Text> : null}
      <Box flexDirection={showSidePreview ? "row" : "column"} flexGrow={1} minHeight={3} marginTop={1} gap={1}>
        <ScrollBox ref={itemScrollRef} width={listWidth} flexGrow={showSidePreview ? 0 : 1} flexDirection="column">
          {view.items.length ? view.items.map((item, index) => (
            <Box key={item.id} ref={element => {
              if (element) itemRefs.current.set(item.id, element);
              else itemRefs.current.delete(item.id);
            }} flexDirection="column" flexShrink={0}>
              <Text {...(selection === index ? { color: "cyan" as const } : {})} bold={selection === index}>
                {selection === index ? figures.pointer : " "} {item.active ? figures.tick : " "} {item.label}
              </Text>
              {selection === index && item.description ? <Text dimColor>    {item.description}</Text> : null}
            </Box>
          )) : <Text dimColor>No items available.</Text>}
        </ScrollBox>
        {showSidePreview ? (
          <ScrollBox ref={previewScrollRef} flexGrow={1} flexDirection="column">
            {detail}
          </ScrollBox>
        ) : null}
      </Box>
      {!showSidePreview ? <Box flexDirection="column" marginTop={1}>{detail}</Box> : null}
      {sessionAction?.type === "rename" ? <Text color="cyan">New title: {sessionAction.input}<Text inverse> </Text></Text> : null}
      {sessionAction?.type === "delete" ? <Text color="red">Delete this session? y/Enter confirm · n/Esc cancel</Text> : null}
      <Text dimColor>
        {view.items.length
          ? `${managementActions(view.kind, selected)}↑/↓ select · Enter ${managementEnterLabel(view.kind)} · Esc close${view.items.length > maxItems ? ` · ${selection + 1}/${view.items.length}` : ""}`
          : "Esc close"}
      </Text>
    </Box>
  );
}

function managementActions(kind: ManagementView["kind"], item?: ManagementView["items"][number]): string {
  if (kind === "sessions") return "R rename · F fork · D delete · ";
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

function TaskList({ tasks }: { tasks: readonly TaskRecord[] }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginBottom={1}>
      <Text bold>Task runtime</Text>
      {tasks.map((task) => {
        const running = task.status === "running" || task.status === "in_progress";
        const successful = task.status === "completed";
        const icon = successful ? figures.tick : running ? figures.pointer : task.status === "pending" ? figures.circle : figures.cross;
        const color = successful ? "green" : running ? "cyan" : task.status === "pending" ? "gray" : "red";
        return (
          <Text key={task.id} color={color}>
            {icon} #{task.id} [{task.status}] {running && task.activeForm ? task.activeForm : task.subject}
            {task.owner ? ` · ${task.owner}` : ""}
            {typeof task.metadata?.teamName === "string" ? ` · team ${task.metadata.teamName}` : ""}
          </Text>
        );
      })}
    </Box>
  );
}

function CommandSuggestions({
  commands,
  color,
}: {
  commands: Array<(typeof SLASH_COMMANDS)[number] | ExternalSlashCommand>;
  color: "magenta" | "cyan" | "blue" | "green";
}) {
  return (
    <Box flexDirection="column" paddingX={1}>
      {commands.map(({ name, description }, index) => (
        <Text
          key={name}
          dimColor={index !== 0}
          {...(index === 0 ? { color } : {})}
        >
          {index === 0 ? figures.pointer : " "} /{name} — {description}
        </Text>
      ))}
      <Text dimColor>Tab complete</Text>
    </Box>
  );
}

function InputCompletions({
  values,
  selection,
  color,
}: {
  values: string[];
  selection: number;
  color: "magenta" | "cyan" | "blue" | "green";
}) {
  return (
    <Box flexDirection="column" paddingX={1}>
      {values.slice(0, 8).map((value, index) => (
        <Text key={value} dimColor={index !== selection} {...(index === selection ? { color } : {})}>
          {index === selection ? figures.pointer : " "} {value}
        </Text>
      ))}
      <Text dimColor>↑/↓ select · Tab accept/cycle · Esc dismiss</Text>
    </Box>
  );
}

function CompletionNotice({ message }: { message: string }) {
  return (
    <Box paddingX={1}>
      <Text dimColor>{message}</Text>
    </Box>
  );
}

function TodoList({ todos }: { todos: TuiState["todos"] }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginBottom={1}>
      <Text bold>Tasks</Text>
      {todos.map((todo, index) => {
        const icon = todo.status === "completed" ? figures.tick : todo.status === "in_progress" ? figures.pointer : figures.circle;
        const color = todo.status === "completed" ? "green" : todo.status === "in_progress" ? "cyan" : "gray";
        return <Text key={`${index}-${todo.content}`} color={color}>{icon} {todo.status === "in_progress" ? todo.activeForm : todo.content}</Text>;
      })}
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
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">{question.header}</Text>
      <Text>{question.question}</Text>
      {otherInput !== undefined ? (
        <Box borderStyle="single" borderColor="cyan" paddingX={1} marginTop={1}>
          <Text>Other: {otherInput}<Text inverse> </Text></Text>
        </Box>
      ) : (
      <Box flexDirection="column" marginTop={1}>
        {options.map((option, index) => (
          <Text key={option.label} {...(selection === index ? { color: "cyan" as const } : {})} bold={selection === index}>
            {selection === index ? figures.pointer : " "} {question.multiSelect ? (selected.has(index) ? "[x]" : "[ ]") : `${index + 1}.`} {option.label} — {option.description}
          </Text>
        ))}
      </Box>
      )}
      <Text dimColor>{otherInput !== undefined ? "Enter confirm · Esc back" : question.multiSelect ? "↑/↓ move · Space toggle · Enter confirm · Esc cancel" : "↑/↓ select · Enter confirm · Esc cancel"}</Text>
    </Box>
  );
}

function PromptInputView({ layout, disabled, mode, color }: { layout: PromptLayout; disabled: boolean; mode?: string; color: "magenta" | "cyan" | "blue" | "green" }) {
  return (
    <Box flexShrink={0} borderStyle="round" borderColor={disabled ? "gray" : color} paddingX={1}>
      {mode ? <Text color={mode === "NORMAL" ? "yellow" : "green"}>[{mode}] </Text> : null}
      <Text color={color}>{figures.pointer} </Text>
      <Text color={color}><Ansi dimColor={disabled}>{layout.visibleText}</Ansi></Text>
    </Box>
  );
}

function PermissionDialog({ request, selection }: { request: PermissionAskRequest; selection: PermissionPromptDecision }) {
  const plan = request.tool.name === "exit_plan_mode" &&
    request.input && typeof request.input === "object" && "plan" in request.input &&
    typeof (request.input as { plan?: unknown }).plan === "string"
    ? (request.input as { plan: string }).plan
    : undefined;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">Permission required</Text>
      <Text>{request.message}</Text>
      <Text bold>{request.tool.name}</Text>
      {plan ? <Markdown>{plan}</Markdown> : <Text dimColor>{compactJson(request.input)}</Text>}
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
      <Text dimColor>←/→ select · Enter confirm · Esc deny</Text>
    </Box>
  );
}

function StatusLine({
  model,
  permissionMode,
  busy,
  usage,
  lastInputTokens,
  contextWindowTokens,
  modal,
  transcriptOffset,
  verboseTranscript,
}: {
  model: string;
  permissionMode: PermissionMode;
  busy: boolean;
  usage: TuiState["usage"];
  lastInputTokens: number;
  contextWindowTokens: number;
  modal: boolean;
  transcriptOffset: number;
  verboseTranscript: boolean;
}) {
  const inputTokens = usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
  const cost = usage.costUsd ? ` · $${usage.costUsd.toFixed(4)}` : "";
  const context = contextLabel(lastInputTokens, contextWindowTokens);
  return (
    <Box flexShrink={0} justifyContent="space-between">
      <Text dimColor>
        {modal
          ? "follow dialog controls"
          : transcriptOffset > 0
            ? `PgUp/PgDn · Shift+↑/↓ · Ctrl+End latest · ${transcriptOffset} newer`
            : busy
              ? `esc interrupt · ctrl+o ${verboseTranscript ? "compact" : "expand"} · PgUp scroll`
              : `enter send · ctrl+o ${verboseTranscript ? "compact" : "expand"} · PgUp scroll · ctrl+c ×2 exit`}
      </Text>
      <Text dimColor>{model} · {permissionMode} · {context} · ↑{inputTokens.toLocaleString()} ↓{usage.outputTokens.toLocaleString()}{cost}</Text>
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
