# Transcript Viewport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace record-count transcript paging with a true terminal-row viewport supporting wheel, line, half-page, page, top/bottom and sticky follow-bottom behavior.

**Architecture:** First migrate TUI reducer output into an append-only ordered transcript event stream with stable IDs and revisions. Render each entry through Ink at the exact content width into cached row frames, feed those frames to a pure viewport state machine, and add a fullscreen-only SGR wheel adapter owned by `runTui`. Existing modal priority and input editor behavior remain intact.

**Tech Stack:** Bun, TypeScript, React 19, Ink 6, `@lydell/node-pty`, Bun test.

**Design:** `docs/superpowers/specs/2026-08-12-transcript-viewport-design.md`

---

### Task 1: Ordered transcript event state

**Files:**
- Create: `src/ui/transcript/model.ts`
- Modify: `src/ui/tui-state.ts`
- Modify: `src/ui/tui.tsx`
- Modify: `src/ui/slash-commands.ts`
- Modify: `src/entrypoints/cli.ts`
- Test: `tests/unit/tui-state.test.ts`

- [x] **Step 1: Write failing reducer tests**

Add tests proving:

```ts
expect(state.transcript.map(({ kind }) => kind)).toEqual([
  "user",
  "tool",
  "assistant",
]);
expect(updatedTool.id).toBe(startedTool.id);
expect(updatedTool.revision).toBe(startedTool.revision + 1);
expect(committedAssistant.id).toBe(streamingAssistant.id);
```

Cover submit → tool start → tool finish → streamed assistant → turn complete, restored session ordering (including interleaved `tool_use`/`tool_result` blocks), and session reset.

- [x] **Step 2: Run the tests and confirm RED**

Run: `bun test tests/unit/tui-state.test.ts`

Expected: failures because `transcript`, stable IDs and revisions do not exist.

- [x] **Step 3: Define transcript entry types**

In `src/ui/transcript/model.ts`, define discriminated user/assistant/system/tool entries with common `id`, `sequence`, and `revision`. Add pure constructors and revision helpers; do not import React or Ink.

- [x] **Step 4: Migrate reducer actions**

Update `createTuiState` and `reduceTuiState` to append entries at action arrival, revise tool/stream entries in place, preserve draft assistant identity on commit, and clear sequence state on reset.

Replace the lossy `conversationDisplayMessages()` restore path with `conversationDisplayTranscript()`. It must walk canonical message content blocks in persisted order: append user/assistant text entries, append a tool entry for each assistant `tool_use`, then revise that same entry when the matching user `tool_result` arrives. Pass the structured restored transcript through `SlashCommandResult` rather than flattening it into message strings.

- [x] **Step 5: Render the ordered transcript**

Change `TuiView` to read transcript entries rather than independently mapping `messages`, `tools`, and `streamingText`. Keep todos, tasks and MCP activity as out-of-band live panels.

- [x] **Step 6: Run focused tests and confirm GREEN**

Run: `bun test tests/unit/tui-state.test.ts tests/unit/tui-view.test.tsx`

Expected: pass; existing visible behavior remains intact while tool/message order is now deterministic.

### Task 2: Pure row viewport state machine

**Files:**
- Create: `src/ui/transcript/viewport-state.ts`
- Test: `tests/unit/transcript-viewport-state.test.ts`

- [x] **Step 1: Write failing viewport-state tests**

Cover line/page/half-page movement, clamp behavior, top/bottom, follow-bottom break/restore, content growth while pinned/detached, resize at top/middle/bottom, and zero dimensions.

- [x] **Step 2: Run and confirm RED**

Run: `bun test tests/unit/transcript-viewport-state.test.ts`

Expected: module-not-found or missing-export failure.

- [x] **Step 3: Implement pure operations**

Implement:

```ts
createViewportState(viewportHeight, contentHeight)
scrollBy(state, rows)
scrollPage(state, direction)
scrollHalfPage(state, direction)
scrollToTop(state)
scrollToBottom(state)
resizeViewport(state, viewportHeight)
updateContentHeight(state, contentHeight)
```

Manual movement away from max clears `followBottom`; a downward movement that reaches max restores it.

- [x] **Step 4: Run and confirm GREEN**

Run: `bun test tests/unit/transcript-viewport-state.test.ts`

Expected: all viewport-state tests pass.

### Task 3: Ink-derived row frames and caching

**Files:**
- Create: `src/ui/transcript/entry-view.tsx`
- Create: `src/ui/transcript/row-frame.tsx`
- Modify: `src/ui/markdown.tsx`
- Modify: `package.json` and `bun.lock` only if direct ANSI-width imports are required
- Test: `tests/unit/transcript-row-frame.test.tsx`

