
## 2026-07-25 (Run 59fd6229)
- Agent: opencode
- Input: (none)
- Output: Error: opencode-ai's postinstall script was not run.

This occurs when using --ignore-scripts during installation, or when using a
package manager like pnpm that does not run postinstall scripts by default.

To fix this, run the postinstall script manually:
  cd node_modules/opencode-ai && node postinstall.mjs

Or reinstall opencode-ai without the --ignore-scripts flag.
