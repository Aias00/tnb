# Print-mode automation

`tnb -p` supports bounded and machine-readable Agent runs without changing
the interactive TUI contract.

By default stream JSON includes completed model boundaries, tool lifecycle
events, and the terminal result. Add `--include-partial-messages` for text,
reasoning, signatures, and partial tool-input deltas. Add
`--include-hook-events` for Hook command start, output progress, and completion
records. Both flags require `--output-format stream-json`.

## Limits

- `--max-turns <count>` stops before starting another model turn.
- `--max-budget-usd <amount>` stops as soon as provider-reported usage crosses
  the invocation limit. Every possible primary and fallback model must have
  pricing configured so the limit cannot silently become ineffective.
- `--allowed-tools` and `--disallowed-tools` accept repeated or comma-separated
  exact tool names. The internal structured-output tool is not user-filterable.
- `--add-dir <directory>` is repeatable and adds a canonical, session-scoped
  workspace root to file/search tools, MCP roots, and system context.
- `--session-id <id>` selects the ID for a new session and fails if that ID is
  already present. Use `--resume` or `--continue` for existing sessions.
- `--fork-session` copies the selected `--resume`/`--continue` history into a
  fresh session instead of appending to the source. Combine it with
  `--session-id` for a deterministic target and `--name` for its display title.
- `--tools <names...>` selects the provider-facing tool set. Values can be
  comma- or space-separated; `--tools ""` disables all tools and
  `--tools default` keeps the normal set.
- `--mcp-config <file-or-json...>` merges session-only MCP files or inline JSON,
  with later entries overriding earlier names. `--strict-mcp-config` ignores
  persisted and plugin MCP servers and requires at least one explicit config.

`--system-prompt-file <path>` and `--append-system-prompt-file <path>` load
UTF-8 prompt text relative to the process cwd. Each file option is mutually
exclusive with its inline counterpart.

`--settings <file-or-json>` merges one validated, session-only settings overlay
after user, project, and local settings. `--agents <json>` adds or overrides
Agent profiles for the current process using the same description, prompt,
tools, model, permission-mode, and max-turns fields as file-based agents.
`--agent <name>` applies one of those profiles to the main thread. Explicit
`--model`, `--permission-mode`, `--tools`, `--system-prompt`, and `--max-turns`
options override the corresponding profile defaults.

In an interactive terminal, `tnb --resume` opens the existing session picker.
Use `tnb --resume <session-id>` to resume a specific session directly. Print
mode and SDK automation require the explicit session ID.

## IDE bridge automation

Run `tnb remote-control --socket ~/.tnb/ide/editor.sock` to expose the local
IDE JSON-RPC bridge. Another local process can use these commands without
reading or printing the private owner token:

```sh
tnb ide list
tnb ide status --json
tnb ide context --json
tnb ide query "Explain the active file" --session <session-id>
```

Automatic discovery prefers the unique active descriptor for the current
workspace. If discovery is ambiguous, pass `--descriptor <path>` explicitly.

## Fallback model

`--fallback-model <model|provider/model>` resolves through the same provider
catalog as `--model`. It activates only for retryable transport failures before
the primary emits any stream event. Authentication and other non-transient
client errors do not fall back, and a partial response is never replayed. Once
activated, the fallback handles the remaining turns and its pricing is used for
usage accounting.

## Structured output

`--json-schema '<schema>'` adds a private `structured_output` tool after normal
tool filtering. The root must be an object schema. The runtime validates common
JSON Schema object, array, primitive, enum, const, composition, local `$ref`,
length, pattern, and numeric-bound constraints before accepting the result.

If the model stops without calling the tool, tnb asks it to correct the
response up to five times (`MAX_STRUCTURED_OUTPUT_RETRIES`). JSON and stream-JSON
terminal records include `structured_output`; text mode prints the compact JSON
object after the turn. Structured output is intentionally print-mode only.
