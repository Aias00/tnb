# tnb

Private, local-first coding agent CLI experiment.

This repository uses public documentation and authorized implementation references. Imported concepts are reduced to tnb's requirements and normalized to tnb naming; product-specific branding, gateways, telemetry, and deployment assumptions are excluded.

The implementation selectively studies mature coding-agent implementations, including the MIT-licensed [Pi](https://github.com/earendil-works/pi), without taking a runtime dependency on an entire agent framework. Only the small capabilities required by tnb are implemented in this repository. See [docs/architecture-reference.md](docs/architecture-reference.md) for the boundary.

## Current milestone

The current vertical slice includes:

- a compact provider-neutral event model and multi-turn tool loop;
- a capability-aware coding-agent system prompt and detailed provider-facing prompts for every built-in tool;
- direct Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses transports using Bun `fetch`;
- user-defined model providers, endpoints, credentials, headers, model limits, and OpenAI compatibility profiles through `models.json`;
- provider-reported token usage, JSONL session totals, configurable cost estimates, and Anthropic/OpenAI prompt-cache accounting;
- persistent autonomous goals with explicit turn budgets, plus dependency-aware multi-agent workflows over the existing Agent runtime;
- transient Provider retries with `Retry-After` support and stream duplication protection;
- pre-output fallback model switching, invocation cost ceilings, and schema-validated structured output for automation;
- local `read`, `write`, `edit`, `notebook_edit`, `bash`, `bash_output`, `bash_input`, `bash_resize`, `bash_kill`, `grep`, and `glob` tools behind tnb-owned policies;
- multimodal `read` results for PNG, JPEG, GIF, WebP, direct PDFs, and bounded PDF page ranges;
- bounded `web_fetch` for public textual HTTP/HTTPS resources;
- optional provider-neutral `web_search` through the official Brave Search API;
- optional Brave `image_search` plus OpenAI-compatible `image_generate` with workspace-safe output;
- session and durable cron prompts, relative wakeups, and stdout-driven background monitors;
- layered permission rules with `default`, `acceptEdits`, `dontAsk`, `plan`, and explicit YOLO modes;
- optional macOS Seatbelt sandboxing for foreground, background, monitor, and PTY shell processes;
- project-scoped JSONL sessions with `--resume` and `--continue`;
- project-scoped auto memory with a bounded `MEMORY.md` index and `/memory` controls;
- single-layer automatic context compaction with durable session boundaries;
- stdio, legacy SSE, Streamable HTTP, and SDK-injected in-process MCP servers with dynamic tool registration and OAuth PKCE;
- user and project Skill discovery with isolated Agent execution;
- session task tracking through `todo_write` and structured interactive choices through `ask_user_question`;
- foreground and background `agent` delegation with general-purpose, explore, plan, and custom profiles;
- user and project custom Agent definitions with tool, model, permission, and turn limits;
- user and project custom prompt commands with nested namespaces and argument expansion;
- command Hooks for session, prompt, permission, notification, tool, subagent, stop, and compaction lifecycle events, including plugin-contributed Hooks;
- plugin-contributed MCP servers merged through the same validated transport and permission path as user configuration;
- persistent dependency-aware task tools with live TUI runtime status;
- runtime `enter_plan_mode` and approval-gated `exit_plan_mode` transitions;
- a full-screen Ink TUI plus non-interactive `tnb -p` mode.
- a subprocess-isolated TypeScript `query()` SDK with multi-turn JSONL input, interruption, runtime model and permission controls, and programmatic tool approval;

## Usage

Start the interactive TUI:

```bash
export ANTHROPIC_API_KEY="..."
./dist/tnb
```

The TUI uses an alternate terminal screen, renders streaming Markdown and code,
tracks tool execution, preserves prompt history, and shows a keyboard-selectable
permission dialog. Use the arrow keys and Enter in permission dialogs; press
Escape to interrupt an active turn, or Ctrl-C while idle to exit. `/exit` and
`/quit` also close it. Set `TNB_TUI_FULLSCREEN=0` to keep the same Ink UI
in normal terminal scrollback while debugging.

The fullscreen transcript scrolls by terminal rows. Use the mouse wheel,
`PageUp`/`PageDown`, `Ctrl+U`/`Ctrl+D` for half pages, `Shift+Up`/`Shift+Down`
as page aliases, and `Ctrl+Home`/`Ctrl+End` for the oldest/latest output.
Press `Ctrl+O` to toggle the compact transcript and complete tool output. Bash
progress, file changes, reads, and searches use tool-specific summaries in the
compact view.
Streaming follows the bottom only while it is pinned; scrolling up keeps the
current reading position until you return to the bottom.

Interactive commands are registered through a shared slash-command catalog. Type
`/` to see matching commands and press Tab to complete the first match. The
current set includes `/help`, `/model`, `/models`, `/permissions`, `/status`,
`/agents`, `/skills`, `/plugins`, `/hooks`, `/mcp`, `/commands`, `/sessions`, `/rename`, `/fork`, `/resume`, `/continue`, `/memory`,
`/rewind`, `/rollback`, `/diff`, `/context`, `/usage`, `/copy`,
`/goal`, `/export`, `/compact`, `/clear`, and
`/exit`. Model changes rebuild the selected Provider
transport for the next turn, permission changes pass through the same YOLO and
trusted-workspace gates as startup options, manual compaction writes a durable
JSONL boundary, and `/clear` starts a new session without deleting the old one.
`/models`, `/permissions`, `/sessions`, `/mcp`, `/skills`, `/plugins`, `/hooks`,
`/agents`, `/rollback`, and argument-free `/resume` open
keyboard-selectable management views; use the arrow keys, Enter, and Escape to
navigate them. Resource views include a selected-item detail pane with badges,
actions, and an `I` inspect shortcut. Transcript tool cards provide dedicated
summaries for Agent/Skill/MCP/Web/Notebook/LSP/Task/Team/Workflow/Image calls.

Local worktree jobs created by `enter_worktree` can also be managed without
starting the Agent:

```bash
tnb jobs
tnb jobs show feature+api
tnb rm feature+api --yes
tnb rm feature+api --yes --discard-changes
```

Removal always requires `--yes`. If a worktree has uncommitted files or commits
not reachable from the current branch, `--discard-changes` is required as a
second explicit confirmation.
`/sessions` lists workspace conversations by recency, `/resume` accepts an exact
session id or unambiguous prefix, and `/continue` switches to the newest other
session without restarting tnb. Resumed text is restored in the TUI and
the next prompt continues from the selected JSONL transcript. `/rename` stores
a human-readable title without changing the stable session ID. `/fork` creates
a new session with the current conversation history while resetting usage,
runtime task, worktree, and goal state. `/export` writes
a plain-text transcript inside the active workspace and derives its default
filename from the first prompt and current timestamp.

The Agent can maintain a structured task list for multi-step work. The latest
list is rendered in the TUI and recovered from session history on later turns.
It can also ask one to four structured questions. Use the arrow keys and Enter
for a single choice; multi-select questions use Space to toggle choices and
Enter to submit. Every question includes an `Other` path for custom text.
In print mode, questions return a tool error unless an SDK caller supplies an
`askUser` callback.

The `agent` tool runs a foreground subagent with fresh message history. The
`general-purpose` profile can investigate, edit, and test; `explore` and `plan`
receive only `read`, `grep`, `glob`, and configured web discovery tools. All
profiles inherit the active Provider and permission policy, may optionally use
an exact model override, and return their final report to the parent Agent.
Nested Agent, Skill, Todo, and user-question calls are excluded so a subagent
cannot recursively expand or mutate parent-session interaction state.

Custom agents are loaded from `~/.tnb/agents`, `.claude/agents`, and
`.tnb/agents`; project tnb definitions have highest precedence. Use
`/agents` to inspect the effective catalog and definition errors. See
[docs/agents.md](docs/agents.md) for the Markdown frontmatter format and runtime
restriction rules.

Custom prompt commands are loaded from user and project `commands/` directories,
including compatible `.claude/commands` layouts. They appear in slash-command
completion and support `$ARGUMENTS` plus `$1` through `$9`. See
[docs/commands.md](docs/commands.md).

Lifecycle command Hooks can inspect or block prompts and tool calls, update
tool input, add model context, and request that a stopping Agent continue.
Project Hooks require explicit workspace trust because they execute local
processes. See [docs/hooks.md](docs/hooks.md).

The persistent `task_create`, `task_get`, `task_update`, and `task_list` tools
manage dependency-aware session work items. Agents may use
`run_in_background: true` in the interactive TUI; `task_output` reads their
current or final result and `task_stop` cancels them. See
[docs/tasks.md](docs/tasks.md) for persistence and lifecycle behavior.

For implementation work with genuine architectural ambiguity, the Agent can
enter plan mode. Subsequent writes, commands, Agent/Skill calls, and unknown
external tools are denied while repository reads remain available. When the
plan is complete, `exit_plan_mode` presents the full plan in the terminal and
requires explicit approval even under YOLO. Approval restores the permission
mode that was active before planning. Active plan state is recovered from
session tool results and is also stored in compact boundaries. Print mode
cannot approve a plan unless its SDK caller supplies a permission callback.

The system prompt includes the active model, platform, working directory, Git
state, enabled-tool guidance, safety and verification policy, and project
instructions. Instruction files are loaded from `AGENTS.md` and `CLAUDE.md`
while walking from general parent directories toward the workspace, followed
by `<workspace>/.tnb/instructions.md` when present. The runtime identity
and user-facing prompt text remain tnb-branded.

Run one non-interactive prompt:

```bash
export ANTHROPIC_API_KEY="..."
bun run src/entrypoints/cli.ts -p "Read package.json and summarize it"
```

Automation-oriented controls can bound turns and cost, switch to another
configured model after a transient pre-output failure, filter tools, and require
a final JSON object:

```bash
tnb -p "Classify this repository" \
  --max-turns 8 \
  --max-budget-usd 0.50 \
  --fallback-model openai/gpt-5-mini \
  --output-format json \
  --json-schema '{"type":"object","required":["language"],"properties":{"language":{"type":"string"}},"additionalProperties":false}'
```

See [docs/automation.md](docs/automation.md) for failure and output semantics.
For programmatic single-turn and multi-turn use, see [docs/sdk.md](docs/sdk.md).

Attach workspace text, image, or PDF files directly to the initial request by
repeating `--attachment` (or `-a`):

```bash
tnb -p "Compare the specification and screenshot" \
  --attachment docs/spec.md \
  --attachment screenshots/current.png
```

Attachment paths must remain inside the active workspace. Images and PDFs use
the same validation and selected-model capability checks as the `read` tool.

Start directly in an isolated Git worktree using either the Claude-style
optional name or the qoder-compatible branch form:

```bash
tnb --worktree feature/api
tnb --worktree --branch feature/api
tnb -p "Implement the API" -w feature/api
```

When no name is supplied, tnb derives a stable `job-<session>` name.
The worktree remains registered after the session and can be inspected with
`tnb jobs` or removed with `tnb rm <id> --yes`.

Run all shell tools inside the platform sandbox with `--sandbox`. The effective policy
can also be configured through `tools.sandbox` in settings, including additional
writable paths and child-process network access. See
[docs/sandbox.md](docs/sandbox.md).

When a supported language server is installed, the `lsp` tool provides
diagnostics and code navigation. Large tool sets use deferred schemas through
`tool_search`. See [docs/lsp.md](docs/lsp.md) and
[docs/tool-search.md](docs/tool-search.md).

Auto memory and local extension lifecycle commands are documented in
[docs/memory.md](docs/memory.md) and [docs/extensions.md](docs/extensions.md).
`/rewind [turns]` rewinds only durable conversation history; it intentionally
does not modify workspace files. Before each Agent turn in a Git workspace,
tnb creates a local checkpoint containing tracked, staged, and non-ignored
untracked state. `/rollback` opens the current session's checkpoint picker and
restores both files and its linked conversation boundary; add `--files-only` to
leave the transcript unchanged. Non-interactive restoration uses
`tnb rollback <checkpoint-id> --yes`. Ignored files are never replaced by
checkpoint rollback. `/copy` uses the OSC 52 terminal protocol.
Enable the basic Vim-style prompt mode with `general.vimMode=true`; Escape enters
NORMAL mode, with `i`/`I`, `a`/`A`, `h`/`l`, `b`/`w`, `0`/`$`, `x`/`X`, and
`D`/`C` supported. In the Ink TUI, Ctrl+V reads a PNG image from the native
clipboard, attaches it to the next request, and removes its temporary workspace
file after the turn. Set
`ui.theme` to `magenta`, `cyan`, `blue`, or `green` for the primary TUI color.
The `update_topic` tool persists a concise session title, summary, and strategic
intent so `/sessions`, resume, and fork retain the active topic independently
from compaction.
`codebase_investigator` keeps a project-keyed index under the tnb cache
directory. Unchanged repositories reuse it across CLI processes, while changed
repositories rebuild only added or modified files. Configured non-TypeScript
language servers contribute structured document symbols; TypeScript uses its
compiler AST and the offline parser remains available when an optional LSP is
not installed.

Run a persistent objective as a foreground autonomous loop with:

```bash
tnb goal-loop "Implement the requested migration and verify it" --turns 30
tnb goal-loop-stop <session-id>
```

The command uses the same session GoalManager as `/goal` and the goal tools.
Each terminal model turn records budget/time usage and automatically feeds the
next continuation prompt until the model marks the goal complete, the budget
pauses it, a stop command updates its durable state, or the process is
interrupted. The session ID is printed to stderr so another process can stop or
later resume the same goal.

Override the default model with `--model` or `TNB_MODEL`.

Select OpenAI with `--provider openai` or `TNB_PROVIDER=openai`; its
default model is `gpt-4o` and it reads `OPENAI_API_KEY` directly.

Define any Anthropic- or OpenAI-compatible provider in
`~/.tnb/models.json`, then select its id with `--provider`. Provider ids are
independent from their wire protocol, and model context/output limits feed the
same Agent and compaction loop. See [docs/providers.md](docs/providers.md) for
the schema, environment-variable expansion, custom headers, keyless local
servers, and compatibility flags.

Image discovery and generation are optional. `BRAVE_SEARCH_API_KEY` enables
both web and image search. An OpenAI-compatible active provider enables image
generation; select a different configured provider or image model with
`TNB_IMAGE_PROVIDER` and `TNB_IMAGE_MODEL`. See
[docs/images.md](docs/images.md).

Interactive sessions can schedule future Agent turns or stream monitor events
back into the same conversation. See
[docs/scheduled-tasks.md](docs/scheduled-tasks.md).

The common single-model setup can be created without editing JSON manually:

```bash
tnb provider add deepseek \
  --api openai-completions \
  --base-url https://api.deepseek.com/v1 \
  --model deepseek-chat \
  --api-key-env DEEPSEEK_API_KEY
tnb provider show deepseek
tnb provider use deepseek --model deepseek-chat
tnb provider test deepseek --tools
tnb provider model add deepseek deepseek-reasoner --reasoning
tnb provider model default deepseek deepseek-reasoner
```

Generate native shell completion without installing another package:

```bash
source <(tnb completion zsh)   # Zsh
source <(tnb completion bash)  # Bash
tnb completion fish | source  # Fish
```

This stores `$DEEPSEEK_API_KEY`, not the secret value. Advanced multi-model,
header, compatibility, and per-model overrides remain available through
`models.json`. `provider use` stores the default selection in settings; explicit
CLI flags override environment variables, which override settings.

Inspect the effective catalog, including built-in provider overrides and model
defaults, with `tnb models` or `tnb models --json`.

Use `tnb --help` for the complete command surface without initializing a
Provider. `tnb status` reports the effective local Provider, model,
permission policy, and session count; `tnb doctor` validates configuration
files and optional local tool dependencies. Settings can be inspected or
changed with dotted keys:

```bash
tnb config get permissions.defaultMode
tnb config set permissions.defaultMode '"acceptEdits"'
tnb config set security.disableYolo true --project
```

Print mode supports ordinary text, a single JSON result, or realtime JSON Lines:

```bash
tnb -p "Inspect this project" --output-format json
tnb -p "Run the checks" --output-format stream-json
```

For a long-lived script or SDK process, JSON Lines input can drive multiple
turns in the same session. See [docs/structured-io.md](docs/structured-io.md).

For reasoning-capable OpenAI-compatible models, select `--thinking off`,
`minimal`, `low`, `medium`, `high`, or `xhigh`. Provider compatibility settings
map that level to OpenAI, DeepSeek, Qwen, or OpenRouter request fields.
OpenAI Responses reasoning summaries and encrypted replay state are preserved
across tool turns, JSONL resume, and context boundaries while `store: false`
keeps the endpoint interaction stateless.

Provider requests retry transient connection failures and HTTP 408, 409, 429,
and 5xx responses up to ten times. Backoff starts at 500 ms, honors
`Retry-After`, and stops retrying as soon as any stream event has been emitted.

Non-interactive mode only permits read-risk tools by default. To allow workspace writes explicitly:

```bash
bun run src/entrypoints/cli.ts -p "Create notes.txt" --yolo
```

YOLO maps to the internal `bypassPermissions` mode and also enables shell
commands, so it must be an explicit opt-in. File tools remain confined to the
selected workspace even in YOLO mode. The legacy `--permission-mode bypass`
spelling remains accepted.

The `grep` and `glob` tools call the local `rg` executable, respect workspace
ignore files, and cap returned results. Install [ripgrep](https://github.com/BurntSushi/ripgrep)
and ensure `rg` is available on `PATH` before using them.

The `bash` tool supports three execution modes. Foreground commands default to
a two-minute timeout and may request up to ten minutes. `run_in_background`
returns a task id that can be inspected with `bash_output` or stopped with
`bash_kill`; full output is persisted under the current session's task
directory while the model receives the latest 160,000 characters. `pty=true`
starts a persistent 160x50 terminal for interactive commands. Use
`bash_input`, `bash_output`, and `bash_resize` with the returned PID. A CLI or
TUI session owns these processes and terminates any still running when the
session exits.

PTY mode requires a `node` executable on `PATH` (or `TNB_NODE_PATH`) for
the native `@lydell/node-pty` host. tnb uses this small host because the
native PTY event bridge is reliable in Node while the main CLI and compiled
binary continue to run on Bun.

`notebook_edit` performs cell-level replace, insert, and delete operations on
existing `.ipynb` files. It accepts real Jupyter cell ids and `cell-N`
zero-based aliases, inserts after the selected cell (or at the beginning when
no id is supplied), and clears stale outputs when code source changes. Like
the other file tools, it cannot escape the active workspace.

`read` sends supported images and PDFs to the selected model as native media
content rather than displaying base64 data. Images use the established 5 MiB
base64 API ceiling (3.75 MiB raw input). Direct PDFs are limited to 20 MiB and,
when `pdfinfo` is available, at most ten pages. Pass `pages: "1-5"` to extract
up to twenty selected pages as images; this range mode requires Poppler's
`pdftoppm` command. Anthropic, OpenAI Chat Completions, and OpenAI Responses
each receive their native image/file content format through the same canonical
conversation representation.

`web_fetch` is classified as network access and therefore requires explicit
`--yolo` or an explicit allow rule in non-interactive mode. It rejects local/private
destinations, rechecks redirects, accepts textual content only, and enforces
the established defaults of a 60-second timeout, 10 MiB response limit,
100,000-character output limit, and 10 same-host redirects.

Enable `web_search` with a Brave Search API subscription token:

```bash
export BRAVE_SEARCH_API_KEY="..."
./dist/tnb -p "Search for the latest Bun release and cite sources" --yolo
```

The tool accepts `query`, `allowed_domains`, and `blocked_domains`, returns up
to ten citable results, and caps model-facing output at 100,000 characters.
Use `BRAVE_SEARCH_BASE_URL` only when targeting a compatible official endpoint.

Continue the most recently used session for the current workspace:

```bash
bun run src/entrypoints/cli.ts -p "Continue the previous task" --continue
```

Resume a known session explicitly:

```bash
bun run src/entrypoints/cli.ts -p "Continue" --resume <session-id>
```

For automation, `--session-id <id>` assigns a specific ID to a new session and
rejects collisions. `--add-dir <directory>` can be repeated to approve extra
workspace roots for tools and MCP without changing the process cwd.

Use `--fork-session` with `--resume` or `--continue` to preserve the source
transcript and continue in a copied session. `--session-id` can select the fork
target and `--name` assigns its visible title.

Sessions are stored as JSONL under `~/.tnb/projects/<project-id>/`.
Interactive `/sessions` shows titles when present and supports title, prompt,
or session-ID filtering. Use `/rename <title>` to label the current session and
`/fork [title]` to branch its conversation into a fresh session ID.

Long conversations are summarized before a model request when their rough
token estimate reaches a provider- and model-aware compaction threshold. The
default Anthropic budget is 167,000 tokens for a 200,000-token context window;
known OpenAI models use their published context and output limits. Set
`TNB_COMPACT_THRESHOLD_TOKENS` to a positive integer to tune this limit,
and optionally set `TNB_COMPACT_MODEL` to use another configured model for
the tool-free summary request. Compaction preserves the recent turn and records
the replacement state as a JSONL boundary, so `--resume` restores the compacted
conversation instead of replaying discarded history.

If a model response reaches its output-token limit, tnb preserves the
partial assistant message and asks the same model to continue. It makes at most
three continuation requests so a repeatedly truncated response cannot loop
forever.

Configure local MCP servers in `~/.tnb/mcp.json`:

```json
{
  "mcpServers": {
    "local-tools": {
      "command": "bun",
      "args": ["/absolute/path/to/server.ts"],
      "env": { "SERVICE_TOKEN": "value" }
    },
    "remote-tools": {
      "type": "http",
      "url": "https://mcp.example.com/rpc",
      "oauth": {
        "clientId": "$MCP_CLIENT_ID",
        "scopes": ["tools:read", "tools:execute"]
      }
    }
  }
}
```

Set `TNB_MCP_CONFIG` to use another configuration file. MCP tools are
exposed as `mcp__<server>__<tool>`. Server annotations do not automatically
grant read permission, so MCP calls require an explicit allow rule or YOLO mode
in non-interactive use. Run `tnb mcp list` to inspect configured servers,
`tnb mcp auth <name>` for OAuth PKCE, and `tnb mcp logout <name>` to
revoke server tokens when supported and remove stored credentials.
Resource-capable servers also expose
`mcp__<server>__read_resource`; inspect resources and prompts with
`tnb mcp resources|templates|prompts <name>`, or monitor subscribed resource
updates with `tnb mcp watch <name> <uri>`. Interactive sessions expose
advertised prompts as `/mcp__<server>__<prompt>` and refresh MCP lists after
`list_changed` notifications. Servers with the MCP completions capability can
be queried with `tnb mcp complete <name> resource|prompt ...`. See
[docs/mcp.md](docs/mcp.md).

Permission settings are loaded from `~/.tnb/settings.json`, then
`.tnb/settings.json`, then `.tnb/settings.local.json`. See
[docs/permissions.md](docs/permissions.md) for rule syntax, precedence, and
YOLO safety gates.

Skills use `<skill-name>/SKILL.md` directories. Personal skills live under
`~/.tnb/skills/`; project skills live under `.tnb/skills/`. Personal
definitions take precedence when names collide. See
[docs/skills.md](docs/skills.md) for the supported frontmatter and execution
boundary. The main Agent has no implicit turn limit; isolated Skill agents use
the established 200-turn fork limit.

## Development

```bash
bun install
bun test
bun run typecheck
bun run build
```

The compiled executable is written to `dist/tnb`.

Project and manually copied user plugins are content-fingerprint gated. Inspect
them with `tnb plugins show <name>`, approve the current snapshot with
`tnb plugins trust <name> --yes`, and revoke it with
`tnb plugins untrust <name> --yes`. A content change disables the plugin until
the changed snapshot is approved again.

Create checksummed artifacts for the current macOS host and install the full
runtime bundle under a versioned local prefix:

```bash
bun run release:current
bun run install:local
~/.local/bin/tnb --version
```

`install:local` atomically switches the command symlink and retains its prior
target as `tnb.previous`. Pass `--prefix <directory>` for an isolated install.
Set `TNB_RELEASE_BASE_URL` during `release:current` to generate the remote
self-update manifest alongside the binary and `SHA256SUMS`.
