import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { TnbLspDiagnosticsRegistry } from "./diagnostics-registry";
import { TnbLspServer } from "./server";
import type {
  TnbLspDiagnostic,
  TnbLspFileDiagnostics,
  TnbLspHover,
  TnbLspLocation,
  TnbLspResolvedSelector,
  TnbLspServerConfig,
  TnbLspSymbol,
} from "./types";

export class TnbLspManager {
  readonly diagnostics = new TnbLspDiagnosticsRegistry();
  readonly workspaceRoot: string;
  #servers = new Map<string, TnbLspServer>();

  constructor(
    workspaceRoot: string,
    private readonly configs: TnbLspServerConfig[],
  ) {
    this.workspaceRoot = realpathSync(resolve(workspaceRoot));
  }

  canHandle(filePath: string): boolean {
    return this.#matchServers(resolve(filePath)).length > 0;
  }

  async hover(
    filePath: string,
    position: { line: number; character: number },
    signal?: AbortSignal,
  ): Promise<TnbLspHover | undefined> {
    const { server } = await this.#resolvePrimaryServer(filePath, signal);
    const resolvedFile = await this.#ensureDocumentOpen(filePath, signal);
    const result = await server.request<unknown>("textDocument/hover", {
      textDocument: { uri: pathToFileURL(resolvedFile).href },
      position,
    }, signal);
    return normalizeHover(result);
  }

  async definition(
    filePath: string,
    position: { line: number; character: number },
    signal?: AbortSignal,
  ): Promise<TnbLspLocation[]> {
    const { server } = await this.#resolvePrimaryServer(filePath, signal);
    const resolvedFile = await this.#ensureDocumentOpen(filePath, signal);
    const result = await server.request<unknown>("textDocument/definition", {
      textDocument: { uri: pathToFileURL(resolvedFile).href },
      position,
    }, signal);
    return normalizeLocations(result);
  }

  async references(
    filePath: string,
    position: { line: number; character: number },
    signal?: AbortSignal,
  ): Promise<TnbLspLocation[]> {
    const { server } = await this.#resolvePrimaryServer(filePath, signal);
    const resolvedFile = await this.#ensureDocumentOpen(filePath, signal);
    const result = await server.request<unknown>("textDocument/references", {
      textDocument: { uri: pathToFileURL(resolvedFile).href },
      position,
      context: { includeDeclaration: true },
    }, signal);
    return normalizeLocations(result);
  }

  async implementation(
    filePath: string,
    position: { line: number; character: number },
    signal?: AbortSignal,
  ): Promise<TnbLspLocation[]> {
    const { server } = await this.#resolvePrimaryServer(filePath, signal);
    const resolvedFile = await this.#ensureDocumentOpen(filePath, signal);
    const result = await server.request<unknown>("textDocument/implementation", {
      textDocument: { uri: pathToFileURL(resolvedFile).href },
      position,
    }, signal);
    return normalizeLocations(result);
  }

  async workspaceSymbols(query = "", signal?: AbortSignal): Promise<TnbLspSymbol[]> {
    const symbols: TnbLspSymbol[] = [];
    for (const config of this.configs) {
      const server = this.#serverFor(config);
      const result = await server.request<unknown>("workspace/symbol", { query }, signal);
      symbols.push(...normalizeWorkspaceSymbols(result));
    }
    return deduplicateSymbols(symbols);
  }

  async callHierarchy(
    filePath: string,
    position: { line: number; character: number },
    direction: "incoming" | "outgoing",
    signal?: AbortSignal,
  ): Promise<TnbLspLocation[]> {
    const { server } = await this.#resolvePrimaryServer(filePath, signal);
    const resolvedFile = await this.#ensureDocumentOpen(filePath, signal);
    const prepared = await server.request<unknown>("textDocument/prepareCallHierarchy", {
      textDocument: { uri: pathToFileURL(resolvedFile).href },
      position,
    }, signal);
    if (!Array.isArray(prepared) || prepared.length === 0) return [];
    const calls = await server.request<unknown>(
      direction === "incoming" ? "callHierarchy/incomingCalls" : "callHierarchy/outgoingCalls",
      { item: prepared[0] },
      signal,
    );
    if (!Array.isArray(calls)) return [];
    return calls.map((entry) => {
      const value = asObject(entry, `${direction} call`);
      const item = asObject(direction === "incoming" ? value.from : value.to, `${direction} call item`);
      return normalizeLocationRecord(item.uri, item.selectionRange ?? item.range);
    });
  }

