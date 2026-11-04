import type { PromptLayout } from "../input/prompt-layout";

export function measureTranscriptHeight(options: {
  terminalRows: number;
  promptLayout: PromptLayout;
  suggestionRows: number;
  auxiliaryRows?: number;
}): number {
  const statusRows = 2;
  return Math.max(0, options.terminalRows - options.promptLayout.promptRowsUsed - statusRows - options.suggestionRows - (options.auxiliaryRows ?? 0));
}
