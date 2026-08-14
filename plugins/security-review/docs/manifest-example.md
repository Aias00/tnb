# Manifest Example

```json
{
  "name": "security-review",
  "manifestVersion": 2,
  "apiVersion": "tnb.plugin/v1",
  "lifecycle": {
    "activation": "manual",
    "reload": "runtime"
  },
  "documentation": {
    "overview": "What the plugin contributes.",
    "lifecycle": "How activation and reload behave.",
    "resources": ["./docs/overview.md"]
  },
  "contributes": {
    "hooks": "./hooks.json",
    "tools": ["builtin:security_scan"]
  }
}
```

`documentation` is descriptive metadata only. It should explain contribution intent, lifecycle behavior, and where a maintainer can read more.
