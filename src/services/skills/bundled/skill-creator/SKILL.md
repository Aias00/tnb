---
name: skill-creator
description: Create or improve a reusable tnb skill with valid frontmatter, focused instructions, and optional reference files. Use when building or refining skills.
allowed-tools:
  - read
  - write
  - edit
  - grep
  - glob
keywords:
  - skill
  - SKILL.md
  - automation
when-to-use: Use for requests to author, restructure, or audit tnb skills and their resource files.
argument-hint: <skill-purpose>
---
Create or update the requested skill.

Inspect existing nearby skills and project conventions before writing. Keep `SKILL.md` focused on routing, workflow, constraints, and required outputs. Put long examples or domain reference material in sibling files and link them explicitly.

Use frontmatter with a stable kebab-case name and a concrete description that says when the skill applies. Add `allowed-tools` only when restricting the child agent is useful. Use `$ARGUMENTS` for caller input and `${TNB_SKILL_DIR}` when referring to files shipped beside the skill. Validate that every referenced file exists and that the instructions are executable without hidden conversation context.

Requested skill: $ARGUMENTS
