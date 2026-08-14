# Custom Renderer and Virtual Transcript Design

## Goal

Replace tnb's public Ink runtime and temporary transcript viewport with the
authorized custom renderer, selection, ScrollBox, and virtual-message system
used by the local Claude Code reference. Preserve tnb's Agent, Provider, tool,
session, and extension state models.

## Scope

1. Run the custom renderer behind an isolated compatibility entrypoint.
2. Switch every tnb UI import from public Ink to that entrypoint.
3. Integrate screen-buffer selection and terminal input events.
4. Integrate ScrollBox and VirtualMessageList.
5. Replace the transcript viewport with the virtual list.
6. Reuse ScrollBox/virtual list in Session Browser and management pages.
7. Integrate incremental search, match highlighting, copy, and sticky prompts.
8. Delete superseded viewport code and verify behavior in a real PTY.

## Architecture

`src/ui/ink/` becomes the only renderer boundary. It owns DOM nodes, layout,
screen cells, rendering, input parsing, terminal lifecycle, selection, search
highlighting, and reusable scrolling components. Existing tnb components import
renderer primitives only through `src/ui/ink/index.ts`.

`VirtualTranscript` adapts `TranscriptEntry[]` into keyed virtual rows. It owns
height measurement, overscan, follow-bottom, sticky user prompts, current-entry
cursor, per-entry expansion, and transcript search positions. It does not own
conversation state.

Session Browser and management dialogs keep their current command/result data
contracts. Their viewports use the same ScrollBox primitives, eliminating
manual list slicing.

## Migration constraints

- Keep the public Ink dependency installed until the isolated renderer passes
  static rendering and input tests; remove it only after all imports switch.
- Before global import rewrites, isolated-renderer tests use a temporary
  compatibility wrapper that renders a boundary-only fixture through
  `src/ui/ink/`; production imports remain unchanged in that phase.
- Do not migrate reference business types, feature flags, analytics, branding,
  prompts, or session state.
- Preserve alternate-screen cleanup and terminate all owned PTY/process state.
- Each phase must typecheck and pass its targeted renderer tests before the next
  phase starts.
- Use tnb's existing tool-card components as virtual row content.

## Interaction contract

- Mouse drag selects characters; double click selects words; triple click
  selects logical lines.
- Selection survives ordinary repaint and follows content during drag scrolling.
- `Ctrl+Shift+C` copies active screen selection first, then the selected message.
- Search is incremental, highlights every visible match, and supports next/prev.
- Manual scrolling detaches follow-bottom; explicit bottom navigation restores it.
- Resizing invalidates measured heights and preserves a meaningful viewport.
- Session and management detail panes scroll independently of their list pane.

## Verification

- Pure tests: screen cells, selection normalization/copy, search positions,
  virtual-height cache, resize, overscan, follow-bottom.
- Component tests: current tnb TUI rendered through the custom renderer,
  transcript virtualization, Session Browser/detail scrolling, management views.
- PTY tests: alternate screen, keyboard paging, wheel scrolling, drag selection,
  copy sequence, search navigation, resize, and clean exit.
- Final gate: all Bun tests, TypeScript, bundle/compile, and a harness-owned
  process audit. PTY tests record their child PID/process tree and assert every
  owned descendant exits during teardown; global `pgrep` is secondary only.

## Stop condition

tnb has no direct runtime imports from public Ink; transcript and management
surfaces use the shared ScrollBox/virtual system; selection/search/copy work in
a real PTY; the old viewport and mouse adapter are removed; all verification
gates pass without residual processes.
