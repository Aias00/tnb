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

- `/longtask "objective" [options]` submits a durable background task using the
  current workspace and model; `/task`, `/long` and `/长任务` are aliases. `list`, `status`,
  `result`, `events`, `questions`, `answer`, `limits`, `pause`, `resume`, and `cancel` manage those tasks. Without
  a Run ID, controls prefer the current conversation's latest Run, then the
  workspace's latest Run. Bare `/longtask` shows help without starting work.
  Writable tasks require `--allow-write` and replay-safe `--check` commands.
  `/task questions` lists pending decisions; `/task answer --question ID
  --answer "text" --version N` records the user's answer. Waiting releases execution
  resources; answering a paused Run does not resume it or change its permissions.
  Open TUI/REPL sessions receive pending questions automatically: choose an option
  or type an answer directly. Existing drafts and dialogs are preserved; reopened
  sessions restore unanswered questions. Esc (TUI) or `/later` (REPL) defers locally.
  Completion, failure, blocking and budget/deadline alerts are also delivered automatically;
  acknowledged alerts survive reconnect without repeated display. Offline/old-owner states
  are visible. `/runtime start|restart|stop` controls the local service explicitly.
  After a drained pause, `/task limits --extend-hours 24 --max-budget-usd 10` extends
  the deadline and sets a new total budget ceiling without resetting charges or resuming.
  `/task resume` remains a separate explicit action. Submission accepts `--deadline ISO-DATE`.
  This entry works in both the TUI and terminal REPL;
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
  `externalEditor`, `toggleTranscript`, `toggleTasks`, `pasteImage`, `promptQueue`,
  `previousTool`, `nextTool`, `toggleTool`, and `redraw` under a
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


### Queue, tool cards and session browsing

- `Ctrl+Q`: preview queued prompts; Up/Down selects, Enter/E retrieves for editing,
  D/Delete requests removal with Y confirmation, PgUp/PgDn scrolls the preview, and Esc closes. The current draft
  is protected from overwrite. Pending prompts wait while this panel is open.
  This is the same durable queue as Ctrl+T → 排队输入. Taking an item back keeps
  the original saved until explicit resubmission; interrupted dispatches require
  inspection and are never replayed automatically.
- `Alt+Up/Down`: select a tool card; `Alt+Enter` or clicking the card toggles its
  output independently. `Ctrl+O` toggles all output. These bindings are configurable.
- In `/sessions`, press `/` to search the displayed list by title, prompt or ID.
  Enter applies the filter; Enter on the selected item resumes it. PgUp/PgDn
  scrolls the preview. `/sessions <query>` also searches older history.
- `Ctrl+K/U/W` cuts prompt text; `Ctrl+Y` restores it and `Alt+Y` cycles cuts.
  Image references remain atomic and can be removed with Backspace.

### File selection and change review

Typing `@` opens a workspace file menu; `@widget` can find `src/widget.ts`.
Up/Down selects and Tab/Enter accepts, without sending the prompt. Completion
uses the token at the cursor and retains following text. Paths with spaces are
quoted. Dotfiles require an explicit dot prefix. `@` references insert paths
rather than automatically attaching file content.

`/diff` opens a read-only list of working-tree changes, including staged and
untracked files. Up/Down selects a file, PgUp/PgDn scrolls its patch, Enter toggles
a full-width preview, Esc returns/closes, and R refreshes. `/diff "file name"`
opens a single changed file. Reviewing does not alter files or the Git index.


### Starting with a saved session

`tnb resume` is the command form of `tnb --resume`: in a terminal it opens the
current workspace's session picker. `tnb resume <session-id>` restores that
session directly. Runtime flags can follow the command, for example
`tnb resume <session-id> --model <model>`. Existing `-r`, `--resume` and interactive
`/resume` syntax remains supported.


### Command routing and terminal recovery

`tnb continue` is the command form of `tnb --continue`. CLI commands and
interactive slash commands are separate: enter `/clear`, `/diff` or `/theme`
inside tnb. Unknown shell commands now return an error instead of opening a new
session. `tnb <command> --help` prints usage without loading provider credentials
or performing the command's action. Shell completion includes all top-level
commands and aliases.

`Ctrl+L` redraws a disturbed screen without clearing the conversation or draft;
customize/disable it with the `redraw` keybinding. Structural transitions such as
changing themes, opening dialogs and starting/ending turns invalidate stale
screen pixels. The TUI uses the renderer's terminal-size context.

