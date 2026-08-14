import { describe, expect, test } from "bun:test";

import { createSelectionState } from "../../src/ui/ink/selection";
import { subscribeToCopyOnSelect } from "../../src/ui/use-copy-on-select";

describe("TUI text selection clipboard", () => {
  test("copies once when a mouse selection settles and preserves the selection", () => {
    const state = createSelectionState();
    const listeners = new Set<() => void>();
    let copies = 0;
    const selection = {
      copySelection: () => "",
      copySelectionNoClear: () => { copies += 1; return "selected text"; },
      clearSelection: () => undefined,
      hasSelection: () => state.anchor !== null && state.focus !== null,
      getState: () => state,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      shiftAnchor: () => undefined,
      shiftSelection: () => undefined,
      moveFocus: () => undefined,
      captureScrolledRows: () => undefined,
      setSelectionBgColor: () => undefined,
    };
    const unsubscribe = subscribeToCopyOnSelect(selection);

    state.anchor = { col: 0, row: 0 };
    state.focus = { col: 4, row: 0 };
    state.isDragging = true;
    listeners.forEach((listener) => listener());
    expect(copies).toBe(0);

    state.isDragging = false;
    listeners.forEach((listener) => listener());
    listeners.forEach((listener) => listener());
    expect(copies).toBe(1);
    expect(state.anchor).toEqual({ col: 0, row: 0 });
    expect(state.focus).toEqual({ col: 4, row: 0 });

    unsubscribe();
    expect(listeners.size).toBe(0);
  });
});
