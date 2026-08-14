import type { Socket } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { assertToolPathInsideWorkspace, resolveWorkspaceRoot } from "../../utils/workspace-path";
import { runGit } from "../git/command";
import { ShellSessionManager } from "../shell/manager";

export type IdeEditorContext = {
  activeFile?: string;
  openFiles: string[];
  selection?: { file: string; startLine: number; startColumn: number; endLine: number; endColumn: number; text?: string };
  diagnostics: Array<{ file: string; line: number; column?: number; severity: "error" | "warning" | "info"; message: string }>;
  visibleDiff?: string;
};

type JsonRpcRequest = { jsonrpc: "2.0"; id?: string | number; method: string; params?: unknown };

export class IdeJsonRpcBridge {
  private initialized = false;
  private context: IdeEditorContext = { openFiles: [], diagnostics: [] };
  private readonly shell: ShellSessionManager;
  private ownsShell: boolean;

  constructor(private readonly options: {
    cwd: string;
    ownerToken: string;
    query(prompt: string, context: IdeEditorContext, sessionId?: string): Promise<unknown>;
    shellManager?: ShellSessionManager;
  }) {
    this.shell = options.shellManager ?? new ShellSessionManager({
      cwd: options.cwd,
      outputDir: resolve(options.cwd, ".tnb", "ide-terminals"),
    });
    this.ownsShell = options.shellManager === undefined;
  }

  async serve(socket: Socket, lines: AsyncIterable<string>): Promise<void> {
    try {
      for await (const line of lines) {
      let request: JsonRpcRequest;
      try {
        request = parseRequest(line);
      } catch (error) {
        this.writeError(socket, null, -32700, error instanceof Error ? error.message : String(error));
        continue;
      }
      try {
        const result = await this.handle(request);
        if (request.id !== undefined) this.writeResult(socket, request.id, result);
      } catch (error) {
        if (request.id !== undefined) {
          this.writeError(socket, request.id, -32000, error instanceof Error ? error.message : String(error));
        }
      }
      }
    } finally {
      if (this.ownsShell) await this.shell.close();
    }
  }

