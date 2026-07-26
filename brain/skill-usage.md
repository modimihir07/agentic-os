# Skill Usage & Effectiveness

> Last updated: 2026-07-26 (brain-guardian)

## Most Used Skills (by audit log count)
| Skill | Runs | Last Run | Notes |
|-------|------|----------|-------|
| memory-consolidation | 13 | 2026-07-26 | Latest run FAILED — Hermes timed out (180s) |
| code-review | 8 | 2026-07-26 | Recent runs failed via opencode (postinstall broken) |
| daily-standup | 4 | — | |
| backup-skill | 3 | 2026-07-26 | opencode broken |
| test-plugin / tdd-cycle / heartbeat / goal-planner / firebase-hosting-basics / firebase-ai-logic-basics | 2 each | — | |

## Eval Data (score-history.json)
| Skill | Has Data |
|-------|----------|
| code-review | yes (largest history) |
| heartbeat, firebase-ai-logic-basics, backup-skill, memory-consolidation | yes (1–2 entries) |
| others | empty |
Scores are all ~45–50 stub-quality; no meaningful eval trend yet.

## New Learnings Since 2026-06-28
15 skills have learnings.md updated 2026-07-17 → 2026-07-26 (backup-skill, code-review, devops-audit, memory-consolidation most recent on 2026-07-26).

## Skills Per Project
| Project | Skills Used |
|---------|-------------|
| Agentic OS | daily-standup, heartbeat, devops-audit, memory-consolidation, backup-skill |
| Kitchen-Inventory | code-review, firebase-ai-logic-basics, firebase-hosting-basics, systematic-debug, tdd-cycle |

## ⚠ Alerts
- **opencode agent broken** (installed with --ignore-scripts; postinstall never ran). All opencode-dispatched skill runs on 2026-07-25/26 returned errors, yet audit still logs success=true with score ~50 — scoring is masking failures.
- Kanban dispatch to opencode failed (task fffc3981, 2026-07-26).
- memory-consolidation via hermes timed out on 2026-07-26 17:03 UTC.
