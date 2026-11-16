# Jarvis Command Center — Build Handoff (for Cline)

A **voice-first** Agentic OS front end. The desktop app (Tauri v2 + Rust) and the mobile PWA share one React 19 + Tailwind v4 codebase.
Design source: the Stitch export "Tactile Neo-Glass & Luminescent Hardware". Its tokens live in `src/styles/index.css` (`@theme`).
Read this file top to bottom before changing anything.

```bash
npm install
npm run dev            # PWA/web at http://localhost:1420
npm run desktop:dev    # Tauri window (compiles Rust on first run, ~3–5 min)
npm run build          # typecheck + web/PWA build to dist/
npm run desktop:build  # installer
```

The Agentic OS backend (`../server.py`, port 8080) is the **gateway** and the **executor** for approved actions. Start it with `../start.sh`.

### Local services the desktop expects (all optional; each degrades gracefully)

| Service | Default URL (`providers.json`) | Run it with |
|---|---|---|
| LM Studio (your local, uncensored model) | `http://127.0.0.1:1234/v1` | LM Studio → Developer → Start server |
| Whisper STT | `http://127.0.0.1:8178/v1` | `whisper-server -m ggml-base.en.bin --port 8178 --inference-path /v1/audio/transcriptions` (whisper.cpp), or `speaches` |
| Kokoro TTS | `http://127.0.0.1:8880/v1` | `docker run -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu` (or the `-gpu` image) |
| Verifier (verified cloud account) | `https://openrouter.ai/api/v1` | Put the API key in **Settings → LLM providers** |
| Cloud droplet (fallback) | `http://100.64.0.10:8000/v1` | Any OpenAI-compatible server, reached over NetBird |
| n8n | `http://127.0.0.1:5678` | Add workflows under `n8nWorkflows` (see §3) |

`providers.json` lives at `%APPDATA%\os.agentic.commandcenter\providers.json` on Windows. It is written on first run, and new default entries are merged in on upgrade. The UI deliberately cannot edit it.

---

## 1. How a voice command flows

```
 hotkey / mic / ?voice=1
        │
 MicCapture (AudioWorklet PCM + level + VAD: 1.1 s silence ends the utterance)
        │ 16 kHz WAV, raw IPC bytes
 Rust stt_transcribe → Whisper ───────────────► text
        │
 planIntent()  src/features/orchestrator/plan.ts
   1. heuristic plan  (instant, offline; the floor)
   2. model plan      (local model → strict JSON: role, intent, payload, missing, target)
                       ↳ it may ESCALATE to mutating, never downgrade
   3. verifier        (mutating only: a separate cloud account checks the plan
                       against the exact words and flags invented details)
        │
   read-only ──► execute → dispatch() chat → spoken reply (Kokoro, sentence-pipelined)
        │
   mutating ──► ConfirmCard + spoken read-back
                "Got it — instructing Booking Desk to cancel your dinner with Sam on Friday. Proceed?"
                then listen for yes/no
                 ├─ "yes / okay / do it / go ahead" or tap Approve → execute
                 ├─ "no / cancel / wait" or tap Cancel or Esc → cancelled, nothing sent
                 ├─ unclear ("yes but…") → re-prompt once, then cancel
                 └─ no answer before the timeout (default 30 s) → cancelled (fails closed)
```

**Execution of approved mutating plans** (`execute.ts`) goes only to executors that can really act:
- **n8n**: a *named* workflow from `providers.json` (`n8n_trigger`). The webview can never supply a URL.
- **Agentic OS agents** through the gateway (`hermes` / `opencode` / `agy`, which have tools).
- A plain chat model is **never** used to "execute" a mutating action, because it has no tools and would only claim success.

`approve()` in `voice-controller.ts` is the **only** code path from a mutating plan to an executor. Keep it that way.

---

## 2. Design decisions vs the brief