  private async handle(request: JsonRpcRequest): Promise<unknown> {
    if (request.method === "initialize") {
      const params = objectParams(request.params);
      if (params.ownerToken !== this.options.ownerToken) throw new Error("IDE bridge owner token is invalid");
      this.initialized = true;
      return {
        protocolVersion: "tnb.ide-jsonrpc/v1",
        capabilities: {
          editorContext: true,
          diagnostics: true,
          visibleDiff: true,
          agentQuery: true,
          applyWorkspaceEdit: true,
          openFile: true,
          fileEvents: true,
          publishDiagnostics: true,
          terminal: true,
        },
        workspace: this.options.cwd,
      };
    }
    if (!this.initialized) throw new Error("IDE bridge must be initialized first");
    if (request.method === "editor/updateContext") {
      this.context = normalizeContext(objectParams(request.params), this.options.cwd, this.context);
      return { accepted: true };
    }
    if (request.method === "editor/getContext") return structuredClone(this.context);
    if (request.method === "workspace/didChangeFiles") {
      const params = objectParams(request.params);
      const events = normalizeFileEvents(params.events, this.options.cwd);
      for (const event of events) {
        if (event.type === "deleted") {
          this.context.openFiles = this.context.openFiles.filter((file) => file !== event.file);
          if (this.context.activeFile === event.file) delete this.context.activeFile;
          this.context.diagnostics = this.context.diagnostics.filter((diagnostic) => diagnostic.file !== event.file);
        }
      }
      return { accepted: events.length, events };
    }
    if (request.method === "textDocument/publishDiagnostics") {
      const params = objectParams(request.params);
      const file = workspacePath(params.file ?? params.uri, this.options.cwd);
      const diagnostics = Array.isArray(params.diagnostics)
        ? params.diagnostics.slice(0, 500).map((item) => normalizeDiagnostic(item, (value) =>
            value === undefined ? file : workspacePath(value, this.options.cwd)))
        : (() => { throw new Error("diagnostics must be an array"); })();
      this.context.diagnostics = [
        ...this.context.diagnostics.filter((item) => item.file !== file),
        ...diagnostics.map((item) => ({ ...item, file })),
      ].slice(-500);
      return { accepted: diagnostics.length };
    }
    if (request.method === "editor/openFile") {
      const params = objectParams(request.params);
      const file = workspacePath(params.file, this.options.cwd);
      await assertToolPathInsideWorkspace(this.options.cwd, file, "read");
      const line = params.line === undefined ? 1 : positiveInteger(params.line, "editor/openFile line");
      const column = params.column === undefined ? 1 : positiveInteger(params.column, "editor/openFile column");
      this.context.activeFile = file;
      if (!this.context.openFiles.includes(file)) this.context.openFiles.push(file);
      return { file, line, column };
    }
    if (request.method === "workspace/applyEdit") {
      return applyWorkspaceEdit(this.options.cwd, objectParams(request.params));
    }
    if (request.method === "workspace/diff") {
      const params = objectParams(request.params);
      const path = params.path === undefined ? undefined : workspacePath(params.path, this.options.cwd);
      if (path) await assertToolPathInsideWorkspace(this.options.cwd, path, "read");
      const args = ["diff", ...(params.staged === true ? ["--cached"] : []), "--", ...(path ? [relative(this.options.cwd, path)] : [])];
      return { diff: (await runGit(this.options.cwd, args)).stdout };
    }
    if (request.method === "workspace/status") {
      return { cwd: this.options.cwd, context: structuredClone(this.context) };
    }
    if (request.method === "terminal/create") {
      const params = objectParams(request.params);
      if (typeof params.command !== "string" || !params.command.trim()) throw new Error("terminal/create command is required");
      return this.shell.startPty({
        command: params.command.trim(),
        ...(params.cols === undefined ? {} : { cols: positiveInteger(params.cols, "terminal/create cols") }),
        ...(params.rows === undefined ? {} : { rows: positiveInteger(params.rows, "terminal/create rows") }),
      });
    }
    if (request.method === "terminal/write") {
      const params = objectParams(request.params);
      if (typeof params.chars !== "string") throw new Error("terminal/write chars must be a string");
      return this.shell.writePty({
        pid: positiveInteger(params.pid, "terminal/write pid"),
        chars: params.chars,
        ...(params.submit === undefined ? {} : { submit: params.submit === true }),
      });
    }
    if (request.method === "terminal/resize") {
      const params = objectParams(request.params);
      return this.shell.resizePty({
        pid: positiveInteger(params.pid, "terminal/resize pid"),
        cols: positiveInteger(params.cols, "terminal/resize cols"),
        rows: positiveInteger(params.rows, "terminal/resize rows"),
      });
    }
    if (request.method === "terminal/close") {
      const params = objectParams(request.params);
      this.shell.closePty(positiveInteger(params.pid, "terminal/close pid"));
      return { closed: true };
    }
    if (request.method === "agent/query") {
      const params = objectParams(request.params);
      if (typeof params.prompt !== "string" || !params.prompt.trim()) throw new Error("agent/query prompt is required");
      const sessionId = typeof params.sessionId === "string" && params.sessionId.trim() ? params.sessionId.trim() : undefined;
      return this.options.query(params.prompt.trim(), structuredClone(this.context), sessionId);
    }
    if (request.method === "shutdown") {
      this.initialized = false;
      return null;
    }
    throw new Error(`Unknown IDE JSON-RPC method: ${request.method}`);
  }

