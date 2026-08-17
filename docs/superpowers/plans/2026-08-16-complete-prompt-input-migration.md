# Complete PromptInput Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace tnb's app-level prompt editing with a complete Cursor-backed PromptInput supporting Vim, undo, single-slot stash, atomic text/image pills, structured history/resume, external editor, mouse placement, and unified autocomplete.

**Architecture:** Build structured prompt persistence first, port pure Vim/editor state next, then mount one controlled PromptInput. `app.tsx` keeps Agent/modal orchestration but delegates ordinary prompt editing. Cursor/PromptLayout remains the only text measurement engine.

**Tech Stack:** Bun, TypeScript, React, tnb Ink renderer, JSONL sessions, SHA-256 paste store, Bun test.

**Spec:** `docs/superpowers/specs/2026-08-16-complete-prompt-input-migration-design.md`

---

## File map

**Create:**

- `src/ui/prompt-input/types.ts`
- `src/ui/prompt-input/references.ts`
- `src/ui/prompt-input/editor-state.ts`
- `src/ui/prompt-input/undo.ts`
- `src/ui/prompt-input/history.ts`
- `src/ui/prompt-input/completion.ts`
- `src/ui/prompt-input/mouse.ts`
- `src/ui/prompt-input/use-text-input.ts`
- `src/ui/prompt-input/use-vim-input.ts`
- `src/ui/prompt-input/PromptInput.tsx`
- `src/ui/prompt-input/vim/{motions,operators,text-objects,transitions,types}.ts`
- `src/services/session/prompt-paste-store.ts`
- focused `tests/unit/prompt-*.test.ts` files matching each unit.

**Modify:**

- `src/core/message.ts`, `src/core/agent-loop.ts`
- `src/services/session/storage.ts`, `src/services/attachments/load.ts`
- `src/ui/external-editor.ts`, `src/ui/app.tsx`, `src/ui/tui.tsx`
- `src/entrypoints/cli.ts`
- existing session, TUI, query-loop, CLI, and PTY tests.

Runtime work remains uncommitted until every task passes; land it as one verified
implementation commit.

## Task 1: Atomic reference grammar and types

**Files:** create `types.ts`, `references.ts`, `tests/unit/prompt-references.test.ts`.

- [ ] Write failing tests for:

```ts
expect(formatPastedTextRef(1, "line1\nline2\nline3")).toBe("[Pasted text #1 +2 lines]");
expect(formatPastedTextRef(2, "single")).toBe("[Pasted text #2]");
expect(formatImageRef(3)).toBe("[Image #3]");
```

Also test typed token ranges, malformed/duplicate IDs, reverse-order expansion,
and placeholder-like strings inside pasted content.

- [ ] Run `bun test tests/unit/prompt-references.test.ts`; expect module-not-found.
- [ ] Define exact spec types: `PromptEditorState`, `PastedContent`,
  `StoredPastedContent`, `PersistedPromptInput`, `PromptHistoryEntry`,
  `PromptInputSubmit`, and `PromptInputHandle`.
- [ ] Port `getPastedTextRefNumLines`, formatters, and parser from authorized
  `history.ts`. Expand only matching typed records; return referenced images
  separately.
- [ ] Run the test and `git diff --check`; expect PASS. Do not commit.

## Task 2: Paste store and user-message metadata

**Files:** create `prompt-paste-store.ts` and its test; modify `message.ts`,
`agent-loop.ts`, and query-loop tests.

- [ ] Write failing tests for inline content at 1024 characters, external store
  above 1024, SHA-256 dedupe, concurrent writes, hash validation, missing/corrupt
  reads, and confinement below `<projectDir>/prompt-pastes`.
- [ ] Write a failing Agent-loop test proving the initial user message receives
  `promptInput`, Provider requests do not expose it, and metadata forces a
  distinct user message instead of merging into a trailing user message.
- [ ] Run focused tests; expect missing API failures.
- [ ] Implement atomic `0o600` hash storage with `withFileLock`, unique temp file,
  rename, and `/^[a-f0-9]{64}$/` validation.
- [ ] Extend the user-message type and `AgentLoopOptions.promptInput`; attach it
  only to the initial prompt message. Keep Provider adapters unchanged and lock
  this with tests.
- [ ] Run focused tests plus `bun x tsc --noEmit`; expect PASS. Do not commit.

## Task 3: Structured session history and resume

**Files:** modify session storage, CLI, app types, and session/CLI tests.

- [ ] Add failing tests for inline/hash text, image metadata, missing image,
  malformed metadata rejection, missing paste hash, and legacy message migration.
- [ ] Add failing `--resume`, `/resume`, `/continue`, and fork tests asserting
  exact `PromptHistoryEntry[]`; picker summaries remain plain display strings.
- [ ] Extend `isConversationMessage` validation: positive unique IDs, canonical
  reference grammar, supported media types, mutually exclusive content/hash,
  valid hashes, and safe non-empty paths.
- [ ] Resolve prompt metadata during `SessionStore.load()` into
  `SessionState.promptHistory`. Read hashes via the paste store; stat image paths
  without reading bytes; mark missing records.
- [ ] Convert `initialInputHistory`, resume results, `restoreInputHistory`, and
  switching from `string[]` to structured entries. Legacy messages use joined
  text and empty content records.
- [ ] Run session/CLI tests and typecheck; expect PASS. Do not commit.

## Task 4: Complete Vim engine port

**Files:** create five `src/ui/prompt-input/vim/*.ts` modules and
`tests/unit/prompt-vim.test.ts`.

- [ ] Write characterization tests for counts, `w/b/e`, WORD motions,
  `d/c/y`, line operators, `f/F/t/T`, text objects, replace, case toggle,
  indent, join, open line, dot repeat, undo callback, and INSERT→NORMAL cursor
  correction. Every result must remain outside atomic token interiors.
