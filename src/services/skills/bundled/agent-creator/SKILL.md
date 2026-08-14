---
name: agent-creator
description: Create or improve a custom tnb subagent profile with a bounded role, tool policy, model choice, and completion contract. Use when defining or revising agents.
allowed-tools:
  - read
  - write
  - edit
  - grep
  - glob
keywords:
  - agent
  - subagent
  - profile
when-to-use: Use for requests to add, refine, or audit an agent profile, role prompt, or subagent execution contract.
argument-hint: <agent-purpose>
---
Create or update the requested agent markdown file.

Inspect nearby agents first. Keep the role narrow, state the inputs and outputs explicitly, and define a clear stop condition. Use frontmatter fields such as `name`, `description`, `tools`, or `disallowed-tools`, and add `model`, `permission-mode`, or `max-turns` only when the task genuinely needs an override.

The body must tell the child what evidence to collect, what it owns, what it must not change, and what to report upward. Avoid duplicating the parent system prompt.

Requested agent: $ARGUMENTS
