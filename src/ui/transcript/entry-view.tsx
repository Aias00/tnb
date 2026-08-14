import React from "react";
import figures from "figures";
import { Box, Text } from "../ink/index";
import { Markdown } from "../markdown";
import type { TranscriptEntry } from "./model";

type ToolEntry = Extract<TranscriptEntry, { kind: "tool" }>;

export function TranscriptEntryView({
  entry,
  verbose = false,
  selected = false,
}: {
  entry: TranscriptEntry;
  verbose?: boolean;
  selected?: boolean;
}) {
  if (entry.kind === "tool") return <ToolEntryView entry={entry} verbose={verbose} selected={selected} />;
  if (entry.kind === "user") {
    return (
      <Box marginBottom={1}>
        <Text bold color="cyan" inverse={selected}>{figures.pointer} </Text>
        <Text>{entry.text}</Text>
      </Box>
    );
  }
  if (entry.kind === "assistant") {
    return (
      <Box marginBottom={1} paddingLeft={1} flexDirection="row">
        <Text color="cyan" inverse={selected}>{selected ? `${figures.pointer} ` : "  "}</Text>
        <Box flexDirection="column" flexGrow={1}><Markdown streaming={entry.streaming}>{entry.text}</Markdown></Box>
      </Box>
    );
  }
  return <Text inverse={selected} color={entry.tone === "error" ? "red" : "yellow"}>{selected ? `${figures.pointer} ` : ""}{entry.text}</Text>;
}

function ToolEntryView({
  entry,
  verbose,
  selected,
}: {
  entry: Extract<TranscriptEntry, { kind: "tool" }>;
  verbose: boolean;
  selected: boolean;
}) {
  const icon = entry.status === "running" ? figures.ellipsis : entry.status === "completed" ? figures.tick : figures.cross;
  const color = entry.status === "running" ? "yellow" : entry.status === "completed" ? "green" : "red";
  const detail = renderToolUse(entry.name, entry.input, verbose);
  return (
    <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
      <Text color={color} inverse={selected}>
        {icon} {toolTitle(entry.name)}{detail ? <Text dimColor>({detail})</Text> : null}
      </Text>
      <ToolResponse entry={entry} verbose={verbose} />
    </Box>
  );
}

function ToolResponse({
  entry,
  verbose,
}: {
  entry: Extract<TranscriptEntry, { kind: "tool" }>;
  verbose: boolean;
}) {
  const body = renderToolResponse(entry, verbose);
  if (!body) return null;
  return (
    <Box flexDirection="row">
      <Text dimColor>{"  "}⎿  </Text>
      <Box flexDirection="column" flexShrink={1}>{body}</Box>
    </Box>
  );
}

function renderToolResponse(
  entry: Extract<TranscriptEntry, { kind: "tool" }>,
  verbose: boolean,
): React.ReactNode {
  if (entry.name === "bash") return renderBashResponse(entry, verbose);
  if (entry.name === "write") return renderWriteResponse(entry, verbose);
  if (entry.name === "edit") return renderEditResponse(entry, verbose);
  if (entry.name === "read") return renderReadResponse(entry);
  if (entry.name === "grep" || entry.name === "glob") return renderSearchResponse(entry, verbose);
  if (entry.name === "agent") return renderAgentResponse(entry, verbose);
  if (entry.name === "skill") return renderSkillResponse(entry, verbose);
  if (entry.name.startsWith("mcp__")) return renderMcpResponse(entry, verbose);
  if (entry.name === "mcp_auth" || entry.name === "mcp_logout") return renderMcpAuthResponse(entry, verbose);
  if (entry.name === "web_fetch" || entry.name === "web_search") return renderWebResponse(entry, verbose);
  if (entry.name === "notebook_edit") return renderNotebookResponse(entry, verbose);
  if (entry.name === "image_search" || entry.name === "image_generate") return renderImageResponse(entry, verbose);
  if (entry.name.startsWith("lsp_")) return renderLspResponse(entry, verbose);
  if (entry.name === "send_message" || entry.name === "complete_task") return renderTeamResponse(entry, verbose);
  if (entry.name.startsWith("task_")) {
    return renderTaskResponse(entry, verbose);
  }
  if (entry.name === "ask_user_question" || entry.name === "enter_plan_mode" || entry.name === "exit_plan_mode") {
    return renderInteractionResponse(entry, verbose);
  }
  if (isOperationalTool(entry.name)) return renderOperationalResponse(entry, verbose);
  if (entry.status === "running") return <Text dimColor>{runningLabel(entry)}</Text>;
  if (!entry.output) return <Text dimColor>Done</Text>;
  return <OutputText content={entry.output} verbose={verbose} error={entry.status === "failed"} />;
}

