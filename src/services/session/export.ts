import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { ConversationMessage } from "../../core/message";
import { assertToolPathInsideWorkspace, resolveWorkspaceRoot } from "../../utils/workspace-path";

export async function exportConversation(options: {
  cwd: string;
  messages: ConversationMessage[];
  filename?: string;
  now?: Date;
}): Promise<string> {
  if (options.messages.length === 0) throw new Error("The current session has no conversation to export");
  const filename = normalizeExportFilename(
    options.filename || defaultExportFilename(options.messages, options.now ?? new Date()),
  );
  const root = resolveWorkspaceRoot(options.cwd);
  const path = resolve(root, filename);
  await assertToolPathInsideWorkspace(root, path, "write");
  await writeFile(path, renderConversation(options.messages), "utf8");
  return path;
}

export function renderConversation(messages: ConversationMessage[]): string {
  return `${messages.map(renderMessage).filter(Boolean).join("\n\n")}\n`;
}

function renderMessage(message: ConversationMessage): string {
  const blocks = message.content.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "thinking") return `<thinking>\n${block.thinking}\n</thinking>`;
    if (block.type === "tool-use") {
      return `[Tool: ${block.name}]\n${JSON.stringify(block.input, null, 2)}`;
    }
    if (block.type === "tool-result") {
      return `[Tool result${block.isError ? " · error" : ""}]\n${block.content}`;
    }
    if (block.type === "image") return `[Image: ${block.source.mediaType}]`;
    return `[Document: ${block.filename}]`;
  });
  return `# ${message.role === "user" ? "User" : "Assistant"}\n\n${blocks.join("\n\n")}`;
}

function defaultExportFilename(messages: ConversationMessage[], date: Date): string {
  const firstPrompt = messages.flatMap((message) =>
    message.role === "user"
      ? message.content.filter((block) => block.type === "text").map((block) => block.text)
      : []
  )[0];
  const title = sanitizeFilename(firstPrompt?.split("\n")[0]?.slice(0, 50) ?? "");
  const timestamp = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
    "-",
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0"),
  ].join("");
  return title ? `${timestamp}-${title}.txt` : `conversation-${timestamp}.txt`;
}

function normalizeExportFilename(filename: string): string {
  const trimmed = filename.trim();
  if (!trimmed) throw new Error("Export filename must not be empty");
  return trimmed.endsWith(".txt") ? trimmed : `${trimmed.replace(/\.[^./]+$/, "")}.txt`;
}

function sanitizeFilename(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
