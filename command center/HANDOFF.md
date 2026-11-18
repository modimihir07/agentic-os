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

**Not started yet** (speced): a true hard-reset Kill Switch (abort every in-flight stream, flush queues, relock the custom TTS voice profile) and generalizing the tool pre-executor into a capped `[PREFETCHED_CONTEXT]` block Tony always gathers before delegating. (Spotify and mic hard-stop landed in §7.)

## 7. Nov 2026 fix pass — mic hard-stop, Gmail + Spotify tools, Spotify widget, dashboard pages, Gabagool audio

Seven areas from a live-test report. All checks pass: `npm run typecheck`, `npx vitest run` (343), `npm run test:scripts`, `cargo test --lib` (124), `python tests/run_all.py` (97). Four rounds of independent review with adversarial verification followed the implementation; every confirmed finding is fixed (later rounds were mostly spoken-phrase variants — expect more of those from live use; add each as a parser test case). **Not exercised live** (no `tauri dev` in the agent session): the real mic indicator, audio ducking/limiter by ear, a real Spotify OAuth round trip and Web API calls, a real Apps Script Gmail call.

| Area | What | Key files |
|---|---|---|
| Mic hard-stop | `MicCapture` has a session counter: `stop()` invalidates any `start()` still awaiting `getUserMedia`/worklet and stops the tracks it acquired. `WhisperStt` ignores callbacks from a superseded capture, so a cancelled clip never transcribes into a turn. `hardStopMic()` (bumps `micGen`, aborts STT, releases the user-speech duck) is behind Listening-off, Esc and the mic button's cancel; every awaited step of a turn re-checks `micGen` before speaking or reopening the mic. Follow-up and barge-in listens only happen in hands-free mode or after a tap-started turn; background re-listens (confirmation, idea capture) are `silent` so the HUD stays closed. Mic button: listening + heard speech → submit; listening + silence → hard stop; transcribing/thinking → cancel. | `features/voice/engines.ts`, `voice-controller.ts`, `voice-status.ts` |
| Header | Live, never written to settings: `wakeMode || state ∉ {idle, error}` swaps a trailing "ACTIVE" in the subtitle for "STANDBY"; the dot follows `STATE_DOT`. | `shell/TopBar.tsx` |
| Gmail | Native Apps Script backend (`POST script.google.com/macros/s/{id}/exec {key, action}` — the same deployment AnythingLLM's Gmail agent uses). Builtins `gmail.recent`, `gmail.search`, `gmail.read_thread`; `gmail_create_draft` is a Tauri command only, refused unless `approved`, and is never callable through `mcp_call`. Deployment id + key live in the keychain (`gmail-script-id`, `gmail-script-key`) or `.env`; Settings → Integrations → Gmail has **Import from AnythingLLM** (reads `%APPDATA%\anythingllm-desktop\storage\anythingllm.db`, Rust-side, values never reach TS) and **Test**. Deterministic `gmail_plan` ("read my last email", "check Gmail", "emails from Sam") runs before `whatsapp_plan`, except lines that name WhatsApp/texts. A Gmail that's off or unconfigured injects a `[TOOL FAILURE]` note so Tony says what's missing instead of inventing a refusal. "draft an email to x@y.z about … saying …" becomes a confirmation card (`plan.target = {kind: "tool"}`); an address-less draft asks for the address, unless it's routed to another desk ("draft an email to my agent…" stays the Booking Desk's). | `commands/gmail.rs`, `commands/agents.rs` (`gmail_plan`, `tools_section`), `features/orchestrator/draft-email.ts`, `plan.ts`, `execute.ts`, `features/integrations/*` |
| Spotify (backend) | Native Web API module, Authorization Code + PKCE (+ client secret, basic auth). Scopes: playback state/modify/currently-playing, recently-played, playlists. Refresh token in the keychain (`spotify-refresh`); access token in memory only. Redirect URI is **exactly** `http://127.0.0.1:1420/callback` (register it in the Spotify dashboard). **Packaged build:** Rust binds 127.0.0.1:1420 itself for the callback. **`tauri dev`:** Vite owns :1420, so `vite.config.ts` proxies `/callback` → gateway `/api/spotify/callback` (`os_api.py spotify_router`, loopback-only, single-use 5-min codes, access-log redacted), and Rust polls `/api/spotify/pending` — **the gateway must be running for Connect in dev**. Builtin MCP server `spotify` (off until Connect succeeds); the router only sees read tools (`now_playing`, `recent`, `playlists`); playback is deterministic (`spotify_plan`) or the widget. 403 Premium → "needs Premium"; 404 no device → transfers to the first available device; body-less PUT/POST send an explicit `Content-Length: 0` (Spotify 411s without it). | `commands/spotify.rs`, `commands/envfile.rs`, `os_api.py`, `vite.config.ts`, `tauri.conf.json` (CSP: `i.scdn.co`, `*.spotifycdn.com`, `open.spotify.com`) |
| Spotify (widget + voice) | Widget `spotify` (3×3 default): art, title/artist, play/pause/skip/prev, volume, Recent/Playlists quick-select, 4 s polling while visible, Connect button when not connected; desktop-only (browser shows a notice). Voice: "play X on Spotify", "pause music", "skip track", "next/previous", "turn spotify up", "spotify volume 40", "what's playing". | `widgets/spotify/*`, `features/os/os-intent-parse.ts` (`media`), `os-intents.ts`, `media-reply.ts` |
| Dashboard pages | `cc.layout` persist **v5** `{pages: [{id, name, items}], activePage}`; v4 `{instances}` migrates to Page 1 (`migrateLayout`/`sanitizePages` in `core/widgets/pages.ts`). `add()` places on the active page, else the next page with room, else a new page (never "No free space"). `PageSwitcher` (desktop: in the ReelDock row; mobile: fixed bottom-right) — click to switch, double-click to rename, × to delete (not the last), `+ New`, Ctrl+Alt+←/→. Generate adds a built-in directly when the prompt is essentially its name ("spotify", "add the weather widget"); anything else goes to the LLM generator. | `core/widgets/layout-store.ts`, `pages.ts`, `catalog-match.ts`, `shell/PageSwitcher.tsx`, `ReelDock.tsx`, `sections/CommandSection.tsx` |
| Gabagool audio | Cue audio runs through one bus: per-clip gain → duck `GainNode` → `DynamicsCompressor` → soft-clip `WaveShaper`. Theme volume 0–300 % (CueStudio slider, saved on release) and live: "turn it up / make the music louder / crank it / turn it down / lower the music / turn gabagool up" step ±25 % (crank = 2 steps) and move the slider. Duck engages only while TTS is speaking (`say()`, depth-counted) or the VAD reports speech — never while the mic is merely armed. "turn off / exit gabagool mode" is handled locally before any pending confirmation; music-naming stops ("pause the music") stop the theme only while it is actually playing, otherwise they pause Spotify. | `features/cues/player.ts`, `volume.ts`, `gaba.ts`, `features/os/os-intent-parse.ts`, `features/voice/wake-word.ts`, `sections/settings/CueStudio.tsx` |
| TTS / ElevenLabs | `optimize_streaming_latency` is never sent for v4 models. Bulleted/numbered replies are one TTS call (`sentences()` list mode; streamed replies stop chunking once a list line appears and speak the rest at end of stream). Tony's voice comes from `agent_voices.general.voice` in `providers.json` (persisted). | `commands/elevenlabs.rs`, `features/voice/tts-text.ts` |
| Selects | Roster/Voice Settings selects: `!h-9 !py-0 !leading-normal`; `Select` gets `leading-normal`. | `sections/settings/VoiceSettings.tsx`, `components/ui.tsx` |

**Known, deliberately not changed:** the tool router's second step still offers `fetch.url` after a read tool returned outside text (email/WhatsApp content), so a crafted message could in principle steer it to fetch a URL. Pre-existing (HEAD offered every tool on both steps); this pass narrowed it with keyword gating. Hardening: drop outbound tools from step 2. Also pre-existing: a worklet failure after `getUserMedia` leaves the stream open until the next `stop()`.

## 8. Guardrails
- No code path may execute a mutating plan without `approve()`. No auto-approve and no Enter-to-approve.
- Finance stays local: **never add bank, Plaid, card or broker integrations.** Trading is research-only (no order entry).
- Generated widgets stay data-only: extend `CustomSpec` and `validateSpec`, never `eval`.
- No secrets in TypeScript, localStorage, logs, error strings or backups (the keychain stays out of backup zips).
- Respect `prefers-reduced-motion`. Every canvas loop pauses when hidden.
- `npm run typecheck`, `cargo check` and `python tests/run_all.py` must pass before you commit.
