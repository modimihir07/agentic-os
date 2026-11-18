# Phase 2 — Voice reflexes (cut / hold / resume) + Whisper vocabulary biasing

**Read `HANDOFF.md` top to bottom first.** Its §8 guardrails apply. Do not break anything from §6–§7
(Spotify, Gmail, Gabagool cues, mic hard-stop, routing, voice roster).

**My decisions are already filled in under "Decisions" at the bottom; don't ask them again. Build all of §1–§4.**

Scope: this file covers Whisper biasing, the alias mapper, and the cut/hold/resume reflexes.
The rest of the original Phase 2 spec (Verbal Landmark & Cue Network, Daily Action Pipelines) is
not included yet; don't invent it.

---

## 0. Build on what exists (extend it; don't make a second copy)

| Already built | Where | Phase 2 does |
|---|---|---|
| "Gabagool" mishearing normaliser (`norm`, `isGabaLike`) | `src/features/cues/gaba.ts` | Reuse `norm()` as the first pass. Don't write a second gabagool mapper. |
| Barge-in: any VAD speech onset over Tony → `tts.cancel()` | `src/features/voice/voice-controller.ts` (`speechHandlers`, `startBargeIn`) | Change it to duck, then classify (§3). |
| Mic hard-stop (`hardStopMic`, `micGen`) | `voice-controller.ts` | "Cut it" builds on it. |
| Per-agent voice roster + Tony's "Routing X to Y…" notice | `commands/voice.rs` (`tts_synthesize`), `osRun()` | Extended by §4: sub-agents speak in their own voices. |
| Brainstorm listen profiles (1 s / 3 s / continuous) | `src/features/brainstorm/listen-profiles.ts` | Hold mode gets its own timing, using the same `endSilenceMs`/`maxUtteranceMs` overrides on `stt.start()`. |
| Native Rust audio engine with barge-in | `src-tauri/src/audio/*` | **Don't use it.** It's a scaffold and isn't wired to TTS. The TS path is what actually runs. |

---

## 1. Whisper vocabulary biasing

**Where:** `src-tauri/src/commands/voice.rs` → `stt_transcribe`. It currently sends no `prompt` field.

- Add an optional `sttPrompt` field to the STT provider in `providers.json` (`Provider` in `dispatch.rs`). When it's set
  and non-empty, send it as the multipart `prompt` field. Check that whisper.cpp's server reads
  `prompt` on the `--inference-path /v1/audio/transcriptions` route (check `whisper.cpp/examples/server`).
- Default value (written as natural speech on purpose, not a comma list):
  `"Tony, Gabagool mode. Take it ease. Cut it. Whoa. Madone, aspetta. Prompter, Designer, Coder, Booking Desk, Librarian and Ops. Bilmuri, Erra. WhatsApp, Gmail, Spotify, Tauri, Kokoro, Serena, checkpoint."`
- Add an editable text box for it in Settings → Voice (STT section), saved through the existing provider-update path.
- **Hallucination guard (required).** `base.en` sometimes repeats its prompt back on near-silent clips. In
  `stt_transcribe`, after the existing `junk` filter, drop the transcript when it contains a run of **4 or more
  consecutive prompt words in prompt order** (case- and punctuation-insensitive). Short real phrases like "cut it"
  or "take it ease" must still pass. Add Rust unit tests for both cases.

---

## 2. Reflex parser (pure, tested)

**New file:** `src/features/voice/reflex-parse.ts` + `reflex-parse.test.ts`. It may import only `norm` from
`@/features/cues/gaba` (same pattern as `wake-word.ts`, so Vitest runs it without browser code).

```ts
type Reflex = { kind: "cut" | "hold" | "resume" | "submit"; rest: string } | null;
export function parseReflex(text: string, ctx: { busy: boolean; holding: boolean }): Reflex;
// busy    = Tony/an agent is speaking OR a turn is thinking/executing
// holding = already in hold mode
```

Normalise with `norm()` first. Then apply these phrase tables. The alias lists match whole words only and are
easy to extend; every new phrase that shows up in live use goes in as a test case.

| Kind | Phrases (+ Whisper variants) |
|---|---|
| **cut** | cut it, cut it out, cut that, cutit, yo tony cut it, tony cut it, stop talking, stop stop |
| **hold — multi-word** | take it ease, take it easy, take it eas, take it ees, take it knees, take at ease, take it is, madone, madonna, ma donna, my donna, mad one, aspetta, aspett, aspet, a spetta, ah spet |
| **hold — single syllable** | whoa, woah, oh, eh, aye, ay |
| **hold — only if standalone** | hey kitties (a Whisper mishearing of "take it ease"; never match it as a prefix) |
| **resume** | keep going, go on, continue, carry on, where were you, you were saying |
| **submit** | go ahead, run that, over to you, that's it, send it |