function renderAgentResponse(entry: ToolEntry, verbose: boolean): React.ReactNode {
  if (entry.status === "running") return <Text dimColor>{entry.progress?.message ?? "Initializing…"}</Text>;
  if (entry.status === "failed") return <OutputText content={entry.output ?? "Agent failed"} verbose={verbose} error />;
  const output = cleanOutput(entry.output ?? "");
  const background = /(?:background agent|teammate).*(?:started|task id)/i.test(output);
  if (background) {
    const input = record(entry.input);
    return (
      <Box flexDirection="column">
        <Text>Agent task · {stringField(input, "subagentType", "subagent_type") ?? "general-purpose"} · {cleanOutput(entry.output ?? "")}</Text>
        <Text dimColor>{output}</Text>
      </Box>
    );
  }
  return summaryWithExpandableOutput("Done", entry, verbose);
}

function renderSkillResponse(entry: ToolEntry, verbose: boolean): React.ReactNode {
  if (entry.status === "running") return <Text dimColor>{entry.progress?.message ?? "Initializing…"}</Text>;
  if (entry.status === "failed") return <OutputText content={entry.output ?? "Skill failed"} verbose={verbose} error />;
  const input = record(entry.input);
  return (
    <Box flexDirection="column">
      <Text>Skill profile · {stringField(input, "name", "skill") ?? "unknown"}{entry.output ? ` · ${cleanOutput(entry.output)}` : ""}</Text>
      {entry.output ? <Text dimColor>{cleanOutput(entry.output)}</Text> : <Text dimColor>Done</Text>}
    </Box>
  );
}

function renderMcpResponse(entry: ToolEntry, verbose: boolean): React.ReactNode {
  const server = entry.name.split("__")[1] ?? "MCP";
  if (entry.status === "running") {
    const progress = entry.progress?.progress;
    const total = entry.progress?.progressTotal;
    if (progress !== undefined && total !== undefined && total > 0) {
      const ratio = Math.min(1, Math.max(0, progress / total));
      const filled = Math.round(ratio * 16);
      return (
        <Box flexDirection="column">
          <Text>MCP server · {server} · {entry.progress?.message ?? "Running"}</Text>
          {entry.progress?.message ? <Text dimColor>{entry.progress.message}</Text> : null}
          <Text dimColor>[{"█".repeat(filled)}{"░".repeat(16 - filled)}] {Math.round(ratio * 100)}%</Text>
        </Box>
      );
    }
    return <Box flexDirection="column"><Text>MCP server · {server}</Text><Text dimColor>{entry.progress?.message ?? (progress === undefined ? runningLabel(entry) : `Processing… ${progress}`)}</Text></Box>;
  }
  if (!entry.output) return <Text dimColor>(No content)</Text>;
  const estimatedTokens = Math.ceil(entry.output.length / 4);
  return (
    <Box flexDirection="column">
      <Text>MCP server · {server}</Text>
      {estimatedTokens > 10_000 ? <Text color="yellow">{figures.warning} Large MCP response (~{estimatedTokens.toLocaleString()} tokens)</Text> : null}
      <OutputText content={entry.output} verbose={verbose} error={entry.status === "failed"} />
    </Box>
  );
}

