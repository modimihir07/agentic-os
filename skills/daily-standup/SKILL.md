---
name: daily-standup
description: Morning briefing with project status overview
version: 1.0.0
author: Agentic OS
tags: [productivity, standup, daily, briefing]
---

# Daily Standup

## Description
Generates a morning briefing with current project status, recent changes, pending tasks, and priorities for the day. Integrates with audit log and recent decisions.

## When to Use
- Every morning
- At the start of a work session
- Before planning the day

## Process
1. Read active-projects.md for current status
2. Check recent audit log entries (last 24h)
3. Review recent-decisions.md
4. Identify blocked items and priorities
5. Generate standup summary

## Output
Morning briefing markdown with: yesterday's work, today's priorities, blockers

## Agent Assignment
- Primary: opencode
- Fallback: claude
