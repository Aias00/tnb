# Claude Tool Protocol Migration Design

## Objective

Replace tnb's Provider-facing core coding tools with the authorized Claude Code
tool names, input schemas, descriptions, progress events, result text, and
execution semantics. This is intentionally breaking: lowercase tnb tool names
and legacy parameter aliases are removed rather than normalized.

The migration covers filesystem search/editing, shell/PTY execution, delegated
Agent tasks, and persistent task management. Other tools keep their current
contracts until separate migrations.

## Authorized source root

Use one source snapshot exclusively:

`/Users/aias/Work/github/codercli/claude-code/package/src-extracted/src`

Relevant reference directories:

- `tools/FileReadTool/`
- `tools/FileWriteTool/`
- `tools/FileEditTool/`
- `tools/GrepTool/`
- `tools/GlobTool/`
- `tools/BashTool/`
- `tools/AgentTool/`
- `tools/TaskCreateTool/`
- `tools/TaskGetTool/`
- `tools/TaskUpdateTool/`
- `tools/TaskListTool/`
- `tools/TaskOutputTool/`
- `tools/TaskStopTool/`
- shared Tool/result/progress helpers used by those directories.

Do not mix other Claude source snapshots during this migration.

## Canonical tool set

The Provider-facing registry exposes these exact names where present in the
pinned source snapshot:

- `Read`
- `Write`
- `Edit`
- `Grep`
- `Glob`
- `Bash`
- `Agent`
- `TaskCreate`
- `TaskGet`
- `TaskUpdate`
- `TaskList`
- `TaskOutput`
- `TaskStop`

The pinned snapshot does not independently register `BashOutput`, `BashInput`,
or `BashResize`; do not expose them as Provider tools. Background output uses
canonical `TaskOutput`. PTY write/resize/kill remain internal TUI controls and
SDK/CLI control operations, outside Claude tool parity. Schema fixtures
generated from the pinned modules are the source of truth.

## Breaking compatibility contract

- Remove lowercase built-in registrations such as `read`, `write`, `edit`,
  `grep`, `glob`, `bash`, and `task_create`.
- Strip legacy aliases and deprecated fields even when the pinned implementation
  retains them for compatibility. Provider-facing input accepts canonical names
  and current fields only: no `Task` alias for `Agent`, no `AgentOutputTool`,
  `BashOutputTool`, `KillShell`, or deprecated `shell_id`.
- Do not create hidden duplicate tools for old names.
- Existing JSONL records remain readable and renderable.
- Historical lowercase tool-use/result blocks are replayed as conversation
  history but are never re-executed locally.
- On resume, the Provider sees only the new registry. If it calls an old name,
  ToolSearch/dispatch returns the ordinary unknown-tool error.
- Existing lowercase permission rules no longer authorize the renamed tools.
  `doctor` reports them as legacy rules with the corresponding new exact name;
  it does not silently rewrite settings.
- Custom commands, Skills, Agents, Plugins, and docs that list old tool names
  must be updated explicitly.
- CLI `--tools`/`--allowed-tools`/`--disallowed-tools`, Skill `allowed-tools`,
  and Agent `tools`/`disallowedTools` use exact case-sensitive canonical names;
  remove their current lowercase normalization for migrated built-ins.

## Architecture

### One module per tool family

Create a `src/tools/claude/` tree mirroring the pinned responsibility split:

```text
src/tools/claude/
  read/
  write/
  edit/
  grep/
  glob/
  bash/
  agent/
  tasks/
  shared/
```

Port algorithms and user-visible protocol text. Remove branding, telemetry,
feature flags, Anthropic account checks, remote execution, and internal-only
services. Do not collapse the modules back into `builtins.ts`, `search.ts`,
`shell.ts`, or `tasks.ts`.

The current `AgentTool` execution interface may remain as the internal adapter,
but its exported `name`, `description`, `inputSchema`, validated input, progress,
and final output must exactly match the pinned tool contract.

### tnb safety/runtime dependencies

Inject existing tnb services into the ported tools instead of replacing them:

- workspace and approved-root path validation;
- symlink escape protection;
- file-state/read-before-write cache;
- permission/plan/YOLO policy;
- command AST permission analysis;
- macOS sandbox runtime;
- shell/PTY process manager and cleanup registry;
- Hook before/after/progress lifecycle;
- task/team/session persistence;
- media decoding and model capability checks.

Safety checks may be stricter than the reference, but cannot change the public
schema or falsely report success.

## File tools

### Read

Port exact input fields, validation, offset/limit semantics, descriptions, and
result formatting. Preserve pinned behavior for:

- UTF-8 text and line numbering;
- offset beyond EOF;
- default and explicit limits;
- long-line and output truncation notices;
- images and supported PDFs;
- directories and unsupported/binary inputs;
- file snapshot recording for later Write/Edit;
- abort and progress behavior.

### Write

Port exact schema and output. Continue enforcing workspace confinement and
read-before-overwrite. Atomically create parents/files according to reference
semantics and update the file snapshot after success. External file changes
between Read and Write fail with an explicit stale-file result.

### Edit

Port exact `old_string`, `new_string`, and `replace_all` semantics, including
empty/missing/non-unique match behavior, newline preservation, stale-file
checks, diff/result formatting, and snapshot refresh. No legacy tnb field names
remain.

## Search tools

### Grep

Port the pinned schema, output modes, glob/type filters, context flags, line
numbers, head/offset behavior, ignore rules, result ordering, no-match output,
and truncation budget. Use the bundled/system ripgrep resolution already in
tnb. Preserve fail-closed behavior when ripgrep is unavailable.

