# Skills

Skills package reusable instructions in a directory containing `SKILL.md`.
tnb keeps skill metadata available for discovery and loads the instruction
body only when the model invokes the `skill` tool.

## Locations and precedence

Skills are scanned from highest to lowest priority:

1. `~/.tnb/skills/<name>/SKILL.md`
2. `<workspace>/.tnb/skills/<name>/SKILL.md`

`TNB_HOME` changes the first root. Duplicate names are compared without
case sensitivity, and the first definition wins. Directories without a
`SKILL.md` file are ignored; malformed skill files stop startup with a concrete
error.

## Format

```markdown
---
name: review-code
description: Review a requested code path and report concrete findings.
allowed-tools: [read]
keywords:
  - review
  - audit
when_to_use: Use when the user asks for a code review or regression audit.
model: anthropic/claude-sonnet-4-6
---

Inspect $ARGUMENTS and report findings ordered by severity.
Supporting files are relative to ${TNB_SKILL_DIR}.
```

`name` and `description` are required. Names may contain letters, numbers,
underscores, and hyphens. `allowed-tools` and `keywords` accept an inline list,
a YAML-style block list, or a comma-separated scalar. Folded (`>`) and literal
(`|`) block strings are supported for metadata. `when_to_use` gives the model
concrete activation guidance. `model` accepts a configured model name or
`provider/model`; `inherit` keeps the parent model. Set
`disable-model-invocation: true` to hide a Skill from automatic model discovery.

At invocation, `$ARGUMENTS` is replaced with the provided argument string and
`${TNB_SKILL_DIR}` is replaced with the skill directory. tnb does not
execute shell directives embedded in Markdown.

Files beside `SKILL.md` are exposed as a relative resource manifest when the
Skill is invoked. The child reads only the required files from the displayed
base directory; resource contents are not eagerly injected into context.

## Execution boundary

The model invokes one dynamic `skill` tool with a skill name and optional
arguments. tnb starts a nested Agent loop with fresh message history and
returns its final text as the parent tool result. The nested loop:

- uses the configured provider and model, or the Skill's `model` override;
- receives only tools listed by `allowed-tools`, or the inherited base tool set
  when the field is absent;
- applies the same permission checker as the parent;
- does not receive the parent conversation or persist its internal messages;
- cannot invoke the `skill` tool recursively;
- has the established 200-turn fork limit.

Because invoking a skill may lead to file, process, network, or MCP activity,
the `skill` tool is classified as execute-risk and requires an allow rule or explicit YOLO
permission in the current non-interactive CLI.

The `skill` tool exposes only names plus compact descriptions, activation hints,
and keywords to the parent model. Full instructions and the resource manifest
are loaded only after model invocation. This follows model-driven Skill
discovery rather than brittle CLI-side substring matching.
