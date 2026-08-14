---
name: provider-config
description: Configure or troubleshoot tnb model provider settings, auth, model selection, and fallback behavior. Use when working on provider credentials, API base URLs, default models, or compatibility switches.
allowed-tools:
  - read
  - write
  - edit
  - grep
  - glob
  - bash
keywords:
  - provider
  - model
  - config
when-to-use: Use for provider onboarding, auth failures, model routing changes, and compatibility fixes across supported model backends.
argument-hint: <provider-or-config-goal>
---
Work on the requested provider configuration or failure.

Inspect the active config, environment variables, selected provider, model overrides, and error output before changing anything. Keep naming consistent with existing tnb config keys. If multiple providers exist, identify which values are shared, which are provider-specific, and what fallback or default behavior is expected.

End with a concrete verification path: the command or scenario that should succeed once the configuration is correct.

Provider request: $ARGUMENTS
