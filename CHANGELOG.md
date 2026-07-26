# Changelog

All notable changes to Agentic OS will be documented in this file.

## [v1.3.0] - 2026-06-28

### Added
- **Web Terminal** — Full bash shell in browser via xterm.js + WebSocket PTY (served on the main dashboard port; endpoint `/ws/terminal`)
  - 256-color support, terminal resizing, 10k line scrollback
  - Reconnect and clear buttons
  - Dark theme matching dashboard
- **Dynamic Agent Registry** — Register/remove custom agents via dashboard or API
  - `GET /api/agents` — list all agents
  - `POST /api/agents/register` — add custom agent (CLI, HTTP, or MCP type)
  - `DELETE /api/agents/:name` — remove custom agent
  - Agent config stored in `data/agent-registry.json`
  - Custom agents auto-appear in status, health, router
- **Agent Health Dashboard** — Complete rewrite
  - Card grid view with status indicators
  - Registry table with type/source/actions
  - "Add Agent" modal with form (name, binary, run args, health check, router keywords)
  - Remove button for custom agents
- **Smart Router Extensibility** — Custom agents can register routing keywords via `data/router-keywords.json`

### Changed
- **Hermes Model** — Switched from `openrouter/owl-alpha` to free model chain:
  1. `qwen/qwen3-next-80b-a3b-instruct:free` (primary)
  2. `openai/gpt-oss-120b:free` (fallback 1)
  3. `google/gemma-4-31b-it:free` (fallback 2)
  4. `nvidia/nemotron-3-super-120b-a12b:free` (fallback 3)
- **Agent Discovery** — All endpoints now use dynamic registry instead of hardcoded `["opencode", "hermes", "gemini"]`
  - `/api/status`, `/api/agents/health`, `/api/chat`, `/api/router/route`, `/api/agents/:name/stats`
- **Base URL** — Hermes now points to `https://openrouter.ai/api/v1` directly

### Fixed
- Audit log malformed timestamp entry removed
- Test artifacts cleaned from kanban, goals, cost history, brain

## [v1.2.0] - 2026-06-26

### Added
- Agent profiles (`agents/{opencode,hermes,gemini}/`)
- APScheduler integration (`scheduler/scheduler.py`)
- Plugin install from git repo or template (`POST /api/plugins/install`)
- Connected apps / integrations system

## [v1.1.0] - 2026-06-05

### Added
- Kanban board (6-column, 13 API endpoints)
- Goals system with auto-sync to `brain/active-projects.md`
- Journal with daily entries and full-text search
- Agent health monitoring (3 endpoints)
- Smart Router with keyword-based task routing
- Learning Analytics (skill eval scores, trends)
- Session Replay (browse opencode logs)
- Cost Analytics (token usage tracking)
- Backup/restore system (tar.gz snapshots)

## [v1.0.0] - 2026-05-17

### Added
- Initial release
- FastAPI backend (58+ endpoints)
- Vanilla JS SPA dashboard (21 pages)
- 3 built-in agents: OpenCode, Hermes, Gemini CLI
- 16 skills with eval scoring
- Brain/memory system (markdown files)
- Scheduler (APScheduler + Hermes cron)
- Plugin registry
- Standards system
- Prompt templates