- [x] **Step 1: Write failing row-frame tests**

Render entries at fixed widths and assert exact rows for wrapped ASCII, CJK, combining characters, Markdown/code borders and explicit blank lines. Add cache tests for stable `(id, revision, width, theme, expansion)` keys and invalidation on every varying key.

- [x] **Step 2: Run and confirm RED**

Run: `bun test tests/unit/transcript-row-frame.test.tsx`

- [x] **Step 3: Extract reusable entry presentation**

Move current message and tool display functions into `entry-view.tsx`, preserving visual output. Keep live task/todo/MCP components in `tui.tsx`.

- [x] **Step 4: Implement frame rendering**

Use `renderToString(<TranscriptEntryView ... />, { columns: contentWidth })` as the single wrapping/layout authority. Split its returned output only on rendered newlines. Return rows plus the entry's `[startRow, endRow)` range.

- [x] **Step 5: Implement bounded cache**

Cache frames by exact spec key with a conservative LRU bound. Session reset clears the cache. Do not cache failures; fall back to a plain-text error row for only the affected entry.

- [x] **Step 6: Run and confirm GREEN**

Run: `bun test tests/unit/transcript-row-frame.test.tsx tests/unit/tui-view.test.tsx`

Expected: row/caching tests pass and current presentation regressions stay green.

### Task 4: TranscriptViewport component and follow-bottom

**Files:**
- Create: `src/ui/transcript/TranscriptViewport.tsx`
- Create: `src/ui/transcript/layout.tsx`
- Modify: `src/ui/tui.tsx`
- Modify: `src/ui/app.tsx`
- Delete obsolete record paging helpers from: `src/ui/app.tsx`
- Test: `tests/unit/transcript-viewport.test.tsx`
- Test: `tests/unit/tui-view.test.tsx`

- [x] **Step 1: Write failing component tests**

Cover a single long Markdown entry scrolling by rows, a large tool entry, detached content growth, bottom repinning, width resize, and modal open/close preserving state.

- [x] **Step 2: Run and confirm RED**

Run: `bun test tests/unit/transcript-viewport.test.tsx`

- [x] **Step 3: Implement the component**

Compose cached frames, update the pure viewport state with measured height, slice exactly `[scrollTop, scrollTop + viewportHeight)`, render visible rows, and expose scroll commands through a controller/ref.

- [x] **Step 4: Integrate fixed chrome**

Replace the current flex clipping block with `TranscriptViewport`. Derive content width from terminal width minus explicit outer padding. Add `measureTuiLayout()` in `layout.tsx`: render the same header and lower-chrome React fragments used by `TuiView` through Ink `renderToString` at that exact width, count their rendered rows (including explicit spacer rows), and compute `viewportHeight = max(0, terminalRows - headerRows - lowerChromeRows)`. Suggestions and completion rows are therefore included when present; wrapped/multiline prompt rows are measured rather than assumed. Modal views continue to replace the transcript surface and do not participate in viewport sizing.

- [x] **Step 5: Remove record-count scrolling**

Delete `transcriptOffset`, `navigateTranscript`, `transcriptRecordCount`, and the associated record-slice logic. Status now reports newer terminal rows, not records.

- [x] **Step 6: Run focused tests and confirm GREEN**

Run: `bun test tests/unit/transcript-viewport.test.tsx tests/unit/tui-view.test.tsx tests/unit/tui-input.test.ts`

### Task 5: Keyboard scroll routing

**Files:**
- Create: `src/ui/transcript/input.ts`
- Modify: `src/ui/app.tsx`
- Test: `tests/unit/transcript-input.test.ts`

- [x] **Step 1: Write failing mapping/propagation tests**

Assert PageUp/PageDown, Ctrl+U/Ctrl+D, Shift+Up/Down and Ctrl+Home/End mappings. Assert plain Up/Down stays in the editor, modal priority wins, and Ctrl+D falls through to forward delete when the viewport cannot scroll down.

- [x] **Step 2: Run and confirm RED**

Run: `bun test tests/unit/transcript-input.test.ts`

- [x] **Step 3: Implement conditional routing**

Return `{ handled, command }`; do not directly mutate React state in the mapper. `TuiApp` sends handled commands to the viewport controller before applying editor input.

- [x] **Step 4: Run and confirm GREEN**

Run: `bun test tests/unit/transcript-input.test.ts tests/unit/tui-input.test.ts`

