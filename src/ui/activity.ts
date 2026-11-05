export const ACTIVITY_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export function activityLabel(label: string, waitingSeconds: number): string {
  if (label !== "Requesting model") return label;
  if (waitingSeconds >= 15) return "Still waiting for model response";
  if (waitingSeconds >= 3) return "Waiting for model response";
  return label;
}
