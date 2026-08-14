# Auto memory

Auto memory is enabled by default. Each workspace receives a persistent memory
directory below `~/.tnb/projects/<project-id>/memory/`. `MEMORY.md` is the
bounded index loaded into every model turn; topic files hold the details.

Use these interactive commands:

```text
/memory
/memory on
/memory off
```

Disabling memory preserves existing files. Set `autoMemoryEnabled` in settings
for a persistent choice. A custom user-level path is supported with
`autoMemoryDirectory`; project settings cannot set that path, preventing a
repository from silently turning an unrelated sensitive directory into an
approved read/write root.

The index is limited to 200 lines and 25 KB. The Agent is instructed to remember
stable preferences, corrections, non-derivable project decisions, and useful
external references, while excluding secrets, transient task state, and facts
that can be recovered from the repository. Standard `read`, `write`, and `edit`
tools may access the exact memory directory while remaining confined elsewhere.

Set `TNB_DISABLE_AUTO_MEMORY=1` for a process-level hard disable.

## Session Memory

Session Memory is an automatic conversation snapshot, not a user-editable
knowledge base. It is stored per session under the project session directory:

```text
~/.tnb/projects/<project-id>/session-memory/<session-id>.json
```

The first snapshot is created after roughly 60,000 conversation tokens and is
refreshed after another 5,000 tokens or five tool calls. It is bounded to about
12,000 rough tokens and included in later system prompts as older context is
microcompacted, fully summarized, or context-collapsed. Newer conversation
messages remain authoritative when they conflict with the snapshot.
