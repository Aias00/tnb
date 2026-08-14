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
