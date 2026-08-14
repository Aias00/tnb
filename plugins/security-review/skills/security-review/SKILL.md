---
name: security-review
description: Review a risky change for trust-boundary expansion, unsafe execution, secret exposure, and missing hardening. Use when editing permissions, shell execution, sandboxing, secrets, or external integrations.
allowed-tools:
  - read
  - grep
  - glob
  - bash
keywords:
  - security
  - permissions
  - sandbox
when-to-use: Use after modifying shell execution, filesystem permissions, sandbox policy, hooks, or networked integrations.
---
Review the requested scope like an adversarial maintainer.

Trace untrusted input, capability expansion, and post-change execution paths. Check whether new behavior can escape workspace boundaries, leak data, weaken approvals, or create an injection path. When an issue is found, cite the exact file and line, explain the abuse path, and recommend the smallest containment fix.

Security scope: $ARGUMENTS
