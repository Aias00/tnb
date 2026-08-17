# Cursor Input Engine Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace tnb's code-unit prompt editor with the authorized Claude Code Cursor, Unicode segmentation, visual wrapping, and kill-ring engine while preserving tnb history, paste, session, and TUI contracts.

**Architecture:** Port the complete pure Cursor and Intl modules into `src/ui/input/`, then keep `InputBuffer` as an adapter boundary. A shared `PromptLayout` produced from Cursor becomes the only source for prompt rendering and prompt-height measurement. Main-prompt key routing enables kill/yank behavior; modal and PTY inputs keep basic editing.

**Tech Stack:** Bun, TypeScript, React, tnb custom Ink renderer, `Intl.Segmenter`, `strip-ansi`, Bun test.

**Reference specification:** `docs/superpowers/specs/2026-08-16-cursor-input-engine-design.md`

**Authorized source modules:**

- `/Users/aias/Work/github/codercli/claude-code/src/utils/Cursor.ts`
- `/Users/aias/Work/github/codercli/claude-code/src/utils/intl.ts`

---

## File map

**Create**

- `src/ui/input/cursor.ts` — complete Cursor, MeasuredText, wrapped-line, Unicode movement, kill-ring, and yank implementation.
- `src/ui/input/intl.ts` — cached grapheme and word segmenters used by Cursor.
- `src/ui/input/prompt-layout.ts` — canonical `PromptLayout` construction and terminal-width normalization.
- `tests/unit/cursor.test.ts` — direct Cursor/Unicode/kill-ring characterization tests.
- `tests/unit/prompt-layout.test.ts` — shared layout, viewport, wide-character, and resize tests.

**Modify**

- `src/ui/input-buffer.ts` — translate InputKeys to Cursor operations while preserving history/paste state.
- `src/ui/app.tsx` — supply prompt width, route main-prompt kill/yank keys, and keep modal/PTY scopes isolated.
- `src/ui/tui.tsx` — render the canonical PromptLayout instead of slicing the JavaScript string.
- `src/ui/transcript/layout.ts` — consume PromptLayout row count rather than recomputing wrapping.
- `tests/unit/tui-input.test.ts` — adapter, history, paste, Vim, Ctrl, and compatibility tests.
- `tests/unit/tui-view.test.tsx` — prompt rendering for wrapped/CJK/emoji input.
- `tests/unit/transcript-viewport.test.tsx` — height stability when prompt layout changes.
- `tests/e2e/tui-custom-renderer-pty.test.ts` — terminal lifecycle plus wrapped prompt smoke coverage.

## Task 1: Lock Cursor behavior with characterization tests

**Files:**

- Create: `tests/unit/cursor.test.ts`

- [ ] **Step 1: Add failing imports and grapheme movement tests**

```ts
import { beforeEach, describe, expect, test } from "bun:test";
import {
  Cursor,
  clearKillRing,
  getLastKill,
  pushToKillRing,
  recordYank,
  yankPop,
} from "../../src/ui/input/cursor";

describe("Cursor input engine", () => {
  beforeEach(() => clearKillRing());

  test("moves over emoji and combining sequences as complete graphemes", () => {
    const family = "👨‍👩‍👧‍👦";
    const text = `A${family}e\u0301B`;
    const afterA = Cursor.fromText(text, 40, 1).right();
    expect(afterA.offset).toBe(1 + family.length);
    expect(afterA.right().offset).toBe(1 + family.length + 2);
    expect(afterA.left().offset).toBe(1);
  });
});
```

- [ ] **Step 2: Add visual wrap and CJK tests**

```ts
test("moves vertically by wrapped terminal rows", () => {
  const cursor = Cursor.fromText("abcdefghij", 6, 7);
  expect(cursor.getPosition()).toEqual({ line: 1, column: 2 });
  expect(cursor.up().offset).toBe(2);
  expect(cursor.up().down().offset).toBe(7);
});

test("counts CJK as two terminal cells", () => {
  const cursor = Cursor.fromText("ab界cd", 6, 3);
  expect(cursor.getPosition().column).toBe(4);
  expect(cursor.right().offset).toBe(4);
});
```

- [ ] **Step 3: Add kill-ring and yank-pop tests**

```ts
test("accumulates consecutive kills and rotates prior kills", () => {
  pushToKillRing("world", "append");
  pushToKillRing("hello ", "prepend");
  expect(getLastKill()).toBe("hello world");
  pushToKillRing("replacement");
  recordYank(0, "replacement".length);
  expect(yankPop()?.text).toBe("hello world");
});
```

