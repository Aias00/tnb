# TypeScript SDK

The SDK runs tnb as an isolated subprocess and communicates over newline-delimited JSON. It uses the same Provider configuration, Agent loop, tools, permissions, Hooks, MCP connections, sessions, and compaction path as the interactive CLI.

```ts
import { query } from "tnb/sdk";

for await (const message of query({
  prompt: "Inspect this repository and summarize its architecture",
  options: {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    permissionMode: "dontAsk",
    maxTurns: 12,
  },
})) {
  if (message.type === "model_event") {
    const event = message.event as { type?: string; text?: string };
    if (event.type === "text") process.stdout.write(event.text ?? "");
  }
  if (message.type === "result") console.log(message);
}
```

## Multi-turn input and controls

Pass an `AsyncIterable` to keep stdin open between turns. Control methods are acknowledged by the CLI before their promises resolve. `setModel()` accepts either a model in the current Provider or `provider/model`.

```ts
const input = createAsyncChannel();
const session = query({
  prompt: input,
  options: {
    permissionMode: "default",
    canUseTool: async (name) =>
      ["read", "grep", "glob"].includes(name)
        ? { behavior: "allow" }
        : { behavior: "deny", message: "Read-only SDK session" },
  },
});

input.push({
  type: "user",
  message: { role: "user", content: "Find the configuration loader" },
  parent_tool_use_id: null,
});

await session.setModel("openai/gpt-4o");
await session.setPermissionMode("dontAsk");
await session.interrupt();
session.close();
```

`interrupt()`, `setModel()`, and `setPermissionMode()` require an `AsyncIterable` prompt or a `canUseTool` callback. A plain string without a callback closes subprocess stdin after sending its single user record.

## Stream JSON protocol

Start the protocol endpoint directly with:

```bash
tnb --print --input-format stream-json --output-format stream-json
```

User input:

```json
{"type":"user","message":{"role":"user","content":"Read package.json"},"parent_tool_use_id":null}
```

Control input:

```json
{"type":"control_request","request_id":"1","request":{"subtype":"interrupt"}}
{"type":"control_request","request_id":"2","request":{"subtype":"set_model","model":"openai/gpt-4o"}}
{"type":"control_request","request_id":"3","request":{"subtype":"set_permission_mode","mode":"dontAsk"}}
{"type":"control_request","request_id":"4","request":{"subtype":"context_usage"}}
{"type":"control_request","request_id":"5","request":{"subtype":"plugin_reload"}}
{"type":"control_request","request_id":"6","request":{"subtype":"mcp_reconnect"}}
{"type":"control_request","request_id":"7","request":{"subtype":"task_list"}}
```

The CLI returns a matching `control_response`; successful requests that return
data put it in `response.payload`. The SDK exposes the same controls through
`getContextUsage()`, `reloadPlugins()`, `addMcpServer()` / `removeMcpServer()` /
`setMcpServerEnabled()` / `reconnectMcpServer()`, and the task
create/get/list/update/stop methods. MCP configuration changes are persisted
atomically and become active on the next model turn; reconnect validates the
selected server and explicitly reports that turn boundary.

When a tool requires approval, the CLI sends a `control_request` with subtype
`can_use_tool`; the SDK calls `canUseTool` and writes the correlated response.
Model, tool, Hook, MCP, usage, and terminal result records continue to use the
existing stream-json output forms.

Always consume the returned async generator or call `close()` so its subprocess cannot remain alive.
