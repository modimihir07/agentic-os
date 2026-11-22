# MEMORY.md — Hermes Persistent Memory

## Active Context
- Current Version: **v4.0** (August 2026) — 74 passing tests
- Next Milestone: **v5.0** (Planning phase — Voice Command Center, Agent Studio, Autonomous Chaining, Gateway Auth)
- Core 3-agent orchestration system: `opencode` (code/DevOps) + `Hermes` (memory/scheduling/channels) + `agy` (research/analysis)
- Web dashboard on FastAPI + Tailwind SPA (localhost & mobile PWA)

## Version Milestones
- **v1.0 (May 17, 2026)**: Initial release — 51 features + 10 extras, 15 skills, SPA dashboard.
- **v2.0 (Jun 5, 2026)**: Kanban Board, Goals, Daily Journal, Agent Health, Smart Router, Learning Analytics, Session Replay.
- **v3.0 (Jun 29, 2026)**: Event-Driven Scheduler, Webhooks, Error Dashboard, Circuit Breaker, SQLite FTS5 Memory Search, Auto-Skill Generator, Mobile PWA.
- **v4.0 (Aug 12, 2026)**: agy integration, Chat History Search, File Attachments, Memory Knowledge Graph, Code Diff Viewer, 74 Tests.
- **v5.0 (Upcoming Roadmap)**: Voice Command Center & Desktop HUD (Tauri v2), Visual Agent Studio & Profile Hub, Autonomous Multi-Agent Chaining, Standard Gateway Auth.

## Skills Known (16 Curated Skills)
- `heartbeat`: system health monitoring
- `devops-audit`: GCP/K8s infra audit
- `content-draft`: content writing
- `code-review`: PR review
- `research-synthesis`: web research
- `daily-standup`: morning briefing
- `meeting-minutes`: notes processor
- `project-planner`: implementation plans
- `brainstorming`: design refinement
- `systematic-debug`: 4-phase debugging
- `memory-consolidation`: weekly synthesis
- `backup-skill`: snapshot creation
- `cost-analytics`: token tracking
- `tdd-cycle`: red-green-refactor
- `goal-planner`: step-by-step plans

## Decisions & Governance
- All persistent memory stored in markdown for cross-agent compatibility.
- Git auto-versioning for `brain/` and `skills/`.
- Free-tier budget guardian strictly active (GCP Free, GitHub Student Pack, OpenRouter free tier).
- Core 3-agent engine (`opencode` + `Hermes` + `agy`) is non-negotiable.
