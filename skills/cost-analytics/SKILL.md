---
name: cost-analytics
description: Tracks token usage and API costs across all providers
version: 1.0.0
author: Agentic OS
tags: [cost, analytics, tracking, budget]
---

# Cost Analytics

## Description
Tracks token consumption and API costs across opencode, Hermes, and Gemini CLI. Computes daily/weekly/monthly projections and alerts when approaching free-tier limits.

## When to Use
- After each agent API call (auto-triggered)
- Daily cost report generation
- When checking budget status

## Process
1. Read latest cost-history.json
2. Compute today's total tokens by agent
3. Compute weekly and monthly projections
4. Compare against free-tier limits from settings.json
5. Generate alert if approaching limits (80%, 90%, 95%)
6. Update cost-analytics chart data

## Output
Cost report with: per-agent breakdown, projections, alerts, recommendations

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

## Agent Assignment
- Primary: opencode