function renderWebResponse(entry: ToolEntry, verbose: boolean): React.ReactNode {
  if (entry.status === "running") return <Text dimColor>{entry.name === "web_fetch" ? "Fetching…" : "Searching…"}</Text>;
  if (entry.status === "failed") return <OutputText content={entry.output ?? "Web request failed"} verbose={verbose} error />;
  const input = record(entry.input);
  const query = stringField(input, "query", "url") ?? "";
  const output = cleanOutput(entry.output ?? "");
  const summary = entry.name === "web_fetch"
    ? `Received ${formatBytes(Buffer.byteLength(output))}`
    : `Found ${countNumberedResults(output)} ${countNumberedResults(output) === 1 ? "result" : "results"}`;
  return (
    <Box flexDirection="column">
      <Text>Web query · {truncateText(query, 72)} · {summary}</Text>
      <Text>{summary}{!verbose && entry.output ? " (ctrl+o to expand)" : ""}</Text>
      {verbose && entry.output ? <Text dimColor>{output}</Text> : null}
    </Box>
  );
}

function renderNotebookResponse(entry: ToolEntry, verbose: boolean): React.ReactNode {
  if (entry.status === "running") return <Text dimColor>{runningLabel(entry)}</Text>;
  if (entry.status === "failed") return <OutputText content={entry.output ?? "Notebook edit failed"} verbose={verbose} error />;
  const input = record(entry.input);
  const result = cleanOutput(entry.output ?? "Notebook updated");
  const source = stringField(input, "new_source", "newSource") ?? "";
  const path = stringField(input, "notebook_path", "notebookPath") ?? "";
  const cell = stringField(input, "cell_id", "cellId") ?? "unknown-cell";
  return (
    <Box flexDirection="column">
      <Text>Notebook cell · {displayPath(path)} · {cell} · {result}</Text>
      <Text>{result}</Text>
      {verbose && source ? <Text dimColor>{source}</Text> : null}
    </Box>
  );
}

