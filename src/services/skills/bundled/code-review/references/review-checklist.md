# Review Checklist

- Reconstruct the behavioral contract before judging the diff.
- Prefer bugs and regressions over style comments.
- Check compatibility edges: CLI flags, config keys, wire formats, saved state, and environment assumptions.
- Verify tests prove the intended branch, not only the happy path.
- Call out missing verification when claims depend on typecheck, build, lint, or targeted tests that did not run.