### Glob

Port exact pattern/path fields, ignore behavior, sorting, timestamps where
specified, limits, truncation, and no-match output. Keep workspace roots and
symlink confinement.

## Bash and PTY

Port the pinned Bash input schema and result/progress formatting, including:

- foreground and background execution;
- timeout behavior;
- shell selection and environment handling;
- output truncation and persisted full output;
- abort/interrupt behavior;
- process-group cleanup;
- sandbox application;
- real-time progress;
- background task identifiers;
- PTY input, output, resize, and termination APIs exactly as registered by the
  pinned snapshot or, when no Provider tool exists, as internal TUI controls.

Use tnb's existing `ShellSessionManager`, node-pty integration, and graceful
shutdown ownership. Do not import Claude remote execution, telemetry, or
platform services.

## Agent and task tools

Port the pinned `Agent` name/schema, foreground/background behavior, agent
profile selection, isolated history, tool restriction, progress, final result,
and abort behavior. Do not expose tnb's former provider-facing `resume` field;
the pinned schema has no such field.

Provider-facing `model` is exactly `sonnet | opus | haiku`. Resolve it through
new optional settings `agentModelAliases.{sonnet,opus,haiku}`. Each value is a
concrete configured tnb provider/model selector. When an alias is absent, it
maps to the active main model, allowing custom Providers such as GLM/Qwen to
use the Claude-style enum without inventing arbitrary schema values. Invalid
configured selectors fail before launching the child Agent.

Port TaskCreate/Get/Update/List/Output/Stop schemas and result text. Map them to
tnb's durable `TaskManager`, preserving:

- dependency validation;
- unique ID allocation;
- status transitions;
- owner/runtime IDs;
- background Agent association;
- output waiting/non-blocking reads;
- cancellation and cleanup;
- stale-process tombstones and recovery.

Where tnb persistence contains fields absent from Claude's protocol, keep them
internal and omit them from Provider-facing results.

### Bash/TaskOutput lifetime

Background Bash and PTY processes remain process-local. During the current CLI
process, register their IDs in a unified TaskOutput resolver so canonical
`TaskOutput` can poll shell and Agent tasks with pinned `block` and `timeout`
semantics. Agent/work-item tasks remain durable through `TaskManager`.

Shell process identity is not promoted into durable task state. After CLI
restart or `--resume`, an old Bash/PTY ID returns the pinned unknown/expired task
error and cannot be reattached; persisted output files remain available only
through existing local task inspection commands. Stopped/expired ephemeral IDs
leave bounded in-process tombstones so repeated TaskOutput/TaskStop calls return
a stable terminal result rather than targeting a reused process ID.

## Registry, permissions, prompts, and UI

- Replace old registrations atomically; never expose mixed old/new tool sets.
- Update ToolSearch catalog entries and deferred schemas.
- Replace system/tool prompts with the exact pinned tool names and argument
  vocabulary.
- Update built-in Agent/Skill allowed-tool lists.
- Update permission matching to exact case-sensitive names.
- Add `doctor` diagnostics for legacy lowercase rules and extension manifests.
- Update Hook payload tool names to the new canonical names.
- Update TUI cards, summaries, icons, Bash live output, Edit diff rendering,
  background task controls, and transcript restoration.
- MCP tool naming remains unchanged.

## Historical conversation handling

The canonical message format retains historical tool-use names exactly as they
were recorded. A completed old lowercase tool result remains paired with its
old tool-use ID. Pruning, compact, rewind, export, and transcript rendering must
not rename historical blocks.

Dispatch uses only the current registry. No migration mutates existing JSONL
files. New turns persist only canonical Claude names.

## Error behavior

- Validation failures use the pinned result wording and error shape.
- Permission denial, user rejection, timeout, abort, missing executable,
  unavailable media capability, and stale file are distinct results.
- Tool failures return model-visible error results; process-level corruption or
  invariant failures may throw.
- Partial Bash output remains accessible after timeout/abort where specified.
- No tool reports success before filesystem/process persistence completes.

## Verification

Generate checked fixtures for every migrated tool's exact name, description,
and JSON Schema from the pinned source. Add behavior tests for:

- Read offsets, limits, media, binary and truncation;
- Write/Edit stale snapshots, unique/all replacements, atomicity and symlinks;
- Grep/Glob filters, ignore rules, limits, ordering and no matches;
- Bash foreground/background/PTY/progress/input/resize/kill/timeout/abort;
- Agent foreground/background/profile/model/abort, plus background Agent
  recovery through internal TaskManager/TaskOutput state—not a Provider-facing
  Agent `resume` field;
- every Task operation, dependency, output, stop, persistence and recovery;
- ToolSearch observable activation: before activation each migrated deferred
  tool is absent from the Provider tool list; after `tool_search`, matched tools
  appear in the next-turn list and `remainingDeferred` decreases by the exact
  number activated;
- permission rules, plan/YOLO, Hooks and legacy diagnostics;
- TUI tool cards and restored historical lowercase transcripts;
- Anthropic, OpenAI Chat, and OpenAI Responses tool conversion.

Run the complete Bun suite, TypeScript, build, binary smoke, PTY tests, process
leak checks, and `git diff --check`. Land runtime changes as one verified commit
after design/plan commits.

## Stop condition

The migration is complete when:

- no migrated lowercase tool remains in the Provider registry;
- every migrated schema matches its pinned fixture;
- ported modules own execution rather than forwarding to legacy aggregators;
- old sessions still read/render without mutation;
- all safety/runtime integrations remain active;
- all focused and full verification passes on macOS;
- the merged `main` build exposes only the canonical names.
