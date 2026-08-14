import { useEffect, useRef } from "react";

import type { useSelection } from "./ink/index";

type Selection = ReturnType<typeof useSelection>;

export function subscribeToCopyOnSelect(selection: Selection): () => void {
  let copied = false;
  return selection.subscribe(() => {
    const state = selection.getState();
    if (state?.isDragging) {
      copied = false;
      return;
    }
    if (!selection.hasSelection()) {
      copied = false;
      return;
    }
    if (copied) return;
    selection.copySelectionNoClear();
    copied = true;
  });
}

export function useCopyOnSelect(selection: Selection, active = true): void {
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  useEffect(() => {
    if (!active) return;
    return subscribeToCopyOnSelect(selectionRef.current);
  }, [active, selection]);
}