function renderImageResponse(entry: ToolEntry, verbose: boolean): React.ReactNode {
  if (entry.status === "running") return <Text dimColor>{entry.name === "image_search" ? "Searching images…" : "Generating image…"}</Text>;
  if (entry.status === "failed") return <OutputText content={entry.output ?? "Image operation failed"} verbose={verbose} error />;
  const input = record(entry.input);
  const output = cleanOutput(entry.output ?? "");
  if (entry.name === "image_search") {
    const count = countNumberedResults(output);
    return (
      <Box flexDirection="column">
        <Text>Image output · search · {count} {count === 1 ? "image" : "images"}</Text>
        <Text>Found {count} {count === 1 ? "image" : "images"}{!verbose && entry.output ? " (ctrl+o to expand)" : ""}</Text>
        {verbose && entry.output ? <Text dimColor>{output}</Text> : null}
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text>Image output · {displayPath(stringField(input, "outputPath", "output_path") ?? "generated image")} · {output || "Image generated"}</Text>
      <OutputText content={output || "Image generated"} verbose error={false} />
    </Box>
  );
}

function renderTaskResponse(entry: ToolEntry, verbose: boolean): React.ReactNode {
  if (entry.status === "running") return <Text dimColor>{runningLabel(entry)}</Text>;
  if (entry.status === "failed") return <OutputText content={entry.output ?? "Operation failed"} verbose={verbose} error />;
  const output = cleanOutput(entry.output ?? "Done");
  const input = record(entry.input);
  if (entry.name === "task_list") {
    const count = output === "No tasks found" ? 0 : output.split("\n").filter((line) => /^#/.test(line)).length;
    return summaryWithExpandableOutput(`${count} ${count === 1 ? "task" : "tasks"}`, entry, verbose);
  }
  return (
    <Box flexDirection="column">
      <Text>Task update · {stringField(input, "subject", "taskId", "task_id") ?? entry.name}</Text>
      <OutputText content={output} verbose={verbose} />
    </Box>
  );
}

function renderTeamResponse(entry: ToolEntry, verbose: boolean): React.ReactNode {
  if (entry.status === "running") return <Text dimColor>{runningLabel(entry)}</Text>;
  if (entry.status === "failed") return <OutputText content={entry.output ?? "Team operation failed"} verbose={verbose} error />;
  const input = record(entry.input);
  const label = entry.name === "send_message"
    ? stringField(input, "recipient") ?? "team"
    : stringField(input, "taskId", "task_id") ?? "assigned task";
  const output = cleanOutput(entry.output ?? "Done");
  return (
    <Box flexDirection="column">
      <Text>Team message · {label}{output ? ` · ${output}` : ""}</Text>
      <OutputText content={output} verbose={verbose} />
    </Box>
  );
}

function renderInteractionResponse(entry: ToolEntry, verbose: boolean): React.ReactNode {
  if (entry.status === "running") return <Text dimColor>{runningLabel(entry)}</Text>;
  if (entry.status === "failed") return <OutputText content={entry.output ?? "Interaction failed"} verbose={verbose} error />;
  if (entry.name === "enter_plan_mode") return <Text dimColor>Plan mode enabled</Text>;
  if (entry.name === "exit_plan_mode") return <Text dimColor>Plan submitted</Text>;
  return <OutputText content={entry.output ?? "Answered"} verbose={verbose} />;
}

function renderOperationalResponse(entry: ToolEntry, verbose: boolean): React.ReactNode {
  if (entry.name === "workflow") return renderWorkflowResponse(entry, verbose);
  if (entry.name.startsWith("lsp_")) return renderLspResponse(entry, verbose);
  if (entry.status === "running") return <Text dimColor>{runningLabel(entry)}</Text>;
  if (entry.status === "failed") return <OutputText content={entry.output ?? "Operation failed"} verbose={verbose} error />;
  return <OutputText content={entry.output ?? "Done"} verbose={verbose} />;
}

function renderWorkflowResponse(entry: ToolEntry, verbose: boolean): React.ReactNode {
  if (entry.status === "running") return <Text dimColor>{runningLabel(entry)}</Text>;
  if (entry.status === "failed") return <OutputText content={entry.output ?? "Workflow failed"} verbose={verbose} error />;
  const input = record(entry.input);
  const steps = Array.isArray(input.steps) ? input.steps.length : 0;
  return (
    <Box flexDirection="column">
      <Text>Workflow run · {stringField(input, "description", "action") ?? "workflow"} · {steps} {steps === 1 ? "step" : "steps"}</Text>
      <Text dimColor>{steps} {steps === 1 ? "step" : "steps"} · concurrency {String(input.max_concurrency ?? input.maxConcurrency ?? "?")}</Text>
      {entry.output ? <Text dimColor>{cleanOutput(entry.output)}</Text> : null}
    </Box>
  );
}

function renderLspResponse(entry: ToolEntry, verbose: boolean): React.ReactNode {
  if (entry.status === "running") return <Text dimColor>{runningLabel(entry)}</Text>;
  if (entry.status === "failed") return <OutputText content={entry.output ?? "Diagnostics failed"} verbose={verbose} error />;
  const diagnostics = parseLspDiagnostics(entry.output);
  const errors = diagnostics.filter((item) => item.severity === "error").length;
  const warnings = diagnostics.filter((item) => item.severity === "warning").length;
  return (
    <Box flexDirection="column">
      <Text>Diagnostics · {entry.name.replace(/^lsp_/, "")} · {errors} error{errors === 1 ? "" : "s"} · {warnings} warning{warnings === 1 ? "" : "s"}</Text>
      <Text>{errors} error{errors === 1 ? "" : "s"} · {warnings} warning{warnings === 1 ? "" : "s"}</Text>
      {verbose && diagnostics.length ? <Text dimColor>{diagnostics.map((item) => `${item.severity}: ${item.message}`).join("\n")}</Text> : null}
    </Box>
  );
}

function parseLspDiagnostics(value: string | undefined): Array<{ severity: string; message: string }> {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const recordItem = item as Record<string, unknown>;
      const severity = typeof recordItem.severity === "string"
        ? recordItem.severity
        : "info";
      const message = typeof recordItem.message === "string"
        ? recordItem.message
        : JSON.stringify(item);
      return [{ severity, message }];
    });
  } catch {
    return [];
  }
}

