import type { TnbLspManager } from "../lsp/manager";
import type { TnbLspSymbol } from "../lsp/types";
import type { CodebaseSemanticInfo, CodebaseSemanticProvider, CodebaseSymbol, CodebaseSymbolKind } from "./index";

export function createLspCodebaseSemanticProvider(manager: TnbLspManager): CodebaseSemanticProvider {
  return {
    id: "lsp-document-symbols-v1",
    async analyzeFiles(files, signal) {
      const results = new Map<string, CodebaseSemanticInfo>();
      const supported = files.filter((file) => manager.canHandle(file));
      await mapWithConcurrency(supported, 4, async (file) => {
        try {
          const symbols = await manager.documentSymbols(file, signal);
          if (symbols.length) results.set(file, { symbols: symbols.map(toCodebaseSymbol) });
        } catch (error) {
          signal?.throwIfAborted();
          // Language servers may be optional workspace tooling and can be absent or
          // reject documentSymbol. The local parser remains the tested offline
          // baseline; an unavailable LSP must not make repository search unusable.
          if (!isRecoverableLspFailure(error)) throw error;
        }
      });
      return results;
    },
  };
}

function toCodebaseSymbol(symbol: TnbLspSymbol): CodebaseSymbol {
  const kind = lspSymbolKind(symbol.kind);
  const signature = symbol.detail?.trim() || `${kind} ${symbol.name}`;
  return {
    name: symbol.name,
    kind,
    line: symbol.location.startLine + 1,
    signature,
    tokens: tokenize(`${symbol.name} ${symbol.containerName ?? ""} ${signature}`),
  };
}

function lspSymbolKind(kind: number): CodebaseSymbolKind {
  if (kind === 5) return "class";
  if (kind === 10) return "enum";
  if (kind === 11) return "interface";
  if (kind === 12 || kind === 6 || kind === 9) return "function";
  if (kind === 13 || kind === 14 || kind === 7 || kind === 8) return "variable";
  return "type";
}

function tokenize(value: string): string[] {
  return [...new Set(value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean))];
}

async function mapWithConcurrency<T>(items: T[], concurrency: number, run: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]!;
      await run(item);
    }
  }));
}

function isRecoverableLspFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /No LSP server configured|ENOENT|spawn|exited|closed|method not found|not supported/i.test(error.message);
}
