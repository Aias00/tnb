# Goals and workflows

## Persistent goals

A goal is stored per session under:

```text
~/.tnb/goals/<session-id>.json
```

The model receives three tools:

- `goal_create` creates one active objective with an optional turn budget;
- `goal_get` reads objective, status, elapsed time, and turn usage;
- `goal_update` marks the goal complete or resumes a paused goal that still has budget.

The default budget is 20 completed interaction turns. While a goal remains
active, tnb adds a goal reminder to each model request and automatically
continues after an ordinary terminal response. Reaching the budget pauses the
goal; it does not mark incomplete work as complete. The user can grant another
20 turns explicitly with `/goal resume`.

Interactive commands are:

```text
/goal set <objective> [--turns N]
/goal status
/goal pause
/goal resume
/goal clear
```

Goal continuation uses the active permission mode. It does not silently enable
YOLO; start the session with `--yolo` or switch with `/permissions yolo` when
unattended workspace mutations are intended.

## Multi-agent workflows

The `workflow` tool is a thin dependency-graph orchestrator over the existing
`agent` runtime. It is intended only for an explicit workflow request or for a
skill/command that calls for multi-agent orchestration. Each step declares a
stable ID, prompt, progress description, optional Agent profile, and optional
dependencies:

```json
{
  "steps": [
    {
      "id": "inspect",
      "description": "inspect provider code",
      "prompt": "Inspect provider error handling and report concrete gaps.",
      "agent_type": "explore"
    },
    {
      "id": "implement",
      "description": "implement fixes",
      "prompt": "Implement and verify the confirmed provider fixes.",
      "depends_on": ["inspect"]
    }
  ]
}
```

Ready steps run concurrently. The default concurrency follows the referenced
runtime policy: `min(16, max(2, cpuCount - 2))`; `max_concurrency` can override
it. Completed dependency outputs are attached to a downstream step. A failed
step is reported and its dependents are skipped, while independent branches can
still finish. Every subagent keeps the existing model, transcript, hook, tool,
and permission behavior.

tnb deliberately uses a declarative graph instead of executing arbitrary
workflow JavaScript. This preserves the useful orchestration behavior without
adding a second JavaScript security boundary before a dedicated script sandbox
exists.