  async documentSymbols(filePath: string, signal?: AbortSignal): Promise<TnbLspSymbol[]> {
    const { server } = await this.#resolvePrimaryServer(filePath, signal);
    const resolvedFile = await this.#ensureDocumentOpen(filePath, signal);
    const result = await server.request<unknown>("textDocument/documentSymbol", {
      textDocument: { uri: pathToFileURL(resolvedFile).href },
    }, signal);
    return normalizeSymbols(result, pathToFileURL(resolvedFile).href);
  }

  async diagnosticsForFile(
    filePath: string,
    options: { waitMs?: number; signal?: AbortSignal } = {},
  ): Promise<TnbLspFileDiagnostics[]> {
    const before = this.diagnostics.sequence;
    const resolvedFile = await this.#ensureDocumentOpen(filePath, options.signal);
    const current = this.diagnostics.getByFile(resolvedFile);
    if (current.length > 0 || (options.waitMs ?? 0) <= 0) return current;
    return this.#waitForDiagnostics(resolvedFile, before, options.waitMs ?? 0, options.signal);
  }

  async close(): Promise<void> {
    await Promise.all([...this.#servers.values()].map((server) => server.close()));
    this.#servers.clear();
  }

  async #ensureDocumentOpen(filePath: string, signal?: AbortSignal): Promise<string> {
    const resolvedFile = realpathSync(resolve(filePath));
    const matches = this.#matchServers(resolvedFile);
    if (matches.length === 0) throw new Error(`No LSP server configured for ${resolvedFile}`);
    await Promise.all(matches.map(async (match) => {
      const server = this.#serverFor(match.config);
      await server.openDocument(resolvedFile, match, signal);
    }));
    return resolvedFile;
  }

  async #resolvePrimaryServer(filePath: string, signal?: AbortSignal): Promise<{ server: TnbLspServer; selector: TnbLspResolvedSelector }> {
    const resolvedFile = realpathSync(resolve(filePath));
    const match = this.#matchServers(resolvedFile)[0];
    if (!match) throw new Error(`No LSP server configured for ${resolvedFile}`);
    const server = this.#serverFor(match.config);
    await this.#ensureDocumentOpen(resolvedFile, signal);
    return { server, selector: match };
  }

  #serverFor(config: TnbLspServerConfig): TnbLspServer {
    const existing = this.#servers.get(config.name);
    if (existing) return existing;
    const server = new TnbLspServer(this.workspaceRoot, config, this.diagnostics);
    this.#servers.set(config.name, server);
    return server;
  }

  #matchServers(filePath: string): TnbLspResolvedSelector[] {
    const extension = extname(filePath).toLowerCase();
    return this.configs.flatMap((config) =>
      config.selectors
        .filter((selector) => selector.extensions.map(normalizeExtension).includes(extension))
        .map((selector) => ({ config, languageId: selector.languageId })),
    );
  }

  #waitForDiagnostics(filePath: string, afterSequence: number, waitMs: number, signal?: AbortSignal): Promise<TnbLspFileDiagnostics[]> {
    const current = this.diagnostics.getByFile(filePath);
    if (current.some((entry) => entry.sequence > afterSequence)) return Promise.resolve(current);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve(this.diagnostics.getByFile(filePath));
      }, waitMs);
      const removeAbort = bindAbort(signal, () => {
        cleanup();
        reject(abortError());
      });
      const unsubscribe = this.diagnostics.subscribe((entry) => {
        if (entry.filePath !== filePath || entry.sequence <= afterSequence) return;
        cleanup();
        resolve(this.diagnostics.getByFile(filePath));
      });
      const cleanup = () => {
        clearTimeout(timer);
        unsubscribe();
        removeAbort();
      };
    });
  }
}

function normalizeExtension(extension: string): string {
  return extension.startsWith(".") ? extension.toLowerCase() : `.${extension.toLowerCase()}`;
}

function normalizeLocations(input: unknown): TnbLspLocation[] {
  if (input === null || input === undefined) return [];
  if (!Array.isArray(input)) return [normalizeLocationLike(input)];
  return input.map(normalizeLocationLike);
}

function normalizeLocationLike(input: unknown): TnbLspLocation {
  const value = asObject(input, "location");
  if ("targetUri" in value) {
    return normalizeLocationRecord(value.targetUri, value.targetSelectionRange ?? value.targetRange);
  }
  return normalizeLocationRecord(value.uri, value.range);
}

