# MCP client

tnb supports local MCP servers over stdio, legacy remote SSE, remote
Streamable HTTP, and SDK-injected in-process transport pairs. It implements both
the legacy handshake era through `2025-11-25` and the stateless `2026-07-28`
protocol without a runtime MCP SDK dependency. The modern implementation follows
the official [versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning),
[Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http),
and [MRTR](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr)
specifications.

## Configuration

The default file is `~/.tnb/mcp.json`. Set `TNB_HOME` to move the
entire tnb configuration directory or `TNB_MCP_CONFIG` to select only
the MCP file.

```json
{
  "mcpServers": {
    "database": {
      "command": "node",
      "args": ["/opt/local/database-mcp/server.js"],
      "logLevel": "info",
      "env": {
        "DATABASE_URL": "postgres://localhost/app"
      }
    },
    "remote": {
      "type": "http",
      "protocol": "auto",
      "url": "https://mcp.example.com/rpc",
      "headers": {
        "Authorization": "Bearer value"
      }
    },
    "legacy": {
      "type": "sse",
      "url": "https://mcp.example.com/sse"
    },
    "oauth-server": {
      "type": "http",
      "url": "https://mcp.example.com/rpc",
      "oauth": {
        "clientId": "$MCP_CLIENT_ID",
        "clientSecret": "$MCP_CLIENT_SECRET",
        "scopes": ["tools:read", "tools:execute"]
      }
    }
  }
}
```

`protocol` follows the official SDK's era-selection model:

- `legacy` (default) sends the established `initialize` handshake directly.
- `auto` probes `server/discover`, uses `2026-07-28` when advertised, and
  otherwise restarts a stdio server before falling back to the legacy handshake.
- `2026-07-28` pins the modern protocol and fails instead of silently falling
  back.

Explicit opt-in avoids adding a discovery timeout and an extra short-lived
process to every invocation of a legacy stdio server. The deprecated `sse`
transport only accepts `legacy`.

The current `2026-07-28` lane covers discovery, stateless request metadata,
standard tools/resources/prompts/completion calls, MRTR sampling and
elicitation, modern HTTP routing headers, `x-mcp-header`, the unified
`subscriptions/listen` stream, and the `io.modelcontextprotocol/tasks`
extension. List changes and selected resource updates share one modern
subscription. Task-returning operations are polled using each server's
`pollIntervalMs`; input requests are answered through `tasks/update`, while
abort still uses the dedicated `tasks/cancel` operation. Roots, Sampling, and Logging are deprecated in this
revision, so tnb retains all three only for legacy compatibility and does
not advertise them as new modern dependencies. For a legacy server that
declares `logging`, tnb sends `logging/setLevel` and filters
`notifications/message` at the configured `logLevel`. The default is `info`;
valid levels are `debug`, `info`, `notice`, `warning`, `error`, `critical`,
`alert`, and `emergency`.

Tool calls include a request-scoped `_meta.progressToken`. Valid
`notifications/progress` updates are shown in the terminal and Ink status area;
server `notifications/cancelled` messages retain their request ID and optional
reason for the same output surfaces. Malformed activity notifications are
ignored without interrupting the active MCP connection.

For stdio, `command` must be a non-empty string, `args` must contain only
strings, and `env` must map names to string values. Remote definitions require
`type: "http"` or `type: "sse"`, an HTTP(S) URL, and optional string headers. Invalid
configured servers stop startup with an explicit error; an absent default file
means no MCP servers. `$NAME` and `${NAME}` references in commands, arguments,
environment values, headers, URLs, and OAuth strings are expanded from the
process environment; use `$$` for a literal dollar sign.

## OAuth PKCE

Add an `oauth` object to an HTTP or SSE server, then authenticate explicitly:

```bash
tnb mcp auth oauth-server
tnb mcp logout oauth-server
```

`clientId` is optional when the authorization server advertises Dynamic Client
Registration. `clientSecret`, `callbackPort`, `authorizationServerUrl`, and
`scopes` are optional. `authorizationServerUrl` names the issuer and is useful
when protected-resource discovery is unavailable. tnb discovers protected
resource and authorization-server metadata, requires PKCE S256, validates the
callback state, opens a loopback callback on `127.0.0.1`, and refreshes expiring
tokens when a refresh token exists. Authorization and token endpoints must use
HTTPS except for loopback development servers.

Credentials are stored in `~/.tnb/mcp-oauth.json` with mode `0600`.
Ordinary Agent startup never launches an OAuth browser: when credentials are
missing or cannot be refreshed, it reports the exact `mcp auth` command.

