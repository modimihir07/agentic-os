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

## 9. Phase 2 — voice reflexes (cut / hold / resume) + Whisper vocabulary biasing

Scope: Whisper biasing, the reflex parser, the cut/hold/resume reflexes, audio route, and the multi-agent voice handoff. (The rest of the original Phase 2 spec — Verbal Landmark & Cue Network, Daily Action Pipelines — is **not** built.) The decision itself is a pure string parse (well under 15 ms once Whisper returns the transcript); what you feel is Tony ducking on speech onset (one audio frame). End-to-end latency is Whisper's, not 15 ms. `npm run typecheck`, `npx vitest run` (669), `npm run test:scripts` pass; `cargo test --lib` passes for everything in this pass (6 new tests) — see "State of the tree" below. **Not exercised live** (no `tauri dev` in the agent session): the real mic/duck/pause by ear, whisper.cpp actually honouring the prompt, the speakers/headset label on this machine, ElevenLabs intro caching, Spotify pause/resume round trips. Run the checklist at the end.

| Part | What | Key files |
|---|---|---|
| Whisper biasing | `Provider.sttPrompt` (`providers.json`, STT provider). `None` = built-in default (`DEFAULT_STT_PROMPT`, natural speech on purpose); `""` = send none. Sent as the multipart `prompt` field — verified upstream: whisper.cpp `examples/server/server.cpp` `get_req_parameters` reads `prompt`, and the only inference route is `request_path + inference_path`, so `--inference-path /v1/audio/transcriptions` gets it. `providers_list` shows the effective prompt; Settings → Voice → Speech-to-text has an editable box (saved on blur via `providers_update`). **Hallucination guard:** after the junk filter, a transcript containing a run of ≥ 4 consecutive prompt words in prompt order (case/punctuation-insensitive) is dropped (`echoes_prompt`). "cut it", "take it ease" (2–3 words) always pass. | `commands/voice.rs` (`stt_transcribe`, `effective_stt_prompt`, `echoes_prompt`, `stt_prompt_tests`), `commands/dispatch.rs` (`Provider`, `ProviderPatch`, `view`) |
| Reflex parser | `parseReflex(text, {busy, holding, ttsAudible?})` → cut / hold / resume / submit / null. Only imports `norm` from `cues/gaba` (Vitest-safe, like `wake-word.ts`). Whole-word phrase tables are exported arrays — **add every new live phrase to the table AND `reflex-parse.test.ts`**. Rules as specced: cut in every state (≤ 5 words containing a cut phrase, or starts with one); single-syllable holds (oh/eh/aye/ay/whoa/woah) only when busy/holding, only as the whole line (repeats ok), never while `ttsAudible` (speakers mode); multi-word holds standalone or as a prefix (rest = first held segment), also from idle ("thought-form lock"); "hey kitties" standalone only; resume/submit only while holding (submit may carry a rest: "go ahead and email Sam" → submit + "email Sam"). Leading address words ("hey Tony, …") are skipped. | `features/voice/reflex-parse.ts` + `.test.ts` (65 cases incl. every required fixture) |
| Barge-in = duck | Speech onset over a reply → `tts.duck(true)` (Kokoro: a `GainNode` between sources and analyser, ramps to 15 %; WebSpeech can't duck, so it pauses). After transcription: cut → `killTurn()`, hold → `enterHold(rest)`, otherwise the old behaviour (Tony stops — `supersedeTurn()`: `micGen++` + `tts.cancel()`, and the old `os_turn` stream is cancelled — then `handleInput`). Empty/noise → un-duck, keep the state, keep listening. Barge listens use `conversation.bargeEndSilenceMs` (default **500 ms**). **Tradeoff:** a long new command said over Tony may be split at a pause; the follow-up listen catches the rest. **New:** in conversational mode (hands-free or a tapped turn) the barge listen also opens while an `osRun` turn is still *thinking*, so "cut it"/"whoa" work before he speaks; a non-reflex line said then replaces the thinking turn. | `features/voice/voice-controller.ts` (`speechHandlers`, `startBargeIn`, `endIdleBargeIn`), `engines.ts` (`KokoroTts.duck`, `WebSpeechTts.duck`), `tts-types.ts`, `tts-fallback.ts` |
| Cut it | `killTurn()`: `os_turn_cancel` for every in-flight `streamId`, `tts.cancel()`, cue theme stopped (`stopAllAudio`) + Spotify paused (`spotify_control {action:"pause"}`, never disconnected, no auto-resume), pending card → `reject("cut", {silent:true})` (fails closed, no spoken "Cancelled."), `hardStopMic()` (idle, re-arms hands-free), then a 140 ms soft blip — never an LLM sentence. Works from a barge listen, a follow-up, a tap listen, a hands-free listen (no wake word needed for a cut) and the yes/no confirmation listen. Rust: `os_turn` races the turn against a per-`streamId` `tokio::sync::Notify`; cancelling drops the whole future (every `reqwest` stream + the compute slot), which closes the connection and stops the server generating. A cancel that arrives before the turn registers is kept as a permit. The webview treats the `"turn cancelled"` error silently (the partial bubble stays, meta "cut"). | `commands/agents.rs` (`os_turn`, `TurnCancels`, `os_turn_cancel`, `turn_cancel_tests`), `lib.rs`, `voice-controller.ts` (`killTurn`), `features/voice/media-hold.ts` |
| Hold mode | New voice state `holding` (HOLDING on the orb caption, HUD chip, TopBar subtitle — `headerSubtitle(…, holding)`). While `held` is set, `voice-store.setState` ignores every other state, so the interrupted turn keeps running quietly (its bubble still fills) without knocking HOLDING off. Enter: `tts.pause()` — Kokoro keeps the sentence list + index and replays the interrupted sentence from its start on `resume()`; the shared `AudioContext` is **not** suspended (the mic uses it); a `speak()` started while paused waits. WebSpeech uses `speechSynthesis.pause/resume`. Spotify is paused only if it was playing; the cue theme only if it was playing (the cue player's **own** AudioContext is suspended in place — `pauseCueAudio`/`resumeCueAudio`); resume unpauses only what the hold paused. Listens with `endSilenceMs 4500 / maxUtteranceMs 120 000`, re-listening; each non-reflex line becomes a held segment (live in the HUD's Hold bar). Exits: resume with nothing held → reply continues in the same voice, music back; submit or resume with segments → paused reply dropped (and its server stream cancelled, so it doesn't hold the model slot), one new turn with `segments.join(" ")`, music back; cut → `killTurn`; 90 s without speech → paused audio dropped quietly, unsent segments logged as a system turn, music back, idle. Typed: typed lines while holding join the hold; the HUD (panel and collapsed orb) has a Resume/Send button; Esc/mic button = `stopVoice` (ends the hold, unpauses music). | `voice-controller.ts` (reflex section at the end), `voice-store.ts` (`held`, guard), `VoiceHUD.tsx` (`HoldBar`), `VoiceParts.tsx`, `VoiceOrb.tsx`, `voice-status.ts`, `shell/TopBar.tsx`, `features/cues/player.ts` |
| Audio route | `conversation.audioRoute: auto | headset | speakers` (Settings → Voice → Voice reflexes, with a live "In effect: …" indicator and the device label). Auto reads the default `audiooutput` label (`enumerateDevices`; labels need mic permission once) on each barge listen and on `devicechange`: headphone/headset/earbuds/earphones/AirPods/Buds/hands-free/WH-/WF-1000 → headset, anything else or no label → speakers. Speakers: single-syllable holds ignored while TTS is audible, barge-in `sensitivityOffset` −35 (headset −25). | `features/voice/audio-route.ts` + `.test.ts` (22), `sections/settings/VoiceSettings.tsx` (`ConversationReflexesCard`), `stores/settings.ts` |
| Announcer handoff | `routing.announcerHandoff` (app settings, default **on**; toggle "Agents speak their own answers" in Settings → Voice → Agent routing). Voice + delegated Named/Domain route: Tony says "Here's Booking Desk." (also on an explicit agent tab, before its first streamed words; cached audio per line for the session — `SpeakOpts.cache`, so repeats cost no synthesis call), then the agent's reply plays in its roster voice the moment it lands — new Rust event `os-agent-reply {streamId, agent, text}` (emitted only for non-explicit delegated replies), listened to locally rather than via the shared `onNativeEvent` union. Tony's streamed synthesis is shown in the bubble but **not spoken**. Order is strict (one `speakQ`), no overlap, no re-summary. Replies the event didn't carry (a Librarian comms quote) speak at the end; an agent Rust re-routed to gets its own intro first; several agents → each introduced in turn. If the agent failed and Tony stepped in, Tony's answer is spoken in his voice after the intro. A failing agent voice still falls back to local TTS with the `tts-fallback` notice. Hold/cut apply to whoever is speaking (engine-level). Off = the old behaviour (Tony's spoken "Routing … to …" notice + his synthesis). | `voice-controller.ts` (`osRun`, `introLine`, `onAgentReply`), `commands/agents.rs` (`os-agent-reply` emit), `engines.ts` (`KokoroTts` pinned cache) |

**State of the tree at hand-over:** a parallel Spotify overhaul was mid-edit in the same checkout. With this pass complete, `cargo test --lib` ran 259 passed / 2 failed — both failures in that session's in-progress `spotify.rs` auth tests (`refresh_timing`, `scopes_and_401_policy`), a file this pass doesn't touch. Minutes later `spotify.rs` itself stopped compiling mid-edit and the TS side dropped the `media` intent (so `typecheck` shows its pending `worksWhileConfirming`/`cue-runtime`/`os-intent-parse.test` updates). Re-run every suite once that session lands.

**Known limits / deliberate choices:** a cached intro that was synthesized by the local fallback (ElevenLabs down at the time) stays the fallback voice for the rest of the session. A hands-free passive listen (wake word required) only acts on a bare "cut it", or a hold over a busy turn; an idle thought-form lock needs the wake word ("Tony, take it ease, …"). The cut-it "contains" rule means a ≤ 5-word line like "don't cut it short" also cuts (by spec). A confirmation card's yes/no listen only takes "cut it", not holds.

**Live test checklist** (`npm run desktop:dev`):
1. Long question → "cut it" mid-answer → silence within a second; no more tokens stream (bubble meta "cut").
2. Long question → "take it ease" → HOLDING shows, Tony paused → "keep going" → he restarts the same sentence.
3. Spotify playing → "whoa" mid-answer → music and Tony pause → add a thought → "go ahead" → one combined turn is sent; Spotify resumes.
4. Idle → "oh what's the weather" → normal answer (no hold).
5. Confirmation card up → "cut it" → card cancelled, nothing spoken.
6. Spotify + Gabagool theme playing → "cut it" → both stop, Tony stops.
7. "Tell my booking agent to check WhatsApp" → Tony's intro, then Booking Desk answers in its own voice; Tony doesn't repeat it.
8. Speakers mode: Tony says "oh" in a reply → no hold. Headset mode: say "oh" while he talks → hold.
Also worth a look: Settings → Voice → Voice reflexes shows the right "In effect" route for your current output; the STT prompt box round-trips through `providers.json`.