- [ ] **Step 4: Run the test and verify the port does not exist yet**

Run: `bun test tests/unit/cursor.test.ts`

Expected: FAIL with module-not-found for `src/ui/input/cursor`.

- [ ] **Step 5: Keep the red test as an uncommitted local checkpoint**

Run: `git diff --check`

Expected: no whitespace errors. Do not commit while the branch is red.

## Task 2: Port the complete Cursor and Unicode engine

**Files:**

- Create: `src/ui/input/intl.ts`
- Create: `src/ui/input/cursor.ts`
- Test: `tests/unit/cursor.test.ts`

- [ ] **Step 1: Port `intl.ts` without behavioral edits**

Use `apply_patch` to add the complete contents of the authorized
`claude-code/src/utils/intl.ts` as `src/ui/input/intl.ts`. Preserve lazy cached
`Intl.Segmenter`, relative-time, timezone, and locale helpers even when only the
segmenter helpers are initially consumed.

- [ ] **Step 2: Port `Cursor.ts` without algorithmic edits**

Use `apply_patch` to add the complete authorized `Cursor.ts` as
`src/ui/input/cursor.ts`. Apply only these mechanical import translations:

```ts
// reference
import { stringWidth } from "../ink/stringWidth.js";
import { wrapAnsi } from "../ink/wrapAnsi.js";
import { firstGrapheme, getGraphemeSegmenter, getWordSegmenter } from "./intl.js";

// tnb
import { stringWidth } from "../ink/stringWidth";
import { wrapAnsi } from "../ink/wrapAnsi";
import { firstGrapheme, getGraphemeSegmenter, getWordSegmenter } from "./intl";
```

Do not delete image/token helpers, Vim methods, caches, or kill-ring functions.
Do not register tnb's `[Pasted text ...]` or `[Image: ...]` syntax as tokens.

- [ ] **Step 3: Run Cursor tests**

Run: `bun test tests/unit/cursor.test.ts`

Expected: PASS for grapheme, wrap, CJK, and kill-ring cases. If an expected
offset differs, compare it with the authorized module behavior before changing
the test; do not alter the port to satisfy an incorrect assumption.

- [ ] **Step 4: Run typecheck**

Run: `bun x tsc --noEmit`

Expected: PASS without changing Cursor algorithms.

- [ ] **Step 5: Record a green local checkpoint without committing**

Run: `git diff --check`

Expected: no whitespace errors. Keep all migration work uncommitted until the
full verification task.

## Task 3: Introduce the canonical PromptLayout

**Files:**

- Create: `src/ui/input/prompt-layout.ts`
- Create: `tests/unit/prompt-layout.test.ts`

- [ ] **Step 1: Write failing PromptLayout tests**

```ts
import { describe, expect, test } from "bun:test";
import { buildPromptLayout } from "../../src/ui/input/prompt-layout";

describe("prompt layout", () => {
  test("uses one wrapped layout for rows and cursor position", () => {
    const layout = buildPromptLayout({ text: "abcdefghij", offset: 7, terminalColumns: 10, prefixColumns: 4 });
    expect(layout.contentColumns).toBe(6);
    expect(layout.totalWrappedLines).toBe(2);
    expect(layout.cursorLine).toBe(1);
    expect(layout.promptRowsUsed).toBe(layout.totalWrappedLines + 2);
  });

  test("keeps CJK and emoji cursor cells aligned after resize", () => {
    const wide = buildPromptLayout({ text: "界界👨‍👩‍👧‍👦abc", offset: 2, terminalColumns: 12, prefixColumns: 4 });
    const narrow = buildPromptLayout({ text: "界界👨‍👩‍👧‍👦abc", offset: 2, terminalColumns: 9, prefixColumns: 4 });
    expect(narrow.totalWrappedLines).toBeGreaterThanOrEqual(wide.totalWrappedLines);
    expect(wide.cursorColumn).toBe(4);
  });
});
```

- [ ] **Step 2: Run the new tests and verify failure**

Run: `bun test tests/unit/prompt-layout.test.ts`

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement PromptLayout as a thin Cursor adapter**