function summaryWithExpandableOutput(summary: string, entry: ToolEntry, verbose: boolean): React.ReactNode {
  const duration = formatDuration(undefined, entry.durationMs);
  return (
    <Box flexDirection="column">
      <Text>{summary}{duration ? ` ${duration}` : ""}{!verbose && entry.output ? " (ctrl+o to expand)" : ""}</Text>
      {verbose && entry.output ? <Text dimColor>{cleanOutput(entry.output)}</Text> : null}
    </Box>
  );
}

function renderBashResponse(
  entry: Extract<TranscriptEntry, { kind: "tool" }>,
  verbose: boolean,
): React.ReactNode {
  if (entry.status === "running") {
    const progress = entry.progress;
    const output = cleanOutput(progress?.output ?? "");
    if (!output) return <Text dimColor>{runningLabel(entry)}</Text>;
    const lines = output.split("\n").filter(Boolean);
    const visible = verbose ? cleanOutput(progress?.fullOutput ?? output) : lines.slice(-5).join("\n");
    const hidden = Math.max(0, (progress?.totalLines ?? lines.length) - 5);
    return (
      <Box flexDirection="column">
        <Text dimColor>{visible}</Text>
        <Text dimColor>{[
          !verbose && hidden > 0 ? `+${hidden} lines` : undefined,
          formatDuration(progress?.elapsedTimeSeconds, entry.durationMs),
          progress?.totalBytes ? formatBytes(progress.totalBytes) : undefined,
        ].filter(Boolean).join(" ")}</Text>
      </Box>
    );
  }
  if (!entry.output) return <Text dimColor>Done</Text>;
  return <OutputText content={entry.output} verbose={verbose} error={entry.status === "failed"} />;
}

function renderWriteResponse(
  entry: Extract<TranscriptEntry, { kind: "tool" }>,
  verbose: boolean,
): React.ReactNode {
  if (entry.status === "running") return <Text dimColor>{runningLabel(entry)}</Text>;
  if (entry.status === "failed") return <OutputText content={entry.output ?? "Write failed"} verbose={verbose} error />;
  const input = record(entry.input);
  const content = stringField(input, "content") ?? "";
  const lines = visibleLineCount(content);
  const shown = verbose ? content : content.split("\n").slice(0, 10).join("\n");
  const hidden = Math.max(0, lines - 10);
  return (
    <Box flexDirection="column">
      <Text>Wrote <Text bold>{lines}</Text> {lines === 1 ? "line" : "lines"}</Text>
      {shown ? <Text dimColor>{shown}</Text> : <Text dimColor>(No content)</Text>}
      {!verbose && hidden > 0 ? <Text dimColor>… +{hidden} lines (ctrl+o to expand)</Text> : null}
    </Box>
  );
}

function renderEditResponse(
  entry: Extract<TranscriptEntry, { kind: "tool" }>,
  verbose: boolean,
): React.ReactNode {
  if (entry.status === "running") return <Text dimColor>{runningLabel(entry)}</Text>;
  if (entry.status === "failed") return <OutputText content={entry.output ?? "Edit failed"} verbose={verbose} error />;
  const input = record(entry.input);
  const oldText = stringField(input, "oldText", "old_string") ?? "";
  const newText = stringField(input, "newText", "new_string") ?? "";
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const maxLines = verbose ? Number.POSITIVE_INFINITY : 8;
  const maxPairCount = Math.max(oldLines.length, newLines.length);
  const rows = Array.from({ length: Math.min(maxPairCount, maxLines) }, (_, index) => ({
    before: oldLines[index],
    after: newLines[index],
  }));
  const hidden = Math.max(0, maxPairCount - rows.length);
  return (
    <Box flexDirection="column">
      <Text>Patch preview · {oldLines.length} old · {newLines.length} new</Text>
      {rows.map(({ before, after }, index) => (
        <Box key={`edit-${index}`} flexDirection="column">
          {before !== undefined ? <Text color="red">- {before}</Text> : null}
          {after !== undefined ? <Text color="green">+ {after}</Text> : null}
        </Box>
      ))}
      {!verbose && hidden > 0 ? <Text dimColor>… +{hidden} lines (ctrl+o to expand)</Text> : null}
    </Box>
  );
}

