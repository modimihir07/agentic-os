---
name: tdd-cycle
description: Red-Green-Refactor test-driven development cycle
version: 1.0.0
author: Agentic OS
tags: [testing, tdd, quality, development]
---

# TDD Cycle

## Description
Enforces the Red-Green-Refactor TDD cycle: write a failing test, make it pass, then refactor. No code is written before a test exists.

## When to Use
- When implementing any new feature
- When fixing a bug
- When refactoring existing code

## Process
1. **RED**: Write a failing test for the desired behavior
2. Verify test fails (confirm test is valid)
3. **GREEN**: Write minimal code to make the test pass
4. Verify test passes
5. **REFACTOR**: Clean up code while keeping tests green
6. Commit with message format: `RED|GREEN|REFACTOR: description`

## Rules
- Production code is only written to make a failing test pass
- Delete any code written before tests
- Never skip the RED phase

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
