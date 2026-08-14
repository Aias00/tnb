# Local Security Review

`tnb` ships a local `security_scan` tool plus the `plugins/security-review`
plugin for deterministic SAST checks that never upload workspace source.

Built-in coverage includes likely credentials and private keys, disabled TLS
verification, command/SQL injection, unsafe deserialization, raw HTML sinks,
path traversal, weak password hashing, permissive credentialed CORS, and JWT
verification mistakes. Findings include CWE, category, confidence, evidence,
and a remediation. In addition to high-confidence local patterns, bounded
40-line source-to-sink checks propagate locally assigned request/argument
values into shell, database, or filesystem sinks across Python, Go, Java,
.NET, PHP, Ruby, and JavaScript-family source. TypeScript and
JavaScript additionally use the TypeScript 7 AST to propagate external-input
identifiers through assignments and detect their use in command, SQL, and
filesystem calls. Direct request-property flows are high confidence;
propagated flows remain medium confidence. This is a local SAST signal, not a
claim of exploitability.

Language-specific checks also cover Java/.NET process execution, Python shell
mode, Go shell wrappers, PHP deserialization, Ruby interpolation, C/C++ unsafe
copies, Solidity authorization, and Android WebView configuration. Every result
is tagged with its detected language and the report includes severity,
category, and language totals.

For TypeScript and JavaScript projects, the scanner also summarizes local
function and method wrappers whose parameters reach a sink, then reports calls
that pass external input into those wrappers across source files. Project
configuration checks cover privileged GitHub Actions event interpolation,
`pull_request_target` checkout of pull-request-controlled refs, unbounded or
remote package dependencies, and download-to-shell install hooks.

## Scan Modes

Use one scope selector at a time when you do not pass explicit paths:

```bash
tnb security-scan
tnb security-scan --staged
tnb security-scan --base <commit-or-ref>
tnb security-scan --all
tnb security-scan --all --format markdown
tnb security-scan --all --format sarif
```

Interactive users can run `/security`, `/security staged`, or `/security all`
and inspect findings in the Ink management dialog.

Default mode scans current Git changes from the index, working tree, and
untracked files. `--base` compares `HEAD` against the supplied commit or ref and
returns the canonical commit SHA in JSON output.

## Path Filters

Additional local filtering is available in both the CLI command and the
`security_scan` tool input:

```bash
tnb security-scan --base main --path-glob "src/**/*.ts" --exclude scripts/
```

- `--path-glob` keeps only workspace-relative matches.
- `--exclude` drops workspace-relative path prefixes and can be repeated.

## Custom Rule Files

The scanner loads compatible user-level and project-level pattern files in this
order, with later files overriding earlier rules that share the same
`ruleName`:

1. `~/.qodersec/security-patterns.yaml`
2. `~/.tnb/security-patterns.yaml`
3. `<repo>/.codesec/security-patterns.yaml`
4. `<repo>/.tnb/security-patterns.yaml`

Supported fields match the local deterministic subset from the qoder security
example:

```yaml
- ruleName: no-debug-cookie
  substrings: ["debugCookie("]
  regex: "dangerous\\(.*\\)"
  path_glob: "src/**/*.ts"
  paths: ["src/"]
  exclude_paths: ["src/tests/"]
  severity: HIGH
  reminder: "Debug cookie helpers must not ship in production code."
```

Notes:

- `substrings` and `regex` are ORed; at least one matcher is required.
- `paths` and `exclude_paths` are repository-relative prefixes.
- Custom regexes longer than 1000 characters, obviously dangerous nested
  quantifiers, or invalid expressions are ignored locally.
- At most 50 merged custom rules are kept.

## Plugin Behavior

The bundled `security-review` plugin adds:

- the `security_scan` tool for agent turns;
- a `PostToolUse` hook that scans edited files locally after write/edit tools;
- a Skill prompt that treats pattern hits as leads and expects manual security
  review before reporting a confirmed vulnerability.
