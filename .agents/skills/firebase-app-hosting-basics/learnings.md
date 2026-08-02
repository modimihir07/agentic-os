
## 2026-08-02 (Run 7e791f26)
- Agent: opencode
- Input: (none)
- Output: Error: opencode-ai's postinstall script was not run.

This occurs when using --ignore-scripts during installation, or when using a
package manager like pnpm that does not run postinstall scripts by default.

To fix this, run the postinstall script manually:
  cd node_modules/opencode-ai && node postinstall.mjs

Or reinstall opencode-ai without the --ignore-scripts flag.

## 2026-08-02 16:36:42 · opencode · done
- Task: firebase-app-hosting-basics
- Outcome: Error: opencode-ai's postinstall script was not run.  This occurs when using --ignore-scripts during installation, or when using a package manager like pnpm that does not run postinstall scripts by default.  To fix this, run the postinstall script manually:   cd node_modules/open

