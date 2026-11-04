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

The backend must support the selected filesystem and network policy:

- `permissive`: host reads and ordinary operations are allowed, while writes
  remain restricted to the workspace, temporary/cache roots, and
  `allowedPaths`;
- `restrictive`: deny-by-default with host-wide reads and restricted writes;
- `strict`: reads are limited to the workspace, runtime/system roots, caches,
  and `allowedPaths`;
- `open`: direct outbound network access plus the local debugger inbound port;
- `proxied`: on macOS, outbound traffic is restricted to `localhost:8877`;
- blocked (`networkAccess: false`): macOS denies network operations; Linux
  uses a separate network namespace. Windows refuses this mode.

| Backend | Filesystem | Network | Additional boundary |
| --- | --- | --- | --- |
| macOS Seatbelt | Policy enforcement, including workspace `.env` denial | Open, proxied, blocked | Descendant processes inherit the policy |
| Linux bubblewrap | Namespace mounts; writable grants and read-only host or strict roots | Open, blocked | No filename-based `.env` exclusion in the workspace bind |
| Windows PowerShell | Best-effort wrapper; native child programs retain host filesystem access | Open only | Job Object cleanup is best-effort; strict and AppContainer are rejected |

`--sandbox` enables the configured policy without replacing its `allowedPaths`
or profile settings. `TNB_SANDBOX=true|false|sandbox-exec` is also supported;
an explicit `false` disables sandboxing for the process.

The default policy follows Qoder's process-sandbox model: commands can read and
write the active workspace, temporary files, and common Bun/npm cache paths;
system executables and libraries are readable; writes elsewhere are denied.
The macOS Seatbelt backend explicitly denies workspace `.env` files. The Linux
workspace bind does not currently implement the same filename-based exclusion;
Windows reports best-effort confinement. These are separate platform guarantees,
not interchangeable implementations of sensitive-file protection.
Set `networkAccess` to `false` to deny network access from tools while retaining
normal Provider connectivity in tnb itself.

Sandboxing fails closed when the selected backend is unavailable. The shell
manager runs a bounded launch probe before its first command in each cwd and
does not fall back to an unsandboxed process if that probe fails. Executable
discovery in `getSandboxAvailability` describes the backend, not proof that
host namespace/OS policy permits it to launch. A launch probe alone also does
not prove confinement.

Closing the shell runtime cancels pending probes and startups, blocks new
commands, and waits for managed foreground/background processes and PTY
bridges to exit. Probe cancellation waits for process close. Commands that
ignore SIGTERM are forcefully stopped after a 250 ms grace period. PTY helper
exit or input EOF also terminates its terminal child.

`tests/integration/macos-shell-lifecycle.test.ts` checks these lifecycle paths
on macOS, including real Seatbelt file restrictions for foreground, background
and PTY execution, cancellation of a live launch probe, terminal exit, and
commands that ignore SIGTERM. Platform-neutral sandbox and Worker control-state
checks also run on Linux; POSIX TUI tests support both BSD and util-linux `script`.

`tests/integration/sandbox-native.test.ts` executes real processes. It checks
successful workspace writes, denied writes by a descendant outside grants,
the platform's `.env` behavior, and an open-versus-blocked loopback connection.
The Windows case explicitly checks native writes outside grants, documenting
the absence of filesystem isolation rather than asserting a false denial.
The fixtures contain synthetic data and live outside writable temp/cache roots.
CI sets `TNB_REQUIRE_NATIVE_SANDBOX=1` so a missing backend fails the job;
ordinary local runs skip native cases if no backend is installed. The CI jobs
install bubblewrap on Linux and use native macOS and Windows runners.

Linux strict mode remounts the synthetic root directory tree read-only after
installing its mounts, while explicitly writable grants remain writable.
Descendants drop all capabilities, including when the caller has privileges.
This prevents the private tmpfs directory skeleton from becoming an implicit
writable root.

Native checks passed on macOS and in a disposable Debian arm64 container on
the Colima Linux VM. The container run used root with `SYS_ADMIN` and allowed
namespace setup through its container security profiles. A normal unprivileged
launch in that environment was refused while setting up UID maps; the runtime
probe rejected it and did not run the requested command outside the sandbox.
These results verify the tested Linux policies under the stated privileges;
they do not establish launch availability on every unprivileged Linux host.
The dedicated CI jobs still need remote execution, and Windows enforcement
has not been locally verified.

The current runtime has additionally passed full verification directly on a
Colima Ubuntu 24.04.4 ARM64 VM, as an ordinary UID 501 user: **806 pass / 7 skip /
0 fail** with `TNB_REQUIRE_NATIVE_SANDBOX=1`, type checking, build, isolated
installation, the same **29-case functional matrix** used on macOS, and a
durable-task restart flow. Model-dependent cases used real Magpie free-group
requests; management commands were checked locally. Supplementary native probes
verified the read-only strict root, sandboxed PTY input/resize/workspace writes
and outside-secret isolation, and fail-closed behavior with an unprofiled
backend. This run did not use a privileged container. The skipped tests cover
macOS-specific Shell lifecycle behavior and the Windows-specific sandbox case.

The VM initially rejected bubblewrap namespace setup. Its
`kernel.apparmor_restrict_unprivileged_userns` and
`kernel.unprivileged_userns_clone` both remained `1`; a test-specific AppArmor
profile granted `userns` only to `/usr/bin/bwrap`. Ubuntu supports granting this
permission per executable through an AppArmor profile; see its
[user namespace policy explanation](https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces).
An unprofiled backend copy still failed the tnb launch probe, and the requested
command did not run. Successful confinement checks therefore establish the
tested policy under this explicit prerequisite, rather than universal launch
availability on an unmodified Ubuntu system. Linux x86_64, other distributions
and Windows remain outside this local run. The Linux CI job now runs the full
suite; these changes have not yet been executed by remote GitHub Actions.
The matrix is not an hours-long soak or exhaustive coverage of all integrations;
see the [full verification review](superpowers/specs/2026-11-03-durable-task-runtime-review.md#12-linux-完整功能矩阵补齐)
for evidence, environment corrections, and remaining boundaries.

File tools, Hook commands, plugins, MCP servers and model HTTP calls run in the
tnb host process or their own runtimes and are outside this shell sandbox.
