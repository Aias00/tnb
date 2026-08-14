# LSP and diagnostics

tnb exposes one `lsp` tool for diagnostics, hover text, definitions,
references, and document symbols. Language servers start lazily on the first
matching file and are shut down with the session.

`codebase_investigator` also consumes LSP document symbols for configured
non-TypeScript languages. Structured LSP names, kinds, containers, and source
locations take precedence over local text extraction; requests are bounded to
four files concurrently. TypeScript keeps its compiler-backed AST index. When
an optional language server is absent or does not implement document symbols,
the tested offline index remains available rather than making repository search
depend on external tooling.

Installed `typescript-language-server`, `pyright-langserver`, `gopls`,
`rust-analyzer`, and `clangd` executables are discovered automatically. Add or
override servers in `~/.tnb/lsp.json` or `<project>/.tnb/lsp.json`:

```json
{
  "servers": {
    "typescript": {
      "command": "typescript-language-server",
      "args": ["--stdio"],
      "extensionToLanguage": {
        ".ts": "typescript",
        ".tsx": "typescriptreact"
      }
    },
    "company-language": {
      "command": "/opt/company/bin/language-server",
      "args": ["serve"],
      "extensionToLanguage": { ".corp": "company-language" },
      "initializationOptions": { "diagnostics": true }
    },
    "clangd": { "disabled": true }
  }
}
```

Project configuration overrides user configuration by server name. A disabled
entry removes an auto-discovered or user-configured server. Explicit commands
are accepted even when they are not currently on `PATH`, so errors remain
visible when a configured server is missing.

The tool only opens files inside the active workspace or an approved additional
workspace root. Diagnostics are received through LSP `publishDiagnostics`;
`waitMs` controls the short wait after a document is opened.
