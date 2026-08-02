# Active Projects

## Agentic OS (Current)
- Status: Active — hardening/expansion (past Phase 1: central brain, WS terminal, agent registry, port unification shipped)
- Last activity: last commit 2026-07-26 (e4209d2); **18 commits unpushed** on `local-hardening-merged` + **90 dirty working-tree entries** (up from 89). 0 commits in last 48h (re-checked 2026-08-02 22:00 UTC). `main` diverged: ahead 3 / behind 61.
- Skill layer active but failing: audit-test-plugin ran again 19:46 UTC and **errored** (5/5 lifetime runs failed). Kanban cleanup at 19:46 UTC: 6 tasks deleted, 1 created. No local git clone exists for Kitchen-Inventory or Pendelton-comms-live, so neither can be git-tracked from WSL.
- 🔴 TOP RISK: 7 days of uncommitted/unpushed work (18 commits + 89 dirty files). Nothing is pushed. Commit and push.
- ✅ RESOLVED (2026-08-01 18:48 UTC): gemini kanban task `bc45c312` — after four failures (04:00, 06:20, 11:34, 17:20 UTC) it was unblocked at 18:02 and **dispatch completed** at 18:48. Retry loop no longer firing.
- 🔴 REGRESSION (2026-08-02 17:00 UTC): **opencode is BROKEN again** — live `opencode run` returns "opencode-ai's postinstall script was not run … --ignore-scripts". The 07:57 "repaired" note is superseded. Both opencode-routed skill runs at 16:36 UTC failed. Fix: `npm i -g opencode-ai` WITHOUT `--ignore-scripts`.
- ⚠️ Eval layer logs these failed runs as `success: true` score 48 — opencode-routed skill scores are unreliable.
- ⚠️ STILL OPEN (2026-07-31): Hermes skill runs 404 on model `tencent/hy3:free` — devops-audit + memory-consolidation returned errors while logging as "done". Treat their recorded outputs as suspect.
- Priority: HIGH
- Building complete agent orchestration platform
- 8 phases planned

## Kitchen-Inventory (Active)
- Status: In development — catering kitchen management system
- Deployed on antigravity (server/host)
- Key features: invoice scanner (AI vision), barcode scanner, shelf life tracker, vendor invoice parsing
- Pipeline: Invoice image → pre-process → Gemini vision (primary) → GPT-5.5 (backup) → vendor detection → Claude (text→JSON) → math audit → Firebase write
- Vendor invoices: Sysco, Vern's, US Foods (each with custom prompts)
- Shelf scans: photo → Gemini → JSON array of items
- Code under review: geminiService.ts has 18 issues (4 critical) — wrong shelf prompt in GPT fallback, analyzeImage ignores prompt, no shelf retries, bad model names, bare catches

## Pendelton-comms-live (Active)
- Status: ⚠️ STALE (no activity since 2026-02-28, ~5 months) — revive or mark dormant
- Purpose: Walkie talkie for employees spread out at big catering events
- GitHub: https://github.com/Linecheck-store/Pendelton-comms-live (private)
- Last worked on: 2026-02-28
- Tech: Node.js + Express + Socket.IO signaling, React + TypeScript frontend
- Audio: WebRTC peer-to-peer, STUN/TURN configured
- Deployed on Railway
- Known issues: audio cutting out on mobile Safari, reconnection logic needs improvement

- [Ship Agentic OS v1](goal:c24b3d85) — Complete audit and fix all issues

- [Push everything in the Kanban board down the line](goal:2c4b22ac) — It involves different skills to get different things done.

- [2 Teamworkflow](goal:822393ee) — A work flow that creates an AI agent loop that has them research, plan, implamen
