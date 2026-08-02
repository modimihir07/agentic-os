---
name: codebase-inspection-loop
description: Looping multi-round codebase inspection. Builds a manifest, then repeatedly fans out delegate_task subagents (this Hermes session ONLY — no external CLIs) to inspect the highest-priority files, accumulates findings in a durable ledger, lets findings enqueue MORE work, and converges into a report. Use for deep codebase audits, onboarding to a repo, dead-code/hotspot hunts, or pre-refactor reconnaissance.
version: 1.0.0
author: Agentic OS
tags: [code, inspection, orchestration, subagents, loop, audit]
---

# Codebase Inspection Loop

Unlike a single-shot fan-out (`multi-agent-run` / `multi-angle-orchestration`),
this skill is a **loop**: it inspects files in priority order over several
rounds, and *inspection findings can spawn new work*, so the loop digs deeper
where it matters instead of doing one shallow pass over everything.

## When to use
- Onboarding to an unfamiliar repo ("what does this codebase actually do?")
- Pre-refactor / pre-migration reconnaissance (find coupling, dead code, risk)
- Hunting hotspots, secret leaks, missing tests, or inconsistent patterns
- Any audit where "one pass" is not enough

## Hard rules
- **This session only.** Subagents are `delegate_task` leaf workers on THIS
  Hermes session (same model). Never call opencode/gemini/hermes CLIs or a
  separate AI. This is single-source orchestration.
- **Deterministic engine.** The loop state is owned by
  `skills/codebase-inspection-loop/loop.py` — a pure Python tool (no AI). The
  agent drives it; the engine decides *what to inspect next* and stores
  findings. Never hand-maintain the queue.
- **Batches of ≤3.** This user's `delegate_task` runs 3 concurrent children.
  Ask `loop.py next --limit 3` and launch exactly that batch in one call.
- **Findings drive the loop.** When a subagent's finding implies more work
  (a caller to inspect, a module that needs its own pass), pass it back via
  `loop.py record --enqueue "path:reason"` so the queue grows.
- **Converge when drained.** Loop ends when `next` returns `"converged": true`
  (queue empty or `max_rounds` reached). Produce the report; do not keep
  spawning.

## The flow

### 1. Initialize (once)
```bash
python3 skills/codebase-inspection-loop/loop.py init --path . --max-rounds 8
```
Returns a `run_id`. State lives in `data/codebase-inspection/<run_id>/`
(`manifest.json` = all files w/ LOC+lang+weight; `ledger.json` = queue+findings).
Seed the queue from the manifest (every file = a `todo`).

### 2. Loop (rounds)
Repeat while `next` says `converged: false`:

a) **Get the next batch** (priority-ordered by file weight, high-first):
```bash
python3 skills/codebase-inspection-loop/loop.py next --run <run_id> --limit 3
```
It marks the batch `doing`, bumps the round counter, and prints the batch +
`converged` flag.

b) **Fan out** — launch the batch as `delegate_task` calls in ONE `tasks=[...]`
call (up to 3 concurrent). Give each worker FULL context:
```
GOAL: <the inspection goal, verbatim>
FILE: <absolute path>   (worker should read it)
ANGLE: <e.g. "find bugs / dead code / coupling / missing tests / secrets">
ACCEPTANCE: return file:line findings, severity, and any OTHER files that
            should be inspected next (callers, deps). No questions.
```

c) **Record** each worker's result:
```bash
python3 skills/codebase-inspection-loop/loop.py record \
  --run <run_id> --file <rel_path> \
  --summary "..." --severity low|medium|high|critical \
  --refs "a.py:12,b.py:40" \
  --enqueue "other/module.py:called by inspected file"
```
`record` marks the file `done`, appends the finding, and (with `--enqueue`)
adds high-priority `todo` items — this is what makes it a *loop*, not a pass.

### 3. Converge
When `next` returns `converged: true`:
```bash
python3 skills/codebase-inspection-loop/loop.py report --run <run_id>
```
Produce a synthesized report: group findings by severity, call out the
few highest-impact items, and name the single recommended next action.
Log the run to `audit/audit.log` and (optionally) persist a summary into the
brain via `python3 brain-cli.py ingest` so it is searchable later.

## Recovery / re-entrancy
`loop.py` is fully resumable. If the session is interrupted, just re-run
`next --run <run_id>` — already-`done` files stay done and the queue picks up
where it left off. To inspect a fresh repo, `init` a new run.

## Output
- `data/codebase-inspection/<run_id>/ledger.json` — full durable record
- A Markdown report (printed + saved to the run dir)
- Findings grouped by severity, with the top recommendations

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
- Primary: hermes (this session, orchestrating delegate_task subagents)
- Fallback: none — this is a single-source orchestration skill

## Dependencies
- `delegate_task` tool (subagent fan-out)
- `python3` (the engine script — stdlib only, no pip installs)
- `brain-cli.py` (optional, for persisting the report to the brain)
