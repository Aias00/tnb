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
