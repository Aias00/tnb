import type { PromptLayout } from "../input/prompt-layout";

export const statusLineRows = (terminalRows: number): number => terminalRows >= 18 ? 3 : 2;

export function measureTranscriptHeight(options: {
  terminalRows: number;
  promptLayout: PromptLayout;
  suggestionRows: number;
  auxiliaryRows?: number;
}): number {
  const statusRows = statusLineRows(options.terminalRows);
  return Math.max(0, options.terminalRows - options.promptLayout.promptRowsUsed - statusRows - options.suggestionRows - (options.auxiliaryRows ?? 0));
}
