# Learnings

Add lessons learned from each run here.

## Initial Setup
- Skill created: a *looping* (multi-round, finding-driven) codebase inspection
  orchestration, distinct from the single-shot fan-out skills.
- Deterministic engine `loop.py` owns all loop state (manifest + ledger) so the
  agent never hand-maintains the work queue — reproducible and resumable.
- Subagents are THIS session's `delegate_task` leaf workers only (single-source).
