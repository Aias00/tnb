export function measureTranscriptHeight(options: {
  terminalRows: number;
  terminalColumns: number;
  input: string;
  suggestionRows: number;
}): number {
  const width = Math.max(1, options.terminalColumns - 6);
  const inputRows = Math.max(1, options.input.split("\n").reduce(
    (rows, line) => rows + Math.max(1, Math.ceil((line.length + 2) / width)),
    0,
  ));
  const promptRows = inputRows + 2;
  const statusRows = 2;
  return Math.max(0, options.terminalRows - promptRows - statusRows - options.suggestionRows);
}
