import { readFile, realpath, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { IdeJsonRpcClient } from "./ide-client";
import { assertToolPathInsideWorkspace } from "../../utils/workspace-path";
import type { IdeEditorContext } from "./ide-jsonrpc";

export type IdeSelectionReference = { label: string; text: string };

/** Explicit selection snapshot only; never watches or silently reads the active editor. */
export async function selectionReference(workspace: string, selection: NonNullable<IdeEditorContext["selection"]>): Promise<IdeSelectionReference> {
  const root = await realpath(workspace);
  const file = await realpath(resolve(workspace, selection.file));
  await assertToolPathInsideWorkspace(root, file, "read");
  for (const number of [selection.startLine, selection.endLine, selection.startColumn, selection.endColumn]) if (!Number.isSafeInteger(number) || number < 1) throw new Error("Invalid IDE selection range");
  if (selection.endLine < selection.startLine || selection.endLine === selection.startLine && selection.endColumn < selection.startColumn) throw new Error("IDE selection ends before it starts");
  let text = selection.text;
  if (text === undefined) {
    if ((await stat(file)).size > 1024 * 1024) throw new Error("IDE selection file exceeds 1 MiB; send an explicit editor selection snapshot");
    const source = await readFile(file, "utf8");
    if (source.includes("\0")) throw new Error("IDE selection must be text");
    const lines = source.split(/\r?\n/);
    if (selection.endLine > lines.length) throw new Error("IDE selection line is outside the file");
    if (selection.startColumn > lines[selection.startLine - 1]!.length + 1 || selection.endColumn > lines[selection.endLine - 1]!.length + 1) throw new Error("IDE selection column is outside the file");
    const range = lines.slice(selection.startLine - 1, selection.endLine);
    if (range.length === 1) text = range[0]!.slice(selection.startColumn - 1, selection.endColumn - 1);
    else { range[0] = range[0]!.slice(selection.startColumn - 1); range[range.length - 1] = range.at(-1)!.slice(0, selection.endColumn - 1); text = range.join("\n"); }
  }
  if (!text || Buffer.byteLength(text) > 32 * 1024) throw new Error("Select nonempty IDE text up to 32 KiB");
  const path = relative(root, file);
  const label = `${path}:${selection.startLine}:${selection.startColumn}-${selection.endLine}:${selection.endColumn}`;
  return { label, text: `IDE selection snapshot · ${JSON.stringify(label)}\n${text}\nEnd IDE selection snapshot` };
}

export async function loadIdeSelection(workspace: string, descriptorPath: string): Promise<IdeSelectionReference> {
  const timeout = AbortSignal.timeout(5000);
  const client = await IdeJsonRpcClient.connect({ descriptorPath, signal: timeout });
  try {
    if (await realpath(client.server.workspace) !== await realpath(workspace)) throw new Error("IDE bridge is outside the current workspace");
    const context = await client.request<IdeEditorContext>("editor/getContext", undefined, timeout);
    if (!context.selection) throw new Error("The IDE has no selected text");
    return await selectionReference(workspace, context.selection);
  } finally { client.close(); }
}