Activity now shows a rotating spinner and distinguishes waiting for a model,
thinking, preparing tool arguments, tool execution and response output. An
extended wait is described as waiting, not claimed to be hidden model reasoning.
Markdown tables render aligned cell columns, a header separator, wrapped content
and inline formatting rather than literal Markdown punctuation.

### Build identity and local installation rollback

`tnb --version` keeps its semantic-version-only output. `tnb --version --verbose`
shows build commit/time and runtime; `tnb --version --json` includes source digest,
Bun version and platform. Source execution reports `mode: source` with unknown
commit/build time rather than guessing from the current working directory.
`/about` also reports the build identity.

`tnb runtime version` (or `/runtime version`) reads the running owner's build and
compares it with the CLI without starting/restarting a service. `matches: null`
means source execution or an older owner did not supply a comparable identity.
A mismatch is reported, not automatically repaired or used to migrate jobs.

Local installs now retain full bundles under unique build directories, including
when `package.json` is unchanged. The command symlink switches after staging;
`tnb.previous` points to the preceding complete install. From the source checkout:

```sh
bun run install:local
bun run install:local -- --rollback
```

Use the same `--prefix` for an isolated installation and its rollback. Rollback
swaps current/previous links and never deletes either bundle or restarts tasks.
Old install directories are retained; automatic pruning is not implemented.
After checking running jobs, restart the owner explicitly if you want it to use
the newly selected binary. Restarting a different build does not guarantee that
an existing task's pinned plugin generation can migrate.

### Human-readable command lists

Text output for models, providers, sessions, Skills, Agents, Hooks, marketplace
plugins, worktree jobs, checkpoints, MCP servers and IDE bridges uses labelled,
indented summaries instead of terminal-dependent Tab columns. Empty lists print
an explicit result. Long paths and descriptions wrap to the output terminal width.
Existing `--json` output schemas remain unchanged. For sessions, plugins, Skills
and provider listing, `--json` may follow the command without an explicit `list`.
Runtime command responses remain structured diagnostics rather than being
reformatted into these summaries.

### Retry progress, context breakdown and checkpoint restore preview

The foreground activity line displays actual Provider retry events: sanitized
reason/status, retry number, and a backoff countdown. Dispatching the retry switches
to a requesting state; text/thinking/tool events restore normal phase reporting.
Retry progress does not count as output, usage or a reason to suppress fallback.
Durable workers retain zero hidden transport retries; their scheduler is unchanged.

`/context` reports the last prepared execution request's categories when available:
system instructions, tool definitions, conversation text, tool calls/results,
reasoning replay and heuristic summary-like text. Counts are textual serialization
estimates, not Provider tokenization. Media count is separate and its cost is not
invented. The output reserve is separate; history-only reports explicitly say
system/tool data and output reserve are unavailable. The status bar's reported
Provider input is a different measurement. Snapshot time identifies stale reports.

In the Ink TUI, `/rollback <checkpoint-id>` now opens a read-only preview with
explicit choices to restore files, conversation, or both. Enter confirms the
chosen scope; Escape cancels. The preview includes tracked changes, untracked
paths that may be removed/restored and conversation message count. Confirmation
is bound to the previewed workspace/conversation: changes invalidate it and require
a fresh preview. File restore still requires explicit `--force` for a changed HEAD.
A checkpoint from another session offers files only. Preview-bound mutation uses
existing workspace/session ownership and reports partial failures, rather than
claiming both resources were restored. Keep TNB_HOME outside the Git repository
for file restores. The noninteractive `tnb rollback <id> --yes` contract is unchanged.

Custom keybinding conflicts appear as startup warnings and in `/shortcuts`.
Duplicates retain the current map/order; Ctrl+C and Escape remain fixed controls
and cannot be captured by a configurable action. No keys are silently reassigned.

### Completion cache, approval Diff, idle notices and IDE references

Workspace filename search uses a bounded two-second cache and coalesces scans.
It ranks exact/prefix filename matches before path/subsequence matches, with recent
accepted choices preferred within a match class. `/reload` invalidates the cached
workspace. Explicit directory listing remains live. Ignore rules, workspace path
checks, cancellation and quoting of filenames with spaces remain unchanged.

File edit approvals display context and added/removed lines, with fragment-relative
line numbers and an explicit replace-all warning. Write approvals show proposed
additions and say that no original on-disk file was read; they do not invent a
full overwrite Diff. PgUp/PgDn still scrolls the complete approval and Enter/Esc
keeps its existing allow/deny meaning. The preview itself never executes a tool.