Rules:
1. **cut** matches when the whole utterance is ≤ 5 words and contains a cut phrase, or when it starts with one. It
   applies in every state.
2. **Single-syllable holds** (oh/eh/aye/whoa) count only when `busy || holding` **and** the whole utterance is that
   word, repeats allowed ("whoa whoa"). "Oh, and add milk" is **never** a hold. In **speakers** mode (see
   Decisions → audio route), add `ctx.ttsAudible: boolean` and don't count them while Tony/an agent is audibly speaking
   (his own "oh" could leak into the mic); they still count while a turn is only thinking or executing. Multi-word
   holds and cut phrases always count.
3. **Multi-word holds** count standalone or as a prefix. As a prefix, return `kind: "hold"` with `rest` = what
   came after it, which becomes the first held segment. When idle (`!busy && !holding`) they still enter hold.
   This is the "thought-form lock": "take it ease, I'm thinking about…".
4. **resume / submit** only count when `holding`. Otherwise return `null`, so "go ahead and book it" still works as a
   normal command.
5. Otherwise return `null`, which means a normal command.

**Required fixtures** (my real phrasing, said in a row):
`"Take it ease." "Take it easy" "take it eas" "eh" "aye" "whoa" "oh" "madone" "aspetta" "Aspet" "aspett"`.
Each one is a hold when `busy`. Negative cases: `"oh and add milk"` (busy) → null; `"oh"` (idle) → null;
`"go ahead and email Sam"` (not holding) → null; `"take it easy on the bass"` (busy) → hold with rest `"on the bass"`.

---

## 3. Controller changes (`voice-controller.ts`, `engines.ts`)

### 3a. Barge-in: duck first, decide after transcription
- Speech onset while Tony is speaking (`onPhase("speech")` with `convo.active`): **duck** Tony's TTS to ~15 %
  instead of calling `tts.cancel()`. Add `duck(on: boolean)` to `TtsEngine`. In `KokoroTts`, put a `GainNode`
  between the sources and the analyser. `WebSpeechTts` can't duck, so it pauses instead.
- Barge-in listens use a shorter end-of-speech pause: add the setting `conversation.bargeEndSilenceMs`, default
  **500 ms**, and pass it as `endSilenceMs` in `startBargeIn`. Tradeoff to note in HANDOFF: a long new command said
  over Tony may get split. The follow-up listen catches the rest.
- On `onFinal`, call `parseReflex` **before** wake-word handling and `handleInput`:
  - **cut** → `killTurn()` (3b).
  - **hold** → `enterHold(rest)` (3c).
  - **null** → today's behaviour: cancel Tony and `handleInput(t)`.
- **Latency target:** the reflex decision itself is under 15 ms once the transcript is back. What you notice is
  how fast Tony ducks on speech onset (one audio frame). Don't claim end-to-end < 15 ms anywhere.

### 3b. `killTurn()` — "cut it"
- `tts.cancel()`, `releaseTtsDuck()`, `micGen++`. That last one already silences any turn still thinking or streaming on the TS side.
- **Stop the server-side generation too.** Check `dispatch.rs`/`agents.rs` for a way to cancel an in-flight
  `os_turn`/ElevenLabs stream by `streamId`. If there isn't one, add `os_turn_cancel { streamId }`, backed by a
  cancellation token that drops the `reqwest` stream. Dropping the stream closes the connection, which stops the
  server generating.