  private writeResult(socket: Socket, id: string | number, result: unknown): void {
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  private writeError(socket: Socket, id: string | number | null, code: number, message: string): void {
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
  }
}

function normalizeFileEvents(value: unknown, cwd: string): Array<{ file: string; type: "created" | "changed" | "deleted" }> {
  if (!Array.isArray(value)) throw new Error("workspace/didChangeFiles events must be an array");
  return value.slice(0, 1_000).map((event) => {
    const record = objectParams(event);
    const type = String(record.type);
    if (type !== "created" && type !== "changed" && type !== "deleted") throw new Error(`Invalid file event type: ${type}`);
    return { file: workspacePath(record.file ?? record.uri, cwd), type };
  });
}

type TextEdit = {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  newText: string;
};

async function applyWorkspaceEdit(cwd: string, params: Record<string, unknown>): Promise<{ applied: true; files: string[] }> {
  if (!params.changes || typeof params.changes !== "object" || Array.isArray(params.changes)) {
    throw new Error("workspace/applyEdit changes must be an object keyed by file path or file URI");
  }
  const expectedHashes = params.expectedHashes && typeof params.expectedHashes === "object" && !Array.isArray(params.expectedHashes)
    ? params.expectedHashes as Record<string, unknown>
    : {};
  const prepared: Array<{ file: string; temporary: string; content: string; mode: number }> = [];
  try {
    for (const [identifier, rawEdits] of Object.entries(params.changes as Record<string, unknown>)) {
      const file = workspacePath(identifier, cwd);
      await assertToolPathInsideWorkspace(cwd, file, "write");
      const source = await readFile(file, "utf8");
      const expected = expectedHashes[identifier];
      if (expected !== undefined) {
        if (typeof expected !== "string" || !/^[a-f0-9]{64}$/i.test(expected)) throw new Error(`Invalid expected hash for ${identifier}`);
        const actual = createHash("sha256").update(source).digest("hex");
        if (actual !== expected.toLowerCase()) throw new Error(`Workspace edit rejected because ${identifier} changed`);
      }
      const edits = parseTextEdits(rawEdits, identifier);
      const content = applyTextEdits(source, edits, identifier);
      const info = await stat(file);
      const temporary = `${file}.${process.pid}.${randomUUID()}.ide-edit`;
      prepared.push({ file, temporary, content, mode: info.mode });
    }
    for (const item of prepared) {
      await mkdir(dirname(item.file), { recursive: true });
      await writeFile(item.temporary, item.content, { encoding: "utf8", mode: item.mode });
    }
    for (const item of prepared) await rename(item.temporary, item.file);
    return { applied: true, files: prepared.map((item) => item.file) };
  } catch (error) {
    await Promise.all(prepared.map((item) => unlink(item.temporary).catch(() => undefined)));
    throw error;
  }
}

function parseTextEdits(value: unknown, identifier: string): TextEdit[] {
  if (!Array.isArray(value) || !value.length) throw new Error(`Workspace edits for ${identifier} must be a non-empty array`);
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Invalid text edit for ${identifier}`);
    const record = entry as Record<string, unknown>;
    if (typeof record.newText !== "string") throw new Error(`Text edit newText must be a string for ${identifier}`);
    const range = record.range as Record<string, unknown> | undefined;
    if (!range || typeof range !== "object") throw new Error(`Text edit range is required for ${identifier}`);
    return {
      range: {
        start: parsePosition(range.start, `${identifier} start`),
        end: parsePosition(range.end, `${identifier} end`),
      },
      newText: record.newText,
    };
  });
}

function parsePosition(value: unknown, label: string): { line: number; character: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label} position`);
  const record = value as Record<string, unknown>;
  if (!Number.isInteger(record.line) || Number(record.line) < 0 || !Number.isInteger(record.character) || Number(record.character) < 0) {
    throw new Error(`${label} line and character must be non-negative integers`);
  }
  return { line: Number(record.line), character: Number(record.character) };
}

function applyTextEdits(source: string, edits: TextEdit[], identifier: string): string {
  const positioned = edits.map((edit) => ({
    start: positionOffset(source, edit.range.start, identifier),
    end: positionOffset(source, edit.range.end, identifier),
    newText: edit.newText,
  })).sort((left, right) => right.start - left.start || right.end - left.end);
  let nextBoundary = source.length;
  let output = source;
  for (const edit of positioned) {
    if (edit.start > edit.end) throw new Error(`Workspace edit range is reversed for ${identifier}`);
    if (edit.end > nextBoundary) throw new Error(`Workspace edits overlap for ${identifier}`);
    output = `${output.slice(0, edit.start)}${edit.newText}${output.slice(edit.end)}`;
    nextBoundary = edit.start;
  }
  return output;
}

function positionOffset(source: string, position: { line: number; character: number }, identifier: string): number {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) if (source[index] === "\n") starts.push(index + 1);
  const start = starts[position.line];
  if (start === undefined) throw new Error(`Workspace edit line is outside ${identifier}`);
  const lineEnd = source.indexOf("\n", start);
  const end = lineEnd < 0 ? source.length : lineEnd;
  if (start + position.character > end) throw new Error(`Workspace edit character is outside ${identifier}`);
  return start + position.character;
}

function workspacePath(value: unknown, cwd: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Workspace file path is required");
  const input = value.trim();
  const root = resolveWorkspaceRoot(cwd);
  const path = input.startsWith("file:") ? fileURLToPath(input) : input;
  if (!isAbsolute(path)) return resolve(root, path);
  const lexicalRelative = relative(resolve(cwd), path);
  if (lexicalRelative !== ".." && !lexicalRelative.startsWith(`..${sep}`) && !isAbsolute(lexicalRelative)) {
    return resolve(root, lexicalRelative);
  }
  return resolve(path);
}

