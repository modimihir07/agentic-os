# System Memory Map ("architectural X-ray") + Dev Task Queue: build plan

Plans Phases 2–3. Phase 1 (connector auth) is committed in `d3a2175`.

**Design rule:** this page shows how the OS is wired, how data moves through it, and why a node succeeds or fails. It repeats no Settings card; every "fix" action deep-links to the existing control. Every number comes from a live source, or reads "—" with a tooltip saying what's missing.

> **Changed 2026-11-18 (user brief, see §8):** two exceptions to "repeats no Settings card": the **User Delegation** and **Overload Cap** switches in the left column's OS-state panel write `os.json` in place. Everything else still deep-links to Settings.

## 1. Backend: one introspection command

New module **`src-tauri/src/commands/introspect.rs`**, exposing:

- **`system_introspect { deep?: bool } -> SystemSnapshot`**
  - Read-only, no LLM, no secrets.
  - Cached for 10 s; `deep: true` refreshes the probes and MCP listings.
  - Polled every 10 s by the page (paused while hidden).

| Block | Contents | Source (real) |
|---|---|---|
| `host` | CPU model + load %, RAM used/total, GPU name, VRAM used/total, GPU util | `sysinfo` (adds CPU brand) + `nvidia-smi` (existing `system_stats`). Today: RTX 3060 12 GB, Ryzen 7 3800X, 64 GB |
| `services[]` | `{id, port, up, latencyMs, detail}` for gateway :8080, LM Studio :1234 and :1235, AnythingLLM :3001, Whisper :8178, Kokoro :8880, n8n :5678 | Concurrent probes, 3 s timeout. Extends `services_health`, which already covers most of these and n8n. Probed now: :1234 down, the rest up |
| `agents[]` | Tony + Coder, Designer, Prompter, Librarian, Booking Desk (+ Ops): workspace slug, chat model, agent model, `active` | os.json role→slug map; models from AnythingLLM's `/v1/workspaces` (extend `anythingllm_workspaces`); `active` from the `gpu-slot` active labels |
| `rules` | MASTER_IDENTITY.md path, size, mtime, heading and bullet counts; HANDOFF guardrail count | `os_identity` path (`C:\ai-hub\master\MASTER_IDENTITY.md`), parsed in Rust |
| `skills` | Count + list of `SKILL.md` modules per root, with which agents each is granted to | Scans the configured skills roots, `C:\ai-hub\.claude\skills` (102) and repo `skills/` (16), joined with os.json `skills.grants` |
| `routines` | Rust background loops (inbox drain, whisper ensure, local-fit, droplet monitor) with interval and last run; gateway scheduler jobs; n8n workflows | Loops record `last_run` into a small shared struct; gateway `/api/scheduler/jobs`; os.json `n8nWorkflows` + n8n `/api/v1/workflows` when an n8n key is set |
| `stores[]` | Per store: path, size, tables + row counts, read/write health | Read-only opens: `devqueue.db` (new), gateway `data/command-center/cc.db`, `data/memory.db`, AnythingLLM `anythingllm.db`, `training_logs/*.jsonl` lines, `knowledge-graph.json` (**currently missing on disk**, shown as such), cc.db `vault` embedded count = RAG vectors |
| `bus[]` | Each MCP server / direct API: transport, status (`ok`/`needs_token`/`auth_failed`/`error`/`off`), tool count, last-call latency, last error | Cached `mcp_list_tools` (Phase 1 statuses) + **new** per-server call stats recorded in `mcp::call_tool` (`calls`, `lastMs`, `lastOk`, `lastError`), Spotify status, Brave/Gmail source |
| `ipc` | Dev X-Ray only: recent Tauri command names with duration | A TS `cmd()` wrapper keeps a ring buffer of the last 200 invocations. Kept in TS because Tauri has no Rust-side hook |

## 2. Live routing trace: drives both the pulses and the stream

**`TraceStep`:**

```
{ traceId, seq, hop, zone, label, ok, ms, error?, at }
```

