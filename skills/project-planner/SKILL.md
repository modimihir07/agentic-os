---
name: project-planner
description: Detailed implementation plans and spec-driven development
version: 1.0.0
author: Agentic OS
tags: [planning, project, spec, design]
---

# Project Planner

## Description
Creates detailed implementation plans from high-level goals. Breaks work into bite-sized tasks with exact file paths, complete code templates, and verification steps.

## When to Use
- Starting a new feature
- Planning a refactor
- Spec-driven development
- Before writing any significant code

## Process
1. Brainstorm and refine requirements
2. Read standards/ for project conventions
3. Create spec document with screens and data model
4. Break into tasks (2-5 minutes each)
5. Each task has: file path, code template, verification step
6. Save spec and plan to context/

## Output
Spec document + task plan + implementation order

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
