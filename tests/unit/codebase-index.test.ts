import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodebaseIndexStore } from "../../src/services/codebase";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("persistent codebase index", () => {
  test("prefers configured LSP semantics for non-TypeScript symbols", async () => {
    const root = await temporary("workspace");
    const file = join(root, "Service.java");
    await writeFile(file, "// source intentionally lacks a regex-shaped declaration\n");
    const store = new CodebaseIndexStore({
      semantics: {
        id: "fake-lsp-v1",
        async analyzeFiles(files) {
          expect(files).toHaveLength(1);
          expect(files[0]).toEndWith("/Service.java");
          return new Map([[files[0]!, {
            symbols: [{
              name: "SemanticOnlyHandler",
              kind: "class",
              line: 7,
              signature: "class SemanticOnlyHandler",
              tokens: ["semantic", "only", "handler"],
            }],
          }]]);
        },
      },
    });

    const result = await store.investigate(root, "SemanticOnlyHandler", { mode: "symbol" });
    expect(result.results[0]?.symbols[0]).toMatchObject({ name: "SemanticOnlyHandler", kind: "class", line: 7 });
  });

  test("reuses a disk cache across instances and incrementally rebuilds changed files", async () => {
    const root = await temporary("workspace");
    const cacheDirectory = await temporary("cache");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "alpha.ts"), "export function alpha() { return 1; }\n");
    await writeFile(join(root, "src", "beta.ts"), "export function beta() { return alpha(); }\n");

    const first = await new CodebaseIndexStore({ cacheDirectory }).investigate(root, "alpha");
    expect(first.index).toMatchObject({ source: "rebuilt", reusedFileCount: 0, indexedFileCount: 2 });

    const second = await new CodebaseIndexStore({ cacheDirectory }).investigate(root, "alpha");
    expect(second.index).toMatchObject({ source: "disk", reused: true, reusedFileCount: 2, indexedFileCount: 0 });

    await writeFile(join(root, "src", "beta.ts"), "export function betaChanged() { return alpha() + 1; }\n");
    const third = await new CodebaseIndexStore({ cacheDirectory }).investigate(root, "betaChanged");
    expect(third.index).toMatchObject({ source: "incremental", reused: false, reusedFileCount: 1, indexedFileCount: 1 });
    expect(third.results[0]?.symbols[0]?.name).toBe("betaChanged");
  });

  test("rebuilds a corrupt derived cache", async () => {
    const root = await temporary("workspace");
    const cacheDirectory = await temporary("cache");
    await writeFile(join(root, "main.ts"), "export const main = () => true;\n");
    await new CodebaseIndexStore({ cacheDirectory }).investigate(root, "main");
    const [cacheFile] = await readdir(cacheDirectory);
    await writeFile(join(cacheDirectory, cacheFile!), "{truncated");

    const result = await new CodebaseIndexStore({ cacheDirectory }).investigate(root, "main");
    expect(result.index).toMatchObject({ source: "rebuilt", indexedFileCount: 1 });
  });

  test("extracts symbols and cross-file relationships across major language families", async () => {
    const root = await temporary("workspace");
    await writeFile(join(root, "service.py"), [
      "def fetch_user(user_id):",
      "    return user_id",
      "",
      "class UserService:",
      "    pass",
    ].join("\n"));
    await writeFile(join(root, "main.go"), [
      "package main",
      "func LoadUser() string {",
      "    return fetch_user(\"1\")",
      "}",
    ].join("\n"));
    await writeFile(join(root, "Handler.java"), [
      "public class Handler {",
      "  public String handle() { return LoadUser(); }",
      "}",
    ].join("\n"));
    await writeFile(join(root, "worker.rs"), "pub fn process_job() { LoadUser(); }\n");
    await writeFile(join(root, "Client.kt"), "class Client\nfun requestUser() = fetch_user(\"1\")\n");

    const result = await new CodebaseIndexStore().investigate(root, "user service handler process request", { limit: 10 });
    expect(new Set(result.results.map((entry) => entry.language))).toEqual(
      new Set(["python", "go", "java", "rust", "kotlin"]),
    );
    const symbols = result.results.flatMap((entry) => entry.symbols.map((symbol) => symbol.name));
    expect(symbols).toContain("fetch_user");
    expect(symbols).toContain("LoadUser");
    expect(symbols).toContain("Handler");
    expect(symbols).toContain("process_job");
    expect(symbols).toContain("requestUser");
    expect(result.index.relationCount).toBeGreaterThan(0);
  });

  test("resolves local import edges for Python, Go, Java, and Rust modules", async () => {
    const root = await temporary("workspace");
    await mkdir(join(root, "app"), { recursive: true });
    await mkdir(join(root, "internal", "store"), { recursive: true });
    await mkdir(join(root, "src", "main", "java", "com", "example"), { recursive: true });
    await mkdir(join(root, "rust", "src"), { recursive: true });
    await writeFile(join(root, "app", "service.py"), "def fetch_user():\n    return 1\n");
    await writeFile(join(root, "main.py"), "from app.service import fetch_user\nfetch_user()\n");
    await writeFile(join(root, "internal", "store", "store.go"), "package store\nfunc Load() {}\n");
    await writeFile(join(root, "main.go"), 'package main\nimport "example.invalid/project/internal/store"\nfunc main() { store.Load() }\n');
    await writeFile(join(root, "src", "main", "java", "com", "example", "UserService.java"), "package com.example; public class UserService {}\n");
    await writeFile(join(root, "src", "main", "java", "Handler.java"), "import com.example.UserService;\nclass Handler { UserService service; }\n");
    await writeFile(join(root, "rust", "src", "service.rs"), "pub fn load_user() {}\n");
    await writeFile(join(root, "rust", "src", "main.rs"), "use crate::service::load_user;\nfn main() { load_user(); }\n");

    const store = new CodebaseIndexStore();
    const python = await store.investigate(root, "main python", { limit: 10 });
    const go = await store.investigate(root, "main go", { limit: 10 });
    const java = await store.investigate(root, "Handler", { limit: 10 });
    const rust = await store.investigate(root, "main rust", { limit: 10 });

    expect(python.results.find(({ path }) => path === "main.py")?.relations).toContainEqual(
      expect.objectContaining({ path: "app/service.py", direction: "outgoing", kind: "import" }),
    );
    expect(go.results.find(({ path }) => path === "main.go")?.relations).toContainEqual(
      expect.objectContaining({ path: "internal/store/store.go", direction: "outgoing", kind: "import" }),
    );
    expect(java.results.find(({ path }) => path.endsWith("Handler.java"))?.relations).toContainEqual(
      expect.objectContaining({ path: "src/main/java/com/example/UserService.java", direction: "outgoing", kind: "import" }),
    );
    expect(rust.results.find(({ path }) => path === "rust/src/main.rs")?.relations).toContainEqual(
      expect.objectContaining({ path: "rust/src/service.rs", direction: "outgoing", kind: "import" }),
    );
  });

  test("understands grouped Go imports and Rust module declarations", async () => {
    const root = await temporary("workspace");
    await mkdir(join(root, "internal", "store"), { recursive: true });
    await mkdir(join(root, "rust", "src"), { recursive: true });
    await writeFile(join(root, "internal", "store", "store.go"), "package store\nfunc Load() {}\n");
    await writeFile(join(root, "main.go"), [
      "package main",
      "import (",
      '  "example.invalid/project/internal/store"',
      ")",
      "func main() { store.Load() }",
    ].join("\n"));
    await writeFile(join(root, "rust", "src", "service.rs"), "pub fn load() {}\n");
    await writeFile(join(root, "rust", "src", "main.rs"), "mod service;\nfn main() { service::load(); }\n");

    const store = new CodebaseIndexStore();
    const go = await store.investigate(root, "main go", { limit: 10 });
    const rust = await store.investigate(root, "main rust", { limit: 10 });
    expect(go.results.find(({ path }) => path === "main.go")?.relations).toContainEqual(
      expect.objectContaining({ path: "internal/store/store.go", kind: "import", direction: "outgoing" }),
    );
    expect(rust.results.find(({ path }) => path === "rust/src/main.rs")?.relations).toContainEqual(
      expect.objectContaining({ path: "rust/src/service.rs", kind: "import", direction: "outgoing" }),
    );
  });
});

async function temporary(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `tnb-${label}-`));
  directories.push(directory);
  return directory;
}
