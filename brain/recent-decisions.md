# Recent Decisions

## 2026-06-28 — Agentic OS v0.3.0 working-tree changes (committed 2026-07-25 as 94ce010)
- Goal: make Agentic OS a complete local dev environment — build apps, programs, agents through the dashboard.
- Added dynamic agent execution engine (cli/http/mcp) so new agents can be registered at runtime via `/api/agents/register` (persists to `data/agent-registry.json`).
- Live agent registry + health: `/api/agents`, `check_agent()` dynamic per-registry config.
- Integrations API (`/api/integrations` add/list) — e.g. webhook targets.
- Agent-time tracking: `/api/agent-time` (+ recompute + skin), graphify-based session-gap estimate.
- Agent stats + skill scoring persisted (`data/agent-stats.json`, `compute_skill_score`).
- Kanban task delete + plugin uninstall endpoints wired.
- Dashboard modernization: agent-health, plugins marketplace, smart-router, styles; added agent-time monitor page + terminal page.
- Scheduler rewrite; `start.sh` / `start-agentic-os.sh` improvements.
- New skills added: firebase-* (10), notion-knowledge-capture, xcode-project-setup, audit-test-plugin, test-plugin.
- `.gitignore` extended to exclude runtime artifacts (pid, graphify-out, logs).
- VERIFIED live: server on :8081, all new endpoints return 200; register/unregister persists correctly.
- CAVEAT (FIXED 2026-07-25): agent `check_command` previously ran via `subprocess.run(..., shell=True)` — command-injection risk. Now uses `shlex.split` + `shell=False`. Verified: malicious `"; touch /tmp/PWNED"` no longer executes.
- CAVEAT (FIXED 2026-07-25): running two `server.py` on same port caused phantom "register doesn't persist" + 8082 bind crash. Added startup port guard (exits cleanly with message) + terminal websocket now binds gracefully instead of crashing. Verified: 2nd instance bails with exit 1.

## 2026-07-25 — Security & ops hardening (commit pending)
- Fixed command-injection in `check_agent()` custom check_type: `shell=True` → `shlex.split` + `shell=False`.
- Added double-launch guard in `main`: probe API port (8081) before `uvicorn.run`; exit 1 with clear message if already bound.
- Made `start_terminal_server` (8082) fail gracefully — pre-bind probe + try/except, logs warning instead of crashing the process.

## Archived (older than 30 days)

### 2026-05-17
- Created Agentic OS project structure
- 3-agent architecture: opencode (code) + Hermes (memory/channels) + Gemini CLI (research)
- Web dashboard only (no CLI dashboard) — FastAPI + vanilla JS SPA
- Maximum breadth skill set (all-in: DevOps, content, research, coding, productivity)
- Git auto-versioning enabled for brain/ and skills/
