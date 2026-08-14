# Tasks and background agents

tnb keeps task state under the active session directory:

```text
~/.tnb/tasks/<session-id>/task-state.json
```

Writes use a temporary file followed by an atomic rename. Switching or closing
an interactive session stops its running Agent tasks and records the terminal
state before loading the next session.

## Persistent work items

The model can manage dependency-aware work items with:

- `task_create`: creates a pending work item and returns its numeric ID.
- `task_get`: reads one work item or runtime task.
- `task_update`: edits fields, status, owner, metadata, or dependencies.
- `task_list`: lists work items and runtime tasks.

Work-item statuses are `pending`, `in_progress`, and `completed`. Passing
`deleted` to `task_update` removes the item and its dependency references.
`addBlocks` and `addBlockedBy` update both sides of the relationship. Metadata
updates merge keys; a `null` value removes one key.

## Background agents

The `agent` tool accepts `run_in_background: true` in interactive and
SDK-managed task runtimes. It returns an `agent-xxxxxxxx` task ID immediately.
The Agent continues with its selected profile, model, tools, permissions, and
turn limit while the parent conversation remains responsive.

Pass `resume` with a prior runtime task ID (`agent-xxxxxxxx`) or durable agent
ID to continue that subagent explicitly. tnb restores the same isolated JSONL
transcript and agent identity, then asks the agent to re-check current workspace
state before continuing. A currently running target is rejected to prevent two
writers from sharing one transcript.

- `task_output` returns current status, final output, or error without waiting.
- `task_stop` aborts a running background Agent.
- `task_get` and `task_list` also expose background Agent state.

The Ink TUI subscribes to the task manager and updates task status without
waiting for another model turn. Background Agents are intentionally rejected in
one-shot print mode because that process closes its Provider, MCP, and shell
resources when the foreground response completes. SDK callers can enable them
by creating, initializing, and passing a shared `TaskManager`.

## Agent Teams

Pass `team_name`, `name`, and `run_in_background: true` to the `agent` tool to
create or join the current session's Agent Team. Team state and mailboxes are
stored separately from ordinary task state:

```text
~/.tnb/teams/<session-id>.json
```

The first team launch creates the team and its reserved `main` lead member.
Additional teammate names are made unique within that team. Each teammate keeps
the same isolated transcript, profile, model, Hook, permission, and background
Task behavior as an ordinary subagent.

Team control tools are:

- `send_message`: sends a durable message to `main`, a teammate name, an agent
  id, or `*` for broadcast. Structured types cover task assignment,
  completion, idle notification, shutdown request/approval/rejection, and
  teammate termination. Pending messages are inserted before the recipient's
  next model turn and checked again before it stops.
- `complete_task`: completes a persistent work item through `TaskManager`, so
  the ordinary `TaskCompleted` Hook remains authoritative. A teammate launched
  with `task_id` must call this tool before it can finish normally.

Use `/team` in the Ink TUI to inspect member, assigned-task, runtime-task, and
status information. A process restart changes previously running teammates to
`recovering`; on the next managed Agent turn, tnb automatically restarts
the persisted background runtime under the original task and agent ids,
restores its valid JSONL transcript, and reattaches the same profile/name/task
member instead of creating a duplicate. Recovery is matched by the member's
persisted runtime-task id before falling back to its agent id. The supervisor
keeps an unreferenced recovery scan active while the interactive runtime is
open and retries transient launch failures with bounded exponential backoff;
closing the runtime cancels that scan so it cannot keep the process alive.
The supervisor also owns a renewable lease beside the team state file. A second
tnb process may inspect the team but cannot recover or wake teammates while the
first process holds the lease; orderly shutdown releases it, and an expired
lease permits takeover after a crashed process. This provides single-owner
recovery without a separate daemon.
A trailing interrupted JSONL record is
ignored; a final tool call without its result is removed before replay so the
Provider receives valid history. An orderly
session switch marks stopped tasks non-recoverable. Team task rows also show
their owner.

Goal continuation and dependency-graph orchestration are documented separately
in [goals-workflows.md](goals-workflows.md). They reuse this Agent runtime but
keep goal state separate from task/work-item state.
