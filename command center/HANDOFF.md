# Jarvis Command Center — Build Handoff (for Cline)

A **voice-first**, **local-first** Agentic OS command center. The desktop app (Tauri v2 + Rust) and the mobile PWA share one React 19 + Tailwind v4 codebase. The Agentic OS gateway (`../server.py` + `../command_center_api.py`) is the shared store, so the phone and the desktop always see the same data.
Design source: the Stitch export "Tactile Neo-Glass & Luminescent Hardware". Its tokens live in `src/styles/index.css` (`@theme`).
Read this file top to bottom before changing anything.

```bash
npm install
npm run dev            # web at http://localhost:1420 (needs the gateway on :8080)
npm run desktop:dev    # Tauri window; it starts the gateway for you
npm run build          # typecheck + PWA build → dist/ (the gateway serves it at /cc/)
npm run desktop:build  # installer
```

---

## 1. Topology

```
 Phone (PWA, NetBird/Wi-Fi) ──┐                         ┌─ LM Studio :1234  (chat, verifier, vision OCR, embeddings)
                              ├─► Gateway :8080 ────────┤
 Desktop (Tauri) ─────────────┘   server.py             ├─ n8n (Docker) :5678 (Gmail/Calendar nodes hold Google OAuth)
        │                         └ /api/cc  → SQLite    └─ Yahoo chart API   (market candles, read-only)
        │                            data/command-center/  (cc.db, files/, config.json)
        └─ Rust: keychain, routing, Whisper :8178, Kokoro/XTTS :8880, nvidia-smi, docker, netbird
```

- **The desktop app auto-starts the gateway.** If `/api/status` doesn't answer, Rust launches `python server.py` from `providers.json → gateway` (the workdir defaults to the repo). "Gateway down" now only means Python itself failed; the Active Nodes widget offers a **Start gateway** button.
- **Node health is real.** `services_health` probes each service: `/models`, `/api/status`, `/healthz`, `/audio/voices`. Nothing is shown green just because it's configured.
- **Phone setup:** run `npm run build`, then open `http(s)://<desktop NetBird IP>:8080/cc/` and choose Add to Home screen. Mic and camera need **HTTPS** on phones: start the gateway with `--ssl-certfile/--ssl-keyfile` (e.g. a cert from `mkcert <netbird-ip>`) and bind it to the NetBird IP (`--host`). Without HTTPS, the PWA falls back to the OS camera picker and typed input.

## 2. Local services (`providers.json`, all optional, each degrades gracefully)

| Service | Default | Notes |
|---|---|---|
| LM Studio | `http://127.0.0.1:1234/v1` | Chat chain #1. Load a **vision** model (e.g. Qwen2.5-VL) for OCR and an **embedding** model (nomic-embed) for the vault. |
| **Verifier** | **LM Studio, no key** | Zero-cost local cross-check of mutating plans. Pick a *different* model than the planner (Settings warns if they match). The old OpenRouter entry was backed up to `providers.json.bak-openrouter`. |
| AnythingLLM | `:3001/api/v1/openai` | Chat chain #2 (needs its API key). |
| Agentic OS | `:8080` | Chat chain #3 (opencode / agy / claude / gemini / llm; a missing CLI returns 503) and the executor for approved actions (opencode). |
| Whisper STT | `:8178/v1`, engine `whispercpp` | `whisper-server -m ggml-base.en.bin --port 8178 --inference-path /v1/audio/transcriptions`. Set **Models folder** to hot-swap tiny…large-v3-turbo via `/load`. |
| Kokoro TTS | `:8880/v1`, engine `kokoro` | `docker run -p 8880:8880 -v <voicesDir>:/app/api/src/voices/v1_0 ghcr.io/remsky/kokoro-fastapi-cpu`. Mount the voices folder so uploaded `.pt` voices load. |
| Coqui XTTS | engine `xtts` | xtts-api-server. Uploaded `.wav` reference clips become voices (`speaker_wav`). |
| n8n | auto-bound to the Docker container | `n8n_discover` reads `docker ps` and adopts the published port (found: container `n8n` → `127.0.0.1:5678`). |
| Droplet | `100.64.0.10:8000/v1` | Last in the chain; background work moves here when the GPU is over 85% or VRAM is over 90%. |

