# Structured JSON Lines I/O

Use stream-json input and output to keep one tnb process attached to a
script or SDK while preserving its workspace session:

```bash
printf '%s\n' \
  '{"type":"user","prompt":"Inspect package.json"}' \
  '{"type":"user","message":{"role":"user","content":"Now summarize the scripts"}}' |
  tnb -p --input-format stream-json --output-format stream-json
```

Every non-empty input line must be a JSON object with `type: "user"`. Text can
be supplied through `prompt`, `message.content`, or text blocks in
`message.content`. An optional `session_id` fixes the session identifier and
`resume: true` resumes an existing transcript on the first record. All records
in one process must use the same identifier.

Output starts with a `system/init` record and then emits `model_event`,
`tool_event`, and terminal `result` records as JSON Lines. Add
`--replay-user-messages` when the consumer needs an acknowledgement copy of
each accepted user record. Invalid input and failed turns produce a terminal
`result` with `subtype: "error"` and a nonzero exit status.

When an MCP server completes a URL elicitation, output also includes a system
record with `subtype: "elicitation_complete"`, `mcp_server_name`,
`elicitation_id`, `uuid`, and the active `session_id`. This record may arrive
between model or tool records while the connection is active.

Legacy MCP server logs are emitted as system records with `subtype: "mcp_log"`,
`mcp_server_name`, `level`, optional `logger`, `data`, `uuid`, and the active
`session_id`. The server's `logLevel` configuration controls the minimum emitted
severity.

Long-running MCP activity uses `system/mcp_progress` records containing
`mcp_server_name`, `progress_token`, `progress`, optional `total` and `message`.
Server cancellation uses `system/mcp_cancelled` with an optional `request_id`
and `reason`. Both records also include `uuid` and `session_id`.

Provider usage arrives as a `model_event` whose event has `type: "usage"`.
Successful terminal results include per-turn `usage`, session-wide
`total_usage`, and `total_cost_usd`. Token fields distinguish ordinary input,
output, cache-read input, and cache-creation input; cost values are USD
estimates from the selected model's configured per-million-token rates.

The two formats must be selected together and require print mode:

```text
-p --input-format stream-json --output-format stream-json
```
