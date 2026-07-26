# Agentic OS — Documentation

> Multi-agent orchestration platform — FastAPI backend + vanilla JS SPA dashboard
> Version: 1.3.0 | Last updated: 2026-06-28

## Table of Contents

1. [Quick Start](#quick-start)
2. [Architecture Overview](#architecture-overview)
3. [Dashboard Pages](#dashboard-pages)
4. [Web Terminal](#web-terminal)
5. [Agent System](#agent-system)
6. [API Reference](#api-reference)
7. [Skills](#skills)
8. [Scheduler](#scheduler)
9. [Configuration](#configuration)
10. [Development Guide](#development-guide)

---

## Quick Start

```bash
# Start the server
cd ~/agentic-os
./start.sh

# Or with browser auto-open
./start.sh --open

# Check status
./start.sh --status

# Stop
./start.sh --stop
```

**URLs:**
- Dashboard: `http://127.0.0.1:8080`
- Web Terminal: `http://127.0.0.1:8080/ws/terminal` (WebSocket PTY on the main dashboard port)
- API Base: `http://127.0.0.1:8080/api/`

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    AGENTIC OS DASHBOARD                      │
│                   (FastAPI + Vanilla JS SPA)                 │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────┐  ┌──────────┐  ┌───────────┐  ┌───────────┐  │
│  │ opencode │  │  Hermes   │  │  Gemini   │  │  Custom   │  │
│  │  (Code)  │  │ (Memory)  │  │(Research) │  │  Agents   │  │
│  └────┬─────┘  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘  │
│       │              │              │              │         │
│  ─────┴──────────────┴──────────────┴──────────────┴──────── │
│                        Agent Router                          │
│  ─────────────────────────────────────────────────────────── │
│                     FastAPI Backend                          │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌──────────┐ │
│  │ Brain  │ │Skills  │ │Kanban  │ │Journal │ │ Terminal │ │
│  │ (files)│ │(agents)│ │(JSON)  │ │(files) │ │  (PTY)   │ │
│  └────────┘ └────────┘ └────────┘ └────────┘ └──────────┘ │
└─────────────────────────────────────────────────────────────┘
```

**Tech Stack:**
- Backend: Python 3.11+, FastAPI, Uvicorn
- Frontend: Vanilla JS, Chart.js, xterm.js
- Terminal: WebSocket + PTY (pseudo-terminal)
- Data: JSON files (no database required)
- Agents: CLI binaries (opencode, hermes, gemini, + custom)

---

## Dashboard Pages

| Page | Route | Description |
|------|-------|-------------|
| Dashboard | `#dashboard` | System overview, agent status, recent activity |
| AI Chat | `#chat` | Multi-agent chat terminal |
| Terminal | `#terminal` | Browser-based bash shell (xterm.js) |
| Skills | `#skills` | Browse and execute 17+ skills |
| Memory | `#memory` | Shared brain context files |
| Scheduler | `#scheduler` | Cron job management |
| Audit | `#audit` | System activity trail |
| Kanban | `#kanban` | 6-column task board |
| Goals | `#goals` | Project targets with progress tracking |
| Journal | `#journal` | Daily entries with search |
| Agent Health | `#agent-health` | Agent monitoring + registration |
| Smart Router | `#smart-router` | Task routing intelligence |
| Learning Analytics | `#learning-analytics` | Skill eval scores and trends |
| Session Replay | `#session-replay` | Conversation history playback |
| Cost Analytics | `#cost` | Token usage and spending |
| Plugins | `#plugins` | Plugin registry management |
| Backups | `#backups` | Backup/restore system |
| Prompts | `#prompts` | Reusable prompt templates |
| Standards | `#standards` | Project conventions |
| Settings | `#settings` | System configuration |
| Setup Wizard | `#setup-wizard` | Guided configuration |

---

## Web Terminal

The terminal provides a full bash shell in the browser using xterm.js connected to a PTY via WebSocket.

**How it works:**
1. Server forks a PTY (`pty.fork()`) running `/bin/bash`
2. WebSocket endpoint `/ws/terminal` (on the main dashboard port) relays I/O between browser and PTY
3. xterm.js renders the terminal with 256-color support
4. Resize events propagate via `ioctl(TIOCSWINSZ)`

**Features:**
- Full bash shell with tab completion, history, colors
- Automatic terminal resizing
- 10,000 line scrollback
- Reconnect button if connection drops
- Dark theme matching dashboard

**Security:** The terminal runs as the server process user. Only accessible from localhost by default.

---

## Agent System

### Built-in Agents

| Agent | Binary | Role | Check Method |
|-------|--------|------|--------------|
| OpenCode | `opencode` | Code generation, DevOps, file ops | Binary in PATH |
| Hermes Agent | `hermes` | Memory, scheduling, coordination | Binary in PATH |
| Gemini CLI | `gemini` | Research, analysis, multi-modal | Binary + OAuth file |

### Agent Registry

Agents are defined in `data/agent-registry.json` (custom agents) with built-in defaults in `server.py`.

**Agent configuration schema:**
```json
{
  "name": "agent_id",
  "display_name": "Human Readable Name",
  "description": "What this agent does",
  "binary": "cli-binary-name",
  "type": "cli",
  "run_args": ["binary", "arg1", "{message}"],
  "check_type": "binary",
  "timeout": 60,
  "builtin": false
}
```

**Check types:**
- `binary` — checks if binary exists in PATH
- `oauth_file` — checks if OAuth credential file exists
- `http` — HTTP health check against `health_url`
- `custom` — runs `check_command`, online if exit code 0

**Agent types:**
- `cli` — executes via subprocess with `{message}` substitution
- `http` — POSTs to `api_url` with `{"message": "..."}`
- `mcp` — Model Context Protocol (stub, not yet implemented)

### Adding Custom Agents

Via the dashboard: **Agent Health** → **+ Add Agent**

Or via API:
```bash
curl -X POST http://127.0.0.1:8080/api/agents/register \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-llm",
    "display_name": "My Local LLM",
    "description": "Local LLM via Ollama",
    "binary": "ollama",
    "type": "cli",
    "run_args": ["ollama", "run", "llama3", "{message}"],
    "check_type": "binary",
    "timeout": 120,
    "router_keywords": ["local", "llama", "ollama"]
  }'
```

### Removing Custom Agents

Via the dashboard: **Agent Health** → click **Remove** on any custom agent.

Or via API:
```bash
curl -X DELETE http://127.0.0.1:8080/api/agents/my-llm
```

Built-in agents cannot be removed.

---

## API Reference


### Agents

| Method | Endpoint | Handler |
|--------|----------|---------|
| GET | `/api/agents` | `list_agents` |
| GET | `/api/agents/health` | `get_agent_health` |
| POST | `/api/agents/health/refresh` | `refresh_agent_health` |
| POST | `/api/agents/register` | `register_agent` |
| DELETE | `/api/agents/{agent_name}` | `unregister_agent` |
| GET | `/api/agents/{name}/stats` | `get_agent_stats` |

### Analytics

| Method | Endpoint | Handler |
|--------|----------|---------|
| GET | `/api/analytics/skills` | `get_skill_analytics` |
| GET | `/api/analytics/trends` | `get_trend_analytics` |

### Audit

| Method | Endpoint | Handler |
|--------|----------|---------|
| GET | `/api/audit` | `get_audit` |

### Backup

| Method | Endpoint | Handler |
|--------|----------|---------|
| POST | `/api/backup` | `create_backup` |
| POST | `/api/backup/restore` | `restore_backup` |

### Backups

| Method | Endpoint | Handler |
|--------|----------|---------|
| GET | `/api/backups` | `list_backups` |

### Brain

| Method | Endpoint | Handler |
|--------|----------|---------|
| GET | `/api/brain` | `list_brain` |
| GET | `/api/brain/{file_name}` | `get_brain_file` |
| PUT | `/api/brain/{file_name}` | `update_brain_file` |

### Chat

| Method | Endpoint | Handler |
|--------|----------|---------|
| POST | `/api/chat` | `chat` |
| GET | `/api/chat/history` | `get_chat_history` |

### Cost

| Method | Endpoint | Handler |
|--------|----------|---------|
| GET | `/api/cost` | `get_cost` |
| POST | `/api/cost/record` | `record_cost` |

### Goals

| Method | Endpoint | Handler |
|--------|----------|---------|
| GET | `/api/goals` | `list_goals` |
| POST | `/api/goals` | `create_goal` |
| PUT | `/api/goals/{goal_id}` | `update_goal` |
| DELETE | `/api/goals/{goal_id}` | `delete_goal` |

### Integrations

| Method | Endpoint | Handler |
|--------|----------|---------|
| GET | `/api/integrations` | `list_integrations` |
| POST | `/api/integrations` | `add_integration` |

### Journal

| Method | Endpoint | Handler |
|--------|----------|---------|
| GET | `/api/journal/entries` | `list_journal_entries` |
| GET | `/api/journal/entries/{entry_date}` | `get_journal_entry` |
| PUT | `/api/journal/entries/{entry_date}` | `save_journal_entry` |
| GET | `/api/journal/search` | `search_journal` |

### Kanban

| Method | Endpoint | Handler |
|--------|----------|---------|
| GET | `/api/kanban/board` | `kanban_board` |
| POST | `/api/kanban/dispatch` | `kanban_dispatch` |
| POST | `/api/kanban/links` | `kanban_add_link` |
| DELETE | `/api/kanban/links` | `kanban_remove_link` |
| POST | `/api/kanban/tasks` | `kanban_create_task` |
| GET | `/api/kanban/tasks/{task_id}` | `kanban_get_task` |
| PATCH | `/api/kanban/tasks/{task_id}` | `kanban_update_task` |
| POST | `/api/kanban/tasks/{task_id}/block` | `kanban_block_task` |
| POST | `/api/kanban/tasks/{task_id}/comments` | `kanban_add_comment` |
| POST | `/api/kanban/tasks/{task_id}/complete` | `kanban_complete_task` |
| POST | `/api/kanban/tasks/{task_id}/decompose` | `kanban_decompose_task` |
| POST | `/api/kanban/tasks/{task_id}/specify` | `kanban_specify_task` |
| POST | `/api/kanban/tasks/{task_id}/unblock` | `kanban_unblock_task` |

### Plugins

| Method | Endpoint | Handler |
|--------|----------|---------|
| GET | `/api/plugins` | `list_plugins` |
| POST | `/api/plugins/install` | `install_plugin` |
| DELETE | `/api/plugins/{plugin_name}` | `uninstall_plugin` |

### Prompts

| Method | Endpoint | Handler |
|--------|----------|---------|
| GET | `/api/prompts` | `list_prompts` |

### Root

| Method | Endpoint | Handler |
|--------|----------|---------|
| GET | `/` | `index` |
| GET | `/favicon.ico` | `favicon` |
| GET | `/favicon.svg` | `favicon_svg` |
| GET | `/test` | `test_page` |

### Router

| Method | Endpoint | Handler |
|--------|----------|---------|
| POST | `/api/router/route` | `router_route` |
| POST | `/api/router/suggest` | `router_suggest` |

### Scheduler

| Method | Endpoint | Handler |
|--------|----------|---------|
| GET | `/api/scheduler/jobs` | `list_jobs` |
| POST | `/api/scheduler/jobs` | `create_job` |
| DELETE | `/api/scheduler/jobs/{job_id}` | `delete_job` |

### Sessions

| Method | Endpoint | Handler |
|--------|----------|---------|
| GET | `/api/sessions/list` | `list_sessions` |
| GET | `/api/sessions/{session_id}/replay` | `get_session_replay` |

### Settings

| Method | Endpoint | Handler |
|--------|----------|---------|
| GET | `/api/settings` | `get_settings` |
| PUT | `/api/settings` | `update_settings` |

### Skills

| Method | Endpoint | Handler |
|--------|----------|---------|
| GET | `/api/skills` | `list_skills` |
| GET | `/api/skills/{name}` | `get_skill` |
| GET | `/api/skills/{name}/eval` | `get_skill_eval` |
| POST | `/api/skills/{name}/run` | `run_skill` |

### Standards

| Method | Endpoint | Handler |
|--------|----------|---------|
| GET | `/api/standards` | `list_standards` |
| POST | `/api/standards/discover` | `discover_standards` |

### Status

| Method | Endpoint | Handler |
|--------|----------|---------|
| GET | `/api/status` | `get_status` |

## Skills

Skills are stored in `skills/<name>/` directories with this structure:

```
skills/
  skill-name/
    SKILL.md          # Instructions (YAML frontmatter + markdown)
    learnings.md      # Accumulated run logs
    eval.json         # Evaluation criteria
    score-history.json # Historical scores
    context/          # Ephemeral task inputs
```

**Skill frontmatter (SKILL.md):**
```yaml
---
name: skill-name
description: What this skill does
version: 1.0.0
author: Agentic OS
tags: [category]
---
```

**Built-in skills (17):**
- `brainstorming` — Socratic design refinement
- `code-review` — Automated code review
- `content-draft` — Blog/newsletter writing
- `cost-analytics` — Token usage tracking
- `daily-standup` — Morning briefing
- `devops-audit` — GCP/K8s infrastructure audit
- `goal-planner` — Step-by-step goal planning
- `heartbeat` — System health monitoring
- `meeting-minutes` — Meeting notes processor
- `memory-consolidation` — Weekly memory synthesis
- `project-planner` — Implementation plans
- `research-synthesis` — Web research via Gemini
- `systematic-debug` — 4-phase root cause debugging
- `tdd-cycle` — Red-Green-Refactor TDD
- `backup-skill` — Backup snapshot creation
- `test-plugin` — Plugin test fixture
- `notion-knowledge-capture` — Third-party (via npx skills add)

**Skill execution flow:**
1. `POST /api/skills/:name/run` with optional `input` and `agent` override
2. Router determines agent (auto-detect from keywords or SKILL.md `Primary:` line)
3. Prompt built from SKILL.md + learnings.md + user input
4. Agent executes via CLI
5. Output appended to learnings.md, audit log updated

---

## Scheduler

Two scheduling systems exist:

### 1. Hermes Cron (active)
- Managed via `hermes cron` CLI or Hermes cronjob tool
- Currently running: `brain-guardian-autoupdate` (every 2h)
- Persistent across restarts

### 2. APScheduler (configured, not auto-started)
- Script: `scheduler/scheduler.py`
- Jobs stored in: `scheduler/jobs/*.json`
- Loaded at script start, runs in background thread
- Jobs: heartbeat (5min), daily-standup (weekdays 9am), devops-audit, memory-consolidation

**Job JSON format:**
```json
{
  "id": "unique-id",
  "name": "Job Name",
  "skill": "skill-to-run",
  "cron": "*/5 * * * *",
  "enabled": true
}
```

---

## Configuration

### Server Configuration

**`data/settings.json`:**
```json
{
  "agent_preferences": {
    "opencode": {"enabled": false, "binary": "opencode"},
    "hermes": {"enabled": false, "binary": "hermes"},
    "gemini": {"enabled": true, "binary": "gemini"}
  },
  "dashboard": {"port": 8080, "host": "127.0.0.1", "dark_mode": true},
  "free_tier_limits": {
    "gemini_flash": {"requests_per_day": 1500, "tokens_per_day": 1000000},
    "openrouter_free": {"requests_per_day": 100, "tokens_per_day": 200000}
  }
}
```

### Hermes Model Configuration

**`~/.hermes/config.yaml`:**
```yaml
model:
  default: qwen/qwen3-next-80b-a3b-instruct:free
  provider: openrouter
  base_url: https://openrouter.ai/api/v1
fallback_providers:
  - provider: openrouter
    model: openai/gpt-oss-120b:free
  - provider: openrouter
    model: google/gemma-4-31b-it:free
  - provider: openrouter
    model: nvidia/nemotron-3-super-120b-a12b:free
```

**Free model fallback chain:**
1. `qwen/qwen3-next-80b-a3b-instruct:free` — primary (Qwen 3, 80B)
2. `openai/gpt-oss-120b:free` — OpenAI open source
3. `google/gemma-4-31b-it:free` — Google Gemma
4. `nvidia/nemotron-3-super-120b-a12b:free` — NVIDIA Nemotron

### Environment Variables

**`~/.hermes/.env`:**
- `OPENROUTER_API_KEY` — OpenRouter API key (required for free models)
- `GOOGLE_API_KEY` — Google AI Studio key (optional)
- `DEEPSEEK_API_KEY` — DeepSeek API key (optional)

### Data Directory Structure

```
agentic-os/
├── brain/                  # Persistent memory
│   ├── memory.md           # Cross-session memory
│   ├── business-brain.md   # Project context
│   ├── active-projects.md  # Auto-synced from goals
│   ├── identity.md         # Agent persona
│   ├── constitution.md     # Governance rules
│   ├── recent-decisions.md # Decision log
│   └── journal/            # Daily entries (YYYY-MM-DD.md)
├── data/
│   ├── settings.json       # System settings
│   ├── goals.json          # Project goals
│   ├── chat-history.json   # Chat messages (last 200)
│   ├── cost-history.json   # Token cost tracking
│   ├── kanban/             # Task files (UUID.json)
│   ├── agent-registry.json # Custom agent definitions
│   ├── router-keywords.json # Custom agent routing keywords
│   └── integrations.json   # Connected external apps
├── skills/                 # Skill definitions
├── agents/                 # Agent profiles
│   ├── opencode/AGENTS.md
│   ├── hermes/SOUL.md, MEMORY.md, USER.md
│   └── gemini/GEMINI.md
├── scheduler/jobs/         # Cron job definitions
├── registry/plugins.json   # Plugin registry
├── standards/              # Project standards
├── prompts/                # Reusable prompt templates
├── audit/audit.log         # Append-only audit trail
└── backups/                # tar.gz snapshots
```

---

## Development Guide

### Adding a Dashboard Page

1. Create `dashboard/pages/mypage.js` with `async function renderMypage() { ... }`
2. Add navigation link in `dashboard/index.html`: `<a href="#mypage" class="nav-item" data-page="mypage">`
3. Add title in `dashboard/utils.js` `PAGE_TITLES` object
4. Add any CSS to `dashboard/styles.css`

### Adding an API Endpoint

1. Add route in `server.py` under the appropriate section
2. Add Pydantic model if needed (in Models section)
3. Add frontend API method in `dashboard/api.js`
4. Call from page renderer

### Adding a Skill

```bash
cp -r skills/_template skills/my-skill
# Edit SKILL.md with instructions
# Add to registry/plugins.json if desired
```

### Adding an Agent (Programmatic)

```python
# In server.py, add to BUILTIN_AGENTS dict, or use the API:
curl -X POST http://127.0.0.1:8080/api/agents/register \
  -H "Content-Type: application/json" \
  -d '{"name":"my-agent","binary":"my-binary","type":"cli"}'
```

### Key Files

| File | Purpose |
|------|---------|
| `server.py` | FastAPI backend (1780+ lines, 58+ endpoints) |
| `dashboard/index.html` | SPA shell with sidebar nav |
| `dashboard/app.js` | Page router and agent status polling |
| `dashboard/api.js` | API client wrapper |
| `dashboard/utils.js` | Shared utilities (toasts, formatting, PAGE_TITLES) |
| `dashboard/styles.css` | All styling (dark/light theme) |
| `dashboard/pages/*.js` | Individual page renderers |
| `start.sh` | Start/stop/status script |
| `data/agent-registry.json` | Custom agent persistence |
| `brain/` | All persistent memory |

### Server Lifecycle

```bash
./start.sh          # Start (dashboard port from data/settings.json, default 8080)
./start.sh --open   # Start + open browser
./start.sh --stop   # Stop
./start.sh --status # Check if running
```

Logs: `tail -f /tmp/agentic-os.log`

PID file: `.agentic-os.pid`

---

## Changelog

### v1.3.0 (2026-06-28)
- **Web Terminal**: Added browser-based bash shell (xterm.js + WebSocket PTY at `/ws/terminal` on the main port)
- **Agent Registry**: Dynamic agent registration system (add/remove custom agents via dashboard)
- **Agent Health Page**: Complete rewrite with card view, registry table, add agent form
- **Hermes Free Models**: Switched to Qwen 3 80B free + 3 fallback chain (OpenAI, Google, NVIDIA)
- **Dynamic Agent Discovery**: All endpoints now use registry instead of hardcoded agent list
- **Router Extensibility**: Custom agents can register keywords for smart routing
- **API**: New `/api/agents`, `/api/agents/register`, `/api/agents/:name` (DELETE)

### v1.2.0 (2026-06-26)
- Agent profiles for opencode, hermes, gemini
- APScheduler integration (scheduler.py)
- Plugin install from git repo or template

### v1.1.0 (2026-06-05)
- Kanban board (13 endpoints)
- Goals with auto-sync to brain
- Journal with search
- Agent health monitoring
- Smart router with keyword scoring
- Learning analytics
- Session replay

### v1.0.0 (2026-05-17)
- Initial release: FastAPI backend, SPA dashboard, 3 agents, 16 skills