Settings can switch the chain order, models, voices, URLs and Whisper model/language **live**. That is safe because keychain secrets are bound to `provider@host`: re-pointing a provider can never send its key to a new host. The gateway launch command stays file-only.

## 3. Voice-first flow (unchanged core, new pieces)

`listen → transcribe → local intent? → plan (+ local verifier) → read-only: answer | mutating: card + read-back → yes/no → execute`

- **Local intents** ("remind me…", "set an alarm…", "countdown to…", "wake me up…") write only to your own store, so they skip the card. The parser is `features/reminders/when.ts` and covers relative times, clock times, weekdays, dates and tonight/noon.
- **Approval is still the only path** to an executor (`approve()` in `voice-controller.ts`). `requestConfirmation(plan)` lets features build their own plans (for example, "Add to Google Calendar" on a reminder).
- **n8n tiers.** Workflows marked `mutating: false` (calendar-upcoming, gmail-digest) can be read with `n8n_fetch`; Rust **refuses** `n8n_fetch` on anything mutating. Everything else goes through the card and then `n8n_trigger`.
- **Librarian** answers are grounded in vault search results (cited).
- **Floating orb** (`VoiceOrb.tsx`): when the panel is closed, a transparent orb sits at bottom centre. Its outline is a sum of drifting harmonics scaled by the live mic/TTS level. It animates only while listening, transcribing, speaking or thinking; idle or muted, it draws one frame and stops.

## 4. Feature map

| Area | Where | Data |
|---|---|---|
| Widget board + generator | `core/widgets`, `widgets/*`, `widgets/custom/spec.ts` | layout in localStorage; generated widgets are **data-only specs** validated by `validateSpec` (no code, no network) |
| Telemetry | `widgets/system-stats` (+ node strip), `widgets/agent-nodes` | Rust probes |
| Alarms, key dates, reminders | `widgets/reminders`, `features/reminders/*` | `reminders`; the scheduler fires on whichever device is open, claims the reminder in the store (no double-ring), handles repeats, skips anything missed by more than 10 min; mirrors Google Calendar every 10 min via n8n |
| Audition pipeline | `widgets/pipeline` | `pipeline` |
| Contracting | `widgets/contracting` (won jobs → invoice draft) | `projects` |
| Finance (local only) | `sections/FinanceSection` + `sections/finance/*` | `income`, `goals`, `invoices`, `checks`, `receipts`, scans in `data/command-center/files/` |
| Camera / QR / OCR | `features/finance/CameraCapture.tsx` (jsQR), `/api/cc/ocr` | vision LLM → Tesseract fallback; `_tax_check` validates ON 13% / Atlantic 15% HST / 5% GST and the totals |
| Brainstorm | `sections/BrainstormSection`, `features/brainstorm/capture.ts` | `notes` (raw segments kept forever; `organized` added alongside) |
| Day trading | `sections/TradingSection`, `features/trading/*` | TradingView iframe + news timeline; candles via `/api/cc/market/candles`; profile, POC, VA and zones in `analysis.ts` |
| Vault + backups | `sections/VaultSection`, `/api/cc/vault/*`, `/api/cc/backup*` | `vault` table (embeddings + lexical fallback); zips in `backups/command-center/` |

**Sync model.** `useCollection(name)` polls `?since=` every 6 s plus on window focus, writes optimistically, and uses soft deletes so removals propagate. Last write wins per item. To **clear a field across devices, send `null`**, never `undefined`: JSON drops `undefined`, so the server never sees it.

