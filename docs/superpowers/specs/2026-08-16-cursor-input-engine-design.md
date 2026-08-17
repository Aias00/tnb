# Cursor Input Engine Migration Design

## Objective

Replace tnb's character-index prompt editing logic with the mature Claude Code
Cursor, Unicode segmentation, visual-line movement, and kill-ring engine. Keep
tnb's public `InputBuffer` boundary so the migration does not require a rewrite
of the TUI application, session handling, or Provider runtime.

The migration must preserve the recently aligned prompt-history draft and long
paste behavior while making cursor movement correct for wrapped text, CJK,
emoji, combining characters, logical lines, and terminal-width changes.

## Source boundary

Migrate the complete behavior of these authorized reference modules:

- `claude-code/src/utils/Cursor.ts`
- `claude-code/src/utils/intl.ts`

Adjust import paths and project naming only. Do not migrate unrelated product
features such as account state, notifications, voice input, Chrome integration,
prompt suggestions, or Anthropic-specific UI.

The migrated Cursor implementation will reuse tnb's existing copied renderer
utilities:

- `src/ui/ink/stringWidth.ts`
- `src/ui/ink/wrapAnsi.ts`

## Architecture

### Cursor engine

Add a dedicated Cursor module under `src/ui/input/` containing:

- Unicode grapheme and word segmenter caches;
- measured text and terminal-cell width mapping;
- visual and logical line positioning;
- grapheme-safe left/right, insertion, backspace, and forward delete;
- word and Vim-style movement;
- line and word deletion;
- kill-ring, yank, and yank-pop state;
- viewport offset calculations for wrapped input.

The module remains independent of React and session state. It accepts text,
terminal columns, cursor offset, and optional selection state and returns an
immutable Cursor value.

### InputBuffer adapter

`src/ui/input-buffer.ts` remains the stable TUI-facing state API. Its editing
operations will construct a Cursor for the current value, invoke the matching
Cursor operation, and translate the result back into `InputBuffer`.

`InputKey` will carry terminal columns for operations whose result depends on
wrapping. Callers that do not provide columns retain a conservative logical-line
fallback. The main prompt input always supplies its measured content width.

History navigation remains outside Cursor because it is session state rather
than text-editing state. Cursor movement is attempted first; history navigation
starts only when movement cannot continue upward or downward.

### Prompt rendering

The prompt view will use Cursor viewport and position data rather than slicing
the JavaScript string at an arbitrary code-unit offset. Cursor placement must
never split a grapheme cluster or render in the middle of a wide terminal cell.

The existing long-paste placeholder remains ordinary editable text. Its hidden
content stays in `InputBuffer.pastedContents` and expands only at submission.
A later migration may make paste references atomic pills, but this migration
must not silently broaden scope.

### Kill ring and keybindings

Connect the existing input event layer to the Cursor kill-ring operations:

- `Ctrl+K`: kill to logical line end;
- `Ctrl+U`: kill to logical line start;
- `Ctrl+W`: kill the preceding word;
- `Ctrl+Y`: yank the latest killed text;
- `Meta+Y`: rotate the kill ring after a yank.

Consecutive compatible kill operations accumulate using the reference engine's
rules. Ordinary insertion or navigation resets kill accumulation when required.
No new global keybinding configuration format is introduced.

## Data flow

1. The renderer emits a normalized input event.
2. `app.tsx` maps the event to an `InputKey` and supplies prompt columns.
3. `applyInputKey` creates a Cursor over the current buffer.
4. Cursor performs a grapheme-safe editing or movement operation.
5. The adapter updates text, offset, history state, paste state, and submission
   state.
6. `PromptInputView` renders the Cursor-selected viewport and cursor cell.
7. Submission expands any long-paste references before entering session history
   and the Agent loop.

## Error and compatibility behavior

- Clamp invalid offsets to a valid grapheme boundary.
- Normalize text to NFC at the Cursor boundary, matching the reference engine.
- Treat missing or invalid terminal width as a logical-line-only editor rather
  than throwing.
- Preserve macOS DEL-as-backspace and Ctrl+D forward-delete behavior.
- Preserve current Shift+Enter newline, Vim mode, reverse history search,
  external editor, slash completion, and resume history behavior.
- Do not allow ANSI control sequences from pasted input into measured text.

## Verification

Add focused tests for:

- ASCII and logical multiline movement;
- visual movement across wrapped terminal rows;
- CJK double-width positioning;
- emoji, ZWJ sequences, and combining characters;
- insertion and deletion at grapheme boundaries;
- terminal resize and viewport positioning;
- word movement and Vim motions;
- kill accumulation, yank, and yank-pop;
- history draft restoration after Cursor navigation;
- long-paste display and submission expansion;
- resumed-session input history;
- existing Backspace, Ctrl+D, Shift+Enter, and Vim behavior.

Run the focused input/keybinding/TUI suites first, followed by TypeScript
checking, the full Bun suite, binary build, and the PTY lifecycle test. Commit
and push only after all checks pass.

## Rollout and stop condition

Land the migration as one isolated commit after the design and implementation
plan commits. The work is complete when the main TUI uses the Cursor engine for
rendering and editing, all focused and full tests pass, the compiled binary
starts successfully, and local `main` matches `origin/main`.