- A pending confirmation card → `reject("cut")` (fail closed).
- Clear hold state. Go idle (re-arm hands-free if it's on). Short local acknowledgement, never through the LLM:
  a soft cue sound, or nothing. Don't make Tony say a sentence after "cut it".
- **Also stop Spotify playback and the Gabagool theme** (Decision 1). Use the existing pause paths
  (`stopAllAudio()` in `player.ts`; the Spotify pause in `os-intents.ts`). Spotify is only *paused*, never
  disconnected, and it doesn't auto-resume after a cut.

### 3c. Hold mode — "take it ease" / "whoa" / "aspetta"
- New voice state `"holding"` in `voice-store.ts`, shown as **HOLDING** on the orb, HUD and TopBar (same style as
  STANDBY).
- On enter:
  - **Pause, don't cancel.** Give `KokoroTts` `pause()`/`resume()`: keep the sentence list and the current index;
    `pause()` stops the current source and saves the index; `resume()` replays from the start of the
    interrupted sentence. **Don't suspend the shared `AudioContext`**: the mic capture uses it too.
    `WebSpeechTts` → `speechSynthesis.pause()/resume()`. `FallbackTts` forwards both.
  - Let a still-streaming LLM reply keep filling its bubble silently; queue its unspoken sentences for resume.
  - Pause Spotify **only if it was playing**, and remember that *we* paused it, so resume only unpauses what we
    paused. Same for the Gabagool theme (`player.ts`).
  - Hold the current thread context; nothing is wiped.
- Listen with `endSilenceMs: 4500, maxUtteranceMs: 120_000`, and keep re-listening while holding. Append each non-reflex
  transcript to a `heldSegments: string[]` buffer, shown live in the HUD.
- Exits:
  - **resume** with nothing held → resume Tony from the interrupted sentence and unpause whatever we paused.
  - **submit**, or **resume** with segments held → drop the paused audio and send `heldSegments.join(" ")` via
    `handleInput` as one new turn (thread history already has the original request).
  - **cut** → `killTurn()`.
  - **Timeout:** 90 s with no speech → drop the paused audio quietly, keep the turns on screen, go idle.
- Typed equivalents: the Esc key still means hard stop (`stopVoice`). Add a HUD **Resume** button while holding.

---

## 4. Multi-agent voice handoff — BUILD IT (Decision 3), default ON

Today a delegated answer is re-synthesised and spoken by **Tony**, on purpose, so nobody talks twice. Add
`routing.announcerHandoff` (default **on**, with a toggle in Routing settings to go back to the old behaviour). When it's on: Tony says a short intro in his own voice ("Booking
Desk, you're up."); then the sub-agent's own `reply` step (`r.steps`, `kind: "reply"`) is spoken in **its**
roster voice; Tony does not re-summarise it. Cache each agent's intro line as audio, so the intro costs no
ElevenLabs call or wait after the first time.

Details:
- Speaking order: Tony's intro → the agent's answer. No overlap, and no Tony re-summary afterwards. The text bubble
  still shows Tony's synthesis if there is one; only what gets *spoken* changes.
- Stream the agent's reply sentence by sentence in its own voice when it's available as a stream; otherwise speak
  it when it arrives.
- If several agents answer in one turn, Tony introduces each in turn ("Booking Desk, then Librarian.").
- The cut/hold reflexes apply to whoever is speaking. Hold pauses the agent mid-sentence; resume continues in the
  agent's voice.
- If an agent's voice fails, the existing local-TTS fallback still applies. Don't fall back to Tony's voice
  silently: keep the `tts-fallback` notice.

---

## 5. Done means

- `reflex-parse.test.ts` passes, with every fixture above. Rust tests cover the hallucination guard and the prompt field.
- All of these pass: `npm run typecheck`, `npx vitest run`, `npm run test:scripts`, `cargo test --lib`,
  `python ../tests/run_all.py`.
- `HANDOFF.md` gets a new **§9 Phase 2 — voice reflexes** section in the same style as §6/§7, including what
  wasn't exercised live.
- Live test checklist for me to run in `npm run desktop:dev`:
  1. Ask a long question → say "cut it" mid-answer → silence within a second; no more tokens stream.
  2. Ask a long question → "take it ease" → HOLDING shows, Tony is paused → "keep going" → he restarts the same sentence.
  3. Spotify playing → "whoa" mid-answer → music and Tony pause → add a thought → "go ahead" → one combined turn is
     sent; Spotify resumes.
  4. Idle → "oh what's the weather" → normal answer (no hold).
  5. Confirmation card up → "cut it" → card cancelled.
  6. Spotify + Gabagool theme playing → "cut it" → both stop, Tony stops.
  7. "Tell my booking agent to check WhatsApp" → Tony's intro, then the Booking Desk answers in its own voice; Tony doesn't repeat it.
  8. Speakers mode: Tony says "oh" in a reply → no hold. Headset mode: say "oh" while he talks → hold.

---

## Decisions (already answered — don't ask again)

1. **"Cut it" stops everything**: Tony, sub-agents, the LLM stream, the Gabagool theme and Spotify playback (§3b).
2. **Audio route: I use both a headset and open speakers at different times.** Add the setting
   `conversation.audioRoute: "auto" | "headset" | "speakers"` (default `auto`) to Settings → Voice, with a
   live indicator showing which mode is in effect.
   - `auto`: when a turn starts, check the default audio output's label (`navigator.mediaDevices.enumerateDevices()`,
     `audiooutput`; labels can be read once mic permission is granted). Headphone/headset/earbuds/AirPods/Buds/
     Bluetooth-headset names → headset; anything else, or no label → **speakers** (the safe default).
     Re-check on `devicechange`.
   - `speakers`: single-syllable holds are ignored while TTS is audible (§2 rule 2), and barge-in uses a stricter
     `sensitivityOffset` (−35 instead of −25).
   - `headset`: everything enabled, normal barge-in sensitivity.
   - Add unit tests for the label classifier.
3. **Yes: sub-agents speak their own answers in their own voices** after Tony's intro (§4, default on).