**Calendar via n8n (contract).** `calendar-upcoming` returns `[{id, summary, start: ISO | {dateTime|date}, description?}]` (or `{events: [...]}`). `calendar-create` receives `{title, start, end, notes, reminderId}`.

## 5. Backlog (in priority order)

**P0**
- **Gateway auth.** `server.py` is unauthenticated and now holds finance data. Add a bearer token: generate it on first run, require it on `/api/*` except `/api/status`, keep it in the keychain on desktop and ask for it once on the PWA. Then bind the gateway to localhost plus the NetBird IP only.
- **HTTPS helper** for the phone: an `mkcert` script plus `start.sh` flags.

**P1**
- Stream chat tokens (`tauri::ipc::Channel`) and start TTS on the first sentence.
- Gateway `/api/voice/stt|tts` proxies so the phone uses Whisper and Kokoro too.
- A direct Google connector using the stored OAuth client (loopback + PKCE in Rust). n8n is the working path today.
- A save-back on approved calendar pushes (store `gcalId` on the reminder to avoid a duplicate on the next sync).
- Tests: port `checks.ts` (the parser, POC/zones, spec validation, invoice math) to Vitest, and add `unittest` cases for `command_center_api` (store, soft delete, tax check, backup).

**P2**
- Wake word; barge-in; a ⌘K palette; on-disk wallpaper storage; a restore-from-backup UI; per-wallpaper focal points.

## 6. Nov 2026 upgrade — routing, MCP grants, voice roster, native OS controls, streaming

Fixed two live-test bugs ("tell my booking agent to check my WhatsApp" routed to the wrong tab; sub-agents refused WhatsApp/time tool access even with MCP servers registered) and landed six related pieces alongside them. All under `src/`/`src-tauri/src/` unless noted; `npm run typecheck`, `cargo check --tests`, `cargo test --lib`, `npx vitest run`, `npm run test:scripts` and `python ../tests/run_all.py` all pass.

| Part | What | Key files |
|---|---|---|
| Routing | Deterministic name/domain trigger matrix, editable per role in Settings. `resolve()` is mirrored line-for-line in Rust and TS against one shared fixture file, so both sides agree. Tab auto-switches on a Named route; a sub-agent's own tab talks to it directly. | `commands/routing.rs`, `features/dispatcher/router.ts`+`.fixtures.json`, `sections/settings/RoutingSettings.tsx` |
| MCP & skills grants | Per-server, per-skill agent grants (`McpServer.agents`, pill UI: All/Tony/Booking Desk/Coder/Prompter/Designer/Librarian/Ops). Tony always has every enabled server. A **tool pre-executor** runs before delegation: regex-only WhatsApp/time lookups (no LLM call) inject `[LIVE MCP TOOL DATA - …]` into the sub-agent's task or Tony's own prompt, so a refusal is no longer possible once the tool actually ran. "Sync to AnythingLLM" writes Tony's non-builtin servers into `anythingllm_mcp_servers.json` (never overwrites an existing entry). | `commands/os_core.rs`, `commands/mcp.rs`, `commands/agents.rs`, `sections/settings/LibrarySettings.tsx` |
| Voice roster | Per-agent Engine/Voice/Model/Auto-speak (`agent_voices` in `providers.json`). `tts_synthesize` resolves named-agent → general's entry → the old single policy voice, in that order — never silently repoints a cue's own explicit voice. | `commands/dispatch.rs`, `commands/voice.rs`, `sections/settings/VoiceSettings.tsx` (`AgentVoiceRoster`) |
| hermes removed | The uninstalled `hermes` CLI is gone end to end (frontend/backend/skills/tests); all 7 roles route through `opencode`. Gabagool on/off, workspace switch, model swap, compute mode and kill-switch are native handlers (`os-intents.ts`) with no CLI involved — fixes "turn off gabagool mode" (and exit/disable/stop/bare "turn off") hanging on a CLI that was never there. | `features/os/os-intents.ts`, `features/os/os-intent-parse.ts`, `features/cues/gaba.ts` |
| Brainstorm profiles | Listen Mode has its own VAD profile — Snappy (1s), Relaxed (3s, default), Continuous (push-to-talk) — instead of inheriting the 700ms command-mode pause. Switching profiles while listening restarts the current utterance with the new timing. `settings.ts` persist version bumped to 5 with a recursive-merge backfill (`deepMergeDefaults`) so future fields never need another version bump. | `features/brainstorm/listen-profiles.ts`, `features/voice/vad-rules.ts`, `stores/settings.ts` |
| Streaming + fallback | ElevenLabs sentence-boundary streaming for Tony and, when talking directly to a sub-agent's tab, for that sub-agent too (never a delegated/synthesized turn — that would double-speak). One shared `extract_json`/`ensure_prose` (Rust, TS, and Python's `command_center_api.py`) replaces three ad-hoc parsers: malformed/bare-JSON model output degrades to a plain re-asked sentence instead of a raw error reaching the UI. | `commands/dispatch.rs` (`ThinkFilter`, `extract_json`), `commands/agents.rs` (`workspace_chat_streamed`, `ensure_prose`), `features/orchestrator/extract-json.ts` |
| Port 1420 | `predev` runs `scripts/kill-port.mjs 1420 1421` before `npm run dev` (and therefore `tauri dev`), killing any orphaned listener first. Verified live against a real listener, not just unit tests. | `scripts/kill-port.mjs` |