| Field | Values |
|---|---|
| `hop` | `input` · `vad` · `stt` · `router` · `rules` · `memory` · `model` · `tool` · `tts` · `ui` |
| `zone` | `cockpit` · `engine` · `ecu` · `cargo` · `exhaust` |

Who emits each hop:

| Hops | Emitted by | Notes |
|---|---|---|
| `input` / `vad` / `stt` / `tts` / `ui` | TS, in `voice-controller` | Measured client-side |
| `router` | Rust, new `os-trace` event in `agents::os_turn` | Route kind + role |
| `rules` | Rust, `os-trace` | Identity/system prompt loaded |
| `memory` | Rust, `os-trace` | Librarian search, memory reads |
| `model` | Rust, `os-trace` | Provider + model + ms + tokens/s from the token stream rate |
| `tool` | Rust, `os-trace` | Server.tool, ok, ms, error text only |

- No arguments, results or secrets are ever put in a step.
- **`useTrace` store** (zustand, last 500 steps) feeds:
  - the **stream panel**;
  - the **3D pulses**: each step lights the leader path from the previous zone to its zone (e.g. cockpit → engine → ecu → cargo → exhaust).

## 3. Frontend: components (`src/features/memmap/`)

- **Route:** section `memorymap` ("System Map"), lazy `MemoryMapSection.tsx`, URL `#/memorymap`, desktop-first.
  - **Layout:** grid `[280px | 1fr | 340px]` × `[auto | 1fr | 220px]`.
  - **Below `md`:** panels stack and a static SVG chassis replaces the 3D one.
- **`TopStatusBar`:**
  - Title "TONY OS // Gabagool Command Center"
  - App uptime (new `app_uptime`), gateway RTT
  - Active agents (`gpu-slot` active + queued)
  - Host chip from `host`
  - Auth pill showing real state: "LOCAL" / "GATEWAY TOKEN SET". There is no user-auth system behind "TONY_ADMIN".
- **`HoloViewport`** (three.js, lazy chunk):
  - **Model:** procedural E46 Touring wireframe; Orient Blue edges with cyan/amber highlights; `GABAGOUL` plate as a `CanvasTexture`.
  - **Motion:** auto-rotate, drag to orbit, 30 fps cap; paused when hidden; a static frame under reduced motion.
  - **Zones:** 5 invisible hit-volumes (hood, firewall/ECU, cabin, hatch, exhaust). Hover glows the zone; click opens its inspector.
  - **`PulseLayer`:** glowing dots along spline paths between zone anchors, from `useTrace`.
- **`ZoneInspector`** (right-side drawer over the stream):

| Zone | Shows |
|---|---|
| Engine | Tony → provider chain with live up/latency; sub-agent list with model and active flag; last-reply tokens/s |
| ECU & Wiring Harness | Rules (MASTER_IDENTITY.md stats, guardrails), Skills (searchable list, agent bindings), Routines (loops, scheduler jobs, n8n workflows with last run) |
| Cargo | Stores table: rows/size/health; RAG vector count; knowledge-graph presence |
| Cockpit | Mic/Text → VAD → Whisper → Intent Router → TTS, each hop with its last and median ms from `useTrace` |
| Exhaust | Bus topology: one node per MCP server or API with status colour, latency, last error, and an "Open in Settings" link |

- **`GabagoolBlueprint`** (lower-right of the canvas): a rotating wireframe slice and the label "GABAGOOL BLUEPRINT // High-Density Cold-Cut Cache". Clicking it switches **Dev X-Ray** ↔ **Streamlined OS**, persisted in settings.
  - **X-Ray** adds ports, file paths, IPC command names and durations, and per-hop ms with the slowest hop flagged.
  - **Streamlined** collapses those into status colours and plain words.
- **`TraceStream`** (right, top): a scrolling, auto-pausing log of `useTrace`. Failed steps get **Queue Fix**, which calls `dev_task_add` with the step and its error attached.
- **`IntentNoteBar`** (right, bottom): text input + mic + **Dispatch**.
  - Typed or dictated text becomes a `dev_task_add` with a connector snapshot.
  - A voice OS intent ("log a dev note …", "queue a fix for …") does the same from any screen.
