# Reference capability adoption: core, host, Coding and TUI

Reference: local /Users/aias/Work/claude-code. Adopt behavior/contracts, not its
product runtime or source files. Preserve existing uncommitted installation and
command-output work. Web is explicitly deferred.

## Ownership

| Capability | Mechanism owner | UI / domain owner |
| --- | --- | --- |
| Retry feedback | Provider retry events; execution host forwards | TUI countdown; durable Runtime retains its own scheduler retries |
| Restore preview | Checkpoint + session services, workspace ownership | TUI preview/range/explicit confirmation; Coding retains filesystem rules |
| Context breakdown | Shared context report service using actual request data | TUI categories; Coding contributes its normal prompts/tools |
| Keybinding diagnostics | Terminal input configuration | TUI warnings; no Coding/Core dependency |
| File-index cache/ranking | Workspace index service | TUI completions; later increment |
| Approval diff | Approval data + existing diff provider | TUI rendering; later increment |
| Idle notification | Host notification service | TUI interaction/focus; later increment |
| IDE selection references | IDE/attachment services | TUI reference editor; later increment |

## This implementation increment

1. Add sanitized retry progress and retry-start events to the provider-neutral
   event contract, only on actual transport retries. Events are observational:
   they must not disable fallback, duplicate model output, add usage, or enable
   hidden retries in durable workers. Cancel remains effective during backoff.
2. Add a read-only checkpoint preview service and interactive restore selection.
   Plain /rollback <id> previews first. Explicit confirmation is bound to the
   previewed workspace state; scope is files/conversation/both. No restoration
   happens while browsing. Acquire the existing workspace/session owners for
   mutations. Preflight conversation validity before file changes and report
   partial failures explicitly. Existing direct CLI rollback --yes stays intact.
3. Report context from the actual outgoing request when available: system,
   tool definitions, conversation text, tool results, media, summaries and output
   reserve. Estimates are labelled; Provider-reported input is separate. Reports
   without a captured request do not invent missing system/tool data.
4. Warn about duplicate/reserved shortcut bindings without changing the loaded
   map or adding dependencies. Preserve fixed cancellation/exit keys.

## Acceptance

- Targeted tests for retry/fallback/cancellation, preview-no-effects/stale preview,
  restore scopes, context categorization and keyboard diagnostics.
- TUI regression tests confirm no accidental submit/restore on menu navigation.
- Typecheck, full tests, build and local install; no automatic restart of jobs.
- No new provider credentials, permission expansion, persisted schema migration
  or Web modifications. Store plan and implementation evidence in Git Markdown.

## Subsequent increments

File indexing, richer approval diff, idle notifications and IDE references are
delivered in the follow-up below. They reuse existing services instead of adding
another executor or plugin framework. All eight adoption areas now have bounded
implementations; platform and editor prerequisites remain explicit.

## Follow-up implementation: remaining four capabilities

- Workspace file index owns bounded per-root cached scans (2-second TTL,
  coalesced scans, 8 cached roots, 10,000 files/1 MiB scan output/3-second timeout),
  filename/subsequence ranking and recent-choice preference. `/reload` invalidates
  the current root. It stores paths only and never grants file access.
- Approval previews reuse `buildLineDiff`; edit lines retain context and color
  additions/removals, replace-all is explicit. Write previews show proposed text,
  explicitly not a fabricated existing-file diff. Paging/approval controls remain.
- Host idle notifications deduplicate generic approval/question/end/background
  messages. TUI supplies interaction/focus; terminal OSC/BEL is the only output,
  no OS processes or external messages. `ui.notifications: false` disables it.
- `/ide attach [descriptor]` explicitly snapshots a published selection to an
  editable structured text reference. Only an authenticated bridge matching the
  workspace is accepted; files/ranges/size/symlinks are checked. New connections
  share the host's editor context, not authentication state. No automatic sending
  or editor polling is introduced. Original text/image paste data remains intact.

Verify cache expiry/invalidation/concurrent cancellation/ranking, full approval
paging, idle dedupe/focus/cancellation, cross-connection IDE access, no workspace
escapes and actual TUI draft preservation; then full suite/build/local install.
Web and running background tasks remain outside this increment.
