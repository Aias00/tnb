import { join } from "node:path";
import { SessionStore } from "../session/storage";
import { searchSessionHistory } from "../session/history-search";
import { reviewTurns } from "../git/turn-review";
import { buildLineDiff } from "../git/line-diff";
import { compactionLabel } from "../compact/notice";
import { loadMcpConfig } from "../mcp/config";
import { connectMcpPool } from "../mcp/pool";
export type InspectionItem = { id: string; title: string; subtitle?: string; body: string; draftText?: string; referenceText?: string; reconnectServer?: string };
export type InspectionView = { title: string; description: string; items: InspectionItem[] };
export type InspectionRequest = { kind: "history" | "changes" | "compactions" | "mcp" | "mcp-reconnect"; query?: string; chatId?: string; server?: string };
export function createWorkspaceInspection(options: { workspace: string; configDir: string; env: Record<string, string | undefined>; signal: AbortSignal; assertChat(id: string): void }) {
  const pools = new Map<string, Awaited<ReturnType<typeof connectMcpPool>>>(), pending = new Map<string, Promise<void>>();
  const config = () => loadMcpConfig(options.env.TNB_MCP_CONFIG ?? join(options.configDir, "mcp.json"), options.env);
  return {
    async inspect(input: InspectionRequest, signal?: AbortSignal): Promise<InspectionView> {
      options.signal.throwIfAborted(); signal?.throwIfAborted();
      if (!input || !["history", "changes", "compactions", "mcp", "mcp-reconnect"].includes(input.kind) || Object.keys(input).some(key => !["kind", "query", "chatId", "server"].includes(key)) || [input.query, input.chatId, input.server].some(value => value !== undefined && typeof value !== "string") || (input.query?.length ?? 0) > 1024) throw new Error("Invalid inspection request");
      if (input.kind === "history") {
        const result = await searchSessionHistory({ cwd: options.workspace, configDir: options.configDir, query: input.query ?? "", signal: signal ? AbortSignal.any([options.signal, signal]) : options.signal });
        return { title: "会话历史全文检索", description: `当前工作区 · 用户输入 / 回答 / 工具输出${result.truncated ? " · 扫描或结果已截断" : ""} · 选择仅加入草稿`, items: result.matches.map(match => ({ id: match.id, title: `${match.role === "user" ? "用户输入" : match.role === "assistant" ? "回答" : "工具输出"} · ${match.sessionId}`, body: match.preview, subtitle: match.partial ? "仅命中片段" : "文本记录；不含媒体",
          ...(match.role === "user" && !match.partial ? { draftText: match.text } : { referenceText: `历史引用 ${match.id}（${match.role}）：\n${match.preview}\n引用结束` }) })) };
      }
      if (input.kind === "mcp" || input.kind === "mcp-reconnect") {
        const configured = await config();
        if (input.kind === "mcp-reconnect") {
          const name = input.server ?? "", server = configured.mcpServers[name];
          if (!Object.hasOwn(configured.mcpServers, name) || !server || server.enabled === false) throw new Error("请选择已启用的 MCP 服务");
          if (!pending.has(name)) {
            const work = (async () => {
              const next = await connectMcpPool({ mcpServers: { [name]: server } }, { cwd: options.workspace, configDir: options.configDir, stdioEnv: options.env, requestTimeoutMs: 3000, signal: signal ? AbortSignal.any([options.signal, signal]) : options.signal });
              if (next.statuses[name]?.state !== "connected") { await next.close(); throw new Error("连接检查失败；原有诊断连接保留，请核对配置或认证。"); }
              const previous = pools.get(name); pools.set(name, next); await previous?.close();
            })().finally(() => pending.delete(name)); pending.set(name, work);
          }
          await pending.get(name);
        }
        return { title: "MCP 连接管理", description: "显式检查工作区配置的连接。诊断连接与运行中的对话独立；不会中断对话或授予工具权限。认证请使用 tnb mcp auth。", items: Object.entries(configured.mcpServers).map(([name, server]) => ({ id: name, title: name,
          subtitle: server.enabled === false ? "已禁用" : pools.get(name)?.statuses[name]?.state ?? "未检查", body: `传输：${server.type ?? "stdio"}\n不显示凭证或环境变量。`, ...(server.enabled === false ? {} : { reconnectServer: name }) })) };
      }
      if (!input.chatId) throw new Error("请先选择会话"); options.assertChat(input.chatId);
      const audit = await new SessionStore({ configDir: options.configDir, cwd: options.workspace, sessionId: input.chatId }).audit();
      if (input.kind === "compactions") return { title: "上下文整理记录", description: "已记录的整理类型与摘要；查看不会调用模型。", items: audit.compactions.map((record, index) => ({ id: String(index), title: compactionLabel(record.strategy), subtitle: `${record.timestamp} · ${record.preTokens} → ${record.postTokens} 估算 tokens`, body: record.summary || "此记录未生成对话摘要。" })) };
      if (input.kind !== "changes") throw new Error("未知检查类型");
      const items: InspectionItem[] = [];
      for (const turn of reviewTurns(audit.messages)) {
        for (const [index, change] of turn.changes.entries()) items.push({ id: `${turn.turn}:${index}`, title: change.path, subtitle: `第 ${turn.turn} 轮 · edit/write 精确证据`, body: change.truncated || change.after === undefined ? "快照超过上限，仅记录哈希。" : buildLineDiff(change.before ?? "", change.after).map(row => `${row.kind === "added" ? "+" : row.kind === "removed" ? "-" : " "}${row.text}`).join("\n") });
        for (const [index, observation] of turn.observations.entries()) for (const change of observation.changes) items.push({ id: `observed:${turn.turn}:${index}:${change.path}`, title: change.path, subtitle: `第 ${turn.turn} 轮 · ${change.window === "during-command" ? "命令窗口内" : "两次命令之间"}观察；来源未确认`, body: `版本 ${change.before ?? "不存在"} → ${change.after ?? "不存在"}${observation.partial ? "\n观测覆盖不完整。" : ""}` });
      }
      return { title: "分轮改动审阅", description: "编辑证据与时间窗口观测分别标注；观测不证明修改者。显示最近 200 项。", items: items.slice(-200).reverse() };
    },
    async close() { await Promise.allSettled([...pending.values()]); await Promise.allSettled([...pools.values()].map(pool => pool.close())); pools.clear(); },
  };
}
