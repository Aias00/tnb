---
name: mcp-config
description: Configure, debug, or migrate MCP server definitions, credentials, and capability expectations. Use when the user needs MCP setup, transport fixes, resource/tool discovery, or config normalization.
allowed-tools:
  - read
  - write
  - edit
  - grep
  - glob
  - bash
keywords:
  - mcp
  - config
  - server
when-to-use: Use for MCP server onboarding, transport debugging, capability mismatches, auth/config fixes, or MCP manifest cleanup.
effort: high
argument-hint: <mcp-problem-or-target>
---
Work on the requested MCP configuration or failure.

Inspect the live config files, environment inputs, declared transports, auth expectations, and any protocol errors before editing. Normalize the smallest set of changes needed to make the server discoverable and usable. When debugging a failure, identify whether it is a config issue, process launch issue, network/auth issue, or protocol-capability mismatch.

Report the final config surface, required secrets or environment variables, and the exact verification command or interaction that proves the fix.

MCP request: $ARGUMENTS
