# Permissions

tnb follows the established coding-agent permission pipeline: explicit
deny rules first, then explicit ask rules, tool safety checks, permission mode,
allow rules, and finally the mode's default decision.

## Modes

- `default`: read-only tools and read-only shell invocations run; other tools require approval. The
  shell classifier handles POSIX shells and PowerShell aliases/cmdlets, rejects
  redirection, backgrounding and command substitution, blocks nested shell
  wrappers, encoded or dynamic PowerShell execution, splatting, and non-ASCII
  separator tricks, and fails closed on malformed or otherwise unclassified
  shell syntax. It treats only known read-only Git subcommands as reads. Print mode
  cannot prompt, so unresolved approval requests are denied. Interactive mode
  opens an Ink dialog showing the tool and input; arrow keys select Allow once,
  Allow for session, Always allow, or Deny, Enter confirms, and Escape denies. A session
  grant records the exact tool rule in memory and survives later turns in the
  same CLI process, but is not written to settings. Mandatory approvals such as
  `exit_plan_mode` deliberately do not offer a session grant. Always allow
  atomically adds the exact rule to `.tnb/settings.local.json`; it never
  weakens an existing deny or ask rule, which retain precedence.
- `acceptEdits`: workspace write and edit tools run without prompting; shell,
  network, and unknown tools still require approval.
- `auto`: a conservative auto-approve mode aligned with Claude Code and qodercli
  semantics. Workspace file-edit tools (`write`, `edit`, `notebook_edit`,
  `todo_write`) run without prompting, and `bash` is auto-approved only for a
  single `mkdir`, `touch`, `cp`, or `mv` command whose arguments stay inside
  the workspace and avoid shell composition, quoting, redirects, or expansion.
  Other shell, network, and unknown tools still require approval.
- `dontAsk`: unresolved approval requests are denied.
- `plan`: only read-only tools run. Allow rules cannot enable mutations.
  `exit_plan_mode` is the sole control transition and always requests approval.
- `bypassPermissions`: explicit YOLO mode. Deny and ask rules still take
precedence.

Tool-specific approval runs before YOLO and ordinary read-only allowances.
This is currently used by `exit_plan_mode`, so approving broad execution or
selecting YOLO never silently approves an implementation plan.

Use `--yolo`, `--permission-mode yolo`, or
`--permission-mode bypassPermissions`. The Claude-compatible
`--dangerously-skip-permissions` spelling is an alias for `--yolo`; it still
passes through tnb's `disableYolo` and trusted-folder policy. YOLO is never selected implicitly unless
it is configured as `permissions.defaultMode`.

`auto` can be selected through `permissions.defaultMode`,
`--permission-mode auto`, or the interactive `/permissions` picker. It remains
subject to explicit deny/ask rules and mandatory tool approvals.

## Settings

Settings are merged in this order:

1. `~/.tnb/settings.json`
2. `<workspace>/.tnb/settings.json`
3. `<workspace>/.tnb/settings.local.json`

Rule arrays are concatenated and deduplicated. Later scalar settings override
earlier values.

```json
{
  "permissions": {
    "allow": [
      "read",
      "write(src/**)",
      "bash(bun test:*)",
      "agent(explore)",
      "mcp__files__*"
    ],
    "deny": ["bash(rm:*)"],
    "ask": ["bash(bun publish:*)"],
    "defaultMode": "default"
  },
  "security": {
    "disableYolo": false,
    "trustedFolders": ["/absolute/path/to/workspace"]
  }
}
```

Rules use `tool` or `tool(content)` syntax. `tool(*)` is equivalent to a
tool-wide rule. Parentheses and backslashes inside content can be escaped with
a backslash. MCP server-wide rules use `mcp__server__*` and do not match
similarly named built-in tools.

Agent rules match the normalized profile name, for example `agent(explore)` or
`agent(general-purpose)`. Allowing the outer Agent call does not bypass checks
for tools used inside it; child writes, commands, network calls, and MCP calls
still pass through the same permission checker.

Bash rules support exact commands, the legacy `:*` prefix syntax, and `*`
wildcards. A prefix allow rule applies only to a single command; it does not
approve trailing `&&`, `||`, pipe, semicolon, or newline operations. Deny and
ask prefix rules inspect compound-command segments. Full shell-AST permission
analysis is shared with the POSIX/PowerShell shell classifier. Unknown syntax
and executables remain permission-gated.

## YOLO gates

YOLO is downgraded to `default` with an explicit stderr warning when either:

- `security.disableYolo` is `true`;
- `permissions.disableBypassPermissionsMode` is `"disable"`; or
- `security.trustedFolders` is non-empty and the current workspace is not an
  exact member.

Explicit allow rules still operate after a YOLO downgrade. Workspace path
confinement also remains active in YOLO mode.
