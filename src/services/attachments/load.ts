import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import type { MediaBlock, TextBlock } from "../../core/message";
import { assertToolPathInsideWorkspace, resolveWorkspaceRoot } from "../../utils/workspace-path";
import { isImagePath, isPdfPath, readImage, readPdf } from "../../tools/read-media";

export async function loadPromptAttachments(options: {
  cwd: string;
  prompt: string;
  paths: string[];
  capabilities: { supportsVision: boolean; supportsPdf: boolean };
  signal: AbortSignal;
}): Promise<Array<TextBlock | MediaBlock>> {
  const root = resolveWorkspaceRoot(options.cwd);
  const blocks: Array<TextBlock | MediaBlock> = [{ type: "text", text: options.prompt }];
  for (const rawPath of options.paths) {
    const path = rawPath.trim();
    if (!path) throw new Error("--attachment requires a non-empty path");
    await assertToolPathInsideWorkspace(root, path, "read");
    const target = resolve(root, path);
    const file = await stat(target);
    if (!file.isFile()) throw new Error(`Attachment is not a regular file: ${path}`);
    if (isImagePath(target)) {
      if (!options.capabilities.supportsVision) {
        throw new Error(`The selected model does not support image attachment: ${path}`);
      }
      const output = await readImage(target, path, options.signal);
      if (typeof output === "string") throw new Error(`Unable to load image attachment: ${path}`);
      blocks.push({ type: "text", text: `[Attached image: ${path}]` }, ...output.attachments);
      continue;
    }
    if (isPdfPath(target)) {
      const output = await readPdf(target, path, undefined, options.signal, options.capabilities);
      if (typeof output === "string") throw new Error(`Unable to load PDF attachment: ${path}`);
      blocks.push({ type: "text", text: `[Attached PDF: ${path}]` }, ...output.attachments);
      continue;
    }
    const content = await readFile(target, { encoding: "utf8", signal: options.signal });
    if (content.includes("\0")) {
      throw new Error(`Unsupported binary attachment: ${path}`);
    }
    blocks.push({
      type: "text",
      text: `<attachment path=${JSON.stringify(path)}>\n${content}\n</attachment>`,
    });
  }
  return blocks;
}
