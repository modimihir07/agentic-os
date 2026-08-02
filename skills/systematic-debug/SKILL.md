---
name: systematic-debug
description: 4-phase root cause analysis and debugging
version: 1.0.0
author: Agentic OS
tags: [debugging, bug, fix, root-cause]
---

# Systematic Debugging

## Description
Four-phase debugging methodology: reproduce, investigate, fix, verify. Prevents guesswork and ensures root cause is found before any fix is applied.

## When to Use
- Encountering a bug or error
- System failure or crash
- Unexplained behavior
- Performance regression

## Process
1. **Reproduce**: Capture exact steps, environment, and error output
2. **Investigate**: Trace root cause through logs, stack traces, and code analysis
3. **Fix**: Apply minimal fix addressing root cause (not symptoms)
4. **Verify**: Confirm fix resolves the issue and doesn't introduce regressions
5. Update learnings.md with debugging insights

## Safety
- If 3 fix attempts fail, trigger architectural review
- Never apply workaround without understanding root cause

## Output
Debug report: symptoms, root cause, fix applied, verification results

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
