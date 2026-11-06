import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const KEYBINDING_ACTIONS = [
  "historySearch",
  "transcriptSearch",
  "externalEditor",
  "toggleTranscript",
  "toggleTasks",
  "pasteImage",
  "promptQueue",
  "redraw",
  "previousMessage",
  "nextMessage",
  "editMessage",
  "copyToolInput",
  "previousTool",
  "nextTool",
  "toggleTool",
] as const;

export type KeybindingAction = (typeof KEYBINDING_ACTIONS)[number];
export type KeybindingMap = Record<KeybindingAction, string | null>;

export const DEFAULT_KEYBINDINGS: KeybindingMap = {
  historySearch: "ctrl+r",
  transcriptSearch: "ctrl+f",
  externalEditor: "ctrl+g",
  toggleTranscript: "ctrl+o",
  toggleTasks: "ctrl+t",
  pasteImage: "ctrl+v",
  promptQueue: "ctrl+q",
  redraw: "ctrl+l",
  previousMessage: "ctrl+shift+up",
  nextMessage: "ctrl+shift+down",
  editMessage: "meta+e",
  copyToolInput: "meta+p",
  previousTool: "meta+up",
  nextTool: "meta+down",
  toggleTool: "meta+enter",
};

type KeyLike = {
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  home?: boolean;
  end?: boolean;
  return?: boolean;
  tab?: boolean;
  escape?: boolean;
};

export async function loadKeybindings(configDir: string): Promise<KeybindingMap> {
  const path = join(configDir, "keybindings.json");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isMissingFile(error)) return { ...DEFAULT_KEYBINDINGS };
    throw new Error(`Invalid keybindings JSON: ${path}`, { cause: error });
  }
  if (!isRecord(value) || !isRecord(value.bindings)) {
    throw new Error(`keybindings.json must contain a bindings object: ${path}`);
  }
  const result = { ...DEFAULT_KEYBINDINGS };
  for (const [action, binding] of Object.entries(value.bindings)) {
    if (!KEYBINDING_ACTIONS.includes(action as KeybindingAction)) {
      throw new Error(`Unknown keybinding action '${action}': ${path}`);
    }
    if (binding !== null && typeof binding !== "string") {
      throw new Error(`Keybinding ${action} must be a string or null: ${path}`);
    }
    if (typeof binding === "string") validateBinding(binding, action, path);
    result[action as KeybindingAction] = typeof binding === "string" ? binding.trim().toLocaleLowerCase() : null;
  }
  return result;
}

export function matchesKeybinding(
  bindings: KeybindingMap,
  action: KeybindingAction,
  input: string,
  key: KeyLike,
): boolean {
  // Cancellation/exit remain reachable even if a custom map assigns these keys.
  if (key.escape || key.ctrl && input.toLowerCase() === "c") return false;
  const binding = bindings[action];
  if (!binding) return false;
  const parts = binding.trim().toLocaleLowerCase().split("+");
  const expectedCtrl = parts.includes("ctrl");
  const expectedShift = parts.includes("shift");
  const expectedMeta = parts.includes("meta") || parts.includes("cmd");
  if (key.ctrl !== expectedCtrl || key.shift !== expectedShift || key.meta !== expectedMeta) return false;
  const name = parts.at(-1)!;
  if (name === "up") return key.upArrow === true;
  if (name === "down") return key.downArrow === true;
  if (name === "left") return key.leftArrow === true;
  if (name === "right") return key.rightArrow === true;
  if (name === "pageup") return key.pageUp === true;
  if (name === "pagedown") return key.pageDown === true;
  if (name === "home") return key.home === true;
  if (name === "end") return key.end === true;
  if (name === "enter") return key.return === true;
  if (name === "tab") return key.tab === true;
  if (name === "escape") return false;
  return input.toLocaleLowerCase() === name;
}

function validateBinding(binding: string, action: string, path: string): void {
  const normalized = binding.trim().toLocaleLowerCase();
  if (!/^(?:(?:ctrl|shift|meta|cmd)\+)*(?:[a-z0-9]|up|down|left|right|pageup|pagedown|home|end|enter|tab|escape)$/.test(normalized)) {
    throw new Error(`Invalid keybinding '${binding}' for ${action}: ${path}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}


export function diagnoseKeybindings(bindings: KeybindingMap): string[] {
  const groups = new Map<string, string[]>();
  const warnings: string[] = [];
  for (const action of KEYBINDING_ACTIONS) {
    const binding = bindings[action]; if (!binding) continue;
    const parts = binding.toLowerCase().replace(/cmd/g, "meta").split("+");
    const key = parts.pop()!;
    const modifiers = [...new Set(parts)].sort();
    const canonical = [...modifiers, key].join("+");
    const actions = groups.get(canonical) ?? []; actions.push(action); groups.set(canonical, actions);
    if (canonical === "ctrl+c" || canonical === "escape") warnings.push(`${action}: ${binding} conflicts with fixed cancel/exit controls.`);
    if (["ctrl+s", "ctrl+_", "ctrl+shift+-"].includes(canonical)) warnings.push(`${action}: ${binding} overlaps prompt stash/undo controls.`);
    if (modifiers.length !== parts.length) warnings.push(`${action}: repeated modifiers in ${binding}.`);
  }
  for (const [binding, actions] of groups) if (actions.length > 1) warnings.push(`${binding} is assigned to ${actions.join(", ")}; only the first matching action can run in the active view.`);
  return warnings;
}