export function isIdeJsonRpcLine(line: string): boolean {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    return value.jsonrpc === "2.0" && typeof value.method === "string";
  } catch {
    return false;
  }
}

export function formatIdeContextPrompt(context: IdeEditorContext, cwd: string): string {
  const lines = ["<ide-context>"];
  if (context.activeFile) lines.push(`Active file: ${relative(cwd, context.activeFile) || context.activeFile}`);
  if (context.openFiles.length) lines.push(`Open files: ${context.openFiles.map((path) => relative(cwd, path) || path).join(", ")}`);
  if (context.selection) {
    lines.push(`Selection: ${relative(cwd, context.selection.file) || context.selection.file}:${context.selection.startLine}-${context.selection.endLine}`);
    if (context.selection.text) lines.push(context.selection.text);
  }
  if (context.visibleDiff) lines.push("Visible diff:", context.visibleDiff);
  if (context.diagnostics.length) {
    lines.push("Diagnostics:", ...context.diagnostics.slice(0, 50).map((item) =>
      `${relative(cwd, item.file) || item.file}:${item.line}:${item.column ?? 1} [${item.severity}] ${item.message}`));
  }
  lines.push("</ide-context>");
  return lines.length > 2 ? lines.join("\n") : "";
}

function parseRequest(line: string): JsonRpcRequest {
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON-RPC request must be an object");
  const request = value as Partial<JsonRpcRequest>;
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") throw new Error("Invalid JSON-RPC request");
  return request as JsonRpcRequest;
}

function objectParams(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON-RPC params must be an object");
  return value as Record<string, unknown>;
}

function normalizeContext(value: Record<string, unknown>, cwd: string, current: IdeEditorContext): IdeEditorContext {
  const path = (input: unknown): string | undefined => {
    if (typeof input !== "string" || !input.trim()) return undefined;
    return resolve(cwd, input.trim());
  };
  const activeFile = value.activeFile === null ? undefined : path(value.activeFile) ?? current.activeFile;
  const openFiles = Array.isArray(value.openFiles)
    ? value.openFiles.map(path).filter((item): item is string => Boolean(item))
    : current.openFiles;
  const selectionValue = value.selection;
  let selection = value.selection === null ? undefined : current.selection;
  if (selectionValue && typeof selectionValue === "object" && !Array.isArray(selectionValue)) {
    const item = selectionValue as Record<string, unknown>;
    const file = path(item.file);
    if (!file) throw new Error("editor selection file is required");
    selection = {
      file,
      startLine: positiveInteger(item.startLine, "selection.startLine"),
      startColumn: positiveInteger(item.startColumn ?? 1, "selection.startColumn"),
      endLine: positiveInteger(item.endLine, "selection.endLine"),
      endColumn: positiveInteger(item.endColumn ?? 1, "selection.endColumn"),
      ...(typeof item.text === "string" ? { text: item.text.slice(0, 100_000) } : {}),
    };
  }
  const diagnostics = Array.isArray(value.diagnostics)
    ? value.diagnostics.slice(0, 500).map((entry) => normalizeDiagnostic(entry, path))
    : current.diagnostics;
  return {
    ...(activeFile ? { activeFile } : {}),
    openFiles,
    ...(selection ? { selection } : {}),
    diagnostics,
    ...(typeof value.visibleDiff === "string"
      ? { visibleDiff: value.visibleDiff.slice(0, 200_000) }
      : current.visibleDiff ? { visibleDiff: current.visibleDiff } : {}),
  };
}

function normalizeDiagnostic(value: unknown, path: (input: unknown) => string | undefined): IdeEditorContext["diagnostics"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("diagnostic must be an object");
  const record = value as Record<string, unknown>;
  const file = path(record.file);
  if (!file || typeof record.message !== "string") throw new Error("diagnostic file and message are required");
  const severity = ["error", "warning", "info"].includes(String(record.severity))
    ? record.severity as "error" | "warning" | "info"
    : "info";
  return {
    file,
    line: positiveInteger(record.line, "diagnostic.line"),
    ...(record.column === undefined ? {} : { column: positiveInteger(record.column, "diagnostic.column") }),
    severity,
    message: record.message.slice(0, 4_000),
  };
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error(`${label} must be a positive integer`);
  return Number(value);
}