| Brief | Built as | Why |
|---|---|---|
| Two-way voice (Whisper + low-latency TTS) | Desktop uses Whisper STT through Rust and Kokoro TTS through Rust. Replies are split into sentences: all are synthesised in parallel and played in order, so the first sentence plays while the rest are still being made. The waveform is driven by the real playback audio. PWA uses Web Speech STT and TTS for now. | WebView2 has no working Web Speech recognition, so the desktop needs Whisper. Mobile Chrome's recognition is good. Gateway voice proxies are backlog item P1-1. |
| Hardware-button quick launch (PWA) | The manifest `shortcuts` entry "Talk to Jarvis" opens `/?voice=1` and starts listening immediately. `launch_handler: navigate-existing`. | Android: long-press the icon → Talk, or map a side-key double-press / Routine / Shortcuts automation to that URL. Some browsers require a tap before the mic opens; the HUD then shows tap-to-talk. |
| Desktop quick launch | A **system-wide Ctrl+Shift+Space** (Rust global shortcut) brings the window forward and toggles listening, even when the app isn't focused. | |
| Uncensored local model + verified oversight | The local model is the planner and does the heavy lifting. The `verifier` provider (a cloud account you control) cross-checks every mutating plan. The card shows Verified / Flagged (with the issues) / Unverified. | The human "yes" remains the final gate in every case. Verification informs that decision but never replaces it. |
| Waveform widget centred on the board | The **Voice Console** widget (`src/widgets/voice-console`) sits centre stage by default (top of the stack on phones). The floating HUD hides while it is on screen. | One conversation store drives the HUD, the console widget, the ConfirmCard and the Agents section. |
| Wallpapers sync to weather and time | Each scene has tags: atmospheres (clear/autumn/rain/snow/fog/midnight) and phases (day/golden/night). Golden hour is computed from Open-Meteo sunrise and sunset. With sync on, rotation uses only the best-matching scenes, and the slideshow jumps when conditions change. Tag your uploads (e.g. snow + night) in **Wallpapers**. | None of the built-in scenes is a snow scene, so snow falls back to the closest match until you upload and tag one. |
| Keys, firewall, Tauri mobile | Same as before: OS keychain, write-only from the UI, keys bound to `provider@host`, NetBird ACLs, PWA instead of Tauri mobile. | ⚠️ `server.py` still has **no auth** (P0-1). |
| RPM / tach gauges | Removed. | Per the brief. |

---

## 3. Code map

```
src/
├─ lib/platform.ts            desktop vs PWA; typed cmd() for every Rust command; nativeRaw() for bytes; onNativeEvent()
├─ lib/gateway.ts             FastAPI client
├─ stores/settings.ts         prefs (gateway URL, waveform colours, confirmTimeoutSec, wallpaperSync…)
├─ core/widgets/              registry (auto-discovery), 12×8 snap grid, layout persistence + migrations
├─ widgets/<id>/              mantra, voice-console, system-stats, weather, quick-notes, agent-nodes, data-streams
├─ features/
│  ├─ voice/engines.ts        MicCapture (worklet+VAD), encodeWav16k, WhisperStt, WebSpeechStt, KokoroTts, FallbackTts
│  ├─ voice/voice-controller  the conversation state machine (listen → plan → confirm → execute → speak)
│  ├─ voice/voice-store.ts    single conversation store (turns, pending confirmation, state)
│  ├─ voice/VoiceHUD.tsx      floating HUD + launchers (hotkeys, native event, ?voice=1)
│  ├─ voice/VoiceParts.tsx    MicButton, Transcript, CommandInput (shared by HUD, widget, Agents)
│  ├─ orchestrator/plan.ts    heuristic + model planner, verifier, parseConfirmation (strict)
│  ├─ orchestrator/execute.ts the executors (read-only chat, n8n, Agentic OS agents)
│  ├─ orchestrator/ConfirmCard.tsx  the high-contrast gate (no Enter shortcut; Esc = cancel)
│  ├─ wallpaper/              slideshow + weather/time matching + IndexedDB uploads
│  └─ weather/                Open-Meteo (current + sunrise/sunset) + particle canvas + time phase
public/worklets/pcm-capture.js   AudioWorklet (served from 'self' for the CSP)
src-tauri/src/
├─ lib.rs                     commands + global Ctrl+Shift+Space → "voice-toggle" event
└─ commands/
   ├─ dispatch.rs             providers.json (chat, verifier, stt, tts, n8n), GPU-aware routing, maxSecs
   ├─ voice.rs                stt_transcribe (raw WAV in) / tts_synthesize (raw mp3 out)
   ├─ n8n.rs                  n8n_workflows / n8n_trigger (named workflows only)
   ├─ secrets.rs, system.rs, telemetry.rs
```

