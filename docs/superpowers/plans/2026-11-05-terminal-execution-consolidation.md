# Terminal execution consolidation, phase two

Web remains outside this change. Preserve the pending phase-one host/session
refactor and session-list style changes.

1. Baseline CLI/plugin/usage tests before production edits.
2. Share plugin discovery/policy and Agent/Skill/command roots in an execution
   resource service. Preserve precedence, content trust, blocked fingerprints,
   discovery-only behavior and per-invocation policy revalidation.
3. Explain the scope of tnb-coding in CLI/TUI management: durable Coding adapter,
   not the ordinary conversation file tools; owner restart applies the change.
4. Feed terminal usage from the invocation ledger, including the usage crossing
   a ceiling and delegated/maintenance requests. Clearly label invocation limit
   versus session totals. Do not change budgets, permissions or durable policy.
5. Test trust/reload behavior and budget-stop display before full typecheck,
   suite, build and local install. Do not modify Web or persistent schemas.
