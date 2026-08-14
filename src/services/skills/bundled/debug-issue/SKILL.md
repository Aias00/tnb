---
name: debug-issue
description: Investigate a bug by reproducing it, narrowing the fault, proving the root cause, and validating the fix. Use when the user reports a crash, regression, flaky test, or unexpected behavior.
allowed-tools:
  - read
  - write
  - edit
  - grep
  - glob
  - bash
keywords:
  - debug
  - regression
  - flaky
when-to-use: Use for failures that require reproduction, root-cause analysis, or a verified fix.
effort: high
argument-hint: <symptom-or-failure>
---
Debug the reported issue methodically.

1. Reproduce the failure with the smallest reliable command, test, or scenario.
2. Narrow the fault domain before editing. Check recent changes, config, inputs, and environment assumptions.
3. Add only minimal instrumentation that helps prove or disprove a concrete hypothesis.
4. Fix the verified root cause instead of patching the symptom.
5. Re-run the failing scenario plus nearby regression checks and report the evidence.

If reproduction is impossible, explain what evidence is missing and which next-best proof you used.

Issue: $ARGUMENTS
