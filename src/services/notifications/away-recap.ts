/** Local counts only: never retain tool arguments, paths, or output. */
export class AwayRecap {
  private away = false;
  private completed = 0;
  private failed = 0;
  focus(focused: boolean, pending = 0): string | undefined {
    if (!focused) { this.away = true; return; }
    if (!this.away) return;
    this.away = false;
    const message = this.completed || this.failed || pending ? `离开期间：${this.completed} 次工具执行完成，${this.failed} 次失败${pending ? `，${pending} 项等待处理` : ""}。可查看对话详情；后台任务见 /tasks。` : undefined;
    this.completed = this.failed = 0;
    return message;
  }
  toolFinished(failed: boolean) { if (this.away) { if (failed) this.failed++; else this.completed++; } }
}
