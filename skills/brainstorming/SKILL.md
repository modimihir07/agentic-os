---
name: brainstorming
description: Socratic design refinement and ideation
version: 1.0.0
author: Agentic OS
tags: [ideas, design, brainstorming, creative]
---

# Brainstorming

## Description
Socratic brainstorming session that refines rough ideas through structured questions, explores alternatives, and produces a validated design document.

## When to Use
- Starting a new project with vague requirements
- Exploring architectural alternatives
- Solving open-ended problems
- Product design decisions

## Process
1. Ask clarifying questions to understand the core need
2. Identify constraints and trade-offs
3. Generate 3+ alternative approaches
4. Evaluate each against constraints
5. Recommend an approach with rationale
6. Save design document to context/

## Output
Design document with: problem statement, alternatives, evaluation, recommendation

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
- Research: gemini
