# Plugins and Skills

tnb loads user plugins from `~/.tnb/plugins`, project plugins from
`.tnb/plugins`, user Skills from `~/.tnb/skills`, and project Skills
from `.tnb/skills`. Local directories can be installed and removed through
the CLI:

```bash
tnb plugins install ./my-plugin
tnb plugins disable my-plugin
tnb plugins enable my-plugin
tnb plugins show my-plugin
tnb plugins update my-plugin
tnb plugins trust my-plugin --yes
tnb plugins untrust my-plugin --yes
tnb plugins remove my-plugin --yes

tnb skills install ./my-skill
tnb skills show my-skill
tnb skills remove my-skill --yes
```

Marketplace catalogs are optional JSON documents configured with a comma-
separated `TNB_PLUGIN_MARKETPLACE` value or
`~/.tnb/marketplaces.json` (`{ "sources": ["..."] }`). A source may be a
local file or HTTPS URL. Each catalog entry names a versioned Git repository:

```json
{
  "name": "community",
  "plugins": [{
    "name": "review-tools",
    "version": "1.4.0",
    "description": "Review commands and Skills",
    "repository": "https://example.com/review-tools.git",
    "ref": "v1.4.0",
    "commit": "0123456789abcdef0123456789abcdef01234567",
    "manifestSha256": "<64 hexadecimal characters>"
  }]
}
```

Use `tnb plugins marketplace`, `tnb plugins search review`, and
`tnb plugins install review-tools --marketplace`. Installation performs a
shallow Git clone into a temporary directory, validates the ordinary plugin
manifest, checks that the catalog and manifest names agree, then atomically
moves it into the plugin directory. Existing plugin names are never replaced.
The Ink TUI exposes the same catalog through `/marketplace`.
Remote repositories must use HTTPS or SSH and must declare the complete Git
commit expected after clone; a mutable branch or tag alone is rejected. The
optional `manifestSha256` additionally binds the catalog entry to the exact
plugin manifest. The manifest name and semantic version must match the catalog.
`tnb plugins marketplace --json` and `tnb plugins search ... --json` include
whether an entry is already installed, its installed scope/version, and the
latest cached runtime status when present. Use `/plugins` to inspect activation
and start/reload policy. The interactive
commands also accept `update <name>` and `remove <name>`. Use
`/plugins reload` to force a contribution-catalog refresh and reconnect MCP
servers without restarting the TUI.

Add `--project` to target the current project's `.tnb` directory. Removal
requires `--yes`. Installation validates the plugin manifest or Skill
frontmatter before copying and refuses to replace an existing name.
`tnb plugins show <name>` prints the resolved manifest path, scope, lifecycle,
contribution summary, tool descriptors, and cached runtime-session summary.

Plugin discovery is separate from execution trust. A plugin copied directly
into a user or project plugin directory is listed but its Skills, Agents,
commands, Hooks, MCP servers, and tools remain inactive until the current
content fingerprint is trusted. `tnb plugins trust <name> --yes` records that
fingerprint in `~/.tnb/plugin-trust.json`; `/plugins` provides the same review
and trust action interactively. Any later file, executable-bit, or manifest
change produces the `changed` state and disables all contributions until the
new content is reviewed and trusted. Explicit `plugins install` operations
trust the verified installed snapshot; updates naturally require trust again
because their fingerprint changes. `plugins untrust <name> --yes` revokes a
decision immediately.

Skill frontmatter accepts the existing `name`, `description`,
`allowed-tools`, `keywords`, `when_to_use`, `model`, and
`disable-model-invocation` fields plus the Claude/Qoder execution metadata
that tnb now preserves: `arguments`, `argument-hint`, `version`,
`user-invocable`, `context`, `agent`, `effort`, `paths`, and `hooks`.
`context` accepts `inline` or `fork` and defaults to forked execution when
omitted; `inline` returns rendered instructions to the current Agent. `paths`
accepts a scalar or list of glob-like path patterns and is included in model
discovery guidance. `hooks` accepts either nested frontmatter objects or a JSON
object keyed by Hook event name.

At invocation, tnb expands `$ARGUMENTS`, `$ARGUMENTS[n]`, `$n`, named
arguments declared in `arguments`, and both `${TNB_SKILL_DIR}` and
`${CLAUDE_SKILL_DIR}`. The runtime honors `allowed-tools`, `model`,
`disable-model-invocation`, `context`, `agent`, `effort`, and
`user-invocable`. Skill-scoped Hooks run for prompt, tool, permission, and
subagent lifecycle events. Path patterns remain model-facing activation
guidance rather than an unconditional CLI-side trigger.

Plugins contribute `skills/`, `agents/`, and `commands/` directories. The
manifest loader accepts both the legacy top-level contribution fields and the
preferred `contributes` block so a plugin can carry explicit compatibility,
lifecycle, and tool metadata:

