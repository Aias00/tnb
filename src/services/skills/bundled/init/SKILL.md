---
name: init
description: Inspect a repository and create concise tnb project instructions grounded in its real build, test, architecture, and contribution conventions. Use when bootstrapping or refreshing repository guidance.
allowed-tools:
  - read
  - write
  - edit
  - grep
  - glob
  - bash
keywords:
  - init
  - AGENTS.md
  - project instructions
when-to-use: Use when initializing repository guidance, refreshing AGENTS or CLAUDE-style docs, or recording project-specific workflow facts.
argument-hint: <repo-instructions-target>
---
Initialize or refresh project instructions for this repository.

Inspect package manifests, build scripts, test configuration, primary entrypoints, module layout, and existing contributor guidance. Write concise instructions that record only repository-specific facts: commands that actually work, architectural boundaries, naming conventions, generated files, and validation expectations.

Preserve useful existing guidance and remove stale claims only when repository evidence disproves them. Do not include generic advice already covered by the agent system prompt.

Additional request: $ARGUMENTS
