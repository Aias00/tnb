# Terminal interaction improvements

Compared the local `/Users/aias/Work/claude-code` source with tnb. The useful
reference is the interaction contract, rather than its SDKs, telemetry, or
product-specific UI dependencies. No source files from that project are copied
by this change, and no dependencies are added.

## Adopted behavior

- **Draft during a turn and queue on Enter.** The reference's
  `src/utils/handlePromptSubmit.ts` separates editing from active-turn execution.
  tnb now retains structured prompts (including pasted text and images) in an
  per-session durable FIFO and executes them through the existing submission path only
  after the current turn and any permission/question/management dialog finish.
- **Keep the current draft.** Starting a queued turn adds the submitted prompt
  to history without clearing whatever the user is currently writing. Escape
  interrupts the active turn without deleting that draft. Pending prompts remain
  queued; this is an interrupt, not a queue-clear operation.
- **Select command suggestions.** Up/Down selects a slash command, Tab/Enter
  completes a prefix, and Enter submits an exact command. Suggestions and
  keyboard handling use the same selected index.
- **Bound editor height.** The existing cursor-aware viewport is now enabled in
  the TUI, capped at six lines and reduced for short terminals. Mouse mapping
  uses the same viewport limit. Suggestion help rows count toward layout.

## Existing capabilities retained

Collapsed paste storage, prompt history, undo, image references, external editor,
transcript scrolling and tool cards already exist in tnb. They should be improved
in place rather than replaced with a second editor or the reference's product
runtime. Queue state uses the existing durable input store, shared by Ctrl+Q and
the Ctrl+T task workbench. Inputs with an interrupted/unconfirmed dispatch remain
saved and require inspection rather than automatic replay.

## Verification

`tests/unit/tui-interaction.test.tsx` drives real input events through the TUI
and a headless terminal. It checks FIFO execution, no overlapping model turns,
paste expansion, draft retention, and Escape interruption. View tests cover
long-input visibility and selected command/queue feedback. Existing PTY tests
cover terminal lifecycle and bracketed paste.

## Visual hierarchy

Theme accents now propagate through a shared React context to user/assistant
markers, active tools, management views, runtime panels and question dialogs.
Neutral borders and terminal-default body text avoid coloring entire prompts or
tool titles. Tool icons retain success/failure semantics; permission dialogs
retain warning colors. Model names and user/tool titles use weight for hierarchy.
The terminal owns background and normal foreground, preserving its light/dark
palette and color capability settings. `/theme` retains the four existing accent
choices; no new theme format or dependencies are introduced.

## Integrated interaction controls

| Capability | Controls and behavior |
| --- | --- |
| Queue management | Ctrl+Q opens the same durable queue as Ctrl+T. Up/Down selects; Enter/E takes the prompt back for editing while retaining the saved original; D/Delete requests removal with Y confirmation. PgUp/PgDn scrolls the full preview. Execution pauses while the panel is open. Taking a prompt back refuses to overwrite an existing draft and retains structured paste/image payloads. |
| Configurable shortcuts | The prompt controller receives the same keybinding map as the application. Remapping or disabling image paste and external-editor shortcuts takes effect. Ctrl+K/U/W cut text, Ctrl+Y yanks, Alt+Y cycles cuts, and modified Left/Right moves by word. Forward Delete and Backspace are distinct. Image attachments stay intact under text cut shortcuts; Backspace removes them. |
| Per-tool output | Alt+Up/Down selects a tool card; Alt+Enter toggles that card. Clicking a card also toggles it. Ctrl+O toggles all cards and clears individual overrides. Footer and expansion hints follow configured bindings. |
| Diff and output | Edit previews use a bounded line LCS, preserve shared context, distinguish insertions/deletions, and show fragment-relative line numbers. Compact previews start near the first change. Long outputs fold both lines and long individual lines; failures retain the end of the error output. Expanding a Read card shows its content. |
| Runtime feedback | The activity row distinguishes requesting, thinking, writing and tools, displays total turn time, and reports cancellation while awaiting shutdown. Interrupted tool cards stop running. Permission/question waits receive explicit labels. |
| Session navigation | In a session browser, / starts a live filter over title, ID and prompt previews. Enter accepts the filter; a further Enter resumes the visible selection. Escape clears a filter being edited. PgUp/PgDn scrolls the conversation preview, including narrow layouts. The browser retains its existing recent-20 limit; `/sessions <query>` searches history before that limit is applied. Switching/clearing sessions detaches the old session queue without executing or deleting it. |
| Markdown theme | Headings, list markers, links and inline code inherit the active accent. Code syntax highlighting retains its language-specific colors. |

