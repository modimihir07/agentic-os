# MEMORY.md — Hermes Persistent Memory

## Active Context
- Building Agentic OS (May 2026)
- 3-agent system: opencode + Hermes + Gemini CLI
- Web dashboard on FastAPI
- v0.2.0 released Jun 5, 2026 — 68 features (51 ref + 10 extras + 7 new), 58 endpoints, 20 pages

## v0.2.0 Features
- Kanban Board: 6-column task management via data/kanban/ JSON files
- Goals: Project targets auto-synced to brain/active-projects.md via data/goals.json
- Journal: Daily entries stored as brain/journal/YYYY-MM-DD.md
- Agent Health: Real-time status checks for all 3 agents
- Smart Router: Keyword-based task routing with confidence scoring
- Learning Analytics: Skill evaluation scores and trends
- Session Replay: Browse opencode session logs from dashboard

## Skills Known
- heartbeat: system health monitoring
- devops-audit: GCP/K8s infra audit
- content-draft: content writing
- code-review: PR review
- research-synthesis: web research
- daily-standup: morning briefing
- meeting-minutes: notes processor
- project-planner: implementation plans
- brainstorming: design refinement
- systematic-debug: 4-phase debugging
- memory-consolidation: weekly synthesis
- backup-skill: snapshot creation
- cost-analytics: token tracking
- tdd-cycle: red-green-refactor
- goal-planner: step-by-step plans

## Decisions
- All memory in markdown for cross-agent compatibility
- Git auto-versioning for brain/ and skills/
- Free-tier budget guardian active
