# Scheduled tasks and monitors

The interactive TUI owns one project scheduler. It starts with tnb and
queues fired prompts until the current turn and any modal dialog are idle.
Scheduled prompts then enter the same Agent loop as typed prompts, including
permissions, Hooks, session persistence, tools, and usage accounting.

The scheduler exposes five tools:

- `cron_create` creates a recurring or one-shot prompt from a standard
  five-field local-time cron expression.
- `cron_list` lists active jobs.
- `cron_delete` removes a job by ID.
- `schedule_wakeup` sets or replaces one relative-delay timer for the current
  session.
- `monitor` runs a background command and converts each non-empty stdout line
  into an Agent wakeup. Its task ID works with `bash_output` and `bash_kill`.

Cron jobs are session-only by default. `durable: true` stores them in
`.tnb/scheduled_tasks.json`, so they are loaded when tnb is next
started in that project. One-shot jobs delete themselves after firing.
Recurring jobs expire after seven days, matching the bounded-session behavior
used by the reference implementation. A project can hold at most 50 jobs.

Durable scheduling is a local side effect and Monitor executes a command, so
the normal permission engine applies. Plan mode denies both; explicit YOLO mode
allows them only when its project security gates pass.

The scheduler is intentionally interactive-runtime scoped. A standalone print
process does not advertise scheduling tools because it exits after the answer
and cannot deliver session wakeups.
