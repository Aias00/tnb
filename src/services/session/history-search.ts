import { stat } from "node:fs/promises";
import { SessionStore } from "./storage";
export type HistoryMatch = { id: string; sessionId: string; role: "user" | "assistant" | "tool"; text: string; preview: string; partial: boolean };
export async function searchSessionHistory(options: { configDir: string; cwd: string; query: string; signal?: AbortSignal }): Promise<{ matches: HistoryMatch[]; truncated: boolean }> {
  options.signal?.throwIfAborted();
  const needle = options.query.trim().toLocaleLowerCase();
  if (needle.length > 1024) throw new Error("History query exceeds 1024 characters");
  const sessions = await SessionStore.list({ configDir: options.configDir, cwd: options.cwd, limit: 256, metadataOnly: true });
  const matches: HistoryMatch[] = []; let bytes = 0, truncated = sessions.length === 256;
  for (const session of sessions) {
    options.signal?.throwIfAborted();
    const store = new SessionStore({ configDir: options.configDir, cwd: options.cwd, sessionId: session.sessionId });
    const size = (await stat(store.filePath)).size;
    if (size > 32 * 1024 * 1024 || bytes + size > 64 * 1024 * 1024) { truncated = true; continue; }
    bytes += size;
    const audit = await store.audit();
    for (let index = audit.messages.length - 1; index >= 0; index--) {
      const message = audit.messages[index]!;
      for (const [blockIndex, block] of message.content.entries()) {
        if (block.type !== "text" && block.type !== "tool-result") continue;
        const text = block.type === "text" ? block.text : block.content;
        const at = needle ? text.toLocaleLowerCase().indexOf(needle) : 0;
        if (at < 0) continue;
        if (matches.length >= 100) return { matches, truncated: true };
        const start = Math.max(0, at - 300), end = Math.min(text.length, at + Math.max(needle.length, 1) + 900);
        matches.push({ id: `${session.sessionId}:${index}:${blockIndex}`, sessionId: session.sessionId, role: block.type === "tool-result" ? "tool" : message.role,
          text: text.length <= 32768 ? text : text.slice(start, end), preview: `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`, partial: text.length > 32768 });
      }
    }
  }
  return { matches, truncated };
}
