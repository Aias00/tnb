import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import type { CodebaseEmbeddingProvider } from "./embeddings";
import { analyzeTypeScriptFiles, type TypeScriptSemanticInfo } from "./typescript-ast";

export type CodebaseQueryMode = "hybrid" | "symbol" | "content" | "path";

export type CodebaseQueryOptions = {
  path?: string;
  mode?: CodebaseQueryMode;
  limit?: number;
  maxSymbolsPerFile?: number;
  includeSnippets?: boolean;
  rebuild?: boolean;
  extensions?: string[];
  signal?: AbortSignal;
};

export type CodebaseSymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "variable"
  | "heading";

export type CodebaseSymbol = {
  name: string;
  kind: CodebaseSymbolKind;
  line: number;
  signature: string;
  tokens: string[];
};

export type CodebaseSemanticInfo = {
  symbols?: CodebaseSymbol[];
  imports?: string[];
  references?: string[];
  calls?: string[];
};

export type CodebaseSemanticProvider = {
  readonly id: string;
  analyzeFiles(files: string[], signal?: AbortSignal): Promise<Map<string, CodebaseSemanticInfo>>;
};

type IndexedFile = {
  path: string;
  absolutePath: string;
  extension: string;
  language: string;
  size: number;
  mtimeMs: number;
  pathTokens: string[];
  contentTokens: string[];
  symbols: CodebaseSymbol[];
  imports: string[];
  semanticReferences: string[];
  calls: string[];
  embedding?: number[];
};

type CodebaseRelation = {
  source: string;
  target: string;
  kind: "import" | "symbol-reference" | "call";
  symbols?: string[];
};

type CodebaseIndex = {
  version: 5;
  root: string;
  builtAt: string;
  fileCount: number;
  symbolCount: number;
  signature: string;
  embeddingProviderId?: string;
  files: IndexedFile[];
  relations: CodebaseRelation[];
};

type FileCandidate = {
  absolutePath: string;
  relativePath: string;
  size: number;
  mtimeMs: number;
};

export type CodebaseInvestigationResult = {
  index: {
    root: string;
    builtAt: string;
    fileCount: number;
    symbolCount: number;
    relationCount: number;
    embeddingProvider?: string;
    reused: boolean;
    source: "memory" | "disk" | "incremental" | "rebuilt";
    reusedFileCount: number;
    indexedFileCount: number;
  };
  query: {
    text: string;
    tokens: string[];
    mode: CodebaseQueryMode;
    path?: string;
    extensions?: string[];
  };
  results: Array<{
    path: string;
    language: string;
    score: number;
    reasons: string[];
    symbols: Array<{
      name: string;
      kind: CodebaseSymbolKind;
      line: number;
      signature: string;
    }>;
    relations: Array<{ path: string; direction: "incoming" | "outgoing"; kind: CodebaseRelation["kind"]; symbols?: string[] }>;
    snippets?: Array<{
      line: number;
      text: string;
    }>;
  }>;
};

const MAX_TEXT_FILE_BYTES = 512 * 1024;
const MAX_TOKEN_COUNT = 900;
const DEFAULT_LIMIT = 8;
const DEFAULT_SYMBOLS_PER_FILE = 4;

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".idea",
  ".vscode",
  "__pycache__",
  ".venv",
  "venv",
  "vendor",
  "target",
  "tmp",
  "out",
]);

const KNOWN_TEXT_FILENAMES = new Set([
  "Dockerfile",
  "Makefile",
  "README",
  "README.md",
  "README.txt",
  "LICENSE",
  "AGENTS.md",
  "CLAUDE.md",
]);

const TEXT_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".dart",
  ".cs",
  ".css",
  ".go",
  ".graphql",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".mjs",
  ".cjs",
  ".kt",
  ".kts",
  ".lua",
  ".md",
  ".php",
  ".pl",
  ".py",
  ".rb",
  ".rs",
  ".scala",
  ".sol",
  ".sh",
  ".sql",
  ".swift",
  ".vue",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "async",
  "await",
  "be",
  "by",
  "class",
  "const",
  "default",
  "else",
  "enum",
  "export",
  "false",
  "for",
  "from",
  "function",
  "if",
  "import",
  "in",
  "interface",
  "is",
  "let",
  "new",
  "null",
  "of",
  "on",
  "or",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "struct",
  "that",
  "the",
  "this",
  "true",
  "type",
  "undefined",
  "var",
  "void",
  "with",
]);