### Wiring an n8n workflow (for example, cancelling a calendar event)
1. In n8n, create a Webhook-trigger workflow (POST, Header Auth `Authorization: Bearer <token>`) that cancels the event.
2. In `providers.json`, add `"n8nWorkflows": { "cancel-calendar-event": "webhook/cancel-calendar-event" }`. If you used header auth, set `"needsKey": true` on the `n8n` provider.
3. Store the token: **Settings → LLM providers → n8n**.
4. The planner now sees `cancel-calendar-event` as a target. The payload it extracts (event, date…) plus `intent`, `summary`, `utterance` and `approvedAt` is POSTed only after you approve.

### Recipes
- **Widget:** add `src/widgets/<id>/index.ts` with `defineWidget({...})` and lazy-load the component. It shows up in Widgets → Add automatically. Optional `compactOrder` sets its position in the phone stack.
- **Rust command:** write it in `commands/*.rs`, register it in `lib.rs`, add it to `NativeCommands` in `platform.ts`, and call it with `cmd()`. CLIs must go through `proc::stdout` with hard-coded args.
- **Sub-agent:** add an entry to `SUB_AGENTS` (`dispatcher/agents.ts`). `gatewayAgent` is its executor for approved actions.
- **Data connector:** add an entry to `CONNECTORS` (`streams/connectors.ts`).

---

## 4. Backlog (in priority order)

**P0**
- **P0-1 Gateway auth.** `server.py` is unauthenticated, and it is now also the executor for approved actions. Add a bearer token: generate it on first run, require it on every `/api/*` route except `/api/status`, keep it in the keychain on desktop and ask for it once on the PWA. Done when an unauthenticated `curl /api/chat` returns 401.
- **P0-2 Bind address.** `start.sh`: bind to `127.0.0.1` plus the NetBird IP only.
- **P0-3 Streaming.** Stream `dispatch_chat` tokens over a `tauri::ipc::Channel`, and start TTS on the first complete sentence. This is the biggest remaining latency win.

**P1**
- **P1-1 Mobile Whisper/Kokoro.** Add gateway `POST /api/voice/stt` (WAV in) and `/api/voice/tts` (mp3 out) proxies in `server.py`, then add `GatewayWhisperStt` / `GatewayKokoroTts` engines and pick them in `createEngines()` on the PWA.
- **P1-2 Wake word.** Add an always-on "Jarvis" wake word on desktop (openWakeWord or Porcupine as a sidecar) that emits `voice-toggle`.
- **P1-3 Barge-in.** Speaking while Jarvis is talking should cancel TTS and start listening (MicCapture level above threshold during `speaking`).
- **P1-4 Gmail.** Rust loopback OAuth with PKCE, `gmail.readonly` scope, refresh token in the keychain, and a `gmail_digest` command. Any send must go through the confirm gate as an n8n or agent executor.
- **P1-5 MCP bridge.** Add `target.kind = "mcp"` with an allowlist of MCP tools in `providers.json`, run in Rust, and gate it exactly like n8n.
- **P1-6 Missing details.** When `plan.missing` is non-empty, ask the follow-up question by voice before showing the card.

**P2**
- Add tests: Vitest for `plan.ts` (heuristics + `parseConfirmation`; a scratch harness with 21 cases passed during development), `layout-store`, `matchingWallpapers`, and `cargo test` for routing.
- Add a music widget (Windows SMTC), a ⌘K palette, desktop on-disk wallpaper storage, and per-wallpaper focal points.

## 5. Guardrails for agents working here
- No code path may execute a mutating plan without `approve()`. Don't add "auto-approve", "trusted commands", or an Enter-to-approve shortcut.
- `parseConfirmation` is strict on purpose: hedged replies are not a yes.
- No secrets in TypeScript, `localStorage`, logs, or error strings.
- Respect `prefers-reduced-motion`.
- `npm run typecheck` and `cargo check` must pass before you commit.
