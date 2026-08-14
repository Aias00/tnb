import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import { Box, ScrollBox, type ScrollBoxHandle, type DOMElement } from "../ink/index";
import { TranscriptEntryView } from "./entry-view";
import type { TranscriptEntry } from "./model";
import { VirtualList } from "../virtual/VirtualList";
import {
  scrollBy,
  scrollHalfPage,
  scrollPage,
  scrollToBottom,
  scrollToTop,
  type ViewportState,
} from "./viewport-state";

export type TranscriptScrollCommand = "line-up" | "line-down" | "page-up" | "page-down" | "half-up" | "half-down" | "top" | "bottom";
export type TranscriptViewportController = {
  scroll(command: TranscriptScrollCommand): boolean;
  reveal(entryId: string): boolean;
  snapshot(): ViewportState;
};

export const TranscriptViewport = forwardRef<TranscriptViewportController, {
  entries: readonly TranscriptEntry[];
  width: number;
  height: number;
  theme?: string;
  verbose?: boolean;
  selectedEntryId?: string;
  onStateChange?(state: ViewportState): void;
}>(function TranscriptViewport({ entries, width, height, theme, verbose = false, selectedEntryId, onStateChange }, ref) {
  const scrollRef = useRef<ScrollBoxHandle | null>(null);
  const entryRefs = useRef(new Map<string, DOMElement>());
  const itemKey = useCallback((entry: TranscriptEntry) => entry.id, []);
  const snapshot = useCallback((): ViewportState => {
    const handle = scrollRef.current;
    const viewportHeight = handle?.getViewportHeight() || height;
    const contentHeight = handle?.getScrollHeight() || 0;
    const scrollTop = handle?.getScrollTop() || 0;
    return {
      scrollTop,
      viewportHeight,
      contentHeight,
      followBottom: handle?.isSticky() ?? true,
    };
  }, [height]);

  useEffect(() => scrollRef.current?.subscribe(() => onStateChange?.(snapshot())), [onStateChange, snapshot]);
  useEffect(() => {
    if (scrollRef.current?.isSticky()) scrollRef.current.scrollToBottom();
    queueMicrotask(() => onStateChange?.(snapshot()));
  }, [entries, onStateChange, snapshot, theme, verbose, width]);

  useImperativeHandle(ref, () => ({
    scroll(command) {
      const handle = scrollRef.current;
      if (!handle) return false;
      const before = handle.getScrollTop();
      const page = Math.max(1, handle.getViewportHeight());
      if (command === "line-up") handle.scrollBy(-3);
      else if (command === "line-down") handle.scrollBy(3);
      else if (command === "page-up") handle.scrollBy(-page);
      else if (command === "page-down") handle.scrollBy(page);
      else if (command === "half-up") handle.scrollBy(-Math.max(1, Math.floor(page / 2)));
      else if (command === "half-down") handle.scrollBy(Math.max(1, Math.floor(page / 2)));
      else if (command === "top") handle.scrollTo(0);
      else handle.scrollToBottom();
      queueMicrotask(() => onStateChange?.(snapshot()));
      return before !== handle.getScrollTop() || command === "bottom";
    },
    reveal(entryId) {
      const element = entryRefs.current.get(entryId);
      if (!element || !scrollRef.current) return false;
      scrollRef.current.scrollToElement(element);
      return true;
    },
    snapshot,
  }), [onStateChange, snapshot]);

  return (
    <ScrollBox ref={scrollRef} height={Math.max(0, height)} width={Math.max(1, width)} flexDirection="column" stickyScroll>
      <VirtualList
        items={entries}
        itemKey={itemKey}
        columns={width}
        scrollRef={scrollRef}
        renderItem={entry => (
          <Box ref={element => {
            if (element) entryRefs.current.set(entry.id, element);
            else entryRefs.current.delete(entry.id);
          }} flexDirection="column">
            <TranscriptEntryView entry={entry} verbose={verbose} selected={entry.id === selectedEntryId} />
          </Box>
        )}
      />
    </ScrollBox>
  );
});

export function applyViewportCommand(state: ViewportState, command: TranscriptScrollCommand): ViewportState {
  if (command === "line-up") return scrollBy(state, -1);
  if (command === "line-down") return scrollBy(state, 1);
  if (command === "page-up") return scrollPage(state, "up");
  if (command === "page-down") return scrollPage(state, "down");
  if (command === "half-up") return scrollHalfPage(state, "up");
  if (command === "half-down") return scrollHalfPage(state, "down");
  if (command === "top") return scrollToTop(state);
  return scrollToBottom(state);
}