```ts
import { Cursor } from "./cursor";

export type PromptLayout = {
  contentColumns: number;
  wrappedLines: string[];
  viewportStartLine: number;
  viewportEndLine: number;
  cursorLine: number;
  cursorColumn: number;
  visibleText: string;
  totalWrappedLines: number;
  promptRowsUsed: number;
};

export function buildPromptLayout(options: {
  text: string;
  offset: number;
  terminalColumns: number;
  prefixColumns: number;
  maxVisibleLines?: number;
  inverse?: (text: string) => string;
}): PromptLayout {
  const contentColumns = Math.max(2, options.terminalColumns - options.prefixColumns);
  const cursor = Cursor.fromText(options.text, contentColumns, options.offset);
  const position = cursor.getPosition();
  const wrappedLines = cursor.measuredText.getWrappedText();
  const viewportStartLine = cursor.getViewportStartLine(options.maxVisibleLines);
  const viewportEndLine = options.maxVisibleLines
    ? Math.min(wrappedLines.length, viewportStartLine + options.maxVisibleLines)
    : wrappedLines.length;
  return {
    contentColumns,
    wrappedLines,
    viewportStartLine,
    viewportEndLine,
    cursorLine: position.line,
    cursorColumn: position.column,
    visibleText: cursor.render(" ", "", options.inverse ?? ((text) => text), undefined, options.maxVisibleLines),
    totalWrappedLines: wrappedLines.length,
    promptRowsUsed: Math.max(1, wrappedLines.length) + 2,
  };
}
```

- [ ] **Step 4: Run PromptLayout and Cursor tests**

Run: `bun test tests/unit/prompt-layout.test.ts tests/unit/cursor.test.ts`

Expected: PASS.

- [ ] **Step 5: Record a green local checkpoint without committing**

Run: `git diff --check`

Expected: no whitespace errors.

## Task 4: Replace InputBuffer editing with Cursor operations

**Files:**

- Modify: `src/ui/input-buffer.ts`
- Modify: `tests/unit/tui-input.test.ts`

- [ ] **Step 1: Add failing adapter tests for visual and grapheme movement**

Add tests proving:

```ts
test("uses Cursor for grapheme-safe deletion", () => {
  const family = "👨‍👩‍👧‍👦";
  const buffer = applyInputKey(createInputBuffer(`A${family}B`), { name: "left", columns: 20 });
  expect(applyInputKey(buffer, { name: "backspace", columns: 20 }).value).toBe("AB");
});

test("moves by visual rows before history", () => {
  let buffer = createInputBuffer("abcdefghij", ["history"]);
  buffer = { ...buffer, cursor: 7 };
  buffer = applyInputKey(buffer, { name: "up", columns: 6 });
  expect(buffer).toMatchObject({ value: "abcdefghij", cursor: 2 });
});
```

Add adapter-boundary cases that start the cursor inside `e\u0301` and the
family ZWJ emoji and assert the first operation snaps to the containing
grapheme start. Add `columns: undefined`, `columns: 0`, and negative columns
cases and assert Up/Down use logical lines without visual wrapping.

- [ ] **Step 2: Add failing kill/yank adapter tests**

Extend `InputKey` tests for `kill-line-end`, `kill-line-start`, `kill-word`,
`yank`, and `yank-pop`, asserting exact text and cursor offsets.

- [ ] **Step 3: Run focused tests and verify old editor fails**

Run: `bun test tests/unit/tui-input.test.ts`

Expected: FAIL on unsupported `columns`/kill keys and grapheme deletion.

- [ ] **Step 4: Replace code-unit helpers with Cursor calls**

Extend `InputKey`:

```ts
type CursorKeyName =
  | "left" | "right" | "up" | "down" | "backspace" | "delete"
  | "home" | "end" | "word-left" | "word-right" | "delete-to-end"
  | "kill-line-start" | "kill-line-end" | "kill-word" | "yank" | "yank-pop";

export type InputKey =
  | { name: "text"; text: string; columns?: number }
  | { name: CursorKeyName; columns?: number }
  | { name: "enter"; shift?: boolean; columns?: number };
```

Create the adapter through one exact helper:

```ts
import { stringWidth } from "./ink/stringWidth";
import { Cursor } from "./input/cursor";

function createBufferCursor(buffer: InputBuffer, columns?: number): Cursor {
  const normalizedColumns = Number.isFinite(columns) && Number(columns) >= 2
    ? Math.floor(Number(columns))
    : Math.max(2, stringWidth(buffer.value) + 2);
  const measured = Cursor.fromText(buffer.value, normalizedColumns, 0);
  const offset = measured.measuredText.snapToGraphemeBoundary(buffer.cursor);
  return new Cursor(measured.measuredText, offset);
}
```

The width fallback intentionally makes every logical line wide enough to avoid
visual wrapping. For Up/Down, call visual movement first, then logical movement,
then `navigateHistory` only when both return an equal Cursor. Translate every
Cursor result through one helper that updates normalized text and offset while
preserving history and paste metadata.

