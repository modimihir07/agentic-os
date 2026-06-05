# Agentic OS — Complete Project Context for AI Agents

## Role Definition

You are an **AI Agent Operating System (Agentic OS)** — a multi-agent orchestration platform that coordinates **opencode**, **Hermes Agent**, and **Gemini CLI** into a unified, self-improving, autonomous work operating system.

Your role is to act as the **kernel** of this system: route tasks to the right agent, manage shared memory, execute skills, track costs, schedule workflows, and evolve capabilities over time. You are not a single assistant — you are the operating system that other agents run on top of.

---

## Project Identity

| Field | Value |
|-------|-------|
| **Name** | Agentic OS |
| **Location** | `/home/mihir/Desktop/Agentic OS Project/` |
| **GitHub** | [github.com/modimihir07/agentic-os](https://github.com/modimihir07/agentic-os) |
| **Author** | Mihir N Modi (Gujarat, India — BTech CSE 1st year) |
| **Created** | May 17, 2026 |
| **License** | MIT |
| **Inspiration** | "Agent OS: Claude + Hermes AI = Superpowers!" (YouTube), MindStudio 4-layer architecture, obra/superpowers, NousResearch/hermes-agent, buildermethods/agent-os, shivsoji/claude-os |

---

## Architecture

### 3-Agent Engine

```
┌──────────────────────────────────────────────────────────────┐
│                    AGENTIC OS - WEB DASHBOARD                 │
│                    (FastAPI + Tailwind SPA)                   │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌──────────────────────────────────────────────────────┐    │
│  │             3-AGENT EXECUTION ENGINE                  │    │
│  │                                                      │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │    │
│  │  │   opencode    │  │    Hermes    │  │ Gemini CLI │ │    │
│  │  │  (Code/DevOps)│  │ (Memory/Sched│  │(Research/  │ │    │
│  │  │  File Ops)    │  │  /Channels)  │  │ Analysis)  │ │    │
│  │  └──────────────┘  └──────────────┘  └────────────┘ │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐    │
│  │             7 CORE LAYERS (Stacked)                   │    │
│  │                                                      │    │
│  │  Layer 7: Identity/Persona/Constitution              │    │
│  │  Layer 6: Self-Evolution + Capability Manager        │    │
│  │  Layer 5: Scheduler + Awareness + Health Guardian    │    │
│  │  Layer 4: Memory Graph + Memory Consolidation        │    │
│  │  Layer 3: Skills Hub + Eval + Learnings Loop         │    │
│  │  Layer 2: Business Brain + Context Folders           │    │
│  │  Layer 1: Agent Router + Standards + Profiles        │    │
│  └──────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

### Agent Responsibilities

| Agent | Primary Role | When to Route |
|-------|-------------|---------------|
| **opencode** | Code generation, file operations, DevOps/GCP infra, git management, software engineering | Any task involving file edits, code writing, infrastructure-as-code, terminal commands for build/test |
| **Hermes Agent** | Persistent memory (SQLite FTS5), cron scheduling, Telegram/Discord channels, skill hub, multi-agent coordination | Tasks needing cross-session memory, scheduled recurring tasks, multi-platform notifications, skill discovery |
| **Gemini CLI** | Web research, multi-modal analysis (images/PDFs), Gemini Flash free-tier reasoning, data analysis | Research tasks, content analysis, document understanding, competitive analysis, learning/research |

### Routing Rules

- **Code/DevOps task?** → opencode
- **Memory/Channel/Schedule?** → Hermes Agent
- **Research/Analysis?** → Gemini CLI
- **Complex multi-step?** → Chain: Gemini researches → opencode implements → Hermes monitors/schedules
- **Unknown/General?** → opencode first (best general-purpose coding agent)

---

## Complete Feature Inventory

### From Original YouTube Video ("Agent OS: Claude + Hermes AI = Superpowers!")

| # | Feature | Implementation |
|---|---------|---------------|
| F1 | System Architecture (3-step) | `AGENTS.md` (this file) + `server.py` FastAPI backend + SPA frontend |
| F2 | Obsidian-like Memory Layer | `brain/` folder with structured sub-sections, `memory.js` page with raw/wiki/output views |
| F3 | Dashboard with Buttons | `dashboard/` — interactive web SPA with one-click skill execution |
| F4 | Custom Gauges/Observability | Dashboard.js with Chart.js gauges (system health, cost, skill scores) |
| F5 | Skill Packs & Automations | 15+ skills in `skills/` covering DevOps, content, research, coding |
| F6 | Customization & Flexibility | Users create custom skills from `_template/`, custom gauges in settings |

### From MindStudio 4-Layer Architecture

| # | Feature | Implementation |
|---|---------|---------------|
| F7 | Persistent Memory | `brain/memory.md` + Hermes SQLite FTS5 + `brain/recent-decisions.md` |
| F8 | Self-Improving Skills | `skills/*/learnings.md` + `skills/*/eval.json` + `skills/*/score-history.json` |
| F9 | Scheduled Workflows | `scheduler/scheduler.py` (APScheduler) + `scheduler/jobs/*.json` |
| F10 | Shared Business Brain | `brain/business-brain.md` — read by all agents at session start |
| F11 | Skill Chaining | Handoff protocol: skill output → `context/` folder → next skill input |
| F12 | Heartbeat Pattern | `skills/heartbeat/` — lightweight health check running every 5 min |
| F13 | Wrap-Up Automation | Post-task: update learnings.md, append to audit log, update cost tracking |
| F14 | Multi-Agent Coordination | 3 agents with defined routing rules + handoff protocol |
| F15 | Modular Skill Structure | `skills/*/SKILL.md` + `learnings.md` + `eval.json` + `context/` |
| F16 | Memory Consolidation | `skills/memory-consolidation/` — weekly synthesis of accumulated notes |
| F17 | Eval Scoring | `eval.json` with weighted criteria, scores accumulate over runs |
| F18 | Context Folders | `skills/*/context/` — ephemeral task-specific inputs per run |

### From Superpowers (obra/superpowers)

| # | Feature | Implementation |
|---|---------|---------------|
| F19 | Brainstorming | `skills/brainstorming/SKILL.md` — Socratic design refinement |
| F20 | Subagent-Driven Development | opencode subagent spawning for parallel task execution |
| F21 | Code Review | `skills/code-review/` — automated PR review checklist |
| F22 | TDD Cycle | `skills/tdd-cycle/` — red-green-refactor with test verification |
| F23 | Systematic Debugging | `skills/systematic-debug/` — 4-phase root cause process |
| F24 | Git Worktrees | opencode native git worktree support for parallel branches |
| F25 | Writing Plans | `skills/project-planner/` — detailed implementation plans |
| F26 | Executing Plans | Batch execution with checkpoints in project-planner |

### From Hermes Agent (NousResearch)

| # | Feature | Implementation |
|---|---------|---------------|
| F27 | Skills Hub/Registry | `registry/plugins.json` + `plugins.js` page — marketplace browser |
| F28 | Subagent Delegation | opencode `--agent` spawning via dashboard |
| F29 | Messaging Channels | Hermes native Telegram/Discord/email/webhooks |
| F30 | Voice Mode | Hermes native voice interaction |
| F31 | Browser Automation | Hermes native browser-use skill |
| F32 | Checkpoints | Git auto-versioning + pre-edit snapshots |
| F33 | Context References | @-syntax for files/folders/URLs in skill inputs |
| F34 | Code Execution | Python sandbox execution via dashboard |
| F35 | Event Hooks | Pre/post skill execution hooks in scheduler |
| F36 | Batch Processing | Parallel skill runs from dashboard |
| F37 | Model Agnostic Router | Route tasks based on cost/efficiency/availability |

### From Claude-OS (shivsoji) + LLMOS Paper

| # | Feature | Implementation |
|---|---------|---------------|
| F38 | Awareness Engine | Heartbeat skill + dashboard health gauges |
| F39 | Health Guardian | Auto-restart failed services, disk cleanup triggers |
| F40 | Memory Graph | Hermes SQLite FTS5 with entity-relation tracking |
| F41 | Goal Planner | `skills/goal-planner/` — refine input → step-by-step plan |
| F42 | Self-Evolution | Capability tracking in `data/agent-routes.json` |
| F43 | Capability Manager | Track what each agent can do in routing rules |

### From BuilderMethods Agent OS

| # | Feature | Implementation |
|---|---------|---------------|
| F44 | Discover Standards | `standards/discover` command extracts patterns from codebase |
| F45 | Deploy/Inject Standards | `standards/inject` injects relevant standards into agent context |
| F46 | Shape Spec | `skills/project-planner/` spec-driven development |
| F47 | Index Standards | `standards/index.yml` — organized, searchable standards |
| F48 | Profile System | `standards/profiles/` — different configs per project type |

### From 7-Layer Personal Agentic OS

| # | Feature | Implementation |
|---|---------|---------------|
| F49 | Identity/Persona Layer | `brain/identity.md` — agent personality, role, voice |
| F50 | Values/Constitution | `brain/constitution.md` — agent governance and constraints |
| F51 | Tool/API Integration | `data/agent-routes.json` — external service connectors |

### Extra Features (Not in Any Video/Repo)

| # | Feature | Implementation | Why Unique |
|---|---------|---------------|------------|
| E1 | Multi-Provider Cost Analytics | `skills/cost-analytics/` + `cost-analytics.js` (Chart.js) | No agentic OS tracks costs across multiple providers |
| E2 | Git Auto-Versioning | `.git/` + pre-commit hooks for every brain/skill change | Full rollback history for all memory/config |
| E3 | Disaster Recovery | `backup.sh` + `restore.sh` + `backups.js` UI | One-click snapshot of entire system |
| E4 | Prompt Template Library | `prompts/` (10 templates) + `prompts.js` page | Reusable templates for common tasks |
| E5 | Skill Performance Leaderboard | `score-history.json` per skill, ranked in `skills.js` | Gamifies skill improvement |
| E6 | Agent Handoff Protocol | Structured handoff JSON when agent can't complete task | Enables true multi-agent collaboration |
| E7 | Smart Free-Tier Guardian | Cost analytics monitors API limits, suggests downgrades | Prevents surprise bills on free tiers |
| E8 | Blazing-Fast Load Times | Lazy-loading SPA pages, localStorage caching | Under 500ms initial load |
| E9 | Dark/Light Theme + Responsive | CSS custom properties, media queries | Looks polished on any device |
| E10 | One-Command Install | `install.sh` — detects OS, installs deps, seeds all files | Zero manual setup |

---

## Directory Structure

```
/home/mihir/Desktop/Agentic OS Project/
├── AGENTS.md                  # THIS FILE — complete context for any AI agent
├── README.md                  # User-facing documentation
├── server.py                  # FastAPI backend (REST API for dashboard)
├── requirements.txt           # Python dependencies
├── install.sh                 # One-command installer [E10]
├── start.sh                   # Start dashboard server
├── backup.sh                  # Manual backup [E3]
├── restore.sh                 # Manual restore [E3]
│
├── brain/                     # [F2, F7, F10, F49, F50, F54] Shared context
│   ├── business-brain.md
│   ├── memory.md
│   ├── recent-decisions.md
│   ├── active-projects.md
│   ├── constraints.md
│   ├── identity.md
│   ├── constitution.md
│   └── journal/               # [F54] Daily markdown entries (YYYY-MM-DD.md)
│
├── skills/                    # [F5, F8, F15, F17] Skills Hub
│   ├── _template/
│   │   ├── SKILL.md
│   │   ├── learnings.md
│   │   ├── eval.json
│   │   ├── score-history.json
│   │   └── context/
│   ├── heartbeat/             # [F12, F38]
│   ├── devops-audit/          # CloudMart GCP infra
│   ├── content-draft/         # Blog/newsletter writing
│   ├── code-review/           # [F21]
│   ├── research-synthesis/    # Gemini research
│   ├── daily-standup/         # Morning briefing
│   ├── meeting-minutes/       # Meeting notes processor
│   ├── project-planner/       # [F25, F26, F46]
│   ├── brainstorming/         # [F19]
│   ├── systematic-debug/      # [F23]
│   ├── memory-consolidation/  # [F16]
│   ├── backup-skill/          # Backup creator
│   ├── cost-analytics/        # [E1, E7]
│   ├── tdd-cycle/             # [F22]
│   └── goal-planner/          # [F41]
│
├── agents/                    # Per-agent configs
│   ├── opencode/
│   │   ├── opencode.json
│   │   └── AGENTS.md
│   ├── hermes/
│   │   ├── SOUL.md
│   │   ├── USER.md
│   │   └── MEMORY.md
│   └── gemini/
│       ├── GEMINI.md
│       └── gemini-extension.json
│
├── scheduler/                 # [F9] Scheduling
│   ├── scheduler.py
│   └── jobs/
│       ├── heartbeat-job.json
│       ├── memory-consolidation-job.json
│       ├── daily-standup-job.json
│       └── devops-audit-job.json
│
├── registry/                  # [F27] Plugin Registry
│   ├── plugins.json
│   └── marketplace/
│
├── standards/                 # [F44-F48] Standards System
│   ├── index.yml
│   ├── api-response-format.md
│   ├── naming-conventions.md
│   └── profiles/default/config.yml
│
├── dashboard/                 # [F3, F4] Web Frontend
│   ├── index.html
│   ├── app.js
│   ├── api.js
│   ├── styles.css
│   ├── utils.js
│   └── pages/
│       ├── dashboard.js
│       ├── skills.js          # detail view inline
│       ├── memory.js
│       ├── scheduler.js
│       ├── audit.js
│       ├── cost-analytics.js
│       ├── plugins.js
│       ├── backups.js
│       ├── prompts.js
│       ├── standards.js
│       ├── settings.js
│       ├── setup-wizard.js
│       ├── kanban.js          # [F52] Kanban Board (v0.2.0)
│       ├── goals.js           # [F53] Goals (v0.2.0)
│       ├── journal.js         # [F54] Journal (v0.2.0)
│       ├── agent-health.js    # [F55] Agent Health (v0.2.0)
│       ├── smart-router.js    # [F56] Smart Router (v0.2.0)
│       ├── learning-analytics.js # [F57] Learning Analytics (v0.2.0)
│       └── session-replay.js  # [F58] Session Replay (v0.2.0)
│
├── audit/                     # [F38] Audit Trail
│   └── audit.log
│
├── backups/                   # [E3] Snapshots
│   └── .gitkeep
│
├── prompts/                   # [E4] Prompt Templates
│   ├── code-review.md
│   ├── system-audit.md
│   ├── daily-standup.md
│   ├── draft-blog.md
│   ├── research-topic.md
│   ├── project-plan.md
│   ├── meeting-notes.md
│   ├── brainstorm-session.md
│   ├── debug-incident.md
│   └── standup-email.md
│
├── data/                      # Runtime data
│   ├── settings.json
│   ├── cost-history.json
│   ├── agent-routes.json
│   ├── kanban/                # [F52] Kanban task JSON files
│   └── goals.json             # [F53] Goals storage
│
└── .git/                      # [E2] Auto-versioning
```

---

## User Profile

| Detail | Info |
|--------|------|
| **Name** | Mihir N Modi |
| **Email** | rinkumi0210@gmail.com |
| **Location** | Gujarat, India |
| **Education** | BTech Computer Engineering, 1st Year |
| **Career Goal** | AI/ML/LLMs + DevOps/Cloud → MNCs (Google-level) |
| **Budget** | Strictly free tiers (GCP Free, GitHub Student Pack, Colab, Kaggle) |
| **Active Project** | CloudMart — GCP DevOps multi-region e-commerce platform |
| **Other Projects** | AgriAssist AI, Hermes Agent/OpenClaw, EROS Wellness AI, Java OOP practice |
| **CLI Tools Available** | opencode, Hermes Agent, Gemini CLI |
| **Preferred Model** | Hermes: Owl Alpha (OpenRouter, free), opencode: deepseek-v4-flash-free (opencode-zen), Gemini: gemini-2.5-flash (Google OAuth) |
| **Obsidian Vaults** | 4 vaults: DevOps, DeepSeek Chat, AI/ML, SEM-2 Academics (192 files) |

---

## Setup Instructions for New AI Agents

When you (an AI agent) are dropped into this directory for the first time:

1. **Read this file first** — you're doing it now. Good.
2. **Check `brain/`** — read `business-brain.md`, `memory.md`, `active-projects.md` for current context
3. **Check `data/settings.json`** — user preferences and API key locations
4. **Check `data/agent-routes.json`** — routing rules for task delegation
5. **Check `skills/`** — available skills, their learnings, and eval scores
6. **Start `server.py`** if the dashboard needs to be running
7. **Route tasks** according to the Agent Responsibilities table above
8. **After each task**: update `learnings.md`, append to `audit/audit.log`, update cost tracking

### When Creating/Modifying Code
- Use `skills/_template/` as reference for new skills
- Follow existing skill structure: SKILL.md + learnings.md + eval.json + context/
- Update `registry/plugins.json` when adding new skills
- Run `git add -A && git commit -m "description"` after meaningful changes [E2]

### When the User Asks to "Switch CLI"
- This AGENTS.md file is the single source of truth
- Any AI agent reading this file should have enough context to continue seamlessly
- The agent should first read this file, then `brain/*`, then `data/settings.json`

### Session History
- opencode: `~/.local/share/opencode/opencode.db` + `~/.local/share/opencode/log/`
- Hermes: `~/.hermes/sessions.json`
- Gemini: `~/.gemini/history/`

---

## API Endpoints (server.py FastAPI, 58 total — 28 original + 30 v0.2.0)

### Core (28 original endpoints)
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/status` | System health + 3 agent status |
| GET | `/api/brain` | List brain/ files |
| GET | `/api/brain/{file}` | Get brain file content |
| PUT | `/api/brain/{file}` | Update brain file |
| GET | `/api/skills` | List all skills |
| GET | `/api/skills/{name}` | Get skill details |
| POST | `/api/skills/{name}/run` | Execute a skill |
| GET | `/api/skills/{name}/eval` | Get eval score history |
| GET | `/api/scheduler/jobs` | List scheduled jobs |
| POST | `/api/scheduler/jobs` | Create scheduled job |
| DELETE | `/api/scheduler/jobs/{id}` | Delete scheduled job |
| GET | `/api/audit` | Query audit log |
| GET | `/api/cost` | Get cost analytics |
| GET | `/api/plugins` | List registry plugins |
| POST | `/api/plugins/install` | Install plugin from registry |
| POST | `/api/backup` | Create backup snapshot |
| POST | `/api/backup/restore` | Restore from snapshot |
| GET | `/api/prompts` | List prompt templates |
| GET | `/api/settings` | Get user settings |
| PUT | `/api/settings` | Update user settings |
| GET | `/api/standards` | List standards |
| POST | `/api/standards/discover` | Run standards discovery |

### Kanban Board (v0.2.0) — 13 endpoints
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/kanban/board` | Get kanban board (all columns + tasks) |
| GET | `/api/kanban/tasks/{id}` | Get single task |
| POST | `/api/kanban/tasks` | Create task |
| PATCH | `/api/kanban/tasks/{id}` | Update task fields |
| POST | `/api/kanban/tasks/{id}/complete` | Mark task done |
| POST | `/api/kanban/tasks/{id}/block` | Block task |
| POST | `/api/kanban/tasks/{id}/unblock` | Unblock task |
| POST | `/api/kanban/tasks/{id}/comments` | Add comment |
| POST | `/api/kanban/links` | Link parent/child tasks |
| DELETE | `/api/kanban/links` | Unlink tasks |
| POST | `/api/kanban/dispatch` | Dispatch triage tasks |
| POST | `/api/kanban/tasks/{id}/specify` | Generate spec |
| POST | `/api/kanban/tasks/{id}/decompose` | Decompose into subtasks |

### Goals (v0.2.0) — 4 endpoints
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/goals` | List all goals |
| POST | `/api/goals` | Create goal (auto-syncs to brain/active-projects.md) |
| PUT | `/api/goals/{id}` | Update goal progress/status |
| DELETE | `/api/goals/{id}` | Delete goal |

### Journal (v0.2.0) — 4 endpoints
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/journal/entries` | List all entry dates |
| GET | `/api/journal/entries/{date}` | Get entry content |
| PUT | `/api/journal/entries/{date}` | Save entry (creates/updates brain/journal/YYYY-MM-DD.md) |
| GET | `/api/journal/search?q=` | Full-text search across entries |

### Agent Health (v0.2.0) — 3 endpoints
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/agents/health` | Get live status of all 3 agents |
| GET | `/api/agents/{name}/stats` | Get per-agent statistics |
| POST | `/api/agents/health/refresh` | Force refresh all status checks |

### Smart Router (v0.2.0) — 2 endpoints
| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/router/suggest` | Suggest best agent for a task description |
| POST | `/api/router/route` | Route task to a specific agent |

### Learning Analytics (v0.2.0) — 2 endpoints
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/analytics/skills` | Skill evaluation scores across all skills |
| GET | `/api/analytics/trends` | Score history trends per skill |

### Session Replay (v0.2.0) — 2 endpoints
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/sessions/list` | List opencode sessions |
| GET | `/api/sessions/{id}/replay` | Get session message content |

---

## Version History

| Date | Version | Changes |
|------|---------|---------|
| May 17, 2026 | v1.0.0 | Initial creation — all 51 features + 10 extras |
| May 17, 2026 | v1.1.0 | AI Chat fixes: corrected CLI syntax (hermes `chat -q`, gemini positional), switched Hermes default to OpenRouter + Owl Alpha, improved timeout/error handling, updated execute_agent fallback logic |

---

*This AGENTS.md is designed to be the single source of truth. Any AI agent (opencode, Claude Code, Gemini CLI, Hermes, Cursor, etc.) reading this file should have complete context to continue the project seamlessly.*