`tnb mcp logout <server>` discovers the RFC 7009 revocation endpoint from
authorization-server metadata. It revokes the refresh token first and then the
access token, using the endpoint's advertised client authentication method.
Public clients send `client_id`; confidential clients use
`client_secret_basic` by default or `client_secret_post` when explicitly
advertised. Local credentials are always removed even when the server omits a
revocation endpoint or cannot be reached, and the command reports that outcome.

## Resources and prompts

Inspect and consume server primitives without starting an Agent turn:

```bash
tnb mcp resources <server>
tnb mcp templates <server>
tnb mcp read <server> <uri>
tnb mcp watch <server> <uri>
tnb mcp prompts <server>
tnb mcp prompt <server> <name> '{"argument":"value"}'
tnb mcp complete <server> resource '<uri-template>' <argument> <prefix> '[context-json]'
tnb mcp complete <server> prompt <name> <argument> <prefix> '[context-json]'
```

These commands connect only to the named server. List operations follow all
pagination cursors. A resource-capable server also contributes one dynamic
`mcp__<server>__read_resource` Agent tool. Text is returned directly; JPEG,
PNG, GIF, WebP, and PDF blobs use tnb's existing multimodal blocks.
Unsupported binary MIME types fail explicitly instead of being inserted into
the model context as opaque base64.

Resource templates are listed exactly as RFC 6570 URI templates advertised by
the server. tnb does not partially reimplement RFC 6570; the Agent supplies
a concrete URI to `read_resource`, and the MCP server remains responsible for
URI validation. When the server declares `resources.subscribe`, the read tool
accepts `subscribe: true` and tnb adds
`mcp__<server>__resource_updates`. That tool lists update URIs received since
subscription and can explicitly clear the markers. Updated URIs may identify a
sub-resource of the subscribed URI, as allowed by MCP.

`tnb mcp watch` keeps the named connection open, prints one JSON line for
the subscription and each `notifications/resources/updated` event, then
unsubscribes during an orderly interrupt. Interactive sessions also unsubscribe
their active resource subscriptions before closing the transport.

Prompt commands return the protocol result as JSON. In the terminal REPL and
Ink TUI, every advertised prompt is also registered as
`/mcp__<server>__<prompt>`. Values following the command are mapped positionally
to the arguments declared by the server. Expanded text, JPEG, PNG, GIF, WebP,
embedded PDF, and resource-link content enters the next user turn through the
same canonical message types used by ordinary input. Unsupported content types
fail explicitly.

When the server advertises the MCP `completions` capability, `mcp complete`
forwards a standard `completion/complete` request for either a prompt or a
resource template. The optional context JSON object supplies previously
resolved string arguments. Results are validated against the protocol limit of
at most 100 string values and retain the server's optional `total` and
`hasMore` fields.

## Lifecycle, tools, and resources

For every configured server, tnb:

1. starts the stdio command in the active workspace or opens the configured
   HTTP endpoint;
2. uses the configured era policy and reads capabilities from either
   `server/discover` or the legacy initialization result;
3. follows every `tools/list`, `resources/list`, `resources/templates/list`, or
   `prompts/list` pagination cursor used by the active operation;
4. registers each tool under a provider-safe `mcp__server__tool` name;
5. registers `mcp__server__read_resource` when the server supports resources,
   plus `mcp__server__resource_updates` when it supports subscriptions;
6. forwards calls through `tools/call` or `resources/read` and returns execution
   errors to the Agent loop;
7. closes stdin and terminates remaining child processes, or deletes an
   established HTTP session, when the CLI exits.

Connection setup has a 30-second timeout, ordinary protocol requests use 60
seconds, and tool calls use 100,000,000 milliseconds so long-running tools are
not cancelled as ordinary control requests. `MCP_TIMEOUT` and
`MCP_TOOL_TIMEOUT` override the connection and tool-call values. Timed-out or
aborted calls send an MCP cancellation notification. Tool names longer than 64
characters are shortened with a stable hash so they remain valid for both
configured model providers.

For `2026-07-28`, every request carries protocol version, client identity, and
client capabilities in `_meta`. Streamable HTTP also sends the required
`MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` headers. Tool parameters
annotated with valid `x-mcp-header` schemas are mirrored as `Mcp-Param-*`;
malformed annotated tools are excluded, and a `HeaderMismatch` response refreshes
tool schemas before one retry. Modern HTTP does not create protocol sessions,
open the former GET stream, or send `Last-Event-ID`.

