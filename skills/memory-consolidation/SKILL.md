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

## Agent Assignment
- Primary: opencode
- Fallback: claude
