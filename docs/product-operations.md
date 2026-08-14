# Product operations

## IDE and SDK control

`tnb remote-control` exposes the same bidirectional JSON Lines protocol as
`--input-format stream-json --output-format stream-json`. It is a stable stdio
entrypoint for editors and local controller processes; it does not start a
brand-specific cloud daemon or open a network listener.

```bash
tnb remote-control --provider local --model my-model
```

For an editor process that should connect after tnb starts, expose the same
protocol on a local Unix socket:

```bash
tnb remote-control \
  --socket ~/.tnb/ide/editor.sock \
  --provider local --model my-model
```

The socket accepts both `tnb.stream-json/v1` and
`tnb.ide-jsonrpc/v1`. JSON-RPC clients initialize with the descriptor's
`ownerToken`, then use `editor/updateContext`, `editor/getContext`,
`workspace/status`, and `agent/query`. Editor context includes active/open
files, a selection, diagnostics, and the visible diff; an agent query receives
that state in a bounded `<ide-context>` section. The bridge also exposes
`editor/openFile`, `workspace/diff`, and `workspace/applyEdit`. Workspace edits
use zero-based LSP ranges, reject overlapping or out-of-bounds edits, enforce
the workspace boundary, and can carry per-file SHA-256 `expectedHashes` to
reject stale editor writes.

The socket and its adjacent `editor.sock.json` discovery descriptor use mode
`0600`. The descriptor records the protocol version, PID, workspace, CLI
version, supported protocols, start time, and an ownership token. SIGINT/SIGTERM closes connected
clients and removes only the socket and descriptor created by that server.
An active socket is never replaced; a refused stale socket may be removed, and
a regular file at the requested path is always preserved with an error.

Within the Ink TUI, `/ide` lists discovery descriptors from
`~/.tnb/ide`, verifies that both the recorded process and Unix socket are
live, and labels stale descriptors without deleting them.

Editor integrations can use the exported `IdeJsonRpcClient` instead of
implementing socket framing and authentication themselves:

```ts
import { IdeJsonRpcClient } from "tnb";

const client = await IdeJsonRpcClient.connect({
  descriptorPath: `${process.env.HOME}/.tnb/ide/editor.sock.json`,
});
await client.updateContext({ activeFile: "src/main.ts", openFiles: ["src/main.ts"] });
const result = await client.query("Explain the active file");
client.close();
```

The client rejects discovery files readable by group/other users, initializes
with the descriptor owner token, supports concurrent requests, and rejects all
pending requests when the socket closes. It exposes editor context, file
events, diagnostics, guarded edits, diff/status, agent queries, and PTY control.

## Feedback

Set `TNB_FEEDBACK_URL` to an HTTP(S) endpoint accepting multipart form
data, then submit text, optional images, and a session identifier:

```bash
tnb feedback -c "The permission dialog closed unexpectedly" \
  -i screenshot.png -s <session-id>
```

The form contains `comment`, `session_id`, `version`, `cwd`, `platform`, and
repeated `images` fields. No qoder account or gateway is required.

## Verified self-update

Set `TNB_UPDATE_MANIFEST_URL` to a release manifest:

```json
{
  "version": "1.2.3",
  "url": "https://releases.example.com/tnb-darwin-arm64",
  "sha256": "<64 hexadecimal characters>",
  "notes": "Optional release notes"
}
```

Use `tnb update --check` to inspect availability. Installing requires
`tnb update --yes`, verifies SHA-256, and preserves the current binary as
`tnb.previous`. Source-mode development never overwrites the Bun runtime;
use `TNB_EXECUTABLE` only when intentionally managing a nonstandard binary
path. `tnb update --rollback` atomically swaps the current and previous
binaries and does not contact the release server.
