export function parseDeadline(value: string): number {
  const deadline = Date.parse(value);
  if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isSafeInteger(deadline) || deadline <= Date.now()) throw new Error("Deadline requires a future ISO date with timezone");
  return deadline;
}
export function extensionMilliseconds(hours: number): number {
  const milliseconds = hours * 3600000;
  if (!Number.isFinite(hours) || !Number.isSafeInteger(milliseconds) || milliseconds <= 0 || hours > 24 * 365) throw new Error("Extension must be positive and at most one year");
  return milliseconds;
}
