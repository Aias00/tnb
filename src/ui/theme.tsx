import React, { createContext, useContext } from "react";

export type AccentColor = "magenta" | "cyan" | "blue" | "green";

// Keep body/background terminal-owned so light themes and ANSI palettes work.
export const UI_COLORS = {
  border: "gray",
  success: "green",
  warning: "yellow",
  error: "red",
} as const;

const AccentContext = createContext<AccentColor>("cyan");
export const AccentProvider = AccentContext.Provider;
export function useAccent(): AccentColor { return useContext(AccentContext); }
