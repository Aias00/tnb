# Custom agents

tnb discovers Markdown agent definitions from these directories, in
increasing precedence order:

1. `~/.tnb/agents/`
2. `<workspace>/.claude/agents/`
3. `<workspace>/.tnb/agents/`

Project definitions therefore override user definitions with the same
case-insensitive name. The `.claude` directory is supported for configuration
compatibility; new tnb-specific definitions should use `.tnb`.

Each `.md` file contains YAML-style frontmatter followed by the agent's system
instructions:

```markdown
---
name: code-reviewer
description: Reviews changes for correctness, regressions, and security issues.
tools: [read, grep, glob, bash]
disallowedTools: [write, edit]
model: inherit
permissionMode: plan
maxTurns: 12
---

Review the requested change. Inspect concrete evidence, rank findings by
severity, and cite files and lines. Do not modify the workspace.
```

`name` and `description` are required. The Markdown body must be non-empty.
Supported optional fields are:

- `tools`: allowed tool names; omit it or use `[*]` for all available tools.
- `disallowedTools` or `disallowed-tools`: tools removed after the allow list.
- `model`: exact model id, or `inherit` for the active model.
- `permissionMode` or `permission-mode`: `default`, `acceptEdits`, `auto`,
  `bypassPermissions`, `dontAsk`, or `plan`.
- `maxTurns` or `max-turns`: positive subagent turn limit.

Tool names are case-insensitive and may use permission-style suffixes such as
`Bash(git status:*)`; the suffix is ignored when selecting the available tool.
Unavailable allowed tools produce an explicit execution error. A custom
permission mode cannot bypass the global YOLO disable or trusted-folder gate,
and a parent running in plan mode always keeps its subagents in plan mode.

For coordinated background work, the `agent` tool also accepts `team_name`, a
stable teammate `name`, and an optional persistent `task_id`. Team launches
require `run_in_background: true`. Teammates receive `send_message` and
`complete_task` as control-plane tools in addition to the profile's selected
work tools; these two tools do not grant filesystem, command, or network access.
The `resume` field continues a previous subagent by runtime task ID or durable
agent ID and restores its isolated transcript.

Run `/agents` to inspect all active definitions and parse failures. Run
`/agents <name>` for one definition's resolved settings. The main model invokes
the selected profile through the `agent` tool's `subagent_type` field.

Background task cancellation reports `stopping` while the old invocation drains;
a restart is rejected until that invocation settles. Each run has an independent
attempt ID, so an old completion cannot settle its successor. Interrupted tool
intents remain in child transcripts. Resume reuses journaled results or stops
with an unknown-effect error when the prior action cannot be established.

The managed task runtime shares permission-mode authority across foreground
turns. An inherited mode follows the parent's current mode; a parent entering
plan or dontAsk constrains a child even when its profile declares another
mode. Permission changes during an approval are checked again before execution.

An activation keeps its own Hook model handlers and originating budget after
the foreground turn returns. `SubagentStop` and `TaskCompleted` are charged to
that budget even if another foreground turn has installed new Hook handlers.
The budget lease is released after completion callbacks and task persistence.

Shutdown and session switching wait for attempts still inside a creation Hook
or their first persistence write. Those attempts already belong to the task
runtime, even though their Agent callback has not started. Cancellation is
checked after startup I/O, so closing the runtime cannot dispatch a late Agent
or move an old-session task into the new session. Creation/completion Hooks
also receive the attempt's cancellation signal.

Session switching and shutdown are serialized. Closing a runtime permanently
rejects new activations, work-item mutations and session switches. Work-item
creation/completion that awaited a Hook before the session changed is rejected
before its final write. A failed session load restores the preceding storage.

Transcript and journal appends preserve a torn final record in a private
`.torn-<uuid>` sidecar before restoring the newline boundary. This lets a saved
tool result repair an interrupted transcript without merging it into broken
JSON. Journal lifecycle or result-ID corruption blocks recovery and further
execution; an interrupted effect still requires reconciliation.

Automatic recovery also requires the exact history scope written by the Agent
loop. Unscoped legacy records are preserved but do not authorize replaying an
old result for a current call. Reused Provider IDs across completed rounds
remain supported; duplicate IDs within an unfinished round are rejected before
any recovery result is written.
