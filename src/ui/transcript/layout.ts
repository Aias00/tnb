import type { PromptLayout } from "../input/prompt-layout";

export const statusLineRows = (terminalRows: number, terminalColumns = 0): number => terminalColumns >= 80 || terminalRows < 18 ? 2 : 3;

export function measureTranscriptHeight(options: {
  terminalRows: number;
  terminalColumns?: number;
  promptLayout: PromptLayout;
  suggestionRows: number;
  auxiliaryRows?: number;
}): number {
  const statusRows = statusLineRows(options.terminalRows, options.terminalColumns);
  return Math.max(0, options.terminalRows - options.promptLayout.promptRowsUsed - statusRows - options.suggestionRows - (options.auxiliaryRows ?? 0));
}