function renderReadResponse(entry: Extract<TranscriptEntry, { kind: "tool" }>): React.ReactNode {
  if (entry.status === "running") return <Text dimColor>{runningLabel(entry)}</Text>;
  if (entry.status === "failed") return <Text color="red">{entry.output ?? "Read failed"}</Text>;
  const output = entry.output ?? "";
  const lines = visibleLineCount(output);
  return <Text>Read <Text bold>{lines}</Text> {lines === 1 ? "line" : "lines"}</Text>;
}

function renderSearchResponse(
  entry: Extract<TranscriptEntry, { kind: "tool" }>,
  verbose: boolean,
): React.ReactNode {
  if (entry.status === "running") return <Text dimColor>{runningLabel(entry)}</Text>;
  if (entry.status === "failed") return <OutputText content={entry.output ?? "Search failed"} verbose={verbose} error />;
  const output = cleanOutput(entry.output ?? "");
  const empty = output === "No matches found" || output === "No files found" || !output;
  const lines = empty ? [] : output.split("\n").filter(Boolean);
  const label = entry.name === "glob" ? "files" : "matches";
  return (
    <Box flexDirection="column">
      <Text>Found <Text bold>{lines.length}</Text> {lines.length === 1 ? label.slice(0, -1) : label}{!verbose && lines.length ? " (ctrl+o to expand)" : ""}</Text>
      {verbose && lines.length ? <Text dimColor>{lines.join("\n")}</Text> : null}
    </Box>
  );
}

function renderToolUse(name: string, input: unknown, verbose: boolean): string {
  const value = record(input);
  if (name === "bash") return truncateCommand(stringField(value, "command") ?? "", verbose);
  if (name === "read" || name === "write" || name === "edit") {
    const path = stringField(value, "path", "file_path") ?? "";
    return verbose ? path : displayPath(path);
  }
  if (name === "grep" || name === "glob") {
    const pattern = stringField(value, "pattern") ?? "";
    const path = stringField(value, "path");
    return [`pattern: \"${pattern}\"`, path ? `path: \"${verbose ? path : displayPath(path)}\"` : undefined]
      .filter(Boolean).join(", ");
  }
  if (name === "agent") {
    const description = stringField(value, "description") ?? stringField(value, "prompt") ?? "";
    const profile = stringField(value, "subagentType", "subagent_type");
    return [description, verbose && profile ? `agent: ${profile}` : undefined].filter(Boolean).join(", ");
  }
  if (name === "skill") {
    const skill = stringField(value, "name", "skill") ?? "";
    const args = stringField(value, "arguments");
    return [skill, verbose && args ? `arguments: ${args}` : undefined].filter(Boolean).join(", ");
  }
  if (name.startsWith("mcp__")) return renderFlatInput(value, verbose);
  if (name === "web_fetch") return stringField(value, "url") ?? "";
  if (name === "web_search" || name === "image_search") {
    const query = stringField(value, "query") ?? "";
    const allowed = stringArrayField(value, "allowedDomains", "allowed_domains");
    const blocked = stringArrayField(value, "blockedDomains", "blocked_domains");
    return [
      `"${query}"`,
      verbose && allowed.length ? `allowed: ${allowed.join(", ")}` : undefined,
      verbose && blocked.length ? `blocked: ${blocked.join(", ")}` : undefined,
    ].filter(Boolean).join(", ");
  }
  if (name === "image_generate") {
    const path = stringField(value, "outputPath", "output_path");
    const prompt = stringField(value, "prompt") ?? "";
    return [path ? displayPath(path) : undefined, verbose ? prompt : truncateText(prompt, 100)].filter(Boolean).join(", ");
  }
  if (name === "notebook_edit") {
    const path = stringField(value, "notebook_path", "notebookPath") ?? "";
    const cell = stringField(value, "cell_id", "cellId");
    const mode = stringField(value, "edit_mode", "editMode") ?? "replace";
    return [verbose ? path : displayPath(path), cell ? `@${cell}` : undefined, verbose ? mode : undefined].filter(Boolean).join(" ");
  }
  if (name.startsWith("task_")) {
    return stringField(value, "subject")
      ?? optionalLabel("task", stringField(value, "taskId", "task_id"))
      ?? "";
  }
  if (name === "send_message") return optionalLabel("to", stringField(value, "recipient")) ?? "";
  if (name === "complete_task") return optionalLabel("task", stringField(value, "taskId", "task_id")) ?? "assigned task";
  if (name === "ask_user_question") {
    const questions = Array.isArray(value.questions) ? value.questions.length : 0;
    return `${questions} ${questions === 1 ? "question" : "questions"}`;
  }
  if (name === "exit_plan_mode") return truncateText(stringField(value, "plan") ?? "", verbose ? 240 : 80);
  if (isOperationalTool(name)) return renderOperationalUse(name, value, verbose);
  return compactJson(input);
}