**Post-review hardening** (an independent review pass over the above, before this was called done): `settings.ts`'s `gatewayToken` (phone bearer token) is no longer persisted to `localStorage` — it's excluded via `partialize` and must be re-entered each session, closing a real secrets-in-localStorage gap. `OsSettings.tsx`'s workspace-mapping `ROLES` and `os-store.ts`'s `agentBadge()` now derive their role-id set from the one shared `features/dispatcher/roles.ts` instead of their own hand-written copies, so a role added or removed there can't silently go stale in either place.

**Known, pre-existing, not touched by this upgrade:** `CommsSection.tsx`'s live-push WebSocket still passes `gatewayToken` as a URL query string (`?token=…`) because browsers can't set a custom `Authorization` header on a WebSocket handshake. The backend (`os_api.py _ws_authorized`) already prefers a real `Authorization` header and only falls back to the query param — the fix is to switch the client to the `Sec-WebSocket-Protocol` subprotocol trick instead (sent as a header, not a URL) and read it on the server side. Deferred: it predates this changeset, isn't blocking, and touches a live, actively-used auth path on both sides.

**Not started yet** (speced, next up): Phase 1–4 of the live-test audio hardening — half-duplex STT gating to kill the self-triggering audio/UI feedback loop, a true hard-reset Kill Switch (abort every in-flight stream, flush queues, relock the custom TTS voice profile), decoupling the Voice Engine (TTS) from a new Spotify media channel with auto-ducking, and generalizing the tool pre-executor above into a capped `[PREFETCHED_CONTEXT]` block Tony always gathers before delegating. Spotify's `SPOTIFY_CLIENT_ID`/`SPOTIFY_CLIENT_SECRET`/`SPOTIFY_REDIRECT_URI=http://127.0.0.1:1420/callback` are already in the repo-root `.env`, read the same way `elevenlabs::api_key()` is; the matching MCP server/OAuth-callback code doesn't exist yet.

## 7. Guardrails
- No code path may execute a mutating plan without `approve()`. No auto-approve and no Enter-to-approve.
- Finance stays local: **never add bank, Plaid, card or broker integrations.** Trading is research-only (no order entry).
- Generated widgets stay data-only: extend `CustomSpec` and `validateSpec`, never `eval`.
- No secrets in TypeScript, localStorage, logs, error strings or backups (the keychain stays out of backup zips).
- Respect `prefers-reduced-motion`. Every canvas loop pauses when hidden.
- `npm run typecheck`, `cargo check` and `python tests/run_all.py` must pass before you commit.