Idle approval/question/turn-end/background reminders emit only generic terminal
notifications: no prompts, code, paths or command arguments. A focused terminal
waits six seconds of inactivity; an unfocused terminal waits at least 500 ms.
Notifications are deduplicated and resolved requests stop pending reminders.
iTerm/Ghostty use a terminal notification; other terminals/tmux fall back to BEL,
whose presentation depends on terminal preferences. No desktop process or external
messaging service is launched. Disable at the next TUI launch with:

```sh
tnb config set ui.notifications false
```

`/ide attach` adds the matching IDE bridge's last published selection to an editable
structured text reference in the draft. It does not submit a prompt. `/ide` lists
bridges; Enter on an active bridge attaches from that bridge. With multiple bridges
use `/ide attach "descriptor-path"`. The bridge must be authenticated and match
the current workspace. Paths, ranges, symlink boundaries and a 32 KiB selection
limit are validated; the reference records file and line/column range. Unsaved
editor text is a snapshot, not a claim about current disk contents. If the editor
did not publish selected text, only the requested range is read from a file up to
1 MiB. No editor polling or silent full-file attachment is introduced. Existing
text/image references in an asynchronously edited draft are preserved.

### 工作区内容检索与消息复用

- `/search <text>`：按字面内容检索当前主工作区，遵循 ignore，排除依赖和构建目录；最多 200 条，每文件最多 10 条，单文件最多 1 MiB，3 秒超时。显示命中行及前后两行上下文，Enter 将路径行号引用加入草稿，不发送模型。截断会明确提示。
- `Ctrl+Shift+Up/Down`：选择上一条/下一条消息；`Alt+E` 将选中用户消息放回空草稿，保留原对话；`Alt+P` 复制选中工具输入。已有 `Ctrl+Shift+C` 复制选中消息。可在 keybindings.json 中设置 previousMessage、nextMessage、editMessage、copyToolInput。
- 前台子 Agent 显示真实模型/工具阶段、最近工具及事件时耗时；后台任务继续使用任务工作台。
- 终端失焦期间的前台工具执行会在返回后汇总成功/失败次数及待处理数量，不额外调用模型，也不保存工具内容。终端须支持焦点事件。

### Web 工作台的参考交互

`tnb web` 打开的对话页也支持本轮交互：

- 顶部“搜索代码”按字面内容检索入口固定的工作区，显示前后两行上下文。选择文件行号只会追加到当前草稿，Escape 关闭搜索并取消请求；新的检索会取消同一浏览器会话的旧检索。
- 每条消息可以复制显示内容；用户消息可“编辑复用”。已有草稿时保留原内容，不覆盖、不自动发送，不回滚历史。
- 子 Agent 工具卡显示真实阶段、最近工具和事件时耗时。工具卡单独展开，实时刷新保留展开状态和键盘焦点。
- 从隐藏标签页返回时，页面会核对当前所选对话，展示新完成的回复、工具结果和待批准数量。摘要来自最近 64 条消息投影，不调用模型，不代表完整的后台任务审计；后台任务继续在工作台查看。

Web 复用 host 的内容检索与终端执行器。搜索接口保持同源登录与工作区隔离，只接受 query；授权、重试身份和额度归属没有变化。

### 分轮审阅、恢复和历史

- `/mcp reconnect <server>`：只重连指定 MCP 服务。交互宿主将连接失败的服务与健康服务隔离；失败的重连保留旧连接。`/mcp` 展示已观测连接状态，`/mcp reload` 仍用于整体重新加载配置。底层严格连接器和后台任务连接策略不变。
- `/changes [turn]`：审阅指定轮次（默认最后一轮）的已记录 edit/write 操作，使用写入锁内的实际前后内容；多次编辑按操作分别列出。它不等于 `/diff`，不包含推测的 Shell 或外部改动。超过 32 KiB 的快照仅保存哈希；旧会话可能没有证据。轮次按 native 会话记录计算，包含压缩/回退前的历史执行。
- `/history [query]`：检索当前工作区原生历史中的用户输入、回答与工具输出，包括压缩前的记录。显示来源和命中片段，最多 100 条；完整用户文本只放入空草稿，回答/工具输出作为引用加入草稿，不自动发送、不附带媒体。每次最多扫描最近 256 个会话、64 MiB，单会话审计上限 32 MiB；超过 32 KiB 的单条文本只提供命中片段，扫描与结果截断会提示。
- `/sessions` 默认读取最近 20 项；`/sessions <query>` 搜索更早会话及中间输入。按 I 或 `/session-preview <id>` 才加载完整对话预览。索引按文件大小、修改时间、变更时间和 inode 校验，内存最多缓存 128 个会话。
- `/compactions`：查看压缩时间、前后估算 token 数与摘要；Enter 展开，Esc 关闭，不调用模型。自动压缩完成后也会显示通知。

