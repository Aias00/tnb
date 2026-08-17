# Complete PromptInput Migration Design

## Objective

Replace tnb's remaining application-level prompt editing state machine with the
authorized mature Claude Code PromptInput implementation. The result must use
the Cursor/Unicode engine already migrated into tnb while adding complete Vim,
undo, prompt stash, atomic pasted-text and image references, mouse placement,
history state, external-editor round trips, and unified autocomplete behavior.

This is the first of two independent high-value migrations. Core coding tools
will be specified and migrated only after PromptInput is complete and verified.

## Authorized source surface

Migrate or adapt the behavior from these reference areas:

- `claude-code/src/components/BaseTextInput.tsx`
- `claude-code/src/components/TextInput.tsx`
- `claude-code/src/components/VimTextInput.tsx`
- `claude-code/src/components/PromptInput/PromptInput.tsx`
- `claude-code/src/components/PromptInput/inputPaste.ts`
- `claude-code/src/components/PromptInput/inputModes.ts`
- `claude-code/src/hooks/useTextInput.ts`
- `claude-code/src/hooks/useVimInput.ts`
- `claude-code/src/hooks/useArrowKeyHistory.tsx`
- `claude-code/src/hooks/useInputBuffer.ts`
- `claude-code/src/hooks/useHistorySearch.ts`
- `claude-code/src/hooks/usePasteHandler.ts`
- `claude-code/src/history.ts`
- `claude-code/src/utils/pasteStore.ts`
- `claude-code/src/utils/promptEditor.ts`
- `claude-code/src/vim/`
- `claude-code/src/types/textInputTypes.ts`

Adjust imports, branding, telemetry, and product integration points. Preserve
the editing algorithms and state transitions unless this specification names a
tnb compatibility boundary.

## Excluded product behavior

Do not migrate:

- voice input and voice indicators;
- Claude in Chrome input;
- prompt speculation or AI prompt suggestions;
- Slack channel and teammate mention integrations;
- Anthropic account, subscription, telemetry, experiments, or feature flags;
- swarm, buddy, ultraplan, or other internal modes;
- issue banners, surveys, product tips, or branded notifications.

## Architecture

### PromptInput module boundary

Create `src/ui/prompt-input/` as the single owner of editable prompt state.
It exposes a controlled component and an imperative handle:

```ts
export type PromptInputHandle = {
  focus(): void;
  clear(): void;
  setState(state: PromptEditorState): void;
  getState(): PromptEditorState;
  stash(): boolean;
  popStash(): boolean;
};

export type PromptInputSubmit = {
  display: string;
  expanded: string;
  mode: PromptInputMode;
  pastedContents: Record<number, PastedContent>;
};
```

`app.tsx` owns Agent submission and global modal selection but no longer
interprets ordinary prompt characters, cursor movement, Vim commands, history
movement, paste markers, completion selection, undo, or stash commands.

### Editor state

```ts
export type PromptEditorState = {
  value: string;
  cursorOffset: number;
  mode: "prompt" | "bash";
  vimMode: "INSERT" | "NORMAL";
  pastedContents: Record<number, PastedContent>;
  nextPasteId: number;
};

export type PastedContent =
  | { id: number; type: "text"; content: string }
  | {
      id: number;
      type: "image";
      path: string;
      mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    };
```

Cursor offsets use normalized text and grapheme boundaries. State snapshots
used by undo, history, and stash include the entire editor state rather than
only the displayed string.

### Atomic reference grammar

Adopt two canonical references:

- pasted text: `[Pasted text #N +X lines]`
- image: `[Image #N]`

Both forms are atomic tokens:

- Left/Right jumps over the full token.
- Mouse placement snaps to token start or end.
- Backspace/Delete removes the full token and its `pastedContents` entry.
- Selection cannot stop inside a token.
- History, undo, redo, and stash retain the referenced content.
- Submission expands pasted text and converts images into the existing
  multimodal request format.

The current `[Image: /absolute/path]` display form is migrated when loading
existing input state. It remains accepted as ordinary legacy text when no
matching image file is available; it is never silently read from outside the
approved workspace.

### Text input and Cursor integration

Use the migrated `src/ui/input/cursor.ts` as the only text-measurement and
movement implementation. Port `useTextInput` behavior on top of it:

- grapheme-safe insert/delete;
- visual and logical row movement;
- Home/End and word movement;
- kill ring and yank-pop;
- terminal line ending and ANSI cleanup;
- multiline Enter behavior;
- cursor viewport and mouse terminal-cell mapping.

Do not introduce a second cursor model. The current `InputBuffer` becomes a
compatibility adapter for modal and PTY fields and is no longer the main prompt
editor.

### Vim

Port the complete reference `vim/` transition and operator implementation,
including:

