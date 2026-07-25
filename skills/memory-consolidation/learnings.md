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

## 2026-07-17 (Run 5e7d871e)
- Agent: hermes
- Input: (none)
- Output: ⏱ Hermes timed out.

The model took too long to respond. Try a shorter query or check your OpenRouter rate limits.

**Message:** Execute the 'memory-consolidation' skill.

## Skill Instructions
---
name: memory-consolidation
desc
