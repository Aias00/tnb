# Architecture references

## Pi Agent Harness

Reference repository: <https://github.com/earendil-works/pi>

Reviewed snapshot: `936aff00918de1187f085f123c2812d8f2d67745` (2026-08-08).

Pi is MIT licensed. `tnb` studies its public implementation as one reference but does not depend on Pi packages at runtime. Pi is not tnb's roadmap or compatibility target.

### Selection rules

An idea from Pi is adopted only when all of the following are true:

- it addresses a requirement already present in tnb;
- it is simpler or more reliable than tnb's current approach;
- it preserves provider neutrality, testability, and permission boundaries;
- it does not introduce a broad framework or dependency for a narrow benefit;
- its behavior can be specified and tested independently.

Similarity to Pi alone is not a reason to change tnb.

### Referenced capabilities

- Provider-neutral streaming, explicit model transports, tool-loop event flow, and conservative tool interfaces.
- The project implements its provider catalog locally instead of importing an agent framework; telemetry, image pipelines, extension systems, and alternate runtimes remain outside the current boundary.
- Direct dependency versions, when present, are pinned and lockfile changes are reviewed.

Pi packages are intentionally not installed because their broader dependency graph and application concerns are outside the current milestone.

These are candidates, not commitments. Event subscriptions, RPC mode, tree sessions, package extensions, and Pi-compatible APIs are not current requirements.

### Intentional differences

- Pi documents that it has no built-in filesystem, process, network, or credential permission system. `tnb` applies permission checks through the Agent loop's authorization callback and canonicalizes file paths inside each file tool.
- Pi's default coding agent prioritizes extensibility and delegates stronger isolation to containers or sandboxes. `tnb` will keep conservative local defaults even before a full sandbox exists.
- tnb owns its CLI contract, provider selection, permission modes, workspace confinement, configuration, and future product policy.

### Current decisions

1. Maintain a small tnb-owned message, transport, tool, and Agent contract.
2. Reuse selected source-level patterns only when they reduce local complexity.
3. Compare existing session and compaction implementations before selecting the smallest relevant subset.
4. Add tree branching only if it becomes a concrete product requirement.
5. Keep Write, Edit, and Bash behind tnb permission and workspace policies.

## Session storage

Session persistence uses one JSON record per conversation message under a
project-scoped directory. Project IDs are derived from the canonical workspace
path, so symlinked paths resolve to the same session directory. Reads reject
malformed complete records; only an unterminated final record is ignored,
because it is the recoverable failure mode produced by an interrupted append.

Compaction is represented by a `compact_boundary` record containing the full
replacement message state and pre/post rough token estimates. Session reads
discard records before the latest boundary, then apply messages appended after
it. This keeps the JSONL audit trail append-only while making resume behavior
deterministic.

Compact boundaries also store the active permission mode and the mode to
restore after planning. Without those fields, a compacted session resumed in a
new process could lose an active plan restriction even though the preceding
`enter_plan_mode` messages were intentionally removed from model history.

Append-only `session_meta` records store the latest human title, task summary,
strategic intent, and optional parent session ID. The model-facing
`update_topic` tool updates those fields without changing conversation history.
Forking rewrites inherited conversation records under a new
stable session ID and records the parent. It intentionally excludes historical
usage and runtime-only worktree/task/goal state, so the branch starts with the
same model context but independent execution accounting.

Assistant messages may contain provider-neutral text and tool calls plus a
signed reasoning block. OpenAI Responses reasoning blocks persist the summary
shown during streaming and the serialized provider item containing encrypted
state. JSONL resume and compact boundaries preserve that item for stateless
tool-result continuation. Transports that cannot safely replay a foreign
reasoning signature omit the block while retaining visible text and tool calls.

## Context compaction

The Agent core accepts a compaction callback and knows nothing about summary
models or storage. The CLI composes that callback from the provider-neutral
transport summarizer and the session boundary writer.

