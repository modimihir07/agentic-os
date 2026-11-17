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
| Agentic OS | `:8080` | Chat chain #3 (opencode / hermes / agy) and the executor for approved actions. |
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

## 6. Guardrails
- No code path may execute a mutating plan without `approve()`. No auto-approve and no Enter-to-approve.
- Finance stays local: **never add bank, Plaid, card or broker integrations.** Trading is research-only (no order entry).
- Generated widgets stay data-only: extend `CustomSpec` and `validateSpec`, never `eval`.
- No secrets in TypeScript, localStorage, logs, error strings or backups (the keychain stays out of backup zips).
- Respect `prefers-reduced-motion`. Every canvas loop pauses when hidden.
- `npm run typecheck`, `cargo check` and `python tests/run_all.py` must pass before you commit.