Keep `collapsePastedText`, `expandPastedText`, and history-draft ownership in
the adapter. Do not call `deleteTokenBefore()` for tnb placeholders.

- [ ] **Step 5: Run focused tests**

Run: `bun test tests/unit/tui-input.test.ts tests/unit/cursor.test.ts tests/unit/prompt-layout.test.ts`

Expected: PASS.

- [ ] **Step 6: Record a green local checkpoint without committing**

Run: `git diff --check`

Expected: no whitespace errors.

## Task 5: Route main-prompt keybindings and isolate modal/PTY inputs

**Files:**

- Modify: `src/ui/app.tsx:399-840`
- Modify: `src/ui/app.tsx:897-918`
- Modify: `tests/unit/tui-input.test.ts`
- Modify: `tests/unit/keybindings.test.ts`

- [ ] **Step 1: Add failing key-routing tests**

Extend `applyInkInput` tests to assert:

- main prompt `Ctrl+K/U/W/Y` and `Meta+Y` map to kill/yank InputKeys;
- main prompt `Ctrl+A/E` map to the same visual-line operations as Home/End;
- modal scope ignores kill/yank bindings;
- PTY scope does not consume Ctrl key sequences;
- Home/End receive current prompt columns;
- Ctrl+U and Ctrl+D edit a non-empty prompt before transcript scrolling.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `bun test tests/unit/tui-input.test.ts tests/unit/keybindings.test.ts`

Expected: FAIL because `applyInkInput` has no scope/columns options.

- [ ] **Step 3: Add explicit input scope options**

```ts
type ApplyInkInputOptions = {
  columns?: number;
  scope?: "main-prompt" | "modal" | "pty";
};
```

Default to `modal` to preserve existing call sites. Only `main-prompt` maps
kill/yank bindings. Add explicit routes for `key.ctrl && input === "a"` to
`home` and `key.ctrl && input === "e"` to `end`. The final prompt call supplies:

```ts
applyInkInput(bufferRef.current, input, key, {
  columns: promptContentColumns(
    terminalSize.columns,
    vimMode ? (vimInsert ? "INSERT" : "NORMAL") : undefined,
  ),
  scope: "main-prompt",
});
```

Define `promptContentColumns` in `src/ui/input/prompt-layout.ts` and use it from
both `app.tsx` and `tui.tsx`:

```ts
import { stringWidth } from "../ink/stringWidth";

export function promptContentColumns(terminalColumns: number, mode?: string): number {
  const borderAndPaddingColumns = 4;
  const pointerColumns = 2;
  const modeColumns = mode ? stringWidth(`[${mode}] `) : 0;
  return Math.max(2, terminalColumns - borderAndPaddingColumns - pointerColumns - modeColumns);
}
```

`Cursor.fromText` reserves its own final cursor cell from this content width;
callers must not subtract another cell.

Question/session rename inputs use `modal`; shell input uses `pty`.

- [ ] **Step 4: Resolve transcript-scroll conflicts by focus priority**

Before `mapTranscriptInput`, handle `Ctrl+U`, `Ctrl+D`, and kill/yank keys when
the main prompt is non-empty. Preserve transcript half-page scrolling for an
empty prompt. Preserve Ctrl+D forward delete for a non-empty prompt.

- [ ] **Step 5: Route current simplified Vim commands through Cursor columns**

Map `0/I` to visual `home`, `$/A` to visual `end`, and `D/C` to visual
`kill-line-end` without enabling token-special behavior. Keep existing insert
mode transitions.

- [ ] **Step 6: Run focused TUI tests**

Run: `bun test tests/unit/tui-input.test.ts tests/unit/keybindings.test.ts tests/unit/tui-state.test.ts`

Expected: PASS.

- [ ] **Step 7: Record a green local checkpoint without committing**

Run: `git diff --check`

Expected: no whitespace errors.

## Task 6: Use PromptLayout for rendering and height

**Files:**

- Modify: `src/ui/tui.tsx:90-160`
- Modify: `src/ui/tui.tsx:483-494`
- Modify: `src/ui/transcript/layout.ts`
- Modify: `tests/unit/tui-view.test.tsx`
- Modify: `tests/unit/transcript-viewport.test.tsx`

- [ ] **Step 1: Add failing rendering tests**

Add cases that render a narrow TUI with CJK, emoji, and wrapped ASCII input and
assert:

- no replacement characters or split graphemes;
- the cursor appears on the expected wrapped row;
- transcript height decreases by exactly `PromptLayout.promptRowsUsed`;
- resizing wider reduces or preserves prompt rows without moving the logical
  cursor offset.

