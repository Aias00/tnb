---
name: subtask
description: Send a bounded task to a separate agent and return its result to the current conversation. Use when a task can be isolated cleanly.
keywords:
  - subtask
  - delegate
  - agent
when-to-use: Use for bounded delegation where one child can finish independently and report back with evidence.
context: fork
argument-hint: <bounded-subtask>
---
Complete this bounded subtask independently and return a concise, evidence-backed result to the parent agent.

Use the repository context and tools needed for the task. Do not broaden scope, undo unrelated work, or claim success without checking the relevant evidence. Report changed files, validation performed, and any blocker that requires the parent agent.

Subtask: $ARGUMENTS