function renderMcpAuthResponse(entry: ToolEntry, verbose: boolean): React.ReactNode {
  if (entry.status === "running") return <Text dimColor>{entry.name === "mcp_auth" ? "Authorizing…" : "Removing credentials…"}</Text>;
  if (entry.status === "failed") return <OutputText content={entry.output ?? "MCP auth operation failed"} verbose={verbose} error />;
  const output = cleanOutput(entry.output ?? "");
  return (
    <Box flexDirection="column">
      <Text>{entry.name === "mcp_auth" ? "MCP authorization" : "MCP logout"} · {output || "Done"}</Text>
      <OutputText content={output || "Done"} verbose={verbose} />
    </Box>
  );
}

function runningLabel(entry: Extract<TranscriptEntry, { kind: "tool" }>): string {
  const seconds = entry.progress?.elapsedTimeSeconds
    ?? (entry.startedAt ? Math.max(0, Math.floor((Date.now() - entry.startedAt) / 1_000)) : undefined);
  return `Running…${seconds === undefined ? "" : ` (${seconds}s)`}`;
}

function OutputText({ content, verbose, error = false }: { content: string; verbose: boolean; error?: boolean }) {
  const clean = cleanOutput(content);
  const lines = clean.split("\n");
  const shown = verbose || lines.length <= 4 ? lines : lines.slice(0, 3);
  const hidden = Math.max(0, lines.length - shown.length);
  return (
    <Box flexDirection="column">
      <Text {...(error ? { color: "red" as const } : {})} dimColor={!error}>{shown.join("\n") || (error ? "Failed" : "(No output)")}</Text>
      {!verbose && hidden > 0 ? <Text dimColor>… +{hidden} lines (ctrl+o to expand)</Text> : null}
    </Box>
  );
}

function truncateCommand(command: string, verbose: boolean): string {
  if (verbose) return command;
  const lines = command.split("\n");
  let value = lines.slice(0, 2).join("\n");
  if (value.length > 160) value = value.slice(0, 160);
  return lines.length > 2 || command.length > value.length ? `${value}…` : value;
}

function toolTitle(name: string): string {
  if (name.startsWith("mcp__")) {
    const [, server = "MCP", ...tool] = name.split("__");
    return `MCP server`;
  }
  const names: Record<string, string> = {
    bash: "Bash", read: "Read", write: "Write", edit: "Edit", grep: "Grep", glob: "Glob",
    agent: "Agent task", skill: "Skill profile", web_fetch: "Web query", web_search: "Web query",
    notebook_edit: "Notebook cell", image_search: "Image output", image_generate: "Image output",
    ask_user_question: "AskUserQuestion", enter_plan_mode: "EnterPlanMode", exit_plan_mode: "ExitPlanMode",
    send_message: "Team message", complete_task: "Team message",
    bash_output: "BashOutput", bash_input: "BashInput", bash_resize: "BashResize", bash_kill: "BashKill",
    codebase_investigator: "CodebaseInvestigator", security_scan: "SecurityScan", structured_output: "StructuredOutput",
    update_topic: "UpdateTopic", enter_worktree: "EnterWorktree", schedule_wakeup: "ScheduleWakeup",
    workflow: "Workflow run",
    mcp_auth: "MCP authorization",
    mcp_logout: "MCP logout",
  };
  if (name.startsWith("task_")) return "Task update";
  if (name.startsWith("lsp_")) return "Diagnostics";
  if (name.startsWith("goal_")) return `Goal${pascalSuffix(name, "goal_")}`;
  if (name.startsWith("checkpoint_")) return `Checkpoint${pascalSuffix(name, "checkpoint_")}`;
  if (name.startsWith("cron_")) return `Cron${pascalSuffix(name, "cron_")}`;
  return names[name] ?? name;
}

