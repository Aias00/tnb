# Claude Tool Protocol Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace tnb's core coding tool contracts and implementations with the pinned Claude Code Read/Write/Edit/Grep/Glob/Bash/Agent/Task protocols, with no legacy Provider aliases.

**Architecture:** Generate pinned schema fixtures first, then port one isolated tool family at a time behind tnb safety/runtime dependencies. Switch registry/prompts/permissions/UI atomically after all new modules pass. Preserve old JSONL names only as historical data.

**Tech Stack:** Bun, TypeScript, Zod/JSON Schema-compatible AgentTool interface, ripgrep, node-pty, tnb TaskManager/ShellSessionManager, Bun test.

**Spec:** `docs/superpowers/specs/2026-08-16-claude-tool-protocol-migration-design.md`

**Pinned source:** `/Users/aias/Work/github/codercli/claude-code/package/src-extracted/src`

---

## Task 1: Freeze pinned names and schemas

**Create:** `tests/fixtures/claude-tools/*.json`, `tests/unit/claude-tool-schemas.test.ts`, `scripts/extract-claude-tool-fixtures.ts`.

- [ ] Inspect pinned `tools.ts` and each target Tool module; record only canonical names and current fields. Strip aliases `Task`, `AgentOutputTool`, `BashOutputTool`, `KillShell`, and deprecated `shell_id`.
- [ ] Write failing tests comparing runtime `name`, `description`, and normalized JSON Schema against checked fixtures for Read, Write, Edit, Grep, Glob, Bash, Agent, TaskCreate/Get/Update/List/Output/Stop.
- [ ] Implement a deterministic fixture extractor that reads only the pinned source root and emits stable sorted JSON; generated fixtures are reviewed and committed, but the extractor never runs at runtime.
- [ ] Run `bun test tests/unit/claude-tool-schemas.test.ts`; expect current lowercase registry failures.

## Task 2: Port shared adapters and exact-name selection

**Create:** `src/tools/claude/shared/{adapter,results,progress}.ts`.
**Modify:** `src/core/tool.ts`, CLI tool selectors, Skill/Agent allowed-tool selection, permission diagnostics.

- [ ] Add failing tests for case-sensitive exact selection and rejection of old lowercase names/aliases.
- [ ] Port shared Tool/result/progress helpers; adapt pinned calls to `AgentTool` without changing public schemas/results.
- [ ] Remove lowercase normalization from `--tools`, allowed/disallowed tools, Skill allowed-tools, and Agent tool filters for migrated names.
- [ ] Add doctor diagnostics mapping legacy configured names to canonical replacements without mutating settings.
- [ ] Run selector/permission/doctor tests and typecheck; keep changes uncommitted.

## Task 3: Port Read, Write, and Edit

**Create:** `src/tools/claude/{read,write,edit}/` and focused tests.

- [ ] Write failing behavior tests from pinned fixtures: Read offsets/limits/EOF/media/binary/truncation; Write create/overwrite; Edit unique/all/empty/newline/diff.
- [ ] Mechanically port pinned modules with `apply_patch`; remove branding/telemetry only.
- [ ] Inject workspace path guards, approved roots, read-before-write snapshot cache, media capability checks, Hooks, and abort signals.
- [ ] Preserve exact result strings while stale-file/symlink checks remain fail-closed.
- [ ] Run new tests plus existing built-in/notebook/workspace-path tests and typecheck.

## Task 4: Port Grep and Glob

**Create:** `src/tools/claude/{grep,glob}/` and focused tests.

- [ ] Write failing tests for pinned fields, output modes, context, glob/type filters, ignore behavior, ordering, head/offset, no-match, and truncation.
- [ ] Port pinned search modules; inject current ripgrep discovery, workspace roots, and symlink confinement.
- [ ] Remove old Provider-facing lowercase search schemas without deleting shared low-level search utilities until registry cutover.
- [ ] Run search, ToolSearch, and workspace tests plus typecheck.

