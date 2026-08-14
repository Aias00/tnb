---
name: docs-writer
description: Write or update technical documentation grounded in the current code, commands, and user workflow. Use when the user asks for README, migration notes, setup docs, or architecture explanations.
allowed-tools:
  - read
  - write
  - edit
  - grep
  - glob
  - bash
keywords:
  - docs
  - readme
  - migration
when-to-use: Use for documentation authoring, refreshes, release notes, setup guides, and architecture explanations that must match the codebase.
argument-hint: <doc-target>
---
Write or revise the requested documentation using repository evidence.

Inspect the relevant commands, configuration, source files, and tests before drafting. Prefer executable facts over aspirational wording. Document the user-visible workflow, prerequisites, sharp edges, and verification steps. Remove stale claims only when repository evidence disproves them.

Keep the structure concise: who it is for, how to use it, what can go wrong, and how to verify it worked.

Documentation target: $ARGUMENTS