```json
{
  "name": "team-automation",
  "manifestVersion": 1,
  "version": "1.2.0",
  "apiVersion": "tnb.plugin/v1",
  "compatibility": {
    "hosts": ["tnb", "claude-code"],
    "minTnbVersion": "0.0.0",
    "testedTnbVersions": ["0.0.0"]
  },
  "lifecycle": {
    "activation": "auto",
    "start": "lazy",
    "reload": "runtime",
    "state": "workspace",
    "events": ["SessionStart", "SessionEnd", "PostToolUse"]
  },
  "contributes": {
    "hooks": "./hooks.json",
    "mcpServers": "./mcp.json",
    "tools": [
      "builtin:security_scan",
      {
        "id": "team.audit",
        "type": "external",
        "description": "Workspace audit tool run as a one-shot command.",
        "command": "./bin/audit.js",
        "args": [],
        "inputSchema": "./schemas/audit.json",
        "security": {
          "access": "read",
          "workspace": "read",
          "network": "none",
          "shell": false,
          "approval": "always"
        },
        "lifecycle": {
          "transport": "oneshot",
          "start": "lazy",
          "reload": "runtime"
        }
      }
    ]
  }
}
```

`manifestVersion` defaults to `1` and versions newer than the supported v2
schema fail closed. `apiVersion`, when present, must be `tnb.plugin/v1`.
`compatibility.hosts`, `minTnbVersion`, and `maxTnbVersion` are enforced during
discovery; `testedTnbVersions` remains informational. `lifecycle` declares how
the plugin expects to activate, when it should start work, which Hook-style
events it cares about, how fast a changed contribution can reload, and whether
its state is ephemeral, workspace-scoped, or user-scoped.

Hook files may contain either a top-level `hooks` object or the Hook event map
directly. MCP files use the normal `{ "mcpServers": { ... } }` format, including
environment expansion, transports, protocol modes, and `enabled` state. Paths
must be relative to the plugin root. Duplicate MCP names across plugins or with
the user's MCP configuration fail startup instead of silently replacing a
server.

`contributes.tools` accepts either a built-in tool identifier string or an
external tool descriptor object. `oneshot` starts a command without a shell,
writes one JSON object to stdin, and accepts plain stdout or
`{ "content": "..." }`. `stdio` keeps one process alive and multiplexes
JSON-RPC `tools/call` requests by id; eager processes start during activation
and lazy processes start on first use. `http` sends the same envelope with POST
and requires declared loopback or egress access.
Descriptors are validated with resolved command/schema paths and declared
security metadata (`access`, workspace reach, network reach, shell usage, and
approval policy). Manual plugins remain loaded without registering tools,
Hooks, MCP servers, Skills, Agents, or commands until explicitly enabled.
Session shutdown rejects pending requests and terminates owned
processes. Unknown identifiers, unsupported transports, and escaping paths fail
startup instead of being silently ignored.

Interactive REPL and Ink sessions own one shared plugin runtime, so `stdio`
tool processes survive across multiple Agent turns and are terminated only when
the interactive session exits. Print-mode and SDK calls that do not inject a
runtime continue to own and close their process set for that invocation.

## Local security review plugin

The repository ships an installable plugin combining the local scanner, a
PostToolUse edit hook, and a model-discoverable review Skill:

```bash
tnb plugins install ./plugins/security-review
tnb security-scan --all
tnb security-scan --staged --json
```

The scanner reads files locally, never executes them, redacts likely credential
evidence, and returns high-severity findings with exit code 2. With the plugin
enabled, `security_scan` is available to the Agent and edited files are scanned
before the next model step. Pattern matches are review leads; the Skill checks
data flow and exploitability before reporting a vulnerability.

Enablement is persisted in `enabledPlugins`; disabling a plugin removes all of
its contribution types from subsequent Agent runtimes without deleting files.
Install/remove is the filesystem lifecycle, enable/disable is the persisted
availability lifecycle, and runtime refresh applies on the next catalog or
runtime rebuild according to the plugin's declared reload policy.

Each Agent runtime records loaded/active/stopped plugin lifecycle state under
`~/.tnb/plugins/.runtime/<session-id>.json`. Manual-activation plugins stay
loaded until explicitly enabled by host policy; automatic plugins become active
for the runtime and are marked stopped during orderly shutdown.
These runtime cache files, removed-plugin trash under `.removed/`, and staging
directories used during install/update are internal housekeeping directories and
are ignored by plugin discovery.

Interactive sessions refresh the plugin, Skill, Agent, and command catalogs in
the background and again immediately before each command or Agent turn. Skill,
Agent, and command changes therefore become active without restarting
tnb; slash-command completion also reads the current catalog. Hook and MCP
contributions are reloaded when a new runtime is created; `/plugins reload` and
`/mcp` configuration changes reconnect the interactive MCP catalog immediately.
