---
name: multi-agent-run
description: Spin up multiple agents (opencode, Gemini, Hermes) on the same project goal from different angles, then converge their outputs into one synthesis. Use for parallel multi-perspective problem solving, design, or planning on a shared project.
version: 1.0.0
---

# Multi-Agent Run — Fan-out + Converge

Orchestrate the 3 built-in agents on ONE project goal, each from its own angle,
then merge their outputs into a single coherent result.

## When to use
- A project goal benefits from multiple perspectives at once (implementation +
  research + coordination).
- You want a synthesized plan that reconciles engineering, analysis, and ops.
- You want the run persisted and searchable in the brain for later review.

## How it works (backend)
`POST /api/orchestrate`:
1. **Fan-out** — runs each agent in parallel on its angle:
   - `opencode` → implementation approach / build plan
   - `gemini`   → research, analysis, risks, feasibility
   - `hermes`   → coordination, sequencing, integration, memory
2. **Converge** — feeds all angle outputs to `converge_agent` (default `hermes`)
   to produce a unified, prioritized action plan (or final answer).
3. **Persist** — writes `data/orchestration-runs/<run_id>.json` and upserts a
   searchable doc into the brain.

## Request shape
```
{
  "goal": "Build a real-time sync layer between the dashboard and the brain index",
  "angles": {                              // optional per-agent override
    "opencode": "Focus on the websocket protocol and schema migration",
    "gemini": "Survey existing real-time sync patterns and their failure modes"
  },
  "agents": ["opencode", "gemini", "hermes"],   // optional override
  "converge_agent": "hermes",                    // optional
  "converge_prompt": "..."                        // optional custom synthesis
}
```

## Response
```
{
  "status": "completed",
  "run_id": "...",
  "outputs": { "opencode": "...", "gemini": "...", "hermes": "..." },
  "synthesis": "...",          // the converged result
  "run_file": "data/orchestration-runs/<run_id>.json"
}
```

## Notes / caveats
- Agents run in parallel, so a run takes ~1 agent-round-trip (not 3x).
- If an angle agent errors, its output is captured as an error string and the
  convergence step still proceeds (best-effort, never aborts the whole run).
- Review past runs via `GET /api/orchestrate/runs` or the dashboard Orchestration page.
- The converged synthesis is auto-upserted to the brain (source: agent-note) so
  you can later find it with Brain Search.
