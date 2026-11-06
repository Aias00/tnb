# Shared execution host consolidation

## Goal and evidence

CLI/TUI and durable workers already use `core/agent-loop.ts` and
`core/tool-runtime.ts`. Do not introduce a second session or task engine. The
first migration shares host-side model execution and workspace-tool assembly,
keeping the headless Core free of CLI, React, filesystem-tool and Coding imports.

## Implementation boundary

1. Characterize existing CLI, Coding worker, shared-budget and runtime behavior
   before editing production code.
2. Add a host model-execution service owning lazy transport construction,
   fallback/reasoning/fast configuration, billing-route resolution and optional
   caller-owned invocation-budget decoration. CLI main/child invocations and
   durable Coding workers consume it.
3. Share session selection/fork/bootstrap preview between print and TUI paths,
   leaving execution-lock acquisition before restored-state reads in the caller.
4. Add a workspace-tool provider shared by CLI and Coding workers. Preserve tool
   ordering, media capabilities, live workspace roots, separate read receipts,
   and whether mutation tools are exposed.
5. Keep Coding-specific sandbox restrictions, capability admission, workspace
   policy, acceptance checks and durable identity in the Coding adapter. Preserve
   durable zero transport retries: the persistent scheduler owns those retries.
6. Add focused regression tests and verify CLI/runtime integration. Update the
   architecture guide to document the remaining boundary instead of claiming
   that the entire CLI has become a plugin.

## Acceptance

- Both paths instantiate shared model and workspace-tool services.
- Interactive fallback and cost accounting remain intact; injected transports
  remain usable without credentials, and construction stays lazy for CLI calls.
- Durable workers keep maxRetries=0 and their existing billing route/identity.
- Read-before-write receipts never leak between hosts; read-only workers expose
  no mutation tools. Search roots and media permissions do not expand.
- No dependency, persisted schema, RPC, or plugin-generation migration.
- Typecheck, targeted tests, then full suite/build pass (or gaps are explicit).

## Later migrations

Move remaining entrypoint session/bootstrap and slash-command orchestration
behind explicit services only after this shared-host seam is established. Keep
interactive sessions and durable Runs distinct in lifecycle while reusing the
same kernel. A TUI plugin is a later packaging change, not a prerequisite.
