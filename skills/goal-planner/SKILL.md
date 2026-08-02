---
name: goal-planner
description: Refines user inputs into executable step-by-step plans
version: 1.0.0
author: Agentic OS
tags: [planning, goals, execution]
---

# Goal Planner

## Description
Takes a high-level goal or objective and breaks it down into a concrete, executable step-by-step plan with dependencies, milestones, and estimated effort.

## When to Use
- When user says "I want to..." with a complex goal
- Project kickoff
- Quarterly planning
- Learning roadmap creation

## Process
1. Clarify the goal with targeted questions
2. Identify constraints and dependencies
3. Break goal into milestones
4. Break milestones into tasks
5. Estimate effort per task
6. Identify critical path
7. Save plan to context/

## Output
Structured plan with: goal, milestones, tasks, dependencies, estimates

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
- Fallback: gemini
