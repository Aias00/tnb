# Custom commands

## Transcript navigation

- Mouse wheel scrolls terminal rows.
- `PageUp` / `PageDown` scroll one viewport.
- `Ctrl+U` / `Ctrl+D` scroll half a viewport. At the bottom, `Ctrl+D` remains forward-delete in the editor.
- `Shift+Up` / `Shift+Down` are page aliases; plain Up/Down remain input-history navigation.
- `Ctrl+Home` / `Ctrl+End` jump to the oldest/latest output.
- `Ctrl+O` toggles compact/full transcript output, including Bash output and file/search details.
- `Ctrl+F` searches the complete transcript. `Enter` or `Down` advances, `Up` goes back, and `Esc` closes search while retaining the selected entry.
- `Ctrl+Shift+C` copies the selected transcript entry with OSC 52 clipboard integration.
- `Ctrl+T` opens the background task and PTY panel. Use `I` to send PTY input and `K` to stop the selected process.
- `Tab` completes slash commands, MCP prompt arguments, `@file` references, and workspace-relative paths; `Up`/`Down` selects a completion.

Incoming model and tool output does not move a viewport that has been detached from the bottom. Returning to the bottom restores follow mode.

## Built-in interactive commands

The Ink session exposes operational commands for the existing runtime instead
of implementing a second execution path:

- `/about` reports the CLI/runtime/model/workspace identity;
- `/reload` (alias `/refresh`) reloads Skills, Agents, commands, Plugins, and
  reconnects MCP servers;
- `/doctor` (alias `/diagnostics`) runs the same local validation as the CLI
  `doctor` command;
- `/effort` changes the reasoning effort used by later model requests;
- `/fast` uses Anthropic's same-model fast inference protocol for supported
  Opus 4.6 models; it does not lower reasoning effort or switch models;
- `/btw` runs one tool-free request over a copy of the current conversation
  and displays its answer without writing either question or answer to the
  main session transcript;
- `/plan` toggles the existing permission engine's read-only Plan Mode;
- `/settings` (alias `/config`) reads and writes the normal user settings file;
- `/context-window` applies a session-local context/compaction limit no larger
  than the selected model's declared window;
- `/editor` stores the preferred external editor under `general.editor`; Ctrl+G
  opens the current prompt in that editor (falling back to `$VISUAL` and
  `$EDITOR`) and restores the terminal UI after the editor exits;
- `/docs` reports `TNB_DOCS_URL` or the local documentation directory;
- `/release-notes` reports release-channel information for the current build;
- `/add-dir` adds a canonical directory to the current session's approved
  workspace roots and publishes the updated MCP roots list;
- `/directories` (aliases `/workspace`, `/list`) lists the primary and additional roots;
- `/profile`, `/privacy`, and `/shortcuts` expose the effective local runtime,
  data boundaries, and terminal controls;
- `Ctrl+R` opens reverse prompt-history search. Repeating `Ctrl+R` selects an
  older match, Enter accepts it into the prompt, and Esc restores the original
  input;
- `~/.tnb/keybindings.json` can override `historySearch`, `transcriptSearch`,
  `externalEditor`, `toggleTranscript`, `toggleTasks`, and `pasteImage` under a
  `bindings` object. Set an action to `null` to disable it. Ctrl+C and Esc remain
  fixed safety controls;
- the status line shows the latest Provider-reported input as a percentage of
  the active context window, alongside cumulative input/output usage and cost.
  `/model`, `/fast`, and `/context-window` update the displayed budget
  immediately; `ctx —` means no usage record has arrived in this process yet;
- `/security-settings` exposes the existing YOLO kill switch and trusted-folder
  policy through the normal validated settings writer;
- `/tools` reports the currently available built-in, configured Provider,
  Plugin, and MCP tools;
- `/mcp reload` reconnects the MCP catalog, while `/skills reload` refreshes
  local Skills, Agents, commands, and Plugin contributions;
- `/workflows` browses saved workflow definitions and persisted runs;
- `/crontab` (alias `/cron`) browses and removes prompts registered through the
  existing scheduler tools;
- `/insights` aggregates local session/message/usage/cost information without
  sending analytics anywhere;
- `/upgrade` (alias `/update`) checks the configured, checksum-verified release
  manifest; installation remains the explicit `tnb update --yes` operation;
- `/feedback` (alias `/bug`) submits through `TNB_FEEDBACK_URL`;
- `/branch` aliases the existing session-fork operation;
- `/review` aliases the bundled `code-review` Skill and therefore follows the
  same isolated Skill execution, tool, model, and Hook semantics.
- `/setup-github` is a bundled Skill that inspects the current repository and
  creates or repairs standard GitHub Actions automation using repository secrets.
- `/subtask` is a bundled forked Skill that delegates a bounded task through the
  existing isolated Skill Agent runtime and returns the result to the parent.

`/new` remains an alias for `/clear`, `/quit` for `/exit`, `/manage` for
`/memory`, `/checkpoint` for `/rewind`, and `/cost` for `/usage`.

Custom commands are Markdown prompt templates loaded in this order:

1. `~/.tnb/commands/`
2. `<workspace>/.claude/commands/`
3. `<workspace>/.tnb/commands/`

Later definitions replace earlier definitions with the same name. Nested paths
become namespaced commands: `commands/review/code.md` is invoked as
`/review:code`.

Frontmatter is optional:

```markdown
---
description: Review one file
argument-hint: <path> [focus]
allowed-tools: [Read, Grep]
---
Review $1. Pay particular attention to: $ARGUMENTS
```

`$ARGUMENTS` expands to the complete argument string. `$1` through `$9` expand
to shell-style positional words; quoted words remain one argument. The expanded
Markdown is sent as the user prompt. `allowed-tools` is retained as command
metadata for compatibility and future permission presentation; it does not
silently grant or remove tools.

Use `/commands` to inspect the effective command catalog and any load failures.
