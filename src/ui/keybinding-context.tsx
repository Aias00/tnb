import { createContext, useContext } from "react";
import { DEFAULT_KEYBINDINGS, type KeybindingAction } from "./keybindings";

const KeybindingContext = createContext(DEFAULT_KEYBINDINGS);
export const KeybindingProvider = KeybindingContext.Provider;

export function useKeybindingLabel(action: KeybindingAction): string {
  const binding = useContext(KeybindingContext)[action];
  return binding?.replace(/meta/g, "alt") ?? "disabled";
}
