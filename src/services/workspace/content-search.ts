export type ContentMatch = { file: string; line: number; text: string; preview: string[] };
export async function searchWorkspaceContent(root: string, query: string, signal?: AbortSignal): Promise<{ matches: ContentMatch[]; truncated: boolean }> {
  if (!query.trim()) throw new Error("Usage: /search <text>");
  signal?.throwIfAborted();
  const child = Bun.spawn(["rg", "--json", "--context", "2", "--fixed-strings", "--max-count", "10", "--max-filesize", "1M", "--glob", "!node_modules/**", "--glob", "!dist/**", "--", query, "."], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const stop = () => child.kill();
  const timeout = setTimeout(stop, 3000);
  signal?.addEventListener("abort", stop, { once: true });
  const reader = child.stdout.getReader();
  const matches: ContentMatch[] = []; let pending = "", bytes = 0, truncated = false;
  const context = new Map<string, Map<number, string>>();
  const decoder = new TextDecoder();
  const errors = new Response(child.stderr).text();
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.length;
      if (bytes > 1024 * 1024) { truncated = true; stop(); break; }
      pending += decoder.decode(next.value, { stream: true });
      const lines = pending.split("\n"); pending = lines.pop()!;
      for (const line of lines) {
        const event = JSON.parse(line);
        if (!["match", "context"].includes(event.type) || !event.data.path.text || !event.data.lines.text) continue;
        const file = event.data.path.text.replaceAll("\\", "/").replace(/^\.\//, "");
        const rows = context.get(file) ?? new Map<number, string>();
        rows.set(event.data.line_number, event.data.lines.text.trimEnd().slice(0, 1000)); context.set(file, rows);
        if (event.type !== "match") continue;
        if (matches.length >= 200) { truncated = true; stop(); break; }
        matches.push({ file, line: event.data.line_number, text: event.data.lines.text.trimEnd().slice(0, 1000), preview: [] });
      }
      if (truncated) break;
    }
    signal?.throwIfAborted();
    const code = await child.exited;
    const stderr = await errors;
    if (code !== 0 && code !== 1 && !truncated) throw new Error(stderr.trim() || "Content search interrupted or timed out");
    for (const match of matches) match.preview = [...(context.get(match.file) ?? [])].filter(([line]) => Math.abs(line - match.line) <= 2).sort((a, b) => a[0] - b[0]).map(([line, text]) => `${line}: ${text}`);
    return { matches, truncated };
  } finally { clearTimeout(timeout); signal?.removeEventListener("abort", stop); stop(); await reader.cancel().catch(() => {}); await child.exited; }
}
