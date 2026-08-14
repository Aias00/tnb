# Hooks

Hooks run commands, HTTP callbacks, isolated model evaluations, or bounded
subagents at Agent lifecycle boundaries. Every handler receives the same event
object and may return additional model context or a structured decision.

Supported events are `SessionStart`, `SessionEnd`, `UserPromptSubmit`,
`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `PreCompact`, and
`PostCompact`, plus `PermissionRequest`, `Notification`, `SubagentStart`,
`SubagentStop`, `Elicitation`, `ElicitationResult`, `InstructionsLoaded`,
`PermissionDenied`, `TaskCreated`, `TaskCompleted`, `WorktreeCreate`,
`WorktreeRemove`, and `CwdChanged`. Additional compatible lifecycle names are
accepted by settings and become active as their corresponding tnb
subsystems are implemented. Configure them in `settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "jq -e '.tool_input.file_path | startswith(\"/tmp/\") | not'",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

`matcher` is a case-insensitive regular expression; omit it or use `*` to match
all calls. Tool events match the tool name, session events
match their source or reason, and compact events match `manual` or `auto`.
Permission requests match the tool name, notifications match their
`notification_type`, and subagent events match the agent profile name.
`timeout` is measured in seconds. The established
default Hook timeout is 600 seconds. Hooks for a matching event run in parallel
and their results are combined in configuration order. Set `sequential: true`
on a group to run its handlers in order and stop after a blocking result. Set
`async: true` on a group or handler for fire-and-forget notification/logging
work whose output must not affect the triggering operation.

Command handlers accept optional `args`; when present, tnb invokes the
executable directly without a shell. HTTP handlers POST the event JSON and may
interpolate `${ENV_VAR}` in headers:

```json
{"type":"http","url":"https://hooks.example.test/review","headers":{"authorization":"Bearer ${HOOK_TOKEN}"}}
```

Prompt handlers run a fresh tool-free model evaluation. Agent handlers run an
isolated bounded Agent and may select tools and a turn limit:

```json
{"type":"prompt","prompt":"Classify this event and return {\"ok\":true} or {\"ok\":false,\"reason\":\"...\"}."}
{"type":"agent","prompt":"Verify the edited file.","tools":["read","grep","bash"],"maxTurns":8}
```

`$ARGUMENTS` expands to the event JSON. A returned `{ "ok": false, "reason":
"..." }` blocks synchronous prompt/agent hooks; their isolated context never
contains the main conversation. Agent tool calls still pass through the active
permission policy.

Exit code `0` is success, exit code `2` blocks the operation using stderr as the
reason, and other nonzero exits are reported without granting permission. A
successful Hook may emit:

```json
{
  "systemMessage": "Visible context",
  "decision": "block",
  "reason": "Why it was blocked",
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "Policy reason",
    "updatedInput": {},
    "additionalContext": "Context returned to the model"
  }
}
```

`PreToolUse` may allow, deny, ask through the ordinary permission system, or
replace tool input; replaced input is validated again by the tool. A blocking
`Stop` result returns its reason to the model and continues the Agent loop.
`PermissionDenied` receives the tool name, validated input, actual tool-use ID,
and denial reason after the ordinary permission checker rejects a call.

`PermissionRequest` runs only when ordinary policy evaluation requires a user
decision. It runs before the terminal dialog and may answer directly:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow",
      "updatedInput": { "path": "approved.txt", "content": "approved" }
    }
  }
}
```

A deny decision may include `message`. An allow decision skips the interactive
prompt; updated input is validated again before execution. When no Hook decides,
the normal terminal prompt or non-interactive denial remains authoritative.
`Notification` fires with `permission_prompt`, `elicitation_dialog`,
`elicitation_response`, and `elicitation_complete` for permission and
structured-question attention events. Its input includes `message`, optional
`title`, and `notification_type`.

`SessionStart` receives `source` as `startup`, `resume`, `clear`, or `compact`
and the active `model`. Its additional context is injected into the next model
request. `SessionEnd` receives `reason`; normal terminal exit uses
`prompt_input_exit`, while `/clear` and `/resume` close the preceding session
with matching reasons. `PreCompact` receives `trigger` and nullable
`custom_instructions`; `PostCompact` receives the generated `compact_summary`.
Automatic and `/compact` compaction both run the lifecycle pair.

`SubagentStart` receives `agent_id` and `agent_type`; additional context is
appended to the isolated Agent briefing. `SubagentStop` also receives
`stop_hook_active`, `last_assistant_message`, and `agent_transcript_path`.
Blocking it returns feedback to the subagent and lets it continue. Agent and
Skill transcripts are real JSONL files stored under the parent project's
session directory rather than aliases of the main transcript.

`Elicitation` is reserved for MCP requests rather than ordinary
`ask_user_question` tool prompts. It matches `mcp_server_name` and receives
`message`, `mode`, plus `requested_schema` for form requests or `url` and
`elicitation_id` for URL requests. A Hook may answer without opening the TUI:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "Elicitation",
    "action": "accept",
    "content": { "environment": "staging" }
  }
}
```

`ElicitationResult` receives the final `action` and optional `content` before
the response is sent to the MCP server. It accepts the same Hook output shape,
allowing policy to replace the response or force `decline`/`cancel`. For URL
mode, a later MCP `notifications/elicitation/complete` notification emits a
Notification Hook with matcher `elicitation_complete` and the server-provided
elicitation ID in its message.

`TaskCreated` runs before a task is persisted and `TaskCompleted` runs before a
task enters the completed state; exit code 2 prevents that transition.
`WorktreeCreate` runs before Git worktree creation, `WorktreeRemove` runs before
destructive removal, and `CwdChanged` receives `old_cwd` and `new_cwd` after the
session switches directories. Hook commands after a directory switch execute
from the new session cwd.

`Setup` accepts matcher `init` or `maintenance` and runs before `SessionStart`
when the matching CLI flag is present. `--init-only` runs Setup and SessionStart
without initializing a Provider. `StopFailure` is emitted for terminal Provider
HTTP, network, and malformed-stream errors; its matcher is the normalized error
kind such as `authentication_failed`, `rate_limit`, or `server_error`.

`ConfigChange` watches active user, project, and local settings paths while a
session is running and also gates tnb-owned settings writes. Its matcher is
`user_settings`, `project_settings`, `local_settings`, or `skills`; the latter
is emitted when the interactive extension catalog changes. `InstructionsLoaded`
runs once for every loaded instruction file with its exact `file_path`,
`memory_type` (`Project` or `Local`), and `load_reason` (`session_start`).
`FileChanged` matcher
entries are pipe-separated exact absolute or cwd-relative filenames to watch,
for example `.env|.envrc`; events report `add`, `change`, or `unlink`. Exact-file
watching avoids recursively monitoring the whole repository.

With print-mode stream JSON, `--include-hook-events` emits `hook_started`,
`hook_progress`, and `hook_response` system records including command output and
exit outcome.

User Hooks in `~/.tnb/settings.json` are always eligible. Project Hooks in
`.tnb/settings.json` and `.tnb/settings.local.json` execute only when
the exact workspace path appears in the user settings
`security.trustedFolders`. This prevents opening an untrusted repository from
silently launching local processes.
