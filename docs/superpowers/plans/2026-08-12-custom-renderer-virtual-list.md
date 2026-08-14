# Custom Renderer and Virtual Transcript Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace public Ink with the authorized custom renderer and use its selection, ScrollBox, and virtual-list system across tnb's transcript and management surfaces.

**Architecture:** `src/ui/ink/` is the renderer boundary; tnb components keep their current React/state contracts. A thin tnb adapter feeds `TranscriptEntry` into the renderer's virtual list, while Session Browser and management views reuse ScrollBox without importing reference business types.

**Tech Stack:** Bun, TypeScript, React 19, react-reconciler, Yoga, PTY integration, ANSI/OSC/Kitty terminal protocols.

---

### Task 1: Isolated custom renderer

**Files:**
- Create: `src/ui/ink/**`
- Create: `src/ui/ink/index.ts`
- Create: `src/ui/ink/compat-render.tsx`
- Modify: `package.json`
- Test: `tests/unit/custom-ink-renderer.test.tsx`

- [ ] Copy only the authorized renderer/DOM/layout/event modules required by `Box`, `Text`, `render`, `renderToString`, `useInput`, `useApp`, `useStdout`, and `measureElement`.
- [ ] Replace reference-only imports (`bootstrap`, logging, native Yoga facade) with tnb-local adapters.
- [ ] Add exact runtime dependencies required by the copied renderer; do not copy unrelated application dependencies.
- [ ] Introduce `compat-render.tsx` as a temporary boundary-only renderer fixture. It must exercise tnb-equivalent static chrome through `src/ui/ink/index.ts` without rewriting production imports; the full current `TuiView` switches in Task 2.
- [ ] Assert wrapping, borders, colors, and fixed terminal dimensions through that fixture.
- [ ] Run `bun test tests/unit/custom-ink-renderer.test.tsx && bun x tsc --noEmit`.

### Task 2: Switch tnb renderer imports

**Files:**
- Modify: every `src/ui/**/*.tsx` importing `ink`
- Modify: `src/ui/app.tsx`
- Test: `tests/unit/tui-view.test.tsx`
- Test: `tests/unit/transcript-row-frame.test.tsx`

- [ ] Change renderer imports to `src/ui/ink/index.ts` without changing component behavior.
- [ ] Switch `runTui` to the custom renderer lifecycle.
- [ ] Verify alternate-screen cleanup, resize, and exit behavior.
- [ ] Remove public Ink usage only after `rg 'from "ink"' src` is empty.
- [ ] Run TUI unit tests, typecheck, and build.

### Task 3: Screen selection and terminal events

**Files:**
- Adapt: `src/ui/ink/screen.ts`
- Adapt: `src/ui/ink/selection.ts`
- Adapt: `src/ui/ink/events/**`
- Adapt: `src/ui/ink/parse-keypress.ts`
- Adapt: `src/ui/ink/terminal.ts`
- Test: `tests/unit/custom-ink-selection.test.ts`
- Test: `tests/e2e/tui-selection-pty.test.ts`

- [ ] Add failing tests for drag selection, word/line expansion, soft-wrap copy, resize, and scrolled-off text.
- [ ] Wire SGR mouse press/move/release and extended keyboard events to the screen buffer.
- [ ] Copy screen selection through OSC 52, including tmux passthrough.
- [ ] Preserve selected cells across repaint until explicit clear/copy.
- [ ] Verify in a bounded PTY harness with unconditional teardown.
- [ ] Phase gate: run selection and PTY tests, then `bun x tsc --noEmit` and `bun run build`.

### Task 4: ScrollBox and virtual list foundation

**Files:**
- Adapt: `src/ui/ink/components/ScrollBox.tsx`
- Create: `src/ui/virtual/use-virtual-scroll.ts`
- Create: `src/ui/virtual/VirtualList.tsx`
- Test: `tests/unit/virtual-list.test.tsx`

- [ ] Test variable row heights, overscan, scroll-to-index, width invalidation, resize anchoring, and follow-bottom.
- [ ] Port the renderer-generic ScrollBox behavior.
- [ ] Adapt the reference virtual scroll algorithm to generic keyed tnb items.
- [ ] Expose imperative navigation and visible-range state.
- [ ] Phase gate: run virtual-list tests, then `bun x tsc --noEmit` and `bun run build`.