function renderFlatInput(value: Record<string, unknown>, verbose: boolean): string {
  return Object.entries(value).map(([key, item]) => {
    const rendered = JSON.stringify(item) ?? String(item);
    return `${key}: ${verbose ? rendered : truncateText(rendered, 80)}`;
  }).join(", ");
}

function renderOperationalUse(name: string, value: Record<string, unknown>, verbose: boolean): string {
  const primaryKeys: Record<string, string[]> = {
    bash_output: ["taskId", "task_id"], bash_input: ["taskId", "task_id"], bash_resize: ["taskId", "task_id"], bash_kill: ["taskId", "task_id"],
    goal_get: ["goalId", "goal_id"], goal_update: ["goalId", "goal_id"], goal_create: ["title", "objective"],
    checkpoint_create: ["message"], checkpoint_rollback: ["checkpointId", "checkpoint_id"],
    cron_create: ["name", "schedule"], cron_delete: ["id", "name"], monitor: ["name", "command"], schedule_wakeup: ["reason"],
    codebase_investigator: ["query"], security_scan: ["path"], update_topic: ["topic"], enter_worktree: ["name"], workflow: ["action", "name"],
  };
  for (const key of primaryKeys[name] ?? []) {
    const item = stringField(value, key);
    if (item) return truncateText(item, verbose ? 240 : 100);
  }
  return renderFlatInput(value, verbose);
}

function isOperationalTool(name: string): boolean {
  return name.startsWith("goal_") || name.startsWith("checkpoint_") || name.startsWith("cron_")
    || ["bash_output", "bash_input", "bash_resize", "bash_kill", "workflow", "monitor", "schedule_wakeup",
      "codebase_investigator", "security_scan", "structured_output", "update_topic", "enter_worktree"].includes(name);
}

function displayPath(path: string): string {
  const cwd = process.cwd().replace(/\/$/, "");
  return path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) if (typeof value[key] === "string") return value[key] as string;
  return undefined;
}

function stringArrayField(value: Record<string, unknown>, ...keys: string[]): string[] {
  for (const key of keys) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate.filter((item): item is string => typeof item === "string");
  }
  return [];
}

function optionalLabel(label: string, value: string | undefined): string | undefined {
  return value ? `${label}: ${value}` : undefined;
}

function truncateText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

function countNumberedResults(value: string): number {
  return value.match(/^\d+\.\s/gm)?.length ?? 0;
}

function pascalSuffix(value: string, prefix: string): string {
  return value.slice(prefix.length).split("_").filter(Boolean).map((part) => part[0]?.toUpperCase() + part.slice(1)).join("");
}

function compactJson(value: unknown): string {
  const text = JSON.stringify(value);
  if (!text) return "";
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

function cleanOutput(value: string): string {
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").trimEnd();
}

function visibleLineCount(value: string): number {
  if (!value) return 0;
  const parts = value.split("\n");
  return value.endsWith("\n") ? parts.length - 1 : parts.length;
}

function formatDuration(seconds?: number, durationMs?: number): string | undefined {
  const value = seconds ?? (durationMs === undefined ? undefined : Math.floor(durationMs / 1_000));
  if (value === undefined) return undefined;
  return value < 60 ? `(${value}s)` : `(${Math.floor(value / 60)}m ${value % 60}s)`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes}B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)}KB`;
  return `${(bytes / 1_048_576).toFixed(1)}MB`;
}
