# Transcript Viewport Design

## Goal

Replace tnb's record-count transcript paging with a reusable, terminal-row viewport that matches the proven Claude Code and qodercli interaction model: line, half-page and page scrolling; top/bottom jumps; mouse wheel support; stable position while new output arrives; and automatic following only while pinned to the bottom.

This is the first foundation of the larger TUI parity effort. Tool cards, session preview, transcript search and richer management pages will consume the same viewport rather than implementing separate scrolling.

## Reference behavior

The implementation will reuse behavior, state transitions and key conventions from the authorized Claude Code and qodercli references, while retaining tnb's current public Ink package and application state.

- Claude Code reference surfaces: `ink/components/ScrollBox.tsx`, `ScrollKeybindingHandler`, `useVirtualScroll`, renderer scroll-top translation and sticky-bottom behavior.
- qodercli reference behavior: mouse wheel moves three rows; PageUp/PageDown move a viewport; Ctrl+U/Ctrl+D move half a viewport; explicit top/bottom shortcuts.
- tnb constraint: do not import Claude Code's private Ink renderer wholesale. Its `ScrollBox` depends on a large custom DOM, renderer, selection and screen-diff stack. Reimplement the externally observable contract over public Ink.

## Chosen approach

Use a row-frame viewport rather than copying the private renderer or continuing record-count cropping.

Each transcript entry is rendered independently to ANSI text at the current content width. ANSI-aware line measurement splits that output into terminal rows. The viewport concatenates those row frames in transcript order, applies `scrollTop`, and renders exactly the visible row range inside the fixed transcript region.

This preserves the most important mature behavior without taking ownership of Claude Code's custom Ink fork. It also gives later features stable row coordinates for search results, selection, tool-card expansion and session preview.

Rejected alternatives:

1. Copy Claude Code's complete private Ink renderer. Highest fidelity, but it would pull in its DOM, Yoga bindings, screen diffing, selection, hit testing and native layout behavior. That is effectively a UI-runtime fork rather than a tnb feature.
2. Keep cropping React message nodes by record count. Smallest change, but wrapped Markdown and large tool results can never scroll correctly because a record has no stable height.

## Architecture

### `transcript-model.ts` and `tui-state.ts`

Defines an append-only transcript event model and captures order when reducer actions arrive. Order is not reconstructed from the current `messages` and `tools` buckets because those buckets contain no chronology metadata.

```ts
type TranscriptEntry = {
  id: string
  sequence: number
  kind: 'user' | 'assistant' | 'system' | 'tool'
  // kind-specific display payload
  revision: number
}
```

`reduceTuiState` allocates a monotonic sequence and stable ID for every submitted message, completed assistant turn, system result and tool start. Tool deltas mutate the matching entry while increasing `revision`; they never move the entry. Streaming assistant content uses one stable draft entry whose revision changes as text arrives and whose identity is retained when committed. Session restore creates entries in persisted conversation order. Session reset clears the timeline and sequence counter.

`messages`, `tools` and `streamingText` may remain temporarily as derived compatibility views while consumers migrate, but `TranscriptViewport` reads only ordered transcript entries. Todo state, task-manager state and MCP progress remain live out-of-band panels in this phase: they are not durable transcript rows and do not affect transcript `contentHeight` or “newer rows”. Tool lifecycle events are transcript rows and do affect both.

### `transcript-render.tsx`

Renders one entry using existing `MessageRow`, `Markdown` and tool presentation components. It exposes an entry renderer suitable for both the normal viewport and future transcript/search views.

### `row-frame.ts`

Converts rendered Ink/ANSI output into measured terminal rows:

- respects current content width;
- ignores ANSI escape sequences when measuring display width;
- handles wide CJK characters, combining characters and explicit newlines;
- returns immutable rows and an entry-to-row range index;
- caches by entry identity, expansion state, width and theme.

The measurement source is Ink's own `renderToString(entry, { columns: contentWidth })`; the returned visible lines are the row frame. `contentWidth` is the outer terminal width minus `TuiView` horizontal padding, and individual entry renderers receive this exact width. Measurement never independently re-wraps already-rendered ANSI text. `string-width`, `strip-ansi` and `wrap-ansi` are already indirect Ink dependencies, but code must not depend on undeclared transitive packages: if direct imports are needed, promote the exact packages to direct dependencies in `package.json` and lockfile.

Cache key is `(entry.id, entry.revision, contentWidth, theme, expansionState)`. The stable ID/revision migration above is required before caching is enabled. Terminal resize and theme or expansion changes naturally select different keys; session reset drops the cache.

### `viewport-state.ts`

Pure state machine:

```ts
type ViewportState = {
  scrollTop: number
  viewportHeight: number
  contentHeight: number
  followBottom: boolean
}
```

Operations:

- `scrollBy(rows)`
- `scrollPage(direction)`
- `scrollHalfPage(direction)`
- `scrollToTop()`
- `scrollToBottom()`
- `resize(height)`
- `contentChanged(previousHeight, nextHeight)`

Any upward/manual movement clears `followBottom`. Reaching the bottom through downward movement restores it. When `followBottom` is true, content growth pins `scrollTop` to the new maximum. When false, content growth leaves `scrollTop` unchanged. Resizing clamps the position and preserves bottom pinning.

