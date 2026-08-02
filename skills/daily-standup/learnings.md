# Learnings

## 2026-05-17
- Reads from brain/ files and audit log
- Runs best at session start

## 2026-05-18
- Multipleup runs confirm: consistent pattern of reading brain/ + audit log
- Both opencode and hermes agents execute standup successfully
- Known backup filenagentic-os-20260517_163610.tar.gz created & restored

## 2026-06-23
- hermes agent returns partial output when session times out mid-execution
- openerate agent reads brain/ files correctly via Read tool
- Recommend: use `hermes chat -q "morning briefing"` for faster standup execution

## 2026-07-25 (Run efcfb319)
- Agent: hermes
- Input: Generate today's standup notes
- Output: I'll execute the daily-standup skill. Let me gather the context from the
brain files and audit log.
Now let me check the audit log and pending tasks (kanban/goals).
Let me read the kanban task files to see pending work, and check today's
journal.
I have all the context I need. Here's today's daily standup.
══════════════════════════════════════════════
DAILY STANDUP — Saturday, July 25, 2026
══════════════════════════════════════════════
YESTERDAY / RECENT ACTIVITY (last 24h + recent log)
- 2026

## 2026-07-25 (Run ba720ad7)
- Agent: hermes
- Input: standup
- Output: I'll execute the daily-standup skill. Let me gather context from the
brain files, audit log, and task systems in parallel.
Now let me check the kanban tasks, goals, and today's journal entry.
Let me read the kanban task files to assess their status.
Daily Standup gathered. Here's the briefing.
══════════════════════════════════════════════
DAILY STANDUP — Saturday, July 25, 2026
══════════════════════════════════════════════
YESTERDAY / RECENT ACTIVITY (last 24h + recent log)
- 2026-07-25 17:10 

## 2026-07-31 (Run 1cec5bcb)
- Agent: hermes
- Input: (none)
- Output: I'll execute the daily-standup skill. Let me gather context from the brain files, audit log, task systems, and journal in parallel.
Now let me read the kanban tasks, the audit log (last 24h), and check for today's journal entry.
The audit log is large. Let me read the tail to see the most recent activity (last 24h, around July 29-30).
I have all the context needed. Here's today's daily standup.
══════════════════════════════════════════════
DAILY STANDUP — Thursday, July 30, 2026 (evening run)
═

## 2026-07-31 00:37:12 · hermes · done
- Task: daily-standup
- Outcome: I'll execute the daily-standup skill. Let me gather context from the brain files, audit log, task systems, and journal in parallel. Now let me read the kanban tasks, the audit log (last 24h), and check for today's journal entry. The audit log is large. Let me read the tail to see

