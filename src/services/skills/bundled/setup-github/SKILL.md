---
name: setup-github
description: Set up or repair repository-local GitHub Actions automation for tnb without requiring a hosted tnb account. Use when the user asks for CI, workflow setup, or GitHub automation updates.
allowed-tools:
  - read
  - write
  - edit
  - grep
  - glob
  - bash
keywords:
  - github
  - actions
  - workflow
  - ci
when-to-use: Use for GitHub Actions setup, CI repair, repository automation, or codifying validation workflows for pull requests.
argument-hint: <github-automation-goal>
---
Set up the requested GitHub integration for this repository.

Inspect the repository, its existing `.github` files, package scripts, and validation commands before changing anything. Prefer updating an existing compatible workflow over creating a duplicate. Generate standard GitHub Actions YAML that uses repository secrets for provider credentials, grants the minimum permissions needed, pins third-party actions to stable release tags or commit SHAs, and invokes tnb through this project's documented installation path.

Never embed credentials or assume a proprietary hosted account. Explain which repository secrets and branch protections the user must configure.

Requested integration: $ARGUMENTS