- **`TaskDock`** (bottom): rows with a status pill (click cycles), category filter chips and priority; **Export Session Brief**.

## 4. Phase 3: SQLite task queue

**File:** `%APPDATA%\os.agentic.commandcenter\devqueue.db`. It's Rust-owned (`rusqlite` bundled is already a dependency), so it works with the gateway down. Uses WAL and `PRAGMA user_version` migrations.

```sql
CREATE TABLE dev_task_queue (
  id               TEXT PRIMARY KEY,                       -- uuid
  title            TEXT NOT NULL,
  category         TEXT NOT NULL DEFAULT 'backend'
                   CHECK (category IN ('mcp','auth','ui','backend','routing')),
  priority         INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3),   -- 0 = urgent
  status           TEXT NOT NULL DEFAULT 'Pending'
                   CHECK (status IN ('Pending','Queued','In Progress','Done')),
  context_snapshot TEXT NOT NULL DEFAULT '{}',             -- JSON (below)
  kind             TEXT NOT NULL DEFAULT 'task' CHECK (kind IN ('task','note','fix')),
  body             TEXT NOT NULL DEFAULT '',
  source           TEXT NOT NULL DEFAULT 'typed' CHECK (source IN ('typed','voice','trace','phone')),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX dtq_open ON dev_task_queue(status, priority, created_at);
```

**`context_snapshot`** is built in Rust at insert, from the cached introspection snapshot, with no new network calls:

- services up/latency by port
- bus statuses and last errors
- active agents
- voice state
- git branch + HEAD
- for `fix`, the failing `TraceStep`
- secrets are never included (only statuses and error text, already secret-free per Phase 1)

**Category inference** when none is given:

| Text contains | Category |
|---|---|
| token, 401/403, auth | `auth` |
| mcp, connector, tool | `mcp` |
| route, router, intent | `routing` |
| ui, layout, css, widget | `ui` |
| anything else | `backend` |

**Commands:**

- `dev_task_add`
- `dev_task_list {status?, category?}`
- `dev_task_update {id, status?, priority?, title?, category?}`
- `dev_task_delete`
- `dev_brief_export`, which:
  - builds Markdown: open Pending/Queued/In Progress tasks by priority, notes since the last export, current connector diagnostics, git state, suggested next command;
  - writes `<repo>/memory/session_handoffs/YYYY-MM-DD-HHMM.md` (fixed directory, generated name);
  - returns the text, which the UI copies to the clipboard.

## 5. Build order

1. `devqueue.rs` + migrations + commands + Rust tests.
2. `introspect.rs` (+ `app_uptime`, CPU brand, MCP call stats, loop last-run, `anythingllm_workspaces` models) + tests.
3. `os-trace` emission in Rust + TS hops + `useTrace`.
4. Page shell, top bar, `TraceStream`, `IntentNoteBar`, `TaskDock`, Export Session Brief.
5. `HoloViewport` (procedural E46, plate, zones, inspector, pulses), `GabagoolBlueprint` + X-Ray/Streamlined.
6. Independent review + adversarial verification, full test suite, browser check of the page (3D included: the dev web build renders it; IPC data needs the desktop app).

## 6. Decisions needed before building