Additional configurable actions in `~/.tnb/keybindings.json`: `promptQueue`,
`previousTool`, `nextTool`, and `toggleTool`. See `/shortcuts` for the active map.
Per-card expansion remains process-local; queued inputs use the per-session
durable store. Its limits and recovery behavior are described in
[the durable runtime guide](durable-runtime.md#对话中的任务工作台).

Behavior was implemented in tnb's existing components after examining the local
reference's prompt submission/editor, queued-command view and design-system
colors. Product-specific services, SDKs and source files were not imported.

## File selection, workspace review and layout follow-up

- Typing an `@` reference opens a debounced file menu. Queries such as `@widget`
  also match nested workspace filenames using a bounded `rg --files` scan that
  respects ignore rules. Explicit relative paths retain directory completion;
  dotfiles are offered when the query explicitly starts with a dot. Symlink
  directory escapes, parent traversal and absolute paths are rejected.
- Suggestions are previews. Up/Down changes selection without rewriting the
  draft. Tab/Enter accepts the selection; a later Enter submits. Replacement uses
  the cursor's current token, preserves trailing text and structured pasted
  content, and quotes paths containing spaces. Late or aborted results are
  discarded. References insert paths; they do not automatically attach file
  contents to model requests. Ordinary path and MCP completions remain available
  through Tab.
- `/diff` opens a read-only per-file browser covering staged and unstaged changes
  against HEAD, including untracked files. Up/Down selects a file, PgUp/PgDn
  scrolls its patch, Enter toggles a full-width preview, Esc returns/closes and
  R refreshes. `/diff "file name"` narrows the view. Binary/symlink files receive
  descriptive previews; new repositories without HEAD work. The list is bounded
  to 100 files, tracked patch previews to 100,000 characters and untracked text
  previews to 64 KiB. No files or Git index entries are changed by reviewing.
- The footer occupies exactly two rows. Input width accounts for outer padding
  as well as border/pointer width. Menus use a selection-centered visible window
  whose height adapts to terminal size. Input height, queue previews and activity
  panels share the remaining row budget so the prompt/footer stay visible.
  Expanded diff views use the full modal height. Mouse cursor mapping receives
  the actual input viewport size.

Regression coverage includes cursor-position completion, paths with spaces,
symlink confinement, nested filename matching, stale completion responses,
paste retention, selecting beyond the first visible menu page, 42×12-to-90×24
resizing, narrow diff browsing, and Git status equality before/after reviewing.

## Next reference adoption increment

The plan in `superpowers/plans/2026-11-06-reference-capability-adoption.md` assigns
Provider events to transport, context analysis to a shared service, restore policy
to checkpoint/session services and diagnostics to terminal configuration. This
increment implements retry progress, checkpoint preview/scopes, context categories
and keybinding warnings. It does not copy reference product source files, change
Web, add dependencies or move Coding filesystem policy into the generic kernel.

Tests exercise sanitized retry metadata, cancellation during backoff, fallback
after metadata-only retries, read-only and stale restore previews, all restore
scopes, context/media accounting, keyboard collisions and TUI phase transitions.
File index caching, richer approval Diff, idle notifications and IDE selections
are delivered in the follow-up below.

## Remaining four capabilities delivered

The follow-up implements the workspace index cache/ranking, approval Diff, host
idle notifications, and explicit IDE selection references from the adoption plan.
TUI consumes workspace/IDE/notification services; generic Core and Coding authority
remain unchanged. Web is untouched. The IDE host can share published context across
authenticated connections without sharing per-connection authentication state.
See `docs/commands.md` for commands, controls, size limits and notification behavior.

Focused tests cover cache expiry/coalescing/cancellation/ranking, edit/write preview
semantics and non-approving pagination, idle focus/dedupe/privacy, IDE range/size/
workspace confinement, two authenticated connections, and preserved structured
paste payloads when attaching to a draft. These capabilities have intentionally
bounded behavior rather than unbounded file watchers or automatic editor capture.

## Web 同步吸收

聊天页新增工作区内容搜索、消息复制与空草稿复用、结构化子 Agent 进度、标签页返回摘要。搜索结果用文本节点呈现，加入草稿后由用户决定是否发送；用户输入与工具结果不作为 HTML 注入。桌面和 390px 移动视口已做浏览器交互验证，摘要通过模拟 visibilitychange 验证，无额外模型请求。

## 恢复、审阅和历史（第三批）

交互 MCP 连接按服务隔离，支持指定服务重连和真实连接状态；新增 native 记录驱动的 `/changes` 分轮审阅、跨会话 `/history`、按需 `/session-preview` 和 `/compactions` 摘要浏览。默认会话列表限制为最近一页并复用文件版本缓存。Web 回答现在使用已有 marked 与受控 DOM 渲染 Markdown，保持原文复制、授权和预算归属。

## 阅读密度与任务空状态修正

Markdown 顶层段落、标题、列表和代码块之间保留一行间距，紧凑列表不额外拉开；长回答在宽终端中限制为 112 列内容宽度，窄终端继续按可用宽度换行。此调整仅影响显示，不修改回答或复制内容。

任务工作台补充当前前台执行，显示当前指令与真实运行阶段，完成后移除；前台仍使用当前终端预算，不创建后台 Run。空状态明确区分已完成的普通对话与后台任务，不再无依据地提示更新服务。

## 状态与上下文提示修正

宽度至少 80 列时使用两行横向分区页脚：第一行分布模型/权限、上下文、目录，第二行左侧快捷键、右侧费用与会话累计 tokens。窄于 80 列且至少 18 行时折为三行，更矮的窗口使用两行紧凑布局。上下文数据不可用时显示“待获取”，不将会话累计输入称为“前台上下文”。各面板与滚动区使用相同页脚高度预留。

轻量旧工具输出清理不再向对话插入黄色提示，但仍保存整理记录；完整摘要与较早对话折叠使用不同提示。`/compactions` 展示真实类型，轻量清理不会把保留的用户文本当成生成摘要。重复通知在当前调用内去重。

Bash 完成使用中性标记和实际进程退出码，不以绿勾暗示任务目标验收；非零退出仍显示失败，并保留退出码与原输出。输出中出现 error 不会被启发式重判，管道与目标程序是否成功需要依据实际执行结果核对。Web 工具卡同步显示已知退出码。

## Web 检查、全文历史与观测补齐

Web 增加历史全文、分轮改动、压缩记录和 MCP 诊断入口，共用工作区约束的 host inspection service。历史覆盖原生用户输入/回答/工具输出，命中结果带来源，超大文本仅展示片段；Web 和 TUI 均保持草稿确认后再发送。

Shell 版本观测与精确编辑证据分别呈现。窗口内观察和命令间观察都不声明修改者；大文件、非 Git、采样间隙等覆盖边界见 commands.md。MCP 检查明确是独立诊断连接，保留运行中对话的连接与权限语义。

## Web 会话导航和状态

增加会话侧栏筛选和有界历史分页，历史页与实时状态分离，保持草稿、授权与已展开工具。固定向前游标覆盖翻页期间新增消息的边界；切换会话或新建会话会取消过期分页结果。工作阶段来自真实模型/工具/批准/停止事件，重试倒计时不触发额外请求；并行工具状态独立于展示列表的大小上限。

完整验证发现的原生文件通知漏事件由显式 matcher 的轮询兜底修复，并增加“没有原生事件”和“关闭后迟到事件”回归。

## 上下文显示恢复修正

会话累计用量与上下文数据分开恢复。恢复旧会话时先显示“历史文本 ≈N tokens”（不含系统提示、工具定义和媒体成本）；准备主对话请求后显示带 ≈ 的请求文本估算，模型报告正数输入后切换为实报占比。仅报告输出的 usage 不清空已知输入，累计账本、子 Agent、维护摘要不会替换主对话上下文。切换模型/清空/回退/压缩会失效或重新计算对应估算，不将旧模型的值当作新模型实报。

该修复验收：完整 1315 pass / 3 平台 skip / 0 fail，相关六文件 74 pass；类型检查与构建通过。额外覆盖输出-only 用量保留输入、累计量不充当上下文、恢复估算/请求估算/实报切换、清空后的迟到回调隔离，以及观测器不可修改或中断实际请求。大输出测试拆分成功与失败进程，使各进程保留原有独立超时，不再共用一个测试期限。

页脚横向铺开修正：分区按终端列宽计算，目录居右、累计用量居右；缩窄时受控截断并优先保留本轮额度。滚动区和队列/工作台/管理面板共用同一高度计算，避免顶部标题被页脚挤出。