Legacy Streamable HTTP sends each JSON-RPC message in a POST request and accepts
both JSON and SSE responses. It records `MCP-Session-Id` from initialization and
sends that value plus the negotiated `MCP-Protocol-Version` on later requests.
After `notifications/initialized`, it also opens the optional GET SSE channel
for independent server notifications and requests; HTTP 405 means the server
does not provide that channel. SSE event IDs are retained and sent as
`Last-Event-ID` when a stream is resumed. Server-provided `retry` values take
precedence over the MCP SDK-compatible reconnect policy (1 second initial
delay, 1.5 growth factor, 30 second ceiling, and two failed reconnects). If a
request carrying an established session ID receives HTTP 404, tnb clears
the expired transport state, performs a new MCP initialization, restores
active resource subscriptions, and retries the interrupted request once.
Closing tnb aborts the GET stream before deleting the MCP session.
Cancellation aborts only its target request, leaving the connection usable.

Legacy SSE keeps one GET event stream open, accepts the server's `endpoint`
event, sends JSON-RPC through POST, and receives `message` events. The announced
POST endpoint must remain on the configured server origin so OAuth or static
authorization headers cannot be redirected to another host.

SDK callers may create a linked pair with `createLinkedMcpTransportPair()` and
pass the client side under `connectMcpServers(..., { inProcess: { name:
clientTransport } })`. Delivery is queued as a microtask, preventing recursive
request/response stacks, and does not spawn a subprocess.

Legacy interactive sessions retain their MCP connections between Agent turns.
When a server sends `notifications/tools/list_changed`,
`notifications/resources/list_changed`, or
`notifications/prompts/list_changed`, tnb refreshes that server's cached
snapshot. Updated tools and prompt commands become available on the next user
turn without restarting the CLI. A failed advisory refresh preserves the last
successfully validated snapshot and records the failure in
`McpConnections.refreshErrors`.

Legacy initialization advertises the standard Roots capability. A server may
call `roots/list` to receive the active workspace as a canonical `file:` URI.
When a worktree tool changes the session root, tnb sends
`notifications/roots/list_changed`; the next list request resolves the current
root dynamically rather than returning the startup path. The deprecated Roots
capability is intentionally omitted from `2026-07-28` discovery metadata.

## Permission boundary

MCP tool and resource descriptions, schemas, results, contents, and annotations
originate outside the tnb process. Annotations never raise a tool's trust
level: every MCP tool, including resource reads, is registered with unknown
access and therefore denied by the default and plan permission modes. Use an
explicit MCP allow rule or YOLO only for servers whose command and behavior you
trust.

Standard prompt and resource-template completion requests are available through
`tnb mcp complete`. In the Ink TUI, MCP prompts appear in slash-command
completion. After entering a prompt argument, press Tab to request the server's
`completion/complete` values; repeated Tab presses cycle the returned choices.
Previously completed prompt arguments are sent as completion context.

## Sampling

Interactive tnb sessions advertise sampling with tool-use support. Legacy
servers use a direct `sampling/createMessage` request. Under `2026-07-28`, the
same request appears inside an `input_required` MRTR result; tnb gathers the
response and retries the original `tools/call`, `resources/read`, or
`prompts/get` with the opaque `requestState` unchanged. tnb validates the
message/tool-result sequence, asks the user to approve the request, and performs
exactly one call with the currently selected provider and model. The generated
response is shown for a second approval before it is returned. Tool uses are
returned to the server and are never executed by tnb, so the server remains
responsible for its own bounded multi-turn tool loop.

Sampling honors `maxTokens`, `temperature`, `stopSequences`, and `toolChoice`.
Model preferences are advisory and the configured tnb model wins. Context
inclusion and task-augmented sampling are not advertised and are rejected.
Non-interactive print mode rejects sampling because no human approval UI is
available. Sampling approval remains mandatory in YOLO mode.

## Elicitation

Interactive sessions advertise both MCP form and URL elicitation. Legacy servers
send `elicitation/create` directly; modern servers carry it through MRTR. Every
request first displays the requesting server, explanation,
and requested fields or destination host in the normal permission UI. Denial
returns the protocol `decline` action; closing or interrupting the follow-up UI
returns `cancel`.

Form mode accepts the MCP restricted flat-object schema: strings, finite
numbers, integers, booleans, single-select enums, and string multi-select
enums. Required, default, length, range, pattern, format, and item-count
constraints are validated before values are returned. Credential-shaped fields
such as passwords, API keys, tokens, private keys, and payment-card data are
rejected because MCP requires sensitive data collection to use URL mode.

URL mode validates an HTTP(S) URL without embedded credentials and shows its
full URL and host for consent. tnb does not automatically launch the URL;
the user remains in control of navigation. Non-interactive clients safely
decline because no approval or form UI is available.

During connection initialization, before the interactive controllers are ready,
elicitation returns `cancel` and sampling returns a protocol rejection. This
keeps a server request from deadlocking capability negotiation or initial tool
discovery.
