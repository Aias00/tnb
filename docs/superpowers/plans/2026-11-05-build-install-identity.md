# Build and install identity

First update the existing local installation, then improve the upgrade contract.
Keep --version's default semantic-version output compatible. Add --version --json
and --verbose with embedded commit/build time/source digest/runtime identity;
source execution explicitly reports source mode. Health reports the owner's
identity; runtime version compares it with the CLI without starting/restarting it.

Install each build into a fresh immutable directory before switching the command
symlink; retain the previous link even for the same package version. Add explicit
local rollback that validates both targets then swaps links, preserving bundles.
Never remove the running bundle or automatically restart jobs during install.
Verify temporary-prefix update/rollback/failure paths, version CLI routing and
runtime health, typecheck, suite and build. No Web changes or new dependencies.
