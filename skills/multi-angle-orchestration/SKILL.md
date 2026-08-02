---
name: multi-angle-orchestration
description: Spin up 5+ parallel subagents (delegate_task leaf workers, all on this same Hermes session — NO external/separate AIs) on one project goal from different angles, then converge. Single-source orchestration for fast deployment.
version: 1.0.0
---

# Multi-Angle Orchestration (single-source, fast)

When the user gives an end goal and says "call up some subagents," this is the
playbook. All work is done by THIS Hermes session's own `delegate_task`
subagents — there is NO opencode / gemini / hermes CLI invocation, no external
agent, no second AI. Fast deployment: parallel fan-out, then converge.

## Hard rules
- **≥5 subagents, always.** Decompose the goal into at least 5 distinct angles.
- **All same source.** Every subagent is a leaf worker on this session's model.
  Never call execute_agent / the 3 CLI agents / a separate AI.
- **Parallel.** Launch in one background batch where possible. The tool runs
  up to 3 concurrently for this user, so issue 5+ as: first batch of 3, then a
  second batch of the remaining (still effectively parallel, fast).
- **No human-in-the-loop inside workers.** Subagents can't clarify; give them
  complete context up front.
- **I converge.** When all subagents return, I synthesize their outputs into
  one result (no separate synthesizer agent needed unless the goal is huge).

## The flow
1. **Decompose** the goal into ≥5 angles. Good angle variety (pick per goal):
   - Implementer (what to build / change)
   - Researcher / evidence (facts, refs, prior art)
   - Skeptic / risk (failure modes, contradictions, what could break)
   - Integrator (how it fits the existing system / repo)
   - Communicator / docs (how to explain, UI copy, README, rollout)
   - (extra) Tester / QA, Security, Performance, Ops/Deploy
2. **Launch** each angle as a `delegate_task` with FULL context:
   - The goal, verbatim.
   - Its specific angle + acceptance criteria.
   - Relevant repo context (paths, constraints, the established patterns).
   - Instruction: return a concise, self-contained result; do not ask questions.
3. **Converge**: reconcile contradictions, produce a unified prioritized plan
   or final answer + the single next step.
4. **Log the run**: write `data/orchestration-runs/<run_id>.json` with
   {goal, angles, agents:["delegate-x5"], synthesis, timestamp}. Then
   `python3 brain-cli.py ingest` so it's searchable in Brain Search (the
   orchestration source is indexed). Optionally surface results on the
   Orchestration dashboard page.

## delegate_task call shape (per angle)
```
delegate_task(
  goal="<angle-specific deliverable>",
  context="""GOAL: <full user goal>
ANGLE: <this worker's perspective + acceptance criteria>
CONTEXT: <repo paths, constraints, prior decisions>
OUTPUT: concise, self-contained. No questions.""",
)
```
Batch up to 3 in one `tasks=[...]` call; fire the rest in a second call.

## Notes
- Subagent summaries are self-reports; verify external side-effects (writes,
  publishes) yourself before claiming success.
- Keep angle prompts tight — workers get clean isolated context, no shared
  state, so everything they need must be in `context`.
- This is the PRIMARY orchestration workflow. The Agentic OS `/api/orchestrate`
  backend endpoint (which fans out the 3 CLI agents) is an OPTIONAL headless
  alternative only — not used for this single-source workflow.

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