- [ ] Run test; expect module-not-found.
- [ ] Mechanically port authorized `src/vim/` files using `apply_patch`.
  Translate imports to local Cursor/types; remove only telemetry/product imports.
- [ ] Add one token-range adapter: movement snaps to a token edge; delete/change
  across a token consumes it completely and reports orphan IDs.
- [ ] Run Vim/Cursor tests and typecheck; expect PASS. Do not commit.

## Task 5: Pure editor, undo, stash, and history

**Files:** create `editor-state.ts`, `undo.ts`, `history.ts` and focused tests.

- [ ] Write failing editor tests for Cursor insert/delete/movement, atomic pills,
  orphan cleanup, modes, newline behavior, image insertion, large paste collapse,
  ANSI/CR/Tab cleanup, and missing references.
- [ ] Write failing undo tests for debounced inserts and structural boundaries.
  Restore the full state including Vim mode and `nextPasteId`.
- [ ] Write failing single-slot stash tests: non-empty overwrites and clears;
  empty restores and clears; empty-without-slot is no-op.
- [ ] Write failing structured history tests: draft preservation, row priority,
  synchronous rapid arrows, bash filtering, pasted contents, chunked loading,
  reverse search, and missing image records.
- [ ] Implement all text mutations through Cursor and centralized token/orphan
  helpers. Port reference undo and arrow-history algorithms into pure reducers.
- [ ] Run focused tests and typecheck; expect PASS. Do not commit.

## Task 6: Completion and mouse controllers

**Files:** create `completion.ts`, `mouse.ts`, and their tests.

- [ ] Write failing completion tests for slash/custom/file/MCP sources,
  replacement ranges, cycling, accept/cancel, empty results, and rejecting stale
  async generations.
- [ ] Write failing mouse tests for ASCII, CJK, ZWJ emoji, wrapped rows,
  past-end/border clicks, resize, and token-edge snapping.
- [ ] Implement completion state as
  `{ generation, source, values, selectedIndex, replacementRange }`; only the
  current generation may update state.
- [ ] Implement mouse mapping with PromptLayout and
  `MeasuredText.getOffsetFromPosition`, then atomic-range snapping.
- [ ] Run focused tests and typecheck; expect PASS. Do not commit.

## Task 7: Controlled PromptInput React component

**Files:** create the two hooks, `PromptInput.tsx`, component tests; modify
`external-editor.ts` and its tests.

- [ ] Add failing renderer-driven tests for insert, full Vim, undo, stash,
  text/image pills, history, completion focus, mouse click, busy state, and
  imperative state restore.
- [ ] Add failing external-editor tests: expand text, retain unchanged images,
  collapse new large text, prune orphan records, cursor at end, undo boundary,
  and exact snapshot restore on error.
- [ ] Port product-neutral `useTextInput`: keep mappings/paste behavior; replace
  notifications with `onNotice`, environment globals with props, and remove
  telemetry rather than replacing it.
- [ ] Port `useVimInput` over local Vim modules without simplifying transitions.
- [ ] Build PromptInput with existing PromptLayout/Ansi rendering, published
  prompt rectangle, imperative handle, and structured submit only.
- [ ] Keep editor process protocol `{ content?, error? }`; PromptInput owns
  expansion, snapshot, restore, and end-of-text cursor.
- [ ] Run component/external-editor/all prompt tests and typecheck; expect PASS.

## Task 8: Replace app editor and bridge multimodal turns

**Files:** modify `app.tsx`, `tui.tsx`, attachment loader, CLI, and integration tests.

- [ ] Add failing TUI→CLI test submitting
  `review [Image #1] [Pasted text #2 +2 lines]`. Assert structured TuiTurn,
  workspace validation, expanded text plus one image block, persisted metadata,
  Provider metadata exclusion, and missing-image non-loading.
- [ ] Add failing priority tests: modal > completion > history search >
  PromptInput > transcript > global exit, including Ctrl+C/U/D, Escape, PTY,
  and busy Agent state.
- [ ] Remove main `buffer`, direct character/Vim dispatch, prompt history
  mutation, completion mutation, and image-path string insertion from `app.tsx`.
  Keep modal/PTY InputBuffers and a `PromptInputHandle` ref.
- [ ] Mount PromptInput in existing layout while preserving transcript height,
  status, theme, fullscreen, and selection.
- [ ] In interactive `runTurn`, use `input.expanded` for commands; collect only
  referenced non-missing images, validate/load them through the shared attachment
  loader, and pass canonical `promptContent` plus `promptInput` metadata.
- [ ] Run TUI/CLI/query-loop tests and typecheck; expect PASS. Do not commit.

## Task 9: PTY and full verification

**Files:** modify the PTY fixture/test.

- [ ] Extend PTY input with bracketed paste, image pill, mouse click, completion,
  Vim count/operator/dot-repeat, undo, stash/pop, history, resize, and double
  Ctrl+C. Assert no raw sequences, split graphemes, leaked process, or misplaced
  resume hint.
- [ ] Run all `tests/unit/prompt-*.test.ts`, session, TUI, CLI, query-loop, and
  PTY tests; expect PASS.
- [ ] Run:

```bash
bun x tsc --noEmit
bun test
bun run build
./dist/tnb --version
git diff --check
```

Expected: all tests pass, version `0.1.0`, no leaked child process.

- [ ] Create the only runtime commit:

```bash
git add src tests
git commit -m "feat: migrate complete PromptInput editor"
```

- [ ] Re-run the full verification commands on committed HEAD and require a
  clean worktree.
- [ ] Push with `git push -u origin feat/complete-prompt-input`; local and remote
  commits must match. Do not merge before finishing-branch review.

