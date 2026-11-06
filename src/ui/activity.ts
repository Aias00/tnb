export const ACTIVITY_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export function activityLabel(label: string, waitingSeconds: number): string {
  if (label.includes(" · retry ") && / in \d+s$/.test(label)) return label.replace(/ in (\d+)s$/, (_, seconds) => ` in ${Math.max(0, Number(seconds) - Math.floor(waitingSeconds))}s`);
  if (label !== "Requesting model") return label;
  if (waitingSeconds >= 15) return "Still waiting for model response";
  if (waitingSeconds >= 3) return "Waiting for model response";
  return label;
}