- INSERT/NORMAL modes;
- counts;
- motions and WORD motions;
- delete/change/yank operators;
- find/till motions;
- text objects supported by the reference;
- replace, toggle case, indent, join, and open-line operations;
- dot repeat;
- undo integration;
- cursor correction when leaving INSERT mode.

Vim actions operate through Cursor and cannot split atomic references.

### Undo and stash

Undo snapshots contain `value`, `cursorOffset`, `pastedContents`, and mode.
Rapid insertions use the reference debounce/buffer policy; structural actions
such as paste, token deletion, Vim operators, external editor, and history
acceptance create explicit boundaries.

Prompt stash is a bounded LIFO stack. Stashing clears the active editor without
submitting. Pop restores text, cursor, mode, and pasted contents. Stash state is
session-local and is not written into the conversation JSONL until submission.

### History and resume

History entries use:

```ts
export type PromptHistoryEntry = {
  display: string;
  mode: PromptInputMode;
  pastedContents: Record<number, PastedContent>;
};
```

Up/Down first moves within visual/logical rows. At the top or bottom boundary it
navigates history and preserves the current draft. Rapid repeated arrows use a
synchronous ref and chunked loading to avoid stale React closures.

Resumed sessions reconstruct history from user prompt records. New session
records must persist enough attachment metadata to restore image pills without
embedding image bytes in JSONL. Missing image files render a non-executable
missing-reference pill and remain visible to the user.

### External editor

Before opening the external editor:

1. expand pasted-text references;
2. render image references as stable textual markers;
3. save an undo boundary.

After the editor closes:

1. normalize line endings and strip control sequences;
2. preserve unchanged image markers and their content records;
3. collapse newly introduced large text using the ordinary paste threshold;
4. remove orphaned content records;
5. restore a grapheme-valid cursor at the returned offset or end of text.

### Autocomplete

One completion controller owns:

- slash commands and aliases;
- custom commands;
- workspace `@file` references;
- MCP prompt arguments;
- model/provider selectors where already supported.

Completion state includes source, values, selected index, replacement range,
and request generation. Async completion results are applied only when their
generation still matches the active query. While the completion menu owns
focus, Up/Down, Tab, Enter, and Escape do not reach history or transcript
navigation.

### Mouse placement

Prompt rendering publishes its terminal rectangle and Cursor layout. Mouse
clicks inside the prompt translate row/column cells to a Cursor offset using
the same measured text used for rendering. Clicks after end-of-line clamp to the
line end; clicks inside wide graphemes or atomic tokens snap to a valid edge.

## Input priority

Handle events in this order:

1. permission/question/session/management modal;
2. completion menu;
3. history search;
4. PromptInput Vim or insert editing;
5. transcript scrolling only when PromptInput does not consume the event;
6. global exit/interrupt shortcuts.

Ctrl+C preserves existing behavior: interrupt an active Agent; otherwise clear
the prompt on the first press and exit on the second press. PTY input remains
outside PromptInput and must receive its own control sequences.

## Compatibility and error behavior

- Invalid offsets snap to a grapheme boundary.
- Invalid terminal width falls back to logical-line movement.
- Malformed or unknown reference IDs remain visible text and never crash.
- Orphan `pastedContents` entries are pruned after edits.
- Missing image paths never trigger reads outside approved roots.
- Clipboard errors produce a non-blocking TUI error and preserve editor state.
- External-editor failure restores the exact prior editor snapshot.
- Async completion cancellation is silent; non-cancellation errors surface in
  the existing completion notice area.

## Verification

Add unit coverage for:

- complete Cursor-backed TextInput mappings;
- Vim operators, counts, text objects, dot repeat, and undo;
- undo grouping and structural boundaries;
- stash push/pop and full-state restoration;
- atomic text/image movement and deletion;
- paste expansion and orphan cleanup;
- history draft, rapid arrows, search, and resumed entries;
- external-editor expand/collapse and failure restoration;
- completion focus, replacement ranges, async generation fencing, and cancel;
- mouse placement for ASCII, CJK, emoji, wrapped lines, and tokens;
- Ctrl+C, transcript-scroll, modal, and PTY priority.

Extend PTY coverage with bracketed paste, image pill rendering, mouse click,
Vim mode transition, completion navigation, and clean exit. Run TypeScript,
the complete Bun suite, build, version smoke, resource-leak checks, and
`git diff --check` before a single implementation commit.

## Rollout and stop condition

Use a dedicated feature worktree. Land the runtime migration as one verified
implementation commit after the design and plan commits. The migration is
complete when:

- `app.tsx` no longer handles ordinary prompt editing state;
- main prompt editing is owned by the new PromptInput module;
- all listed features are active in the compiled TUI;
- the complete suite and PTY tests pass on macOS;
- the binary builds and exits without leftover processes;
- the merge result is verified on `main`.