### `TranscriptViewport.tsx`

Owns row-frame composition and displays the visible interval. It receives viewport state rather than handling keys directly. It reports `contentHeight`, `maxScroll` and whether the bottom is pinned for the status line.

### `transcript-input.ts`

Maps input into viewport operations before the editor handles it:

| Input | Operation |
| --- | --- |
| Mouse wheel up/down | 3 rows |
| `PageUp` / `PageDown` | one viewport |
| `Ctrl+U` / `Ctrl+D` | half viewport |
| `Shift+↑` / `Shift+↓` | one viewport, compatibility alias |
| `Ctrl+Home` / `Ctrl+End` | top / bottom |

Plain Up/Down remain editor-history navigation. Modal dialogs retain their own input priority. `Ctrl+D` only scrolls when transcript scrolling is possible; at the bottom it falls through to the editor's forward-delete behavior. This mirrors mature conditional key propagation rather than globally stealing the key.

### `mouse-input.ts`

Public Ink does not surface wheel events. `runTui` therefore owns a fullscreen-only SGR mouse adapter on the same stdin stream supplied to Ink:

- write `CSI ?1000h` and `CSI ?1006h` after entering alternate screen;
- attach one `data` observer without changing raw-mode ownership;
- recognize only complete SGR wheel sequences (`button` 64/65), retain incomplete suffix bytes between chunks, and leave all other bytes untouched for Ink's existing listener;
- publish wheel direction through a small controller subscribed by `TuiApp`;
- modal state causes wheel events to be ignored unless that modal later opts into scrolling;
- detach the observer and write `CSI ?1000l`/`CSI ?1006l` in `runTui`'s `finally`, before leaving alternate screen, including render failures.

Because listeners observe rather than consume Node stream bytes, Ink still receives the escape sequence. Ink 6 ignores unsupported mouse sequences; the adapter test must prove they do not insert text into the editor. If a supported terminal/Ink version begins interpreting them, the adapter will move to a single input demultiplexer rather than double-processing.

## Rendering and data flow

1. A reducer action appends or revises a stable transcript entry in arrival order.
2. `TranscriptViewport` consumes that ordered list.
3. Entry frames are rendered/measured for the active width.
4. Total row height is sent through `contentChanged`.
5. Sticky-bottom logic either advances to the new maximum or preserves the user's row.
6. `TranscriptViewport` renders only `[scrollTop, scrollTop + viewportHeight)`.
7. Status text shows `latest`, or the number of newer rows while detached.

Submitting a prompt explicitly returns to bottom because the user is starting a new conversational turn. Streaming by itself does not return to bottom after the user has scrolled upward.

## Error and compatibility behavior

- Width or height of zero renders no transcript rows and preserves state until the terminal is usable again.
- Invalid mouse sequences remain ordinary ignored terminal input.
- Measurement failure for one entry produces a plain-text fallback frame for that entry; it does not reset the entire viewport.
- Terminal resize invalidates width-dependent frames and recomputes row ranges.
- Non-fullscreen/plain REPL behavior is unchanged.
- Existing permission, question and management modals continue to take input precedence and temporarily hide the transcript viewport. Opening and closing a modal preserves `scrollTop` and `followBottom`.

## Testing

### Pure state tests

- clamps line, half-page and page movement;
- top/bottom jumps;
- upward movement disables follow-bottom;
- content growth preserves detached position;
- reaching bottom restores follow-bottom;
- resize behavior at top, middle and bottom.

### Row measurement tests

- wrapped ASCII;
- CJK and combining characters;
- ANSI-colored Markdown/code;
- explicit blank lines;
- width changes invalidate cached heights;
- entry-to-row ranges remain stable.

### Input tests

- key mapping and conditional Ctrl+D propagation;
- SGR wheel parsing;
- modal priority;
- cleanup disables mouse reporting.
- unsupported mouse bytes do not enter the editor.

### Render and integration tests

- a single long Markdown response scrolls by actual rows;
- large tool content scrolls without skipping the whole entry;
- user/model/tool ordering follows reducer event arrival;
- new streaming rows do not move a detached viewport;
- returning to bottom resumes follow mode;
- resize does not blank or jump the viewport;
- theme, tool-status revision and expansion changes invalidate the correct cached frame;
- opening and closing a modal preserves a detached viewport;
- a new `tests/e2e/tui-pty.test.ts` harness spawns `dist/tnb` in `@lydell/node-pty`, waits for stable frame markers, sends PageUp/Ctrl+U/Ctrl+End and SGR wheel sequences, then sends Ctrl+C and asserts alternate-screen and mouse-disable sequences plus child exit. The harness has a hard timeout and always kills/disposes the PTY in `finally` so verification cannot leak processes.

## Delivery boundary

This phase finishes when tnb no longer uses `transcriptOffset` or record counts for display scrolling, all listed controls work over actual rendered rows, follow-bottom has regression coverage, the full suite/typecheck/build pass, and no TUI or Bun test process remains after verification.

Tool-card expansion, PTY streaming, editor replacement and session-browser redesign remain separate phases built on this viewport.
