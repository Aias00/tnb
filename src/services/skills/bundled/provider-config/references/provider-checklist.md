# Provider Configuration Checklist

- Verify which config layer wins: defaults, file config, environment, or CLI override.
- Distinguish auth failures from model-name mismatches and unsupported feature flags.
- Preserve repo-local naming; avoid provider-specific aliases unless the code already uses them.
- Record any secrets or endpoints the user must supply separately.
