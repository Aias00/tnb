---
name: security-review
description: Audit code or configuration for privilege boundaries, unsafe execution, data exposure, and missing hardening checks. Use when the user asks for a security review, permission audit, or high-risk change assessment.
allowed-tools:
  - read
  - grep
  - glob
  - bash
keywords:
  - security
  - audit
  - permissions
when-to-use: Use for security-sensitive diffs, sandbox or permission changes, secret handling, remote execution, and trust-boundary reviews.
effort: high
model: gpt-5
argument-hint: <security-scope>
---
Review the requested scope from an adversarial security perspective.

Focus on trust boundaries, capability expansion, shell execution, filesystem writes, network access, secret exposure, sandbox bypass, prompt or tool injection, and unsafe defaults. Prefer concrete exploit paths or abuse scenarios over abstract concern. If an issue depends on a threat model assumption, state the assumption explicitly.

When no material weakness is found, list the residual risks and unverified areas instead of claiming absolute safety.

Security scope: $ARGUMENTS
