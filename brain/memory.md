# Persistent Memory

## System
- 3 agents configured: opencode, Hermes Agent, Gemini CLI
- Dashboard runs on FastAPI (Python) — localhost only
- All skills follow _template/ convention
- Memory consolidation: 2026-07-26 (run — 4 skill learnings files cleaned of corrupted run-log pollution)

## User
- Name: User
- Budget: Strictly free tiers

## Active Work
- Building Agentic OS from scratch (May 17, 2026)
- Kitchen-Inventory — catering kitchen management system (on antigravity)
- Pendleton-comms-live — walkie talkie app for catering events (on Railway)

## Technology Preferences
- Preferred model: deepseek-v4-flash-free
- Free tiers: GCP Free, GitHub Student Dev Pack, Colab, Kaggle
- Knowledge management via markdown vaults

## Consolidated Insights (2026-07-26)
- **opencode** times out on non-code tasks (brainstorming, tdd-cycle, backup-skill, code-review, goal-planner, test-plugin) — route these to hermes
- **opencode** run failures leave corrupted run-log fragments (truncated "## Skill Instructions / name: / description:" blocks, postinstall errors) in learnings.md — clean these up during consolidation
- **hermes** can also time out on complex multi-step tasks — keep queries short
- **daily-standup** is the most-run skill; hermes executes faster than opencode for it
- **Score tracking**: backup-skill (1 entry) + code-review (2 entries) now have single-run eval scores from 2026-07-26; remaining 16 skills empty — no pruning needed (all <20 entries)
- **All learnings files** are concise (under 400 words each), no compression needed
- **No contradictions** found across skill learnings
- **recent-decisions.md**: 2 recent entries (2026-06-28, 2026-07-25), 2026-05-17 trio archived — no archiving needed
