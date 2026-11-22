# Recent Decisions

## 2026-11-22
- Reviewed PR #6 (Jarvis Command Center by @nicholas15rae). Decided to close PR to preserve core 3-agent engine (Hermes preservation) and maintain test stability.
- Formally adopted the **Voice Command Center & Desktop HUD** (Tauri v2 + hands-free voice) as the flagship feature of **v5.0**, to be engineered modularly with an authenticated API bridge and 100% test coverage.

## 2026-10-22
- Standardized version numbering format across entire repository to major.minor format (`v1.0`, `v2.0`, `v3.0`, `v4.0`).
- Generated official GitHub releases and semantic git tags for all 4 milestones.
- Standardized git commit attribution to `modimihir07`.

## 2026-08-12 (v4.0)
- Replaced Gemini CLI with agy CLI across backend, routing, frontend, skills, and docs.
- Added Chat History search, chat file attachments, SQLite FTS5 Memory Knowledge Graph, and Code Diff Viewer (expanded test suite to 74 tests).

## 2026-06-29 (v3.0)
- Shipped Event-Driven Scheduler, Webhooks, Error Dashboard + Circuit Breaker, Persistent Memory Search (SQLite FTS5), and Mobile PWA.

## 2026-06-05 (v2.0)
- Shipped Kanban Board, Goals Tracker, Daily Journal, Smart Router, Agent Health, Learning Analytics, and Session Replay.

## 2026-05-17 (v1.0)
- Created Agentic OS project structure.
- 3-agent architecture: opencode (code) + Hermes (memory/channels) + agy (research).
- Web dashboard only — FastAPI + vanilla JS SPA.
- Maximum breadth skill set (15+ skills seeded).
- Git auto-versioning enabled for brain/ and skills/.