- [ ] **Step 2: Run rendering tests and verify failure**

Run: `bun test tests/unit/tui-view.test.tsx tests/unit/transcript-viewport.test.tsx`

Expected: FAIL because the current view slices raw input and layout counts code
units.

- [ ] **Step 3: Build PromptLayout once in `TuiView`**

Derive the mode string exactly as
`vimMode ? (vimInsert ? "INSERT" : "NORMAL") : undefined`. Use the shared
`promptContentColumns` helper for border/padding, pointer, and mode-label width.
Pass the resulting `PromptLayout` to both `PromptInputView` and
`measureTranscriptHeight`; neither consumer may repeat the formula.

- [ ] **Step 4: Render Cursor output through the copied ANSI component**

Replace raw `before/current/after` slicing with the layout's `visibleText` and
tnb's `Ansi` component so Cursor's inverse cursor cell and wrapped rows are
rendered consistently. Keep border color, disabled dimming, pointer, and mode
label unchanged.

- [ ] **Step 5: Make transcript height consume PromptLayout**

Change the API to:

```ts
export function measureTranscriptHeight(options: {
  terminalRows: number;
  promptLayout: PromptLayout;
  suggestionRows: number;
}): number {
  const statusRows = 2;
  return Math.max(0, options.terminalRows - options.promptLayout.promptRowsUsed - statusRows - options.suggestionRows);
}
```

Delete the independent raw-string wrapping calculation.

- [ ] **Step 6: Run rendering and input suites**

Run: `bun test tests/unit/tui-view.test.tsx tests/unit/transcript-viewport.test.tsx tests/unit/tui-input.test.ts tests/unit/prompt-layout.test.ts`

Expected: PASS.

- [ ] **Step 7: Record a green local checkpoint without committing**

Run: `git diff --check`

Expected: no whitespace errors.

## Task 7: Full verification and PTY regression

**Files:**

- Modify: `tests/e2e/tui-custom-renderer-pty.test.ts`
- Modify: `tests/fixtures/custom-renderer-tui.tsx` if a deterministic initial
  prompt fixture is needed.

- [ ] **Step 1: Extend the PTY smoke test**

Feed a bracketed multi-line/CJK paste, exercise one visual Up/Down movement,
then use the existing double-Ctrl+C exit path. Assert clean alternate-screen
entry/exit, no leaked paste markers, no literal mouse/CSI fragments, and the
resume hint after the alternate screen closes.

- [ ] **Step 2: Run the PTY test alone**

Run: `bun test tests/e2e/tui-custom-renderer-pty.test.ts`

Expected: PASS and child process reaped.

- [ ] **Step 3: Run focused TUI verification**

Run:

```bash
bun test \
  tests/unit/cursor.test.ts \
  tests/unit/prompt-layout.test.ts \
  tests/unit/tui-input.test.ts \
  tests/unit/keybindings.test.ts \
  tests/unit/tui-state.test.ts \
  tests/unit/tui-view.test.tsx \
  tests/unit/transcript-viewport.test.tsx
```

Expected: PASS.

- [ ] **Step 4: Run static and full verification**

```bash
bun x tsc --noEmit
bun test
bun run build
./dist/tnb --version
git diff --check
```

Expected: all tests pass, build completes, version prints `0.1.0`, and diff
check is empty.

- [ ] **Step 5: Create the single verified migration commit**

```bash
git add src/ui/input src/ui/input-buffer.ts src/ui/app.tsx src/ui/tui.tsx \
  src/ui/transcript/layout.ts tests/unit/cursor.test.ts \
  tests/unit/prompt-layout.test.ts tests/unit/tui-input.test.ts \
  tests/unit/keybindings.test.ts tests/unit/tui-view.test.tsx \
  tests/unit/transcript-viewport.test.tsx \
  tests/e2e/tui-custom-renderer-pty.test.ts tests/fixtures/custom-renderer-tui.tsx
git commit -m "feat: migrate prompt editing to Cursor engine"
```

- [ ] **Step 6: Inspect history and working tree**

```bash
git status --short
git log --oneline --decorate -10
```

Expected: clean worktree with exactly one implementation commit after the
design and plan commits on `feat/cursor-input-engine`.

- [ ] **Step 7: Push the verified feature branch**

Run: `git push -u origin feat/cursor-input-engine`

Expected: remote branch points at the single verified migration commit. Do not
merge to `main` until the implementation review confirms the rollout criteria.