Before each model turn, tnb estimates conversation size from serialized
message length and runs a bounded compression pipeline. Microcompact first
replaces large older tool results while retaining the five newest results and
their complete tool-use/result structure. If the history still exceeds the
configured threshold, a tool-free full summary replaces the older prefix and
keeps the recent turns intact. If that summarizer cannot return a usable
replacement, context-collapse removes complete old rounds at safe user-message
boundaries and leaves an explicit marker rather than retrying an unbounded
compactor.

The pipeline persists consecutive summarizer failures. Three failures suspend
full summarization for five minutes while safe context-collapse remains
available. Provider context-window errors trigger forced compaction inside the
same model turn and retry without duplicating the user prompt. Large shell,
search, web, and codebase results use tool-aware pruning thresholds.

Session Memory is distinct from user/project Auto Memory. It stores a bounded
background summary under the project session directory after 60,000 tokens,
then refreshes after another 5,000 tokens or five tool calls. The snapshot is
loaded into the system prompt on later turns and is refreshed from successful
full compaction summaries. Compact boundaries continue to store the exact
post-pipeline message state, so resume remains deterministic regardless of the
strategy selected.

The default threshold follows the model context budget: context window minus up
to 20,000 summary-output tokens and a 13,000-token automatic-compaction buffer.
For the default Anthropic 200,000-token model window this is 167,000 rough
tokens. OpenAI model aliases and dated snapshots are resolved through a small
capability catalog; unknown OpenAI-compatible model names use a 128,000-token
context and 16,384-token output compatibility baseline. The threshold can be
changed with `TNB_COMPACT_THRESHOLD_TOKENS`; `TNB_COMPACT_MODEL`
selects the model used by the same configured transport for summaries.

When a provider reports an output-token stop, the loop commits the partial
assistant message and adds a continuation turn. The retry budget is three
continuations, after which the terminal `max-tokens` result is returned to the
caller. This preserves streamed content without allowing an unbounded recovery
loop.

## Provider retry boundary

All model transports pass their canonical event generators through one retry
boundary. Transient connection failures and HTTP 408, 409, 429, and 5xx
responses use the established ten-retry, 500 ms exponential-backoff policy and
honor `Retry-After`. Once an event has been yielded, the attempt becomes
non-retryable so text deltas and tool calls cannot be duplicated.

## Prompt boundary

The system and tool prompts migrate the authorized external coding-agent
guidance while normalizing identity and capability names to tnb. Static
sections cover task completion, careful actions, secure code, dedicated tool
selection, Git safety, verification, communication, and concise output.
Dynamic sections contain only active capabilities and environment data: model,
date, platform, working directory, Git state, and discovered project
instructions.

Tool descriptions are the prompts sent through both provider transports. They
describe only behavior implemented by tnb; unsupported source-product
features such as replace-all edits are excluded. JSON Schema fields carry
parameter-level descriptions so models do not need to infer argument semantics
from the long description.

Media-producing tools return a text result plus canonical image or document
attachments. The Agent persists both in the ordinary user result message.
Anthropic maps them to base64 image/document blocks, OpenAI Chat Completions to
image_url/file parts, and OpenAI Responses to input_image/input_file parts.
Provider-specific wire shapes therefore remain outside Read and the Agent loop.

Image reads validate PNG, JPEG, GIF, and WebP magic bytes and enforce the
established 5 MiB base64 ceiling through a 3.75 MiB raw-file limit. PDFs use a
20 MiB direct-document limit and a 100 MiB absolute extraction limit. When Poppler reports more than ten pages the tool
requires an explicit range; range extraction accepts at most twenty pages and
uses `pdftoppm` to produce provider-neutral JPEG attachments. Temporary page
files are removed before the tool returns.

## Shell execution boundary

Shell execution follows the mature split between blocking commands,
non-interactive background tasks, and persistent PTY sessions. Foreground
commands use the two-minute default and ten-minute maximum timeout. Background
tasks return a stable task id, retain the latest 160,000 characters for model
inspection, and stream the complete output to a session-owned log with a 5 GiB
hard cap. The manager terminates unfinished tasks when its CLI/TUI owner exits.

