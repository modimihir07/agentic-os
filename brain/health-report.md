# Brain Health Report

> Generated: 2026-08-02 15:00 local (~22:00 UTC)

## Status: needs attention

### Memory Files
- memory.md: 248 words (OK, limit 600)
- active-projects.md: 3 projects (1 stale — Pendelton-comms-live)
- log.md: 23 entries (OK, limit 500)
- recent-decisions.md: 31 lines (OK, nothing >30 days needing archive)
- audit/audit.log: 373 entries, parses cleanly (no JSONL corruption)

### Projects
- **Agentic OS**: Active — hardening/expansion. Last commit 2026-07-26. 0 commits in 48h. 🔴 18 unpushed commits + 90 dirty files.
- **Kitchen-Inventory**: Active — on antigravity host, no local clone. geminiService.ts review findings (18 issues, 4 critical) still open.
- **Pendelton-comms-live**: ⚠️ STALE — no activity since 2026-02-28 (~5 months). Revive or mark dormant.

### GitHub
- Agentic OS: 0 commits in 48h, **18 unpushed**, 90 dirty entries; `main` diverged (ahead 3 / behind 61)
- Kitchen-Inventory: repo not cloned locally
- Pendelton-comms-live: repo not cloned locally

### Skills
- 46 `skill_run` events lifetime; 24 `skill_scored` events
- 10 skills with learnings.md content; **0 new learnings since 2026-07-30**
- 9 skills with eval data; scores clustered 45–53 (low signal)
- 🔴 audit-test-plugin: 5/5 lifetime runs errored, most recently 2026-08-02 19:46 UTC

### Alerts
1. 🔴 **Unpushed work** — 18 commits + 90 dirty files on `local-hardening-merged`, nothing on remote for 7+ days. Highest data-loss risk.
2. 🔴 **opencode still broken** — live `opencode run` returns "postinstall script was not run" (installed with `--ignore-scripts`). Fix: `npm i -g opencode-ai` without `--ignore-scripts`. All opencode-routed skill/kanban dispatch fails.
3. ⚠️ **Eval layer lies** — failed runs recorded as `success: true` with a score. Skill scores untrustworthy until fixed.
4. ⚠️ **audit-test-plugin** — 100% failure rate; disable or repair.
5. ⚠️ **Pendelton-comms-live stale 5 months** — decide: revive or mark dormant.
6. ⚠️ **`main` branch diverged** (ahead 3 / behind 61) — reconcile with `local-hardening-merged`.
