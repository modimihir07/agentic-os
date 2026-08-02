---
name: heartbeat
description: Proactive self-healing system health monitor that detects, diagnoses, and auto-remediates anomalies before they breach thresholds
version: 2.0.0
author: Agentic OS
tags: [monitoring, health, system, proactive, self-healing]
---

# Heartbeat — Proactive Self-Healing Monitor

## Description
Lightweight health monitor that runs on a schedule and continuously checks agent
status, resource pressure (disk/memory/CPU), and recent audit errors. Unlike a
passive checker, Heartbeat is *proactive*: when a metric trends toward a
threshold it acts early, attempts a safe self-remediation, and only escalates to
a human when the automated fix fails.

## When to Use
- Every 5 minutes as a scheduled cron job (primary mode)
- On-demand before/after running other skills
- After any deploy or config change to confirm the system is green

## Process
1. Probe all 3 agents (opencode, hermes, gemini) for liveness + last-success age
2. Sample disk (< 90% soft / 95% hard), memory (< 80% soft / 90% hard), CPU spike
3. Tail the audit log for ERROR/WARN entries in the last N minutes
4. **Proactive step:** if any metric is within 15% of a soft threshold, attempt
   the lightest safe remediation (e.g. clear stale context/ dirs, prune old
   logs, restart a stalled agent via its health endpoint) — never destructive
5. If remediation fails or a hard threshold is breached, escalate: write a
   flagged entry to brain/recent-decisions.md and emit an alert
6. Return a JSON health report with pass/fail per check AND an "actions_taken" list

## Output
JSON: { checks: [...], actions_taken: [...], escalations: [...] }

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
- Fallback: hermes
