# Learnings

## 2026-05-17
- Run weekly to keep memory files under 600 words
- Archive decisions older than 30 days
- Check for contradictions across skills

## 2026-06-26
- hermes timed out on memory-consolidation (model too slow)
- Recommend: try shorter queries or check OpenRouter rate limits

## 2026-06-28
- All 18 learnings.md files under 600 words — no compression needed
- All score-history.json files empty — no pruning needed
- recent-decisions.md: 3 archived entries (older than 30 days), 0 recent
- No contradictions found across skill learnings
- Stale truncated run logs cleaned from memory-consolidation, code-review, goal-planner, test-plugin

## 2026-06-29 (Run 2)
- All 18 learnings.md files still under 600 words (largest: memory-consolidation at 186)
- All 18 score-history.json files empty — no pruning needed
- recent-decisions.md: 3 archived entries (from 2026-05-17), 0 recent — no archiving needed
- No contradictions found across skill learnings
- Cleaned stale truncated run log from memory-consolidation learnings.md (leftover from previous run)

## 2026-07-17 (Run — full)
- Agent: hermes
- Input: (none)
- All 18 learnings.md files under 600 words (largest: memory-consolidation at 245) — no compression needed
- All 18 score-history.json files empty (`[]`) — no pruning needed
- recent-decisions.md: 3 archived entries (from 2026-05-17, already >30 days old), 0 recent — no archiving needed
- No contradictions found across skill learnings
- Cleaned stale truncated run log (Run 0e7b20b5) from this file — it cut off mid-line and was leftover from an earlier failed run

## 2026-07-17 (Run 4f8a2c19)
- Agent: hermes
- Input: (none)
- 19 learnings.md files under 600 words (largest: memory-consolidation at 333) — no compression needed
- All 19 score-history.json files empty (`[]`) — no pruning needed
- recent-decisions.md: 3 archived entries (from 2026-05-17, >30 days old), 0 recent — no archiving needed
- No contradictions found across skill learnings
- Cleaned stale truncated run log (Run 82b75bcd) and stale opencode-timeout logs from firebase-hosting-basics

## 2026-07-26 (Run — consolidation)
- Agent: hermes
- Input: (none)
- 18 learnings.md files all under 600 words — no compression needed
- score-history.json: backup-skill (1 entry, 2026-07-26), code-review (2 entries, 2026-07-26) — both <20 entries, no pruning; remaining 16 empty
- recent-decisions.md: 2 recent entries (2026-06-28, 2026-07-25), both <30 days old — no archiving needed; 2026-05-17 already archived
- Cleaned corrupted run-log pollution from 4 skill learnings files (devops-audit, code-review, backup-skill, memory-consolidation): removed truncated "## Skill Instructions / name: / description:" fragments and opencode postinstall-error blocks left by failed runs
- No contradictions found across skill learnings

## 2026-07-26 (Run 33b38b7d)
- Agent: hermes
- Input: (none)
- Output: ⏱ Hermes timed out.

The model took too long to respond. Try a shorter query or check your OpenRouter rate limits.

**Message:** Execute the 'memory-consolidation' skill.

## Skill Instructions
---
name: memory-consolidation
desc

## 2026-07-30 (Run 2a0ed767)
- Agent: hermes
- Input: (none)
- Output: ─  ⚕ Hermes  ─────────────────────────────────────────────────────────────────
HTTP 404: Model 'tencent/hy3:free' not found. The requested model does not
exist in our configuration or OpenRouter catalog.
──────────────────────────────────────────────────────────────────────────────
hermes --resume 20260730_021950_469228

## 2026-07-30 09:19:55 · hermes · done
- Task: memory-consolidation
- Outcome: ─  ⚕ Hermes  ───────────────────────────────────────────────────────────────── HTTP 404: Model 'tencent/hy3:free' not found. The requested model does not exist in our configuration or OpenRouter catalog. ────────────────────────────────────────────────────────────────────────────

