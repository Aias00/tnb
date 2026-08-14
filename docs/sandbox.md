# Sandbox

tnb can run every shell process created by `bash`, background monitors, and
PTY sessions inside a platform sandbox. Model API calls, MCP connections, and the
tnb process itself stay outside this boundary.

Enable it for one invocation:

```bash
tnb --sandbox
tnb -p "Run the test suite" --sandbox
```

Or enable it in `~/.tnb/settings.json` or a project settings file:

```json
{
  "tools": {
    "sandbox": {
      "enabled": true,
      "command": "auto",
      "profile": "restrictive",
      "network": "open",
      "allowedPaths": ["~/Library/Caches/my-build-tool"]
    }
  }
}
```

`tools.sandbox` may also be the boolean `true` or `false`. The object fields are:

- `enabled`: enable process sandboxing;
- `command`: `auto`, `sandbox-exec` (macOS), `bwrap` (Linux), or `powershell`
  (Windows). `appcontainer` is reserved and currently fails explicitly;
- `profile`: `permissive`, `restrictive`, or `strict`; defaults to
  `restrictive`;
- `network`: `open` or `proxied`; defaults to `open`;
- `networkAccess`: backward-compatible boolean; `false` selects blocked
  networking when `network` is not set;
- `allowedPaths`: additional read/write roots outside the active workspace.

The three filesystem profiles combine with the two network profiles to form
six modes:

- `permissive`: host reads and ordinary operations are allowed, while writes
  remain restricted to the workspace, temporary/cache roots, and
  `allowedPaths`;
- `restrictive`: deny-by-default with host-wide reads and restricted writes;
- `strict`: reads are limited to the workspace, runtime/system roots, caches,
  and `allowedPaths`;
- `open`: direct outbound network access plus the local debugger inbound port;
- `proxied`: outbound traffic is restricted to `localhost:8877`, matching the
  mature proxy profile used by the reference implementation.

`--sandbox` enables the configured policy without replacing its `allowedPaths`
or profile settings. `TNB_SANDBOX=true|false|sandbox-exec` is also supported;
an explicit `false` disables sandboxing for the process.

The default policy follows Qoder's process-sandbox model: commands can read and
write the active workspace, temporary files, and common Bun/npm cache paths;
system executables and libraries are readable; writes elsewhere are denied.
Workspace `.env` files remain unreadable and unwritable by sandboxed commands.
Set `networkAccess` to `false` to deny network access from tools while retaining
normal Provider connectivity in tnb itself.

Sandboxing fails closed when the selected backend is unavailable. macOS uses
Seatbelt, Linux uses bubblewrap namespaces, and Windows uses constrained
PowerShell plus a Job Object for process cleanup. Windows reports filesystem
isolation as best-effort and refuses unsupported network/filesystem modes
instead of claiming parity with Seatbelt or bubblewrap.
