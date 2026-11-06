export type IdleNotice = { id: string; kind: "permission" | "question" | "finished" | "background" };

/** Host policy only; generic messages never include prompts, code, commands or paths. */
export class IdleNotifications {
  private interactionAt: number;
  private pending = new Map<string, IdleNotice & { at: number }>();
  private sent = new Set<string>();
  constructor(private readonly notify: (kind: IdleNotice["kind"]) => void, private readonly now = Date.now, private readonly delay = 6000) { this.interactionAt = now(); }
  interaction() { this.interactionAt = this.now(); for (const [id, notice] of this.pending) if (notice.kind === "finished") this.pending.delete(id); }
  sync(notices: readonly IdleNotice[]) {
    const ids = new Set(notices.map(notice => notice.id));
    for (const [id, notice] of this.pending) if (notice.kind !== "finished" && !ids.has(id)) this.pending.delete(id);
    for (const notice of notices) this.add(notice);
  }
  add(notice: IdleNotice) { if (!this.sent.has(notice.id) && !this.pending.has(notice.id)) this.pending.set(notice.id, { ...notice, at: this.now() }); }
  tick(focused = true) {
    const now = this.now();
    for (const [id, notice] of this.pending) {
      if (now - notice.at < (focused ? this.delay : 500) || focused && now - this.interactionAt < this.delay) continue;
      this.sent.add(id); this.pending.delete(id);
      try { this.notify(notice.kind); } catch { /* Notification failure cannot change execution. */ }
      if (this.sent.size > 128) this.sent.delete(this.sent.values().next().value!);
    }
  }
  close() { this.pending.clear(); this.sent.clear(); }
}

export function terminalNotice(kind: IdleNotice["kind"], env: Record<string, string | undefined>): string {
  const message = kind === "permission" ? "TNB needs tool approval" : kind === "question" ? "TNB has a question" : kind === "background" ? "TNB background task needs attention" : "TNB foreground turn ended";
  if (env.TMUX) return "\u0007";
  if (env.TERM_PROGRAM === "iTerm.app") return `\u001b]9;${message}\u0007`;
  if (env.TERM_PROGRAM === "ghostty") return `\u001b]777;notify;TNB;${message}\u0007`;
  return "\u0007";
}