PTY sessions use the established defaults of 160 columns, 50 rows, an 800 ms
maximum wait, a 120 ms idle window, at most ten sessions, and a 30-minute
lifetime. `@xterm/headless` maintains the rendered screen so ANSI control
sequences are not exposed as raw model output. Since the pinned native PTY
package does not reliably deliver data events under Bun's current runtime, a
small JSON-lines host runs that package under Node; the Agent, tools, lifecycle,
and compiled executable remain Bun-owned. `TNB_NODE_PATH` provides an
explicit Node path when it is not available from `PATH`.

## Codebase index boundary

`codebase_investigator` stores its derived index under
`~/.tnb/cache/codebase` rather than modifying the workspace. Cache keys use
the canonical workspace path. A later process reuses an unchanged index from
disk; after file additions, removals, or metadata changes, only changed files
are tokenized and parsed again. Atomic replacement prevents readers from seeing
a partially written cache, and malformed derived cache files are discarded and
rebuilt from workspace source.

For TypeScript and JavaScript, the index uses the TypeScript 7 compiler AST to
extract declarations, imports, identifier references, and call edges. Other
languages retain the bounded language-pattern parser. Local imports for Python,
Go, Java/Kotlin, Rust, C/C++, and the other indexed language families are
resolved against workspace module paths and package directories before symbol
and call edges are added. External packages remain unresolved rather than being
guessed as workspace code. The TypeScript native
compiler is resolved from dependencies, `TNB_TSGO_PATH`, or a
`tnb-tsgo` executable beside the compiled CLI.

The same index stores direct relative-import edges plus bounded reference and
call edges, which are returned beside ranked matches. Embeddings are opt-in: setting
`TNB_CODEBASE_EMBEDDING_MODEL` selects an OpenAI-compatible provider (the
active provider by default, or `TNB_CODEBASE_EMBEDDING_PROVIDER`) and
persists vectors with the provider/model identity. Without that setting the
index remains entirely local and uses path, symbol, and content ranking.
Changing the embedding identity invalidates only the derived cache.

## Notebook edit boundary

Notebook editing uses the mature cell-oriented contract instead of treating
`.ipynb` as ordinary text. `cell_id` first matches a notebook's real cell id
and otherwise accepts a `cell-N` zero-based index. Replace preserves unrelated
cell fields and clears stale code outputs, insert creates the standard code or
markdown cell shape, and delete removes exactly one resolved cell. Files are
parsed and validated locally, written without executing notebook code, and
remain behind the same workspace path and write-permission boundary as the
ordinary file tools. No Jupyter runtime or SDK dependency is introduced.

## Interactive boundary

The interactive entrypoint mounts a React 19 + Ink 6 TUI modeled on the
authorized reference terminal implementation. The migrated boundary includes
the alternate-screen layout, transcript and streaming Markdown rendering,
cursor-aware multiline input, prompt history, tool progress, spinner/status
presentation, keyboard-driven permission dialog, Agent Team state, and generic
management dialogs. `/plugins`, `/marketplace`, `/security`, and `/ide` expose
local product-management surfaces without embedding a brand-specific account or
cloud UI. Telemetry and voice remain excluded.

The TUI assigns one session ID and resumes it on later prompts. Model and tool
lifecycle events are injected by `runAgentLoop`; approval promises are injected
into the same permission checker used by print mode. Core Agent logic therefore
does not import React, Ink, or terminal input APIs. Non-TTY stdin retains the
line-oriented entrypoint so piping remains deterministic.

The IDE bridge reuses the same bidirectional stream-json runtime over either
stdio or a user-owned Unix socket. Socket discovery is local-file based, uses
private permissions, and carries no Provider credentials. Each client gets an
independent Agent/session runtime while model selection, permission controls,
Hook events, MCP activity, and usage remain ordinary protocol records.