Web 对话中的模型回答支持 Markdown 标题、列表、表格、代码块和 HTTP(S)/mailto 链接。原始 HTML 按文字展示，脚本 URL 不生成链接，图片不自动加载；复制操作仍复制原文。审阅快照仅用于本地记录，不进入模型请求或增加压缩预算估算。

### 页脚与执行反馈

至少 80 列的终端将底部信息横向铺成两行：模型/权限与快捷键共用左列，上下文与会话累计 token 共用中列，目录与费用共用右列。窄屏按空间折为三行，短窗口压缩为两行，优先保留模型、本轮额度和操作入口。“上下文 待获取”表示尚无可用占比，不表示零占用；会话累计 token 不是当前上下文大小。

轻量旧工具输出清理仅进入 `/compactions` 记录；完整摘要、较早轮次折叠分别提示，类型缺失的历史记录不冒充完整摘要。Bash 卡显示实际 `exit N`，退出 0 使用中性标记；非零退出保留失败标记和原输出。进程状态不代表目标已经验收，管道返回值沿用原 Shell 语义。

### Web 检查面板与变更观测

Web 对话页增加“历史全文”“分轮改动”“压缩记录”“MCP 管理”。改动与压缩绑定已选会话；历史限定入口工作区。选择历史只加入草稿；已有草稿不会被用户输入复用覆盖。服务保持同源认证，拒绝客户端指定其他工作区、配置路径、环境或任意命令。

MCP 面板默认只读配置状态，不启动服务；点击“检查 / 重建诊断连接”并确认后才尝试连接。此连接用于诊断，与正在执行的对话独立，不声称重连了运行中的对话，不调用工具、不授予权限、不显示凭证。OAuth 使用 `tnb mcp auth <server>` 完成。

前台 Shell 在 Git 工作区中记录有界版本观测，区分命令窗口内变化和两次命令间变化。`/changes` 和 Web 审阅将这些结果标为“来源未确认”，保留 edit/write 的精确前后证据。观测不证明修改者；不覆盖尚未发生下一次采样的外部变化，也不持续监听后台进程。最多 5000 个跟踪项、200 个脏文件、每文件 256 KiB、总读取 4 MiB；Git 输出与耗时有界，观测取消/失败不改变命令结果。超限、非 Git、符号链接或不稳定文件会明确形成不完整覆盖，不伪造删除或修改。观测元数据不会进入模型请求或额外触发模型调用。

### Web 会话翻页与工作状态

会话侧栏可按标题、ID、provider/model 筛选。较早的 Web 消息按每页 64 条加载；旧页不会被实时回复覆盖，授权与工作状态仍更新。使用“较新一页”沿固定游标返回，或“返回最新消息”切回实时跟随；翻页不改变草稿、不重发模型请求。消息只保留当前页与最新投影，导航游标最多保留 256 项；始终可以返回最新。分页游标限定当前会话，非法或跨工作区游标被拒绝。

Web 状态使用真实事件区分请求模型、思考、准备工具、运行工具、等待重试、等待授权与停止中，显示本轮耗时及已知的重试倒计时；不显示或额外存储思考正文，不改变模型预算与重试策略。

FileChanged 对明确配置的文件 matcher 增加 500ms 元数据轮询兜底，恢复可能丢失的原生文件通知；与原生事件合并去重，关闭监听后不再触发。该兜底不递归扫描整个工程。

上下文页脚的数据来源明确区分：恢复时为“历史文本 ≈N tokens”，不是完整请求；主对话准备请求后为“上下文 ≈N%”，包含已准备的系统提示/工具定义/文本；有媒体时明确标为文本估算并附“+媒体”。模型返回输入用量后为不带 ≈ 的实报占比。输出-only usage 不会清零输入。上述显示不使用会话累计 token 推算当前上下文，也不改变额度限制。


## Explicit domain tasks

Installed business Adapters can be selected without replacing the default Coding route:

```sh
tnb runtime adapters
tnb runtime submit "Review the ticket" --adapter ./task.json --namespace support --mode single
tnb runtime list --namespace support
tnb runtime followup <run-id> --namespace support --text "Additional acceptance criteria"
```

The same options work with `/runtime submit` and `/task`; implicit `/task status --namespace support` selection stays inside that namespace. The descriptor is bounded JSON containing business config, resource claims and capability grants. Coding flags cannot be mixed into a domain submission. See [domain tasks](guides/domain-tasks.md) for setup, questions, recovery and client API contracts.