function normalizeHover(input: unknown): TnbLspHover | undefined {
  if (input === null || input === undefined) return undefined;
  const value = asObject(input, "hover");
  const contents = renderHoverContents(value.contents);
  const range = value.range === undefined ? undefined : normalizeInlineRange(value.range);
  return { contents, ...(range ? { range } : {}) };
}

function renderHoverContents(contents: unknown): string {
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) return contents.map(renderHoverContents).filter(Boolean).join("\n\n");
  if (typeof contents !== "object" || contents === null) return "";
  const value = contents as Record<string, unknown>;
  if (typeof value.value === "string") return value.value;
  if (typeof value.language === "string" && typeof value.value === "string") {
    return `\`\`\`${value.language}\n${value.value}\n\`\`\``;
  }
  return JSON.stringify(value);
}

function normalizeSymbols(input: unknown, fileUri: string): TnbLspSymbol[] {
  if (!Array.isArray(input)) return [];
  if (input.length === 0) return [];
  const first = input[0];
  if (typeof first === "object" && first !== null && "location" in (first as Record<string, unknown>)) {
    return input.map((entry) => {
      const value = asObject(entry, "symbol information");
      return {
        name: requireString(value.name, "symbol name"),
        kind: requireNumber(value.kind, "symbol kind"),
        ...(typeof value.containerName === "string" ? { containerName: value.containerName } : {}),
        location: normalizeLocationLike(value.location),
      };
    });
  }
  const symbols: TnbLspSymbol[] = [];
  for (const entry of input) flattenDocumentSymbol(entry, fileUri, undefined, symbols);
  return symbols;
}

function normalizeWorkspaceSymbols(input: unknown): TnbLspSymbol[] {
  if (!Array.isArray(input)) return [];
  return input.map((entry) => {
    const value = asObject(entry, "workspace symbol");
    return {
      name: requireString(value.name, "symbol name"),
      kind: requireNumber(value.kind, "symbol kind"),
      ...(typeof value.containerName === "string" ? { containerName: value.containerName } : {}),
      location: normalizeLocationLike(value.location),
    };
  });
}

function deduplicateSymbols(symbols: TnbLspSymbol[]): TnbLspSymbol[] {
  const seen = new Set<string>();
  return symbols.filter((symbol) => {
    const key = `${symbol.name}\0${symbol.location.uri}\0${symbol.location.startLine}\0${symbol.location.startCharacter}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function flattenDocumentSymbol(
  input: unknown,
  fileUri: string,
  containerName: string | undefined,
  output: TnbLspSymbol[],
): void {
  const value = asObject(input, "document symbol");
  const symbolName = requireString(value.name, "document symbol name");
  const location = normalizeLocationRecord(fileUri, value.selectionRange ?? value.range);
  output.push({
    name: symbolName,
    kind: requireNumber(value.kind, "document symbol kind"),
    ...(typeof value.detail === "string" && value.detail ? { detail: value.detail } : {}),
    ...(containerName ? { containerName } : {}),
    location,
  });
  if (Array.isArray(value.children)) {
    for (const child of value.children) flattenDocumentSymbol(child, fileUri, symbolName, output);
  }
}

function normalizeLocationRecord(uriValue: unknown, rangeValue: unknown): TnbLspLocation {
  const uri = requireString(uriValue, "location uri");
  const range = normalizeRange(rangeValue);
  return {
    filePath: fileURLToPath(uri),
    uri,
    ...range,
  };
}

function normalizeRange(input: unknown): Omit<TnbLspLocation, "filePath" | "uri"> {
  const value = asObject(input, "range");
  const start = asObject(value.start, "range start");
  const end = asObject(value.end, "range end");
  return {
    startLine: requireNumber(start.line, "range start line"),
    startCharacter: requireNumber(start.character, "range start character"),
    endLine: requireNumber(end.line, "range end line"),
    endCharacter: requireNumber(end.character, "range end character"),
  };
}

function normalizeInlineRange(input: unknown): TnbLspHover["range"] {
  const range = normalizeRange(input);
  return range;
}

function asObject(input: unknown, label: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${label} must be an object`);
  }
  return input as Record<string, unknown>;
}

function requireString(input: unknown, label: string): string {
  if (typeof input !== "string" || !input) throw new Error(`${label} must be a non-empty string`);
  return input;
}

function requireNumber(input: unknown, label: string): number {
  if (typeof input !== "number" || !Number.isInteger(input) || input < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return input;
}

function bindAbort(signal: AbortSignal | undefined, handler: () => void): () => void {
  if (!signal) return () => undefined;
  signal.addEventListener("abort", handler, { once: true });
  return () => signal.removeEventListener("abort", handler);
}

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}
