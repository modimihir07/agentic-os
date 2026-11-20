---
name: heartbeat
description: Lightweight system health monitoring skill
version: 1.0.0
author: Agentic OS
tags: [monitoring, health, system]
---

# Heartbeat — System Health Monitor

## Description
Checks system health at regular intervals: agent status, disk usage, memory pressure, and recent audit errors. Flags anomalies and triggers alerts if thresholds are breached.

## When to Use
- Every 5 minutes as a scheduled cron job
- On-demand to check system health
- Before and after running other skills

## Process
1. Check the CLI agents (opencode, agy, claude, gemini, llm) are online
2. Check disk usage (< 90%)
3. Check memory pressure (< 80%)
4. Scan recent audit log for errors
5. Update brain/recent-decisions.md if issues found
6. Return health summary

## Output
JSON health report with pass/fail per check

## Agent Assignment
- Primary: opencode
- Fallback: claude