1. **Add `three`, `@react-three/fiber`, `@react-three/drei`.** These are new npm dependencies, about 150 KB gzipped, loaded only in the lazy chunk for this page.
2. **Car model:** a procedural wireframe built in code (recommended: no asset, no licence question, easy to split into zones), or will you supply a licensed glTF of an E46 Touring?
3. **`memory/session_handoffs/`:** add it to `.gitignore` (you keep `memory/` out of commits)? It is in the Drive-sync list, so exports also back up there.
4. **Dispatch** on the note bar logs to the queue only (Tony isn't messaged). Confirm.

## 7. Build status (2026-11-18)

Built: parts 1–5 above, plus an independent 4-lens review with adversarial verification. All confirmed findings are fixed:

- **Deep-scan timeouts** go to a System-Map-only `SCAN_TIMEOUTS` map, never to `FAILED`, so Tony's tool routing is unaffected.
- **Prefetch tool timeouts** now appear in the bus call stats.
- **Note-bar dictation vs hands-free:**
  - `holdWake` / `isPassiveWakeListen` in voice-controller pause wake re-arming while dictating.
  - A passive wake listen gives way to dictation.
  - A listen the user opened still wins.
- **Voice dev-note intent:**
  - accepts Whisper's sentence punctuation;
  - "write/add/make/create a dev note …" needs an explicit separator;
  - structural bodies ("… in the README", "… template") and second requests ("… and email it to Sam") fall through to Tony;
  - a pronoun-only title ("add this to the dev queue") is refused.
- **Typed dev-queue intents** are stored with `source: typed`.
- **Trace stream** "Paused · N new" counts by identity (`stepsSince`), so it stays correct once the 500-step ring is full.
- **PWA service worker** no longer precaches the three.js `HoloViewport-*.js` chunk (976 kB / 265 kB gzip).
- **Session brief:** notes are listed only under "Notes since…", never as open tasks or as the suggested next command.

Checks:

| Check | Result |
|---|---|
| typecheck | clean |
| vitest | 466/466 |
| test:scripts | 6/6 |
| `vite build` | ok |
| Rust | 185 pass / 12 ignored |

Rust ran via the test exe with a Common-Controls v6 manifest beside it; see below.

**Open issue (not from this work):** plain `cargo test --lib` exits `0xC0000139` (STATUS_ENTRYPOINT_NOT_FOUND). The test exe now imports `comctl32!TaskDialogIndirect`, which arrived with the `src-tauri/src/audio` / `cpal` work. tauri-build embeds the Common-Controls v6 manifest only into the app binary. The durable fix is to embed the manifest for test targets as well, in `build.rs`.

**Not verified:** anything that needs the desktop app:

- live `system_introspect`
- `os-trace` emission
- `dev_task_*` and the brief export
- Whisper dictation
- the voice intent end to end

The web preview showed the 3D car, pulses (including a failed hop), the zone inspector, the X-Ray toggle and the stream, all using injected trace steps.

## 8. Layout v2 (2026-11-18): routing flowchart, OS-state panel, future-tasks dock

**Layout** (`MemoryMapSection.tsx`, `CentreStage.tsx`)

- lg grid is still `[260 | 1fr | 320]` (xl `[280 | 1fr | 340]`) × `[auto | 1fr | 220]`. The centre cell is now a column: the **Architecture Routing** strip on top, the 3D stage under it (`min-h 340px`).
- The strip is collapsible (`systemMapFlowOpen` in `stores/settings.ts`; `null` = expanded only when the window is ≥ 900 px tall). Collapsed it is a 44 px row of status chips that light up on activity; expanded it is ~170 px.
- When the page is shorter than the grid needs (880 px expanded / 760 px collapsed), the grid takes that fixed height and the page scrolls instead of crushing the car.
- The stage reports its height: under 420 px the exhaust callout drops its node pills (`ZoneCallouts compact`), and the exhaust card never sits above `8.5rem`, so it clears the cargo card and the Gabagool inset (bottom-right, unchanged export/props).
- Below `md` the flowchart stacks vertically (sources / routing / destinations as rows) over the static chassis. Below 360 px of width any layout uses the stacked form.

**Flowchart** (`flow-graph.ts` pure + tests, `RoutingFlowchart.tsx` SVG; no second WebGL context)

| Column | Nodes |
|---|---|
| Sources | Gmail API · Local Filesystem · Memory Mapping · Voice / Audio Engine · Telemetry |
| Routing | Brave Search · MCP Server Hub · Tony Dispatcher |
| Destinations | Spotify / Media Output · Write to Memory Database · Sub-Agent Execution |

Edges: gmail→hub, fs→hub, memory→hub, voice→tony, telemetry→tony, memory→tony, fs→tony, hub→brave, hub→tony, hub→media, tony→memwrite, tony→subagents, tony→voice. Cyan = data in to be routed, amber = outbound action (from Tony, or into a destination).

| Event | Pulse |
|---|---|
| `tool` hop (stage prefix stripped; server per `mcp::server_of_tool`) | gmail / gmail-multi → gmail→hub; filesystem / git → fs→hub; knowledge-graph → memory→hub; brave-search → hub→brave; spotify → hub→media; anything else flashes the hub. Always + hub→tony. `PERMISSION_*` error: hub→tony only, hub flashes red |
| `memory` | memory→tony (+ tony→subagents for `anythingllm/` or a non-ledger pipeline); pipeline `ledger · librarian …` → tony→memwrite |
| `model` | `anythingllm/`, `overseer…` (prefix stripped) or a non-ledger pipeline → tony→subagents; the main chain (`provider · model`, no slash) flashes Tony |
| `router` | non-ledger pipeline → tony→subagents; otherwise flashes Tony |
| `rules` | fs→tony; pipeline `handoff verifier` → tony→subagents |
| `vad` / `stt` / `input "voice line"` · `tts` | voice→tony · tony→voice |
| `ui` / `input "typed line"` | flashes Tony |
| IPC `dev_task_add/update/delete`, `memory_harvest/flush/mount` | **inferred**: flashes Memory DB only (user / app writes, never a Tony edge) |
| IPC `spotify_control / play / play_uri` | **inferred**: flashes Media (these bypass `call_tool`, so there is no trace) |
| Snapshot `at` changes · store counters grow (devqueue rows, training-log lines today, cc vault items) | **inferred**: telemetry→tony · flashes Memory DB |

Inferred pulses are drawn dashed and titled "inferred": they are ≥ 10 s stale (poll + Rust cache) and are not os-trace hops. Real per-write hops would need Rust emits (out of frontend scope).

Status LEDs: bus status (Gmail, Brave, Spotify, filesystem + git, the hub aggregate), STT/TTS services + voice state, host sampling + daemon loops, stores, the chain head's service, writable stores, the sub-agent roster. Missing source = idle LED with a "why".

Motion: one rAF loop capped at 30 fps that runs only while a pulse or flash is live, the window is visible and the strip is on screen (IntersectionObserver); ≤ 16 live pulses; edge points precomputed (`edgeSamples`). Reduced motion (and the collapsed strip): no travel, the wire / node lights up and a single 1.5 s timeout clears it. Clicking a node opens its car zone's inspector (gmail / brave / media / hub / fs → exhaust, tony / subagents → engine, memory / memwrite → cargo, voice → cockpit, telemetry → ecu).

**Left column** (`OsStatePanel.tsx` above the subsystem cards, which now fold under one "Subsystems" toggle)

| Row | Value |
|---|---|
| Deployments | services up / total; tooltip lists each probe (label, port, up, latency) |
| Memory mapping | stores ok / total · RAG vectors; click opens the cargo inspector |
| Task queue | open · in progress (devqueue; loaded by the dock; desktop only) |
| Active API keys | services with a credential / services with a known presence source. **Names and counts only, never values.** Brave / Gmail / Spotify from the .env-aware `bus.source`; the rest from one `os_secret_status` call on mount (keychain-only; never polled). ElevenLabs has no presence source here (unknown). Warn when a bus server needs or rejected a token |
| System | CPU / GPU / VRAM % + daemon health |

Switches (via `useOsCfg()`: errors surface under them; disabled outside the desktop app):

- **User Delegation**: `permissions.delegation` allow ⇄ ask. `deny` shows locked and is never flipped from here.
- **Overload Cap**: `compute.mode` hybrid ⇄ local. Disabled (not collapsed) when the mode is `cloud`. Hybrid also offloads heavy contexts, and the hint says so; `vramThresholdPct` is shown read-only.

**Bottom dock** (`TaskDock.tsx`): retitled **Future tasks & autonomous queue**. "Dev queue" tab = the devqueue rows with a coloured status accent (Pending amber, Queued cyan, In Progress teal, Done grey) and the priority badge. "Scheduled" tab = `futureRuns(snap, now)` (format.ts): enabled gateway scheduler jobs with a next run, daemon loops (last run + interval; overdue flagged), active n8n workflows and the GPU-slot queue, sorted by due time; the scheduler / n8n notes show when those sources are missing.
