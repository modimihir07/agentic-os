# Agentic-OS · Agent Time Monitor

A localhost dashboard that tracks **total time the AI agents spent on the
agentic-os project**, plus an embedded graphify knowledge-graph view of the
codebase, with one-click sync of the total to **Mnemoverse** persistent memory.

## What it measures
The project's logs (`audit/audit.log`, `data/chat-history.json`,
`data/cost-history.json`) record *events* (a chat, a skill run, a write)
but not explicit session durations. Total agent time is therefore **estimated**
with a session-gap model:

- Each logged event is a timestamped "touch" by an agent.
- A *session* for an agent = a run of touches where each touch is within
  `GAP` seconds (default 30 min) of the previous one.
- Session duration = (last touch − first touch) + `TAIL` (default 2 min, to
  account for work after the last logged event).
- `total_seconds` = sum of all an agent's session durations.

This is clearly labeled as an ESTIMATE in the UI. Tune `GAP`/`TAIL` via the
`AGENT_TIME_GAP` / `AGENT_TIME_TAIL` env vars.

## Run it
    cd ~/agentic-os
    ./dashboard/start-monitor.sh            # default port 8765
    # or:  python3 dashboard/serve_monitor.py --port 8765

Then open:
    http://localhost:8765/dashboard/pages/agent-time-monitor.html

(Visiting http://localhost:8765/ redirects to the dashboard.)

## Endpoints (server: dashboard/serve_monitor.py)
- `GET  /`                                   → redirect to dashboard
- `GET  /dashboard/.../agent-time-monitor.html` → the dashboard UI
- `GET  /data/agent-time.json`               → computed report (totals + per-agent)
- `GET  /graphify-out/graph.html`            → graphify code knowledge graph
- `POST /recompute`                          → re-run the analyzer from logs
- `POST /sync-mnemoverse`                    → push total to Mnemoverse (graceful)

## graphify integration
The interactive graph is produced by graphify (code-only, no API key needed):

    cd ~/agentic-os
    graphify . --code-only        # writes graphify-out/{graph.json,graph.html,GRAPH_REPORT.md}

Rebuild any time the codebase changes; the dashboard iframe picks it up live.

## Mnemoverse integration
Set your key to enable the "Sync total to Mnemoverse" button:

    export MNEMOVERSE_API_KEY=mk_live_xxxxxxxx
    ./dashboard/start-monitor.sh

The server calls `https://core.mnemoverse.com/api/v1/memory/write` with a
single memory holding the total agent time, the agent count, and the method.
Without a key (or offline) the button reports a clear, graceful message
instead of failing.

## Files
- `scripts/analyze_agent_time.py`  — derives total/per-agent time from logs
- `dashboard/serve_monitor.py`     — localhost server (stdlib only)
- `dashboard/pages/agent-time-monitor.html` — the dashboard UI
- `data/agent-time.json`           — last computed report (regenerated each run)
- `graphify-out/`                  — graphify graph (built separately)