Start a bridge with `tnb remote-control --socket ~/.tnb/ide/editor.sock`.
`tnb ide list` reports only redacted descriptor metadata; `tnb ide status` and
`tnb ide context` connect to the sole active bridge for the current workspace,
and `tnb ide query <prompt> [--session <id>]` invokes the Agent with the current
editor context. Use `--descriptor <path>` when multiple bridges are active.
Clients reject descriptors that are readable by group or other users and must
authenticate with the generated owner token before any method is accepted.

`ask_user_question` uses a separate injected question promise rather than
misusing the permission channel. The Ink UI renders single-select,
multi-select, and custom-answer states; the line-oriented REPL exposes the same
contract with numbered choices. `todo_write` receives a complete replacement
list, renders the current tasks independently from ordinary tool progress, and
restores the latest list by reading the persisted tool input on resumed turns.

## Web search boundary

WebSearch keeps the mature `query`, `allowed_domains`, and `blocked_domains`
tool contract but does not assume an Anthropic-only server tool. When
`BRAVE_SEARCH_API_KEY` is configured, the CLI registers a provider-neutral tool
that calls Brave's official Web Search REST endpoint and returns titles, URLs,
and snippets. This avoids routing Anthropic or OpenAI traffic through a custom
model gateway.

## MCP boundary

The MCP implementation is split into protocol client, stdio transport,
configuration, stdio and HTTP transports, connection manager, and Agent-tool
adapter modules. The Agent
loop receives ordinary `AgentTool` objects and does not import MCP services.
This preserves the dependency direction without adding transport cases to the
core loop.

Configured stdio servers complete initialization before tool discovery. Tool
lists are paginated, names are normalized for both model providers, and name
collisions fail startup. MCP annotations remain untrusted and cannot mark a
tool read-only in the current permission model.

## Skill boundary

Skill loading follows progressive disclosure: name and description are exposed
through the dynamic `skill` tool, while Markdown instructions enter context
only after selection. Personal and project directories are scanned separately
and merged by explicit precedence.

Execution reuses `runAgentLoop` with a new message array rather than adding a
second orchestration engine. The entrypoint injects the inherited transport,
filtered base tools, and the existing permission checker. Nested messages are
written to a separate child transcript rather than the parent conversation
JSONL, and the Skill tool itself is omitted from the nested registry to prevent
recursive invocation.

## Subagent boundary

The `agent` tool reuses `runAgentLoop` with fresh messages rather than adding a
second execution engine. Its input contains a short description, a standalone
prompt, a `general-purpose`, `explore`, or `plan` profile, and an optional exact
model identifier. The active Provider transport, project instructions,
permission checker, abort signal, and established 200-turn child limit are
injected by the CLI composition root.

General-purpose children receive the ordinary stateless base tools. Explore
and plan children receive only repository and web discovery tools, and their
role-specific system section requires read-only investigation or planning.
Agent, Skill, Todo, and question tools are absent from every child registry to
prevent recursive delegation and parent-session state contamination. Child
messages are written to a separate transcript next to the parent session; only
the final report returns as the parent tool result.

## Plan mode boundary

Plan mode is a session runtime state layered over the existing permission
checker. Entering records the preceding mode and changes the checker's dynamic
mode to `plan`; the established plan rule then denies every non-read-only tool.
The transition emits a UI event so the TUI header and status line immediately
show the active mode.

`exit_plan_mode` carries the complete plan because tnb does not expose a
special writable plan file outside the workspace boundary. A tool-specific
`requiresApproval` hook runs before YOLO and read-only shortcuts, allowing the
exit tool to remain structurally safe while still requiring explicit plan
approval. The TUI renders the full Markdown plan rather than a truncated JSON
input. Approval restores the saved mode; denial leaves plan mode active.

Successful transition tool results reconstruct plan state on ordinary resume.
The compact-boundary metadata preserves the same state when earlier transition
messages have been summarized away.
