---
name: cost-analytics
description: Tracks token usage and API costs across all providers
version: 1.0.0
author: Agentic OS
tags: [cost, analytics, tracking, budget]
---

# Cost Analytics

## Description
Tracks token consumption and API costs across opencode, agy, claude, Gemini CLI and llm. Computes daily/weekly/monthly projections and alerts when approaching free-tier limits.

## When to Use
- After each agent API call (auto-triggered)
- Daily cost report generation
- When checking budget status

## Process
1. Read latest cost-history.json
2. Compute today's total tokens by agent
3. Compute weekly and monthly projections
4. Compare against free-tier limits from settings.json
5. Generate alert if approaching limits (80%, 90%, 95%)
6. Update cost-analytics chart data

## Output
Cost report with: per-agent breakdown, projections, alerts, recommendations

## Agent Assignment
- Primary: opencode
