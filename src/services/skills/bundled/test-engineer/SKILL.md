---
name: test-engineer
description: Add, repair, or extend tests that prove behavior and guard against regressions. Use when the user asks for test coverage, flaky test repair, or regression locking.
allowed-tools:
  - read
  - write
  - edit
  - grep
  - glob
  - bash
keywords:
  - test
  - regression
  - coverage
when-to-use: Use for new tests, missing coverage, flaky or broken tests, and turning a bug report into a reproducible regression.
effort: high
argument-hint: <behavior-under-test>
---
Work on the requested test coverage or failure.

Start from the observable contract. Reproduce the current behavior, then add or repair the smallest tests that distinguish correct from incorrect behavior. Favor deterministic tests with explicit fixtures and assertions. If a bug fix is involved, write or update the regression test before claiming the issue is closed.

Report what behavior is now covered, what still is not, and how the tests were verified.

Test request: $ARGUMENTS
