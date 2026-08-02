---
name: memory-consolidation
description: Weekly synthesis of accumulated notes and memory optimization
version: 1.0.0
author: Agentic OS
tags: [memory, consolidation, cleanup, maintenance]
---

# Memory Consolidation

## Description
Synthesizes and compresses accumulated memory files. Removes redundant information, updates summaries, and archives outdated content.

## When to Use
- Weekly (scheduled)
- When learnings.md exceeds 600 words
- When recent-decisions.md has 30+ entries

## Process
1. Read all learnings.md files across skills
2. Read recent-decisions.md and archive entries older than 30 days
3. Compress duplicated lessons into single entries
4. Update memory.md with synthesized insights
5. Prune eval score-history.json to last 20 entries
6. Flag any contradictions in learnings for user review

## Output
Consolidated memory with archived sections, updated summaries, and pruning report

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

For Hermes (memory/scheduling/channels):
- Capture: a recurring scheduling pattern, notification recipe, or routing rule -> skill.
- Heal: a misrouted task or a memory-write mistake -> patch the skill; fix the memory entry too.
- Decay: orphaned context/ folders, outdated MEMORY.md notes, duplicate scheduling skills. Send a message on the user's behalf = ask.
- Route coding to opencode, research to Gemini.

Goal: become faster, smarter, more efficient, more knowledgeable, more thoughtful, and proactively autonomous — never less safe.
A high-stakes irreversible action (delete data, ship to prod, send a message on the user's behalf) always goes through `clarify`. Reversible, low-stakes actions may proceed, then be reported in the same turn.
<!-- SELF-EVOLVE:END -->

## Agent Assignment
- Primary: hermes
- Fallback: opencode
