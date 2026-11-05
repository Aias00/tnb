import { mkdir, readFile, open, rename, rm, lstat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { digestJson } from "../services/runtime/json";
import type { QueuedInput } from "./workbench";
import type { PromptInputSubmit } from "./prompt-input/types";

export type InputQueueStorage = { load(sessionId: string): Promise<QueuedInput[]>; save(sessionId: string, items: readonly QueuedInput[]): Promise<void> };
export class FileInputQueueStorage implements InputQueueStorage {
  constructor(readonly configDir: string) {}
  #directory() { return join(this.configDir, "ui-queues"); }
  #path(sessionId: string) { return join(this.#directory(), digestJson({ sessionId }) + ".json"); }
  async load(sessionId: string): Promise<QueuedInput[]> {
    try {
      const directory = await lstat(this.#directory());
      if (!directory.isDirectory() || directory.isSymbolicLink() || (process.platform !== "win32" && ((directory.mode & 0o077) || directory.uid !== process.getuid?.()))) throw new Error("排队输入目录不安全");
      const path = this.#path(sessionId), info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024 || (process.platform !== "win32" && ((info.mode & 0o077) || info.uid !== process.getuid?.()))) throw new Error("排队输入存储无效");
      return validate(JSON.parse(await readFile(path, "utf8")), sessionId);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  async save(sessionId: string, items: readonly QueuedInput[]): Promise<void> {
    validate(items, sessionId);
    const encoded = JSON.stringify(items); if (Buffer.byteLength(encoded) > 2 * 1024 * 1024) throw new Error("排队输入超过 2 MiB");
    await mkdir(this.#directory(), { recursive: true, mode: 0o700 });
    const info = await lstat(this.#directory());
    if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== "win32" && ((info.mode & 0o077) || info.uid !== process.getuid?.()))) throw new Error("排队输入目录不安全");
    const temporary = this.#path(sessionId) + `.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600); try { await file.writeFile(encoded); await file.sync(); } finally { await file.close(); }
      await rename(temporary, this.#path(sessionId));
      if (process.platform !== "win32") { const parent = await open(this.#directory(), "r"); try { await parent.sync(); } finally { await parent.close(); } }
    }
    finally { await rm(temporary, { force: true }); }
  }
}
function validate(value: unknown, sessionId: string): QueuedInput[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error("排队输入最多 32 项");
  for (const item of value) if (!item || typeof item !== "object" || typeof item.id !== "string" || item.id.length > 128 || item.sessionId !== sessionId
    || typeof item.workspace !== "string" || !["pending", "uncertain", "draft"].includes(item.state)
    || !item.input || typeof item.input.display !== "string" || typeof item.input.expanded !== "string" || item.input.expanded.trimStart().startsWith("/") || !["prompt", "bash"].includes(item.input.mode)
    || !item.input.pastedContents || typeof item.input.pastedContents !== "object" || Array.isArray(item.input.pastedContents)) throw new Error("排队输入格式不匹配");
  if (new Set(value.map((item) => item.id)).size !== value.length) throw new Error("重复的排队输入身份");
  return structuredClone(value);
}
/** Persist before acknowledgment; claiming an item is conservative after interruption. */
export class InputQueue {
  #items: readonly QueuedInput[] = []; #listeners = new Set<() => void>(); #tail: Promise<unknown> = Promise.resolve(); ready = false;
  constructor(readonly sessionId: string, readonly storage?: InputQueueStorage) {}
  current = () => this.#items;
  subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  #emit() { for (const listener of this.#listeners) listener(); }
  async load() { return this.#serialize(async () => { this.#items = validate(this.storage ? await this.storage.load(this.sessionId) : [], this.sessionId); this.ready = true; this.#emit(); }); }
  #serialize<T>(run: () => Promise<T>): Promise<T> { const next = this.#tail.catch(() => undefined).then(run); this.#tail = next; return next; }
  async #save(items: readonly QueuedInput[]) {
    const checked = validate(items, this.sessionId); if (Buffer.byteLength(JSON.stringify(checked)) > 2 * 1024 * 1024) throw new Error("排队输入超过 2 MiB");
    await this.storage?.save(this.sessionId, checked); this.#items = checked; this.#emit();
  }
  enqueue(input: PromptInputSubmit, workspace: string) { return this.#serialize(async () => {
    if (!this.ready) throw new Error("排队输入尚未恢复"); if (this.#items.length >= 32) throw new Error("排队输入最多 32 项");
    const item: QueuedInput = { id: randomUUID(), sessionId: this.sessionId, workspace, state: "pending", input: structuredClone(input) };
    await this.#save([...this.#items, item]); return item;
  }); }
  claim(id: string, workspace: string) { return this.#serialize(async () => {
    const item = this.#items.find((item) => item.id === id);
    if (!item || item.state !== "pending" || item.workspace !== workspace) throw new Error("排队输入或工作区已变化");
    await this.#save(this.#items.map((row) => row.id === id ? { ...row, state: "uncertain" } : row)); return item;
  }); }
  edit(id: string, workspace: string) { return this.#serialize(async () => {
    const item = this.#items.find((row) => row.id === id); if (!item || item.workspace !== workspace) throw new Error("排队输入属于其他工作区或已处理");
    await this.#save(this.#items.map((row) => row.id === id ? { ...row, state: "draft" } : row)); return item;
  }); }
  requeue(id: string, input: PromptInputSubmit, workspace: string) { return this.#serialize(async () => {
    const item = this.#items.find((row) => row.id === id); if (!item || item.state !== "draft" || item.workspace !== workspace) throw new Error("编辑中的输入或工作区已变化");
    await this.#save(this.#items.map((row) => row.id === id ? { ...row, state: "pending", input: structuredClone(input) } : row));
  }); }
  remove(id: string) { return this.#serialize(async () => { const item = this.#items.find((row) => row.id === id); if (!item) throw new Error("排队输入已处理"); await this.#save(this.#items.filter((row) => row.id !== id)); return item; }); }
}
