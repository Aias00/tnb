# Security Review Plugin

This sample plugin demonstrates three contribution surfaces that already exist in tnb:

- A builtin tool contribution declared in the manifest.
- A runtime hook contribution loaded from `hooks.json`.
- A reusable plugin-contributed skill under `skills/security-review/`.

The plugin is intentionally manual-activation so it does not alter edit workflows until the user enables it.
