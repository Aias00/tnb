import type { Key } from "../ink/events/input-event";
import type { PromptEditorAction } from "./editor-state";

export function promptActionFromKey(input: string, key: Key, columns: number): PromptEditorAction | undefined {
  if ((key.meta || key.ctrl) && key.leftArrow || key.meta && input === "b") return { type: "word-left", columns };
  if ((key.meta || key.ctrl) && key.rightArrow || key.meta && input === "f") return { type: "word-right", columns };
  if (key.ctrl && input === "k") return { type: "kill-line-end", columns };
  if (key.ctrl && input === "u") return { type: "kill-line-start", columns };
  if (key.ctrl && input === "w") return { type: "kill-word", columns };
  if (key.ctrl && input === "y") return { type: "yank", columns };
  if (key.meta && input === "y") return { type: "yank-pop", columns };
  if (key.leftArrow) return { type: "left", columns };
  if (key.rightArrow) return { type: "right", columns };
  if (key.upArrow) return { type: "up", columns };
  if (key.downArrow) return { type: "down", columns };
  if (key.home || key.ctrl && input === "a") return { type: "home", columns };
  if (key.end || key.ctrl && input === "e") return { type: "end", columns };
  if (key.backspace) return { type: "backspace", columns };
  if (key.delete) return { type: "delete", columns };
  if (key.ctrl && input === "d") return { type: "delete", columns };
  if (key.return && key.shift) return { type: "insert", text: "\n", columns };
  if (input && !key.ctrl && !key.meta) return { type: "insert", text: input, columns };
  return undefined;
}
