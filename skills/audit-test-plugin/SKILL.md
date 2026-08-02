---
name: _template
description: Template for creating new Agentic OS skills
version: 1.0.0
author: Agentic OS
tags: [template, meta]
---

# {Skill Name}

## Description
Brief description of what this skill does.

## When to Use
- Trigger condition 1
- Trigger condition 2

## Input
- What this skill expects as input

## Process
1. Step one
2. Step two
3. Step three

## Output
- What this skill produces

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

This skill may be run by opencode, Hermes, or Gemini. Apply the zone/loops above using the Primary agent's tailoring: prefer the agent named in `## Agent Assignment`.

Goal: become faster, smarter, more efficient, more knowledgeable, more thoughtful, and proactively autonomous — never less safe.
A high-stakes irreversible action (delete data, ship to prod, send a message on the user's behalf) always goes through `clarify`. Reversible, low-stakes actions may proceed, then be reported in the same turn.
<!-- SELF-EVOLVE:END -->

## Agent Assignment
- Primary: opencode / hermes / gemini
- Fallback: {fallback agent}

## Dependencies
- Any prerequisites
