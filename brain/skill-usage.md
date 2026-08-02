# Skill Usage & Effectiveness

> Last updated: 2026-08-02

Source: audit/audit.log (373 entries) — 46 `skill_run`, 24 `skill_scored` (counted separately).

## Most Used Skills (by audit log `skill_run` count)
| Skill | Runs | Last Run | Avg Score |
|-------|------|----------|-----------|
| memory-consolidation | 13 | 2026-07-30 | 50 (n=2) |
| backup-skill | 6 | 2026-08-02 | 48 (n=5) |
| code-review | 5 | 2026-07-26 | 50 (n=3) |
| audit-test-plugin | 5 | 2026-08-02 | 45 (n=5) — all runs errored |
| daily-standup | 3 | 2026-07-31 | 45 (n=3) |
| tdd-cycle | 2 | 2026-06-26 | — |
| test-plugin | 2 | 2026-06-28 | — |
| goal-planner | 2 | 2026-06-28 | — |
| firebase-hosting-basics | 2 | 2026-06-28 | — |
| firebase-app-hosting-basics | 1 | 2026-08-02 | 45 (n=1) |
| firebase-ai-logic-basics | 1 | 2026-07-25 | 45 (n=1) |
| heartbeat | 1 | 2026-07-25 | 50 (n=1) |
| brainstorming | 1 | 2026-07-28 | 50 (n=1) |

## Most Effective Skills (by eval score, /100 scale)
| Skill | Avg Score | Scored Runs | Trend |
|-------|-----------|-------------|-------|
| devops-audit | 53 | 1 | flat |
| code-review | 50 | 3 | flat |
| memory-consolidation | 50 | 2 | flat |
| heartbeat | 50 | 1 | flat |
| brainstorming | 50 | 1 | flat |
| content-draft | 50 | 1 | flat |
| backup-skill | 48 | 5 | flat |
| daily-standup | 45 | 3 | flat |
| audit-test-plugin | 45 | 5 | flat — **scores unreliable, all runs failed** |

⚠️ Scores are compressed in a 45–53 band. The eval layer records failed
opencode/Hermes-routed runs as `success: true`, so scores are not a trustworthy
quality signal until routing is fixed.

## Skills Per Project
| Project | Skills Used |
|---------|-------------|
| Agentic OS | memory-consolidation, backup-skill, daily-standup, heartbeat, devops-audit, audit-test-plugin, goal-planner, brainstorming, multi-angle-orchestration |
| Kitchen-Inventory | code-review, systematic-debug, tdd-cycle, firebase-* |
| Pendelton-comms-live | (none since 2026-02-28) |

## Learnings activity
10 skills carry learnings.md entries; no new learnings written since the 2026-07-30
memory-consolidation run. 9 skills have non-empty score-history.json.