### Task 5: Virtual transcript

**Files:**
- Create: `src/ui/transcript/VirtualTranscript.tsx`
- Modify: `src/ui/tui.tsx`
- Modify: `src/ui/transcript/entry-view.tsx`
- Test: `tests/unit/virtual-transcript.test.tsx`

- [ ] Feed stable `TranscriptEntry.id` keys and existing tool-card rows into `VirtualList`.
- [ ] Implement per-entry cursor, click expansion, follow-bottom, and sticky user prompt.
- [ ] Replace `TranscriptViewport` only after existing search navigation, prompt pinning, and message-copy fallback are wired through adapter-compatible behavior; optimized visible-match highlighting lands in Task 7.
- [ ] Verify long/CJK/Markdown/tool transcripts and resumed histories.
- [ ] Phase gate: run virtual-transcript and existing transcript tests, then `bun x tsc --noEmit` and `bun run build`.

### Task 6: Session Browser and management surfaces

**Files:**
- Create: `src/ui/management/ManagementLayout.tsx`
- Create: `src/ui/management/SessionBrowser.tsx`
- Modify: `src/ui/tui.tsx`
- Test: `tests/unit/session-browser.test.tsx`
- Test: `tests/unit/management-layout.test.tsx`

- [ ] Build a two-pane ScrollBox layout with independent focus and scrolling.
- [ ] Render full virtual transcript in the selected session preview.
- [ ] Preserve resume/rename/fork/delete and MCP/Plugin/Skill/Hook actions with confirmation dialogs.
- [ ] Remove manual slicing from management rendering.
- [ ] Phase gate: run Session Browser and management tests, then `bun x tsc --noEmit` and `bun run build`.

### Task 7: Search/highlight optimization and clipboard precedence

**Files:**
- Adapt: `src/ui/ink/searchHighlight.ts`
- Adapt: `src/ui/ink/hooks/use-search-highlight.ts`
- Modify: `src/ui/transcript/VirtualTranscript.tsx`
- Modify: `src/ui/app.tsx`
- Test: `tests/unit/transcript-search-highlight.test.tsx`
- Test: `tests/e2e/tui-search-pty.test.ts`

- [ ] Preserve the Task 5 search/copy/sticky parity while warming a cached lowercase search index without blocking the first paint.
- [ ] Incrementally scan visible DOM rows and highlight all matches/current match.
- [ ] Implement next/previous match, manual-scroll disarm, and anchor restoration.
- [ ] Copy active cell selection before message-cursor fallback.
- [ ] Keep sticky prompt tracking synchronized with virtual scroll positions.
- [ ] Phase gate: run search-highlight and PTY tests, then `bun x tsc --noEmit` and `bun run build`.

### Task 8: Delete temporary viewport and perform PTY verification

**Files:**
- Delete: `src/ui/transcript/TranscriptViewport.tsx`
- Delete: `src/ui/transcript/viewport-state.ts`
- Delete: `src/ui/transcript/mouse-input.ts`
- Delete: `src/ui/transcript/row-frame.tsx` only after `entry-view.tsx` and the custom renderer fully own row presentation and `rg 'row-frame' src tests` is empty
- Modify: `README.md`, `docs/commands.md`, `docs/architecture-reference.md`
- Test: `tests/e2e/tui-custom-renderer-pty.test.ts`

- [ ] Prove no old viewport import remains with `rg`.
- [ ] Prove `row-frame.tsx` has no consumers with `rg 'row-frame' src tests`, then delete it; do not delete it while presentation tests still depend on it.
- [ ] Exercise wheel, PageUp/PageDown, half-page, top/bottom, resize, selection, copy, search, Session Browser, and clean exit in the PTY harness.
- [ ] Run `bun test`, `bun x tsc --noEmit`, and `bun run build`.
- [ ] Make each PTY harness record its root child PID and descendants, then assert all owned processes exit during `finally`; use `pgrep -fal '(^|/)(bun|tnb)( |$)'` only as a secondary sanity check and never kill unrelated matches.
- [ ] Remove the public Ink dependency when no runtime/test import remains.
