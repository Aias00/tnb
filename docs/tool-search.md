# Deferred tool schemas

Large tool sets consume model context before any tool is used. When more than
48 tools are enabled, tnb exposes the first 32 core tools plus control tools and
adds `tool_search`. Less frequently used schemas remain deferred until the
model searches for and activates them.

Permission and CLI filtering run before the deferred catalog is built. A tool
excluded by `--allowedTools`, `--disallowedTools`, or an agent profile cannot be
found by `tool_search`. Activated tools retain their original name, schema, and
permission behavior, including `mcp__server__tool` names.

Set `TNB_DEFERRED_TOOL_THRESHOLD` to a positive integer to choose the eager
schema count. Set it to `off` or `0` to expose all schemas. An explicit
`--tools` selection also exposes exactly the requested schemas without adding
deferred discovery.
