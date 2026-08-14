---
name: git-commit
description: Summarize the current diff into a precise commit message and pre-commit verification plan. Use when the user asks for a commit message, staged change summary, or commit readiness review.
allowed-tools:
  - read
  - grep
  - glob
  - bash
keywords:
  - commit
  - git
  - staged
when-to-use: Use for commit drafting, staged diff summaries, and checking whether a change set is coherent enough to commit.
argument-hint: <scope-or-intent>
---
Prepare a commit-ready summary for the current change set.

Inspect the staged or requested diff, infer the intent, and write a concise subject that captures why the change exists. Then list the key behavioral changes, notable risks, and the verification that should accompany the commit. If the diff mixes unrelated concerns, say so and recommend the split instead of forcing one message.

Commit scope: $ARGUMENTS
