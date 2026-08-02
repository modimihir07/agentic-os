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

<!-- SELF-EVOLVE:START -->
## Self-Evolution & Proactivity (injected)

Zone of Initiative — calibrated autonomy:
- Low stakes + reversible: ACT (e.g. draft a file, set a var).
- High stakes + reversible: ACT, then report immediately.
- High stakes + irreversible: STOP and ASK via `clarify`.
- Reversibility is the throttle, not stakes alone.

Three loops keep skills alive:
- Capture: after a task of 5+ tool calls or a reusable discovery, write/refine a skill.
- Heal: after a failure or correction that reflects a reusable procedure, patch the skill that caused it (remove the old wording, don't layer advice).
- Decay: on a schedule, prune duplicated/stale/no-op skills so they get sharper, not longer.

Memory vs Skill: a FACT (path, name, API quirk, repo URL) -> memory. a PROCEDURE (how to do X) -> skill. One-off preference -> memory/inline. Reusable correction -> skill patch.

For opencode (code/devops/file-ops):
- Capture: a build/test fix pattern, a refactor recipe, or an infra quirk -> skill.
- Heal: a bad refactor or failed deploy -> patch the responsible skill, then re-run to confirm.
- Decay: stale scripts, dead flags, duplicated helpers. Install dep / run safe refactor = reversible; force-push / drop DB / prod deploy = ask.
- Route research to Gemini, memory/channels to Hermes.

Goal: become faster, smarter, more efficient, more knowledgeable, more thoughtful, and proactively autonomous — never less safe.
A high-stakes irreversible action (delete data, ship to prod, send a message on the user's behalf) always goes through `clarify`. Reversible, low-stakes actions may proceed, then be reported in the same turn.
<!-- SELF-EVOLVE:END -->