### Task 6: SGR mouse wheel lifecycle

**Files:**
- Create: `src/ui/transcript/mouse-input.ts`
- Modify: `src/ui/app.tsx`
- Test: `tests/unit/transcript-mouse-input.test.ts`

- [x] **Step 1: Write failing parser/lifecycle tests**

Cover complete and split SGR wheel sequences, unrelated bytes, enable/disable control sequences, subscriber disposal, modal-ignore policy, and unsupported mouse bytes not becoming editor text.

- [x] **Step 2: Run and confirm RED**

Run: `bun test tests/unit/transcript-mouse-input.test.ts`

- [x] **Step 3: Implement parser/controller**

Observe the existing stdin stream without changing raw mode. Buffer only an incomplete possible SGR suffix. Publish `-3/+3` row commands for buttons 64/65.

- [x] **Step 4: Own lifecycle in `runTui`**

Enable SGR mouse after alternate-screen entry, pass the controller into `TuiApp`, and always detach/disable it in `finally` before alternate-screen exit.

- [x] **Step 5: Run and confirm GREEN**

Run: `bun test tests/unit/transcript-mouse-input.test.ts tests/unit/tui-input.test.ts`

### Task 7: PTY end-to-end verification

**Files:**
- Create: `tests/e2e/tui-pty.test.ts`

- [ ] **Step 1: Build a leak-safe PTY harness**

Blocked on this host: `@lydell/node-pty` immediately exits the compiled Bun binary with signal 1 and emits no PTY data. Parser/lifecycle unit tests cover enable/disable and disposal; process snapshots confirm no leak. Keep this item open for a Node-hosted PTY fixture or upstream runtime fix.

Use `@lydell/node-pty` to spawn `dist/tnb --resume <fixture-id>` with a temporary `TNB_HOME`/workspace and a session written through `SessionStore`. The fixture transcript contains stable markers `ROW-000` through `ROW-080`. Feed every PTY chunk into an `@xterm/headless` terminal configured to 80 columns by 24 rows. Register a hard timeout and a `finally` block that kills and disposes the PTY.

- [ ] **Step 2: Add interaction assertions**

Read the current screen with `terminal.buffer.active.getLine(y)?.translateToString(true)`. Wait until `ROW-080` is visible, send PageUp and assert an earlier marker plus the `newer` status, send Ctrl+End and assert `ROW-080` returns, then send SGR wheel-up bytes (`\x1b[<64;1;1M`) and assert an older marker becomes visible. Send Ctrl+U as the half-page case. Finally send Ctrl+C and assert the raw captured stream contains SGR mouse enable (`\x1b[?1000h`, `\x1b[?1006h`), matching disable sequences, alternate-screen exit, and a child-process exit event.

- [ ] **Step 3: Run the E2E test twice**

Run: `bun run build && bun test tests/e2e/tui-pty.test.ts && bun test tests/e2e/tui-pty.test.ts`

Expected: both runs pass without hanging.

- [ ] **Step 4: Verify no leaked processes**

Run:

```bash
ps -axo pid=,ppid=,command= | rg '/Users/aias/Work/github/codercli-app/dist/tnb|bun test' || true
```

Expected: only the inspection command itself; do not kill unrelated pre-existing processes.

### Task 8: Full regression and documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/commands.md`
- Modify: `src/entrypoints/cli.ts` (`/shortcuts` help text)
- Modify: `docs/superpowers/plans/2026-08-12-transcript-viewport.md` checkboxes

- [x] **Step 1: Document controls and follow behavior**

Document wheel, PageUp/PageDown, Ctrl+U/Ctrl+D, Shift aliases, top/bottom shortcuts, and the rule that streaming does not steal a detached viewport.

- [x] **Step 2: Run complete verification**

Run:

```bash
bun run typecheck
bun test
bun run build
```

Expected: zero type errors, all tests pass, and both compiled binaries build.

- [ ] **Step 3: Perform one real-terminal smoke test**

Start `dist/tnb`, create or resume a long transcript, verify wheel/page/half-page/top/bottom and follow-bottom, exit, then re-run the process snapshot.

- [ ] **Step 4: Record evidence and next phase**

Update this plan with actual test counts and note that phase 2 is tool-call cards: expansion, duration, result summaries, Edit diff and live Bash output.

> Repository note: the current `main` branch has no commits and all implementation files are untracked. Do not create a worktree or make piecemeal commits until the user establishes the initial repository baseline; doing so would omit the existing implementation or accidentally define an incomplete root commit.
