# Agentic OS — Documentation Draft (NOTES)

> FIRST DRAFT. This is a living scratch pad, not the finished manual.
> The structured reference lives in `docs/README.md` — keep that as the
> canonical doc and fold things from here into it as they mature.
> Last touched: 2026-07-27. Expect this section to grow fast.

## 1. What this is (one paragraph)

Agentic OS is a locally-hosted control plane for AI agents. A FastAPI
backend (`server.py`, ~2,800 lines) serves a vanilla-JS single-page
dashboard (`dashboard/`) plus a JSON REST API (`/api/*`). It coordinates
three built-in CLI agents — **opencode** (code/DevOps), **Hermes**
(memory/scheduling/coordination), **Gemini CLI** (research/analysis) — and
any number of **custom-registered agents**. Shared state is plain files
under `brain/`, `skills/`, `data/`, `scheduler/`. No external database.

## 2. How to run it (verified 2026-07-27)

```bash
cd ~/agentic-os
python3 server.py                 # reads port from data/settings.json (dashboard.port, default 8080)
# or
./start.sh                       # wrapper
# or
./start-agentic-os.sh           # the supervised launcher (PID-tracked)
```

- Dashboard:  http://127.0.0.1:8080
- API base:    http://127.0.0.1:8080/api/
- Terminal WS:  ws://127.0.0.1:8080/ws/terminal   (in-app PTY, same port)

> The dashboard port is the SOLE source of truth and lives in
> `data/settings.json` (`dashboard.port`). `server.py`, the launcher
> scripts, and `scheduler/scheduler.py` all read it. Do NOT hardcode
> 8080/8081 anywhere — change it in one place only.

## 3. Mental model (the layers)

```
          browser SPA  (dashboard/*.html + pages/*.js)
                     │  fetch /api/*   ▲  WebSocket /ws/terminal
                     ▼
          FastAPI backend  (server.py)
           ├─ Agent Router ──► opencode / hermes / gemini / custom
           ├─ Memory        (brain/ folder + Hermes SQLite FTS5)
           ├─ Skills Hub    (skills/*/SKILL.md, eval.json, learnings.md)
           ├─ Scheduler     (APScheduler jobs in scheduler/jobs/*.json)
           ├─ Kanban        (tasks, dispatch to agents)
           └─ Audit/Cost/Backups (append-only logs under data/)
```

Two scheduling systems coexist (be aware):
- **APScheduler** inside the OS — jobs in `scheduler/jobs/*.json`, loaded
  by `scheduler/scheduler.py`.
- **Hermes cron** — managed via the Hermes `cronjob` tool, persistent
  across restarts. Currently running: `brain-guardian-autoupdate`
  (every 2h) which writes `brain/health-report.md`,
  `brain/skill-usage.md`, `brain/github-activity.md`.

## 4. The dashboard pages (current)

Primary: Dashboard, AI Chat, Terminal.
Agents: Skills, Memory, Agent Health, Command Center (new), Smart Router.
Workflow: Kanban, Goals, Journal, Scheduler, Audit, Multi-Agent Run,
Session Replay, Agent Time, Agent Insights, Brain Search.
Management: Cost, Plugins, Backups, Prompts, Standards, Settings, Setup Wizard.

Each page is `dashboard/pages/<name>.js` exposing `render<Name>()`,
loaded on demand by `dashboard/app.js` (hash routing). Shared helpers
live in `dashboard/utils.js` (`navigate`, `showToast`, `escapeHtml`,
`statusColor`, `PAGE_TITLES`) and `dashboard/api.js` (the `api` client).

### New: Command Center (`#command-center`)
See the dedicated section in `docs/README.md`. In short: a command
console (`/help` `/status` `/run` `/wake` `/reset` `/clear` + free text)
that dispatches to the live agent registry via `/api/chat`, with real
agent-status, system-metric, and log/event panels. No mocked data.

## 5. API surface (the parts that matter most)

Full table is in `docs/README.md`. High-traffic ones:

| Group     | Endpoints |
|-----------|------------|
| Agents    | `GET /api/agents`, `POST /api/agents/register`, `DELETE /api/agents/{name}`, `GET /api/agents/health` |
| Chat      | `POST /api/chat`  ← Command Center `/run` lands here |
| Status    | `GET /api/status`  ← `{status, agents[], skills_count, uptime}` |
| Scheduler | `GET/POST/DELETE /api/scheduler/jobs` |
| Skills    | `GET /api/skills`, `POST /api/skills/{name}/run`, `GET /api/skills/{name}/eval` |
| Brain     | `GET/PUT /api/brain/{file}` |
| Agent Time| `GET /api/agent-time`, `POST /api/agent-time/recompute`, `GET /api/agent-time/skin` (Rainmeter) |
| Orchestrate| `POST /api/orchestrate` (fan-out + converge) |

Agent object shape (from `check_agent`):
`{ name, display_name, status: online|warning|offline, description, type, builtin }`

## 6. Agent registry

- Built-in agents: opencode, hermes, gemini (defined in `server.py`).
- Custom agents: `data/agent-registry.json` (register via UI → Agent
  Health → + Add Agent, or `POST /api/agents/register`).
- Check types: `binary` (in PATH), `oauth_file`, `http` (health_url),
  `custom` (check_command, run WITHOUT shell=True — injection-safe).
- Agent types: `cli` (subprocess, `{message}` substitution), `http`
  (POST to api_url), `mcp` (stub — not implemented).

## 7. Memory (brain/)

- `brain/memory.md`, `brain/active-projects.md`, `brain/recent-decisions.md`,
  `brain/business-brain.md` — read by agents at session start.
- `brain/journal/YYYY-MM-DD.md` — daily entries (Journal page).
- Centralized index: `brain-core/brain_index.py` (SQLite FTS5) over
  brain notes + skill learnings + chat history. Query: `/api/brain-index/search`.
- `brain-guardian` (Hermes cron) keeps health/skill-usage/github reports fresh.
- A standalone `dashboard/serve_monitor.py` + `agent-time-monitor.html`
  exist but are SUPERSEDED by the integrated Agent Time page on 8080.
  Kept at user request; do not build new features on top of them.

## 8. Skills

`skills/<name>/` → `SKILL.md` (YAML frontmatter + body), `learnings.md`,
`eval.json`, `score-history.json`, `context/`. ~17 built-in. Run via
`POST /api/skills/{name}/run`. See `docs/README.md` "Skills" for the list.

## 9. Open items / what's next (grow this section)

> This is the section to extend in the near term. Mark done by striking through.

- [ ] **Command Center hardening** — `/run` is fire-and-forget to the
      agent CLI; consider recording console runs into the audit trail and
      surfacing a per-run job id in the Jobs panel.
- [ ] **MCP agent type** is a stub (`type: mcp` in registry schema but
      `execute_agent_mcp` is minimal). Decide: implement or remove from UI.
- [ ] **Standalone monitor cleanup** — `dashboard/serve_monitor.py` and
      `agent-time-monitor.html` are dead weight (superseded). User wants
      them kept for now; revisit deletion later.
- [ ] **Docs drift** — `docs/README.md` still claims 17 skills / v1.3.0
      and a couple of stale numbers; reconcile counts (Skills nav badge
      showed 32 skill dirs on 2026-07-27 — investigate the discrepancy).
- [ ] **Graphify memory layer** — code graph works (`graphify . --code-only`);
      memory-note graphing needs an LLM key (see `docs/GRAPHIFY_MEMORY.md`).
      Expose graphify as a query tool (MCP/HTTP) if wanted.
- [ ] **Rainmeter HUD** — SystemMonitor + AgentTime skins deployed to the
      Windows APieces folder; they read the live `/api/agent-time/skin`
      endpoint. Tie version notes into this doc when changed.
- [ ] **The user said "more to do here very soon"** — leave room at the
      top of this file; prepend new sections rather than burying them.

## 10. Conventions for contributors (this repo)

- One source of truth for config: `data/settings.json`.
- Plain files, no DB. Audit everything via `append_audit(...)`.
- Never `shell=True` with agent-supplied input (injection-safe `shlex`).
- Dashboard pages: add to `index.html` nav + `utils.js` `PAGE_TITLES` +
  a `render<Name>()` in `pages/<name>.js`. Reuse `.cc-*` / existing
  CSS vars; don't invent a second design language.
- Verify with the live server (it's usually up on 8080) before claiming done.
