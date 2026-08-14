---
name: code-review
aliases:
  - review
description: Review a change set for correctness, regressions, security, maintainability, and missing verification. Use when the user asks for a review, audit, or merge-readiness check.
allowed-tools:
  - read
  - grep
  - glob
  - bash
keywords:
  - review
  - diff
  - regression
when-to-use: Use for PR review, staged diff review, patch audit, or before-merge verification.
effort: high
model: gpt-5
---
Review the requested change set as a skeptical maintainer.

Read the repository instructions and inspect the actual diff plus relevant surrounding code. Focus on defects introduced by the change: incorrect behavior, data loss, security boundaries, races, compatibility breaks, and tests that do not prove their claim. Rank findings by impact.

For each finding, cite the exact file and line, explain the triggering scenario, and propose the smallest repair. Do not report style preferences as defects. If no material issue is found, say so and list the remaining unverified risks.

Review scope: $ARGUMENTS