## Task 5: Port Bash and canonical TaskOutput shell resolution

**Create:** `src/tools/claude/bash/`, `src/tools/claude/tasks/task-output-resolver.ts`, focused Bash/PTY tests.

- [ ] Write failing tests for pinned Bash schema/result/progress, foreground/background, timeout, abort, sandbox, output truncation, and process cleanup.
- [ ] Write failing TaskOutput tests for `block`/`timeout`, active shell/Agent tasks, completion, stop, expiry, and restart unknown-task result.
- [ ] Port pinned Bash behavior while injecting ShellSessionManager, command permission AST, sandbox, Hooks, and cleanup registry.
- [ ] Register background shell IDs in a process-local resolver with bounded tombstones; do not persist process identity.
- [ ] Keep PTY write/resize/kill available only through TUI/SDK internal controls.
- [ ] Run shell, sandbox, cleanup, TaskOutput, and PTY tests plus typecheck.

## Task 6: Port Agent and model aliases

**Create:** `src/tools/claude/agent/` and tests.
**Modify:** settings schema/loading and docs.

- [ ] Write failing schema tests proving canonical `Agent`, no `Task` alias, no provider-facing resume, and `model` enum `sonnet|opus|haiku`.
- [ ] Add `agentModelAliases` settings validation; resolve configured provider/model selectors, defaulting missing aliases to the active model.
- [ ] Port foreground/background Agent behavior, isolated history, profile selection, tool restrictions, progress, abort, and final results.
- [ ] Verify background recovery stays internal through TaskManager/TaskOutput.
- [ ] Run Agent/settings/subagent transcript/task recovery tests and typecheck.

## Task 7: Port TaskCreate/Get/Update/List/Output/Stop

**Create:** `src/tools/claude/tasks/` and focused tests.

- [ ] Write failing tests for every pinned schema/result, dependencies, status transitions, owner/runtime IDs, wait/non-blocking output, cancellation, tombstones, and recovery.
- [ ] Port pinned tool modules and map internal persistence to TaskManager; omit tnb-only fields from Provider results.
- [ ] Reject deprecated aliases/fields even if upstream compatibility code contains them.
- [ ] Run task lifecycle/team recovery/Agent/Bash resolver tests and typecheck.

## Task 8: Atomic registry, prompt, permission, and TUI cutover

**Modify:** `src/entrypoints/cli.ts`, tool registry/search, prompts, built-in Skills/Agents, permissions, Hooks, TUI cards, docs, legacy tests.

- [ ] Add failing registry test asserting migrated lowercase names are absent and canonical names are present in one turn—never mixed.
- [ ] Replace old factories with `src/tools/claude` factories; remove migrated implementations from legacy aggregators when no internal consumer remains.
- [ ] Update system/tool prompts, ToolSearch deferred entries, allowed-tool resources, Hook payload expectations, exact-case permissions, TUI renderers, and docs.
- [ ] Add historical JSONL tests: lowercase tool blocks still render/export/compact/rewind unchanged but cannot dispatch.
- [ ] Verify ToolSearch observable: deferred tools absent before activation, appear next turn after search, and `remainingDeferred` decreases exactly.
- [ ] Run Provider adapter fixtures for Anthropic, OpenAI Chat, and Responses plus all registry/permission/TUI/session tests.

## Task 9: Full verification and single runtime commit

- [ ] Run all new schema/behavior tests, existing integration tests, and PTY tests.
- [ ] Run:

```bash
bun x tsc --noEmit
bun test
bun run build
./dist/tnb --version
git diff --check
```

- [ ] Smoke `tnb -p --tools`/`tnb tools` and assert only canonical migrated names.
- [ ] Create one runtime commit: `git add src tests scripts docs && git commit -m "feat: adopt Claude core tool protocol"`.
- [ ] Re-run full verification on committed HEAD; require clean worktree and no child processes.
- [ ] Push `feat/claude-tool-protocol`; do not merge before finishing-branch review.