const SYMBOL_PATTERNS: Array<{
  kind: CodebaseSymbolKind;
  pattern: RegExp;
  nameGroup: number;
}> = [
  { kind: "function", pattern: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][\w$]*)\s*\(/, nameGroup: 1 },
  { kind: "function", pattern: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_][\w$]*)\s*=\s*(?:async\s*)?\([^=]*=>/, nameGroup: 1 },
  { kind: "class", pattern: /^\s*(?:export\s+)?class\s+([A-Za-z_][\w$]*)\b/, nameGroup: 1 },
  { kind: "interface", pattern: /^\s*(?:export\s+)?interface\s+([A-Za-z_][\w$]*)\b/, nameGroup: 1 },
  { kind: "type", pattern: /^\s*(?:export\s+)?type\s+([A-Za-z_][\w$]*)\b/, nameGroup: 1 },
  { kind: "enum", pattern: /^\s*(?:export\s+)?enum\s+([A-Za-z_][\w$]*)\b/, nameGroup: 1 },
  { kind: "function", pattern: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/, nameGroup: 1 },
  { kind: "type", pattern: /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/, nameGroup: 1 },
  { kind: "class", pattern: /^\s*class\s+([A-Za-z_]\w*)\b/, nameGroup: 1 },
  { kind: "function", pattern: /^\s*def\s+([A-Za-z_]\w*)\s*\(/, nameGroup: 1 },
  { kind: "class", pattern: /^\s*class\s+([A-Za-z_]\w*)\s*(?:\(|:)/, nameGroup: 1 },
  { kind: "function", pattern: /^\s*(?:pub\s+)?fn\s+([A-Za-z_]\w*)\s*\(/, nameGroup: 1 },
  { kind: "type", pattern: /^\s*(?:pub\s+)?(?:struct|trait)\s+([A-Za-z_]\w*)\b/, nameGroup: 1 },
  { kind: "enum", pattern: /^\s*(?:pub\s+)?enum\s+([A-Za-z_]\w*)\b/, nameGroup: 1 },
  { kind: "class", pattern: /^\s*(?:public|protected|private)?\s*(?:abstract\s+|final\s+)?(?:class|record)\s+([A-Za-z_]\w*)\b/, nameGroup: 1 },
  { kind: "interface", pattern: /^\s*(?:public|protected|private)?\s*interface\s+([A-Za-z_]\w*)\b/, nameGroup: 1 },
  { kind: "enum", pattern: /^\s*(?:public|protected|private)?\s*enum\s+([A-Za-z_]\w*)\b/, nameGroup: 1 },
  { kind: "function", pattern: /^\s*(?:(?:public|protected|private|internal|static|final|abstract|synchronized|native|override|open)\s+)*(?:[\w<>?,.\[\]]+\s+)+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:\{|=>|throws\b)/, nameGroup: 1 },
  { kind: "function", pattern: /^\s*(?:public|private|protected|internal|open|override|suspend|inline|operator|tailrec|external|abstract|final|static\s+)*fun\s+(?:[\w<>?.]+\.)?([A-Za-z_]\w*)\s*\(/, nameGroup: 1 },
  { kind: "class", pattern: /^\s*(?:public|private|protected|internal|open|abstract|sealed|data|enum|annotation|value|expect|actual\s+)*(?:class|object)\s+([A-Za-z_]\w*)\b/, nameGroup: 1 },
  { kind: "interface", pattern: /^\s*(?:public|private|protected|internal|sealed|fun\s+)*interface\s+([A-Za-z_]\w*)\b/, nameGroup: 1 },
  { kind: "function", pattern: /^\s*(?:public|private|fileprivate|internal|open|final|static|class|mutating|nonmutating|override|required|convenience|async|throws|rethrows\s+)*func\s+([A-Za-z_]\w*)\s*[<(]/, nameGroup: 1 },
  { kind: "class", pattern: /^\s*(?:public|private|fileprivate|internal|open|final\s+)*(?:class|actor)\s+([A-Za-z_]\w*)\b/, nameGroup: 1 },
  { kind: "type", pattern: /^\s*(?:public|private|fileprivate|internal\s+)*(?:struct|protocol|extension)\s+([A-Za-z_]\w*)\b/, nameGroup: 1 },
  { kind: "enum", pattern: /^\s*(?:public|private|fileprivate|internal\s+)*enum\s+([A-Za-z_]\w*)\b/, nameGroup: 1 },
  { kind: "function", pattern: /^\s*(?:[\w*&:<>,\[\]\s]+\s+)?([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:const\s*)?(?:noexcept\s*)?\{/, nameGroup: 1 },
  { kind: "type", pattern: /^\s*(?:typedef\s+)?struct\s+([A-Za-z_]\w*)\b/, nameGroup: 1 },
  { kind: "enum", pattern: /^\s*(?:typedef\s+)?enum\s+(?:class\s+)?([A-Za-z_]\w*)\b/, nameGroup: 1 },
  { kind: "class", pattern: /^\s*(?:abstract\s+|final\s+)?class\s+([A-Za-z_]\w*)\b/, nameGroup: 1 },
  { kind: "interface", pattern: /^\s*interface\s+([A-Za-z_]\w*)\b/, nameGroup: 1 },
  { kind: "function", pattern: /^\s*(?:(?:public|protected|private|static|final|abstract)\s+)*function\s+&?([A-Za-z_]\w*)\s*\(/, nameGroup: 1 },
  { kind: "function", pattern: /^\s*(?:async\s+)?def\s+(?:self\.)?([A-Za-z_]\w*)\s*(?:\(|$)/, nameGroup: 1 },
  { kind: "class", pattern: /^\s*class\s+([A-Za-z_]\w*)\s*(?:<|$)/, nameGroup: 1 },
  { kind: "type", pattern: /^\s*module\s+([A-Za-z_]\w*)\b/, nameGroup: 1 },
  { kind: "function", pattern: /^\s*(?:local\s+)?function\s+([A-Za-z_][\w.:]*)\s*\(/, nameGroup: 1 },
  { kind: "function", pattern: /^\s*(?:external\s+)?(?:static\s+)?[\w<>?]+\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:async\s*)?\{/, nameGroup: 1 },
  { kind: "class", pattern: /^\s*(?:abstract\s+|base\s+|final\s+|sealed\s+)?(?:class|mixin|extension)\s+([A-Za-z_]\w*)\b/, nameGroup: 1 },
  { kind: "heading", pattern: /^\s{0,3}#{1,6}\s+(.+?)\s*$/, nameGroup: 1 },
];

export class CodebaseIndexStore {
  #cache = new Map<string, CodebaseIndex>();

  constructor(private readonly options: { cacheDirectory?: string; embeddings?: CodebaseEmbeddingProvider; semantics?: CodebaseSemanticProvider } = {}) {}

  async investigate(root: string, query: string, options: CodebaseQueryOptions = {}): Promise<CodebaseInvestigationResult> {
    const canonicalRoot = await realpath(resolve(root));
    const indexState = await this.#loadIndex(canonicalRoot, options.rebuild === true, options.signal);
    const mode = options.mode ?? "hybrid";
    const normalizedPath = options.path ? normalizeRelativePath(options.path) : undefined;
    const extensionFilter = normalizeExtensions(options.extensions);
    const limit = clampInteger(options.limit, DEFAULT_LIMIT, 1, 20);
    const maxSymbolsPerFile = clampInteger(options.maxSymbolsPerFile, DEFAULT_SYMBOLS_PER_FILE, 1, 10);
    const queryTokens = uniqueTokens(query);
    if (!queryTokens.length) {
      throw new Error("codebase investigation query must contain searchable text");
    }

    const queryEmbedding = this.options.embeddings
      ? (await this.options.embeddings.embed([query], options.signal))[0]
      : undefined;
    const scored = indexState.index.files
      .filter((file) => matchesFileFilter(file, normalizedPath, extensionFilter))
      .map((file) => scoreFile(file, query, queryTokens, mode, queryEmbedding))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.file.path.localeCompare(right.file.path))
      .slice(0, limit);

    const results = await Promise.all(
      scored.map(async ({ file, score, reasons, matchedSymbols }) => ({
        path: file.path,
        language: file.language,
        score: Number(score.toFixed(2)),
        reasons,
        symbols: matchedSymbols.slice(0, maxSymbolsPerFile).map((symbol) => ({
          name: symbol.name,
          kind: symbol.kind,
          line: symbol.line,
          signature: symbol.signature,
        })),
        relations: relationsForFile(indexState.index.relations, file.path),
        ...(options.includeSnippets === false
          ? {}
          : {
              snippets: await buildSnippets(file.absolutePath, queryTokens, matchedSymbols, options.signal),
            }),
      })),
    );

    return {
      index: {
        root: canonicalRoot,
        builtAt: indexState.index.builtAt,
        fileCount: indexState.index.fileCount,
        symbolCount: indexState.index.symbolCount,
        relationCount: indexState.index.relations.length,
        ...(indexState.index.embeddingProviderId ? { embeddingProvider: indexState.index.embeddingProviderId } : {}),
        reused: indexState.reused,
        source: indexState.source,
        reusedFileCount: indexState.reusedFileCount,
        indexedFileCount: indexState.indexedFileCount,
      },
      query: {
        text: query,
        tokens: queryTokens,
        mode,
        ...(normalizedPath ? { path: normalizedPath } : {}),
        ...(extensionFilter.length ? { extensions: extensionFilter } : {}),
      },
      results,
    };
  }

  async #loadIndex(root: string, rebuild: boolean, signal?: AbortSignal): Promise<{
    index: CodebaseIndex;
    reused: boolean;
    source: "memory" | "disk" | "incremental" | "rebuilt";
    reusedFileCount: number;
    indexedFileCount: number;
  }> {
    const candidates = await collectCandidates(root, signal);
    const embeddingProviderId = this.options.embeddings?.id;
    const signature = `${embeddingProviderId ?? "local"}|${this.options.semantics?.id ?? "syntax-local"}|${candidates.map((file) => `${file.relativePath}:${file.size}:${file.mtimeMs}`).join("|")}`;
    if (!rebuild) {
      const cached = this.#cache.get(root);
      if (cached && cached.signature === signature) {
        return {
          index: cached,
          reused: true,
          source: "memory",
          reusedFileCount: cached.fileCount,
          indexedFileCount: 0,
        };
      }
    }
    const previous = rebuild
      ? undefined
      : this.#cache.get(root) ?? await this.#readPersistentIndex(root);
    if (previous?.signature === signature) {
      this.#cache.set(root, previous);
      return {
        index: previous,
        reused: true,
        source: "disk",
        reusedFileCount: previous.fileCount,
        indexedFileCount: 0,
      };
    }
    const previousFiles = new Map(previous?.files.map((file) => [file.path, file]));
    const changedCandidates = candidates.filter((candidate) => {
      const prior = previousFiles.get(candidate.relativePath);
      return rebuild || !prior || prior.size !== candidate.size || prior.mtimeMs !== candidate.mtimeMs ||
        prior.absolutePath !== candidate.absolutePath;
    });
    const semanticByPath = await analyzeTypeScriptFiles(
      root,
      changedCandidates.filter((candidate) => isTypeScriptFamily(candidate.relativePath)).map((candidate) => candidate.absolutePath),
    );
    const lspCandidates = changedCandidates.filter((candidate) => !isTypeScriptFamily(candidate.relativePath));
    const externalSemanticByPath = this.options.semantics && lspCandidates.length
      ? await this.options.semantics.analyzeFiles(lspCandidates.map((candidate) => candidate.absolutePath), signal)
      : new Map<string, CodebaseSemanticInfo>();
    let reusedFileCount = 0;
    let indexedFileCount = 0;
    const files = await Promise.all(candidates.map(async (candidate) => {
      const prior = previousFiles.get(candidate.relativePath);
      if (
        !rebuild && prior && prior.size === candidate.size && prior.mtimeMs === candidate.mtimeMs &&
        prior.absolutePath === candidate.absolutePath
      ) {
        reusedFileCount += 1;
        return prior;
      }
      indexedFileCount += 1;
      return indexFile(candidate, semanticByPath.get(candidate.absolutePath) ?? externalSemanticByPath.get(candidate.absolutePath), signal);
    }));
    if (this.options.embeddings) {
      const missing = files.filter((file) => !file.embedding);
      for (let offset = 0; offset < missing.length; offset += 64) {
        const batch = missing.slice(offset, offset + 64);
        const vectors = await this.options.embeddings.embed(batch.map(embeddingText), signal);
        for (let index = 0; index < batch.length; index += 1) {
          const vector = vectors[index];
          if (!vector) throw new Error("Embedding provider returned fewer vectors than requested");
          batch[index]!.embedding = vector;
        }
      }
    }
    const relations = buildRelations(files);
    const index: CodebaseIndex = {
      version: 5,
      root,
      builtAt: new Date().toISOString(),
      fileCount: files.length,
      symbolCount: files.reduce((total, file) => total + file.symbols.length, 0),
      signature,
      ...(embeddingProviderId ? { embeddingProviderId } : {}),
      files,
      relations,
    };
    this.#cache.set(root, index);
    await this.#writePersistentIndex(index);
    return {
      index,
      reused: false,
      source: previous && !rebuild ? "incremental" : "rebuilt",
      reusedFileCount,
      indexedFileCount,
    };
  }

  async #readPersistentIndex(root: string): Promise<CodebaseIndex | undefined> {
    const path = this.#cachePath(root);
    if (!path) return undefined;
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      // This cache contains only derived repository data. A truncated cache is
      // safe to discard and rebuild, and the corruption path is regression-tested.
      await unlink(path).catch((error) => { if (!isMissing(error)) throw error; });
      return undefined;
    }
    if (!isCodebaseIndex(value, root)) {
      await unlink(path).catch((error) => { if (!isMissing(error)) throw error; });
      return undefined;
    }
    return value;
  }

  async #writePersistentIndex(index: CodebaseIndex): Promise<void> {
    const path = this.#cachePath(index.root);
    if (!path) return;
    await mkdir(this.options.cacheDirectory!, { recursive: true });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(index), "utf8");
    try {
      await rename(temporary, path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  #cachePath(root: string): string | undefined {
    if (!this.options.cacheDirectory) return undefined;
    const key = createHash("sha256").update(root).digest("hex").slice(0, 24);
    return join(this.options.cacheDirectory, `${key}.json`);
  }
}

async function collectCandidates(root: string, signal?: AbortSignal): Promise<FileCandidate[]> {
  const files: FileCandidate[] = [];
  await walkDirectory(root, root, files, signal);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function walkDirectory(
  root: string,
  current: string,
  files: FileCandidate[],
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    signal?.throwIfAborted();
    if (entry.isSymbolicLink()) continue;
    const absolutePath = resolve(current, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      await walkDirectory(root, absolutePath, files, signal);
      continue;
    }
    if (!entry.isFile()) continue;
    const extension = extname(entry.name).toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension) && !KNOWN_TEXT_FILENAMES.has(entry.name)) continue;
    const info = await stat(absolutePath);
    if (info.size > MAX_TEXT_FILE_BYTES) continue;
    files.push({
      absolutePath,
      relativePath: normalizeRelativePath(relative(root, absolutePath)),
      size: info.size,
      mtimeMs: info.mtimeMs,
    });
  }
}

async function indexFile(
  candidate: FileCandidate,
  semantic: TypeScriptSemanticInfo | CodebaseSemanticInfo | undefined,
  signal?: AbortSignal,
): Promise<IndexedFile> {
  signal?.throwIfAborted();
  const raw = await readFile(candidate.absolutePath, "utf8");
  if (!looksLikeText(raw)) {
    return {
      path: candidate.relativePath,
      absolutePath: candidate.absolutePath,
      extension: extname(candidate.relativePath).toLowerCase(),
      language: detectLanguage(candidate.relativePath),
      size: candidate.size,
      mtimeMs: candidate.mtimeMs,
      pathTokens: uniqueTokens(candidate.relativePath),
      contentTokens: [],
      symbols: [],
      imports: [],
      semanticReferences: [],
      calls: [],
    };
  }
  const lines = raw.split(/\r?\n/);
  const symbols = semantic?.symbols ?? extractSymbols(lines);
  const symbolTokens = symbols.flatMap((symbol) => symbol.tokens);
  const contentTokens = uniqueTokens(
    `${candidate.relativePath}\n${symbols.map((symbol) => symbol.signature).join("\n")}\n${raw}`,
  ).slice(0, MAX_TOKEN_COUNT);
  return {
    path: candidate.relativePath,
    absolutePath: candidate.absolutePath,
    extension: extname(candidate.relativePath).toLowerCase(),
    language: detectLanguage(candidate.relativePath),
    size: candidate.size,
    mtimeMs: candidate.mtimeMs,
    pathTokens: uniqueTokens(candidate.relativePath),
    contentTokens: uniqueStrings([...contentTokens, ...symbolTokens]),
    symbols,
    imports: semantic?.imports ?? extractImports(raw, candidate.relativePath),
    semanticReferences: semantic?.references ?? extractReferences(raw, symbols),
    calls: semantic?.calls ?? extractCalls(raw),
  };
}

function isCodebaseIndex(value: unknown, root: string): value is CodebaseIndex {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const index = value as Partial<CodebaseIndex>;
  if (
    index.version !== 5 || index.root !== root || typeof index.builtAt !== "string" ||
    typeof index.signature !== "string" || !Array.isArray(index.files) || !Array.isArray(index.relations)
  ) return false;
  if (index.fileCount !== index.files.length || typeof index.symbolCount !== "number") return false;
  return index.files.every((file) =>
    typeof file === "object" && file !== null &&
    typeof file.path === "string" && typeof file.absolutePath === "string" &&
    typeof file.size === "number" && typeof file.mtimeMs === "number" &&
    Array.isArray(file.pathTokens) && Array.isArray(file.contentTokens) && Array.isArray(file.symbols) &&
    Array.isArray(file.imports) && Array.isArray(file.semanticReferences) && Array.isArray(file.calls) &&
    (file.embedding === undefined || Array.isArray(file.embedding))
  );
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function scoreFile(
  file: IndexedFile,
  rawQuery: string,
  queryTokens: string[],
  mode: CodebaseQueryMode,
  queryEmbedding?: number[],
): {
  file: IndexedFile;
  score: number;
  reasons: string[];
  matchedSymbols: CodebaseSymbol[];
} {
  const lowerQuery = rawQuery.trim().toLowerCase();
  const pathSet = new Set(file.pathTokens);
  const contentSet = new Set(file.contentTokens);
  const matchedSymbols = file.symbols
    .map((symbol) => ({ symbol, score: scoreSymbol(symbol, lowerQuery, queryTokens) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.symbol.line - right.symbol.line)
    .map((entry) => entry.symbol);

  let score = 0;
  const reasons: string[] = [];
  const pathTokenHits = queryTokens.filter((token) => pathSet.has(token));
  const contentTokenHits = queryTokens.filter((token) => contentSet.has(token));

  if (mode === "hybrid" || mode === "path") {
    if (pathTokenHits.length) {
      score += pathTokenHits.length * 7;
      reasons.push(`path tokens matched: ${pathTokenHits.slice(0, 5).join(", ")}`);
    }
    if (file.path.toLowerCase().includes(lowerQuery)) {
      score += 18;
      reasons.push("path contains the full query");
    }
  }

  if (mode === "hybrid" || mode === "symbol") {
    if (matchedSymbols.length) {
      score += Math.min(32, matchedSymbols.length * 9);
      reasons.push(`symbol matches: ${matchedSymbols.slice(0, 3).map((symbol) => symbol.name).join(", ")}`);
    }
  }

  if (mode === "hybrid" || mode === "content") {
    if (contentTokenHits.length) {
      score += contentTokenHits.length * 4;
      reasons.push(`content tokens matched: ${contentTokenHits.slice(0, 5).join(", ")}`);
    }
  }

  if (mode === "hybrid" && queryEmbedding && file.embedding) {
    const similarity = cosineSimilarity(queryEmbedding, file.embedding);
    if (similarity > 0) {
      score += similarity * 24;
      reasons.push(`embedding similarity: ${similarity.toFixed(3)}`);
    }
  }

  if (!score && mode === "hybrid" && contentTokenHits.length) {
    score += contentTokenHits.length * 2;
  }

  return { file, score, reasons: uniqueStrings(reasons), matchedSymbols };
}

function embeddingText(file: IndexedFile): string {
  return [
    `path: ${file.path}`,
    `language: ${file.language}`,
    ...file.symbols.slice(0, 80).map((symbol) => `${symbol.kind}: ${symbol.signature}`),
    `terms: ${file.contentTokens.slice(0, 500).join(" ")}`,
  ].join("\n");
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (!left.length || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! ** 2;
    rightNorm += right[index]! ** 2;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

function extractImports(raw: string, path: string): string[] {
  const imports: string[] = [];
  const patterns = [
    /\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
    /^\s*import\s*["']([^"']+)["']\s*$/gm,
    /^\s*from\s+([\w.]+)\s+import\s+/gm,
    /^\s*import\s+([\w.\/]+)\s*;?\s*$/gm,
    /^\s*use\s+(?:crate::|self::|super::)?([\w:]+)(?:::\{[^}]+\})?\s*;/gm,
    /^\s*#include\s*[<"]([^>"]+)[>"]/gm,
    /^\s*(?:using|open)\s+([\w.]+)\s*;?\s*$/gm,
    /^\s*(?:require|require_relative)\s*["']([^"']+)["']/gm,
    /^\s*(?:include|require_once|require)\s*(?:\(?\s*)?["']([^"']+)["']/gm,
  ];
  for (const pattern of patterns) {
    for (const match of raw.matchAll(pattern)) if (match[1]) imports.push(match[1]);
  }
  if (path.endsWith(".go")) {
    for (const block of raw.matchAll(/\bimport\s*\(([\s\S]*?)\)/g)) {
      for (const entry of block[1]?.matchAll(/(?:^|\s)(?:[\w.]+\s+)?["`]([^"`]+)["`]/g) ?? []) {
        if (entry[1]) imports.push(entry[1]);
      }
    }
  }
  if (path.endsWith(".rs")) {
    for (const match of raw.matchAll(/^\s*(?:pub\s+)?mod\s+([A-Za-z_]\w*)\s*;/gm)) {
      if (match[1]) imports.push(match[1]);
    }
  }
  return uniqueStrings(imports);
}

function extractCalls(raw: string): string[] {
  const calls: string[] = [];
  const pattern = /\b([\p{L}_][\p{L}\p{N}_]*)\s*(?:[!.?]\s*)?\(/gu;
  const excluded = new Set(["if", "for", "while", "switch", "catch", "return", "sizeof", "typeof", "defined", "function", "func", "fn", "def"]);
  for (const match of raw.matchAll(pattern)) {
    const name = match[1];
    if (name && !excluded.has(name.toLowerCase())) calls.push(name);
  }
  return uniqueStrings(calls).slice(0, 500);
}

function extractReferences(raw: string, symbols: CodebaseSymbol[]): string[] {
  const declared = new Set(symbols.map((symbol) => symbol.name.toLowerCase()));
  return uniqueTokens(raw).filter((token) => !declared.has(token)).slice(0, MAX_TOKEN_COUNT);
}

function buildRelations(files: IndexedFile[]): CodebaseRelation[] {
  const byPath = new Map(files.map((file) => [file.path.replace(/\.[^.]+$/, ""), file.path]));
  const symbolOwners = new Map<string, string[]>();
  for (const file of files) {
    for (const symbol of file.symbols) {
      const key = symbol.name.toLowerCase();
      symbolOwners.set(key, [...(symbolOwners.get(key) ?? []), file.path]);
    }
  }
  const relations: CodebaseRelation[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    for (const specifier of file.imports) {
      const target = resolveLocalImport(file, specifier, files, byPath);
      if (target) addRelation(relations, seen, { source: file.path, target, kind: "import" });
    }
    const referenced = new Map<string, string[]>();
    const referenceTokens = file.semanticReferences.length ? file.semanticReferences.map((value) => value.toLowerCase()) : file.contentTokens;
    for (const token of referenceTokens) {
      for (const owner of symbolOwners.get(token) ?? []) {
        if (owner === file.path) continue;
        referenced.set(owner, [...(referenced.get(owner) ?? []), token]);
      }
    }
    for (const [target, symbols] of referenced) {
      addRelation(relations, seen, {
        source: file.path,
        target,
        kind: "symbol-reference",
        symbols: uniqueStrings(symbols).slice(0, 12),
      });
    }
    const called = new Map<string, string[]>();
    for (const name of file.calls) {
      for (const owner of symbolOwners.get(name.toLowerCase()) ?? []) {
        if (owner === file.path) continue;
        called.set(owner, [...(called.get(owner) ?? []), name]);
      }
    }
    for (const [target, symbols] of called) {
      addRelation(relations, seen, {
        source: file.path,
        target,
        kind: "call",
        symbols: uniqueStrings(symbols).slice(0, 12),
      });
    }
  }
  return relations;
}

function resolveLocalImport(
  source: IndexedFile,
  specifier: string,
  files: IndexedFile[],
  byPath: Map<string, string>,
): string | undefined {
  if (specifier.startsWith(".")) {
    const base = normalizeRelativePath(resolveImportBase(source.path, specifier));
    return byPath.get(base) ?? byPath.get(`${base}/index`);
  }
  const normalized = specifier
    .replace(/^(?:crate|self|super)::/, "")
    .replace(/::/g, "/")
    .replace(/\./g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (!normalized) return undefined;
  const parts = normalized.split("/");
  const candidates: string[] = [];
  for (let start = 0; start < parts.length; start += 1) {
    for (let end = parts.length; end > start; end -= 1) {
      candidates.push(parts.slice(start, end).join("/"));
    }
  }
  const sourceDirectory = source.path.includes("/") ? source.path.slice(0, source.path.lastIndexOf("/")) : "";
  for (const candidate of uniqueStrings(candidates).sort((left, right) => right.split("/").length - left.split("/").length)) {
    const adjacent = byPath.get(sourceDirectory ? `${sourceDirectory}/${candidate}` : candidate);
    if (adjacent) return adjacent;
    const exact = [...byPath.entries()].find(([path]) => path === candidate || path.endsWith(`/${candidate}`));
    if (exact) return exact[1];
    const directoryMatches = files.filter((file) => {
      const directory = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
      return directory === candidate || directory.endsWith(`/${candidate}`);
    });
    if (directoryMatches.length) {
      const packageName = candidate.slice(candidate.lastIndexOf("/") + 1).toLowerCase();
      return directoryMatches.find((file) => file.path.slice(file.path.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "").toLowerCase() === packageName)?.path
        ?? directoryMatches.sort((left, right) => left.path.localeCompare(right.path))[0]?.path;
    }
  }
  const included = files.find((file) => file.path.endsWith(`/${specifier}`) || file.path.endsWith(`/${specifier}.h`));
  return included?.path;
}

function isTypeScriptFamily(path: string): boolean {
  return /\.(?:[cm]?[jt]sx?)$/i.test(path);
}

function resolveImportBase(sourcePath: string, specifier: string): string {
  const sourceDirectory = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
  const parts = `${sourceDirectory}/${specifier}`.split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") resolved.pop();
    else resolved.push(part);
  }
  return resolved.join("/").replace(/\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|swift|c|cc|cpp|h|hpp|cs|php|rb|scala|dart|lua)$/, "");
}

function addRelation(relations: CodebaseRelation[], seen: Set<string>, relation: CodebaseRelation): void {
  const key = `${relation.source}|${relation.target}|${relation.kind}`;
  if (seen.has(key)) return;
  seen.add(key);
  relations.push(relation);
}

function relationsForFile(relations: CodebaseRelation[], path: string): CodebaseInvestigationResult["results"][number]["relations"] {
  return relations
    .filter((relation) => relation.source === path || relation.target === path)
    .slice(0, 20)
    .map((relation) => ({
      path: relation.source === path ? relation.target : relation.source,
      direction: relation.source === path ? "outgoing" as const : "incoming" as const,
      kind: relation.kind,
      ...(relation.symbols?.length ? { symbols: relation.symbols } : {}),
    }));
}

function scoreSymbol(symbol: CodebaseSymbol, lowerQuery: string, queryTokens: string[]): number {
  let score = 0;
  if (symbol.name.toLowerCase() === lowerQuery) score += 18;
  if (symbol.name.toLowerCase().includes(lowerQuery)) score += 12;
  const tokens = new Set(symbol.tokens);
  for (const token of queryTokens) {
    if (tokens.has(token)) score += 4;
  }
  if (symbol.signature.toLowerCase().includes(lowerQuery)) score += 6;
  return score;
}

async function buildSnippets(
  absolutePath: string,
  queryTokens: string[],
  symbols: CodebaseSymbol[],
  signal?: AbortSignal,
): Promise<Array<{ line: number; text: string }>> {
  signal?.throwIfAborted();
  const raw = await readFile(absolutePath, "utf8");
  const lines = raw.split(/\r?\n/);
  const requestedLines = new Set<number>();
  for (const symbol of symbols.slice(0, 2)) {
    requestedLines.add(symbol.line);
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const normalized = line.toLowerCase();
    if (queryTokens.some((token) => normalized.includes(token))) {
      requestedLines.add(index + 1);
    }
    if (requestedLines.size >= 4) break;
  }
  return [...requestedLines]
    .sort((left, right) => left - right)
    .slice(0, 4)
    .map((line) => ({ line, text: truncateLine(lines[line - 1] ?? "") }));
}

function extractSymbols(lines: string[]): CodebaseSymbol[] {
  const symbols: CodebaseSymbol[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    for (const entry of SYMBOL_PATTERNS) {
      entry.pattern.lastIndex = 0;
      const match = entry.pattern.exec(line);
      if (!match) continue;
      const name = (match[entry.nameGroup] ?? "").trim();
      if (!name) continue;
      const signature = truncateLine(line.trim(), 180);
      const key = `${entry.kind}:${name}:${index + 1}`;
      if (seen.has(key)) continue;
      seen.add(key);
      symbols.push({
        name,
        kind: entry.kind,
        line: index + 1,
        signature,
        tokens: uniqueTokens(`${name} ${signature}`),
      });
      break;
    }
  }
  return symbols;
}

function detectLanguage(path: string): string {
  const normalized = path.toLowerCase();
  if (normalized.endsWith(".ts")) return "typescript";
  if (normalized.endsWith(".tsx")) return "tsx";
  if (normalized.endsWith(".js") || normalized.endsWith(".mjs") || normalized.endsWith(".cjs")) return "javascript";
  if (normalized.endsWith(".jsx")) return "jsx";
  if (normalized.endsWith(".py")) return "python";
  if (normalized.endsWith(".go")) return "go";
  if (normalized.endsWith(".rs")) return "rust";
  if (normalized.endsWith(".java")) return "java";
  if (normalized.endsWith(".kt") || normalized.endsWith(".kts")) return "kotlin";
  if (normalized.endsWith(".swift")) return "swift";
  if (normalized.endsWith(".c")) return "c";
  if (normalized.endsWith(".cc") || normalized.endsWith(".cpp") || normalized.endsWith(".hpp")) return "cpp";
  if (normalized.endsWith(".cs")) return "csharp";
  if (normalized.endsWith(".php")) return "php";
  if (normalized.endsWith(".rb")) return "ruby";
  if (normalized.endsWith(".scala")) return "scala";
  if (normalized.endsWith(".dart")) return "dart";
  if (normalized.endsWith(".lua")) return "lua";
  if (normalized.endsWith(".sol")) return "solidity";
  if (normalized.endsWith(".vue")) return "vue";
  if (normalized.endsWith(".md")) return "markdown";
  if (normalized.endsWith(".json")) return "json";
  if (normalized.endsWith(".yml") || normalized.endsWith(".yaml")) return "yaml";
  if (normalized.endsWith(".sh")) return "shell";
  if (normalized.endsWith(".sql")) return "sql";
  return extname(normalized).replace(/^\./, "") || "text";
}

function uniqueTokens(input: string): string[] {
  const tokens = splitIdentifierTokens(input)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token) && /\p{L}|\p{N}/u.test(token));
  return uniqueStrings(tokens);
}

function splitIdentifierTokens(input: string): string[] {
  return input
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function normalizeExtensions(extensions: string[] | undefined): string[] {
  if (!extensions?.length) return [];
  return uniqueStrings(
    extensions
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
      .map((value) => (value.startsWith(".") ? value : `.${value}`)),
  );
}

function matchesFileFilter(file: IndexedFile, path: string | undefined, extensions: string[]): boolean {
  if (path && file.path !== path && !file.path.startsWith(`${path}/`)) return false;
  if (extensions.length && !extensions.includes(file.extension)) return false;
  return true;
}

function normalizeRelativePath(path: string): string {
  const normalized = path.split(sep).join("/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  return normalized === "." ? "" : normalized;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function truncateLine(value: string, maxLength = 220): string {
  const trimmed = value.trim();
  return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength - 1)}…`;
}

function looksLikeText(content: string): boolean {
  if (!content.includes("\0")) return true;
  return false;
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isInteger(value)) return fallback;
  return Math.max(min, Math.min(max, Number(value)));
}
