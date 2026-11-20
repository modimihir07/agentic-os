import { cmd, isTauri, nativeRaw } from "@/lib/platform";
import { useSettings } from "@/stores/settings";
import { voiceLevel } from "./voice-store";
import { SileroStream, preloadSilero, sileroThresholds } from "./silero";
import { utteranceShouldEnd } from "./vad-rules";
import { sentences, stripForSpeech } from "./tts-text";
import type { SpeakOpts, TtsEngine } from "./tts-types";
import { FallbackTts } from "./tts-fallback";

// Re-exported so existing importers (`voice-controller.ts` et al.) are unaffected by
// the split — these three live in their own files so they're testable under Vitest
// without pulling in this file's browser-only code (see `tts-types.ts`'s doc comment).
export { sentences, stripForSpeech, FallbackTts };
export type { SpeakOpts, TtsEngine };

/**
 * Pluggable speech I/O. The controller only talks to these interfaces.
 *
 *   Desktop:  WhisperStt (mic → VAD → 16 kHz WAV → Rust → whisper server)
 *             KokoroTts  (Rust → Kokoro-FastAPI → mp3 → WebAudio, sentence-pipelined)
 *   PWA:      WebSpeechStt (Chrome/Android) + WebSpeechTts
 *             TODO(cline): gateway /api/voice/{stt,tts} proxies so mobile uses Whisper/Kokoro too.
 *
 * Every engine feeds `voiceLevel` so the waveform reacts to real audio.
 */
export interface SttHandlers {
  onPartial: (t: string) => void;
  onFinal: (t: string) => void;
  onError: (e: string) => void;
  /** Speech started/ended — lets the UI say "Listening…" vs "Transcribing…". */
  onPhase?: (p: "waiting" | "speech" | "transcribing") => void;
}

export interface SttEngine {
  readonly name: string;
  readonly supported: boolean;
  start(h: SttHandlers, opts?: { maxSilenceStartMs?: number; sensitivityOffset?: number; endSilenceMs?: number; maxUtteranceMs?: number }): void;
  /** Finish early and deliver what was heard. */
  stop(): void;
  /** Cancel: discard audio, call no handlers. */
  abort(): void;
}

// ── Shared audio context (created lazily inside a user gesture) ─────────────

let ctx: AudioContext | null = null;
export async function audioContext(): Promise<AudioContext> {
  if (!ctx || ctx.state === "closed") ctx = new AudioContext();
  if (ctx.state === "suspended") await ctx.resume();
  return ctx;
}

// ── Mic capture + voice-activity detection ──────────────────────────────────
//
// VAD runs on audio-thread frames (~21 ms each), so it keeps working when the
// window is in the background. Thresholds adapt to the room: a running noise
// floor is tracked while you're quiet, and "speech" means clearly above it.
// Settings → Voice & Triggers → Voice detection: sensitivity, end-of-speech
// pause, max utterance — with a live meter.

interface CaptureOpts {
  record: boolean;
  /** Called once when speech has started and then stayed quiet for the end-of-speech pause. */
  onUtteranceEnd?: (pcm: Float32Array, sampleRate: number) => void;
  onNoSpeech?: () => void;
  onSpeechStart?: () => void;
  maxSilenceStartMs?: number;
  /** Meter only (Settings test): don't keep audio. */
  meterOnly?: boolean;
  /** Added to the sensitivity (negative = stricter, e.g. while Tony is speaking). */
  sensitivityOffset?: number;
  /** Pause (ms) that ends an utterance. Overrides `vad.endSilenceMs`; `Infinity` never ends on silence. */
  endSilenceMs?: number;
  /** Hard cap (ms) on one utterance, measured from speech start. Overrides `vad.maxUtteranceMs`; `Infinity` disables the cap. */
  maxUtteranceMs?: number;
}

/**
 * Live VAD state for the Settings meter (read in a rAF loop while visible).
 * `neural` = Silero is deciding; then `prob`/`probOn`/`probOff` are the live
 * speech probability and its trigger/pause lines (0–1).
 */
export const vadMeter = { level: 0, floor: 0, on: 0, off: 0, speaking: false, neural: false, prob: 0, probOn: 0, probOff: 0 };

const FRAME_SAMPLES = 1024;

export function vadThresholds(floor: number, sensitivity: number) {
  const s = Math.max(0, Math.min(100, sensitivity)) / 100;
  // High sensitivity → trigger closer to the noise floor and at quieter absolute levels.
  const ratioOn = 4.2 - s * 2.7; // 4.2× (deaf) … 1.5× (hair-trigger) above the floor
  const absOn = 0.02 - s * 0.017; // 0.02 … 0.003 RMS
  const on = Math.max(absOn, floor * ratioOn);
  const off = Math.max(absOn * 0.55, floor * Math.max(1.25, ratioOn * 0.55));
  return { on, off };
}

export class MicCapture {
  private stream: MediaStream | null = null;
  private nodes: AudioNode[] = [];
  private chunks: Float32Array[] = [];
  private done = true;
  private timer: ReturnType<typeof setInterval> | undefined;
  private silero: SileroStream | null = null;
  /** Bumped by every start()/stop(): an older start() still awaiting the mic sees it changed and bails. */
  private session = 0;

  /** start() is still acquiring the mic (nothing captured yet, not stopped). */
  get starting() {
    return !this.done && !this.stream;
  }

  async start(opts: CaptureOpts): Promise<void> {
    this.stop();
    const my = ++this.session;
    this.done = false;
    this.chunks = [];
    const ac = await audioContext();
    if (my !== this.session) return;
    const { micDeviceId: deviceId, vad } = useSettings.getState();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        // AGC pumps room noise up between words, which kept the old VAD "hearing speech" forever.
        autoGainControl: false,
        channelCount: 1,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
    });
    if (my !== this.session) return stream.getTracks().forEach((t) => t.stop());
    this.stream = stream;
    const src = ac.createMediaStreamSource(stream);
    await ac.audioWorklet.addModule(import.meta.env.BASE_URL + "worklets/pcm-capture.js");
    // A stop() during addModule already released `stream`; stopping again is a no-op.
    if (my !== this.session) return stream.getTracks().forEach((t) => t.stop());
    const worklet = new AudioWorkletNode(ac, "pcm-capture");
    const sink = ac.createGain();
    sink.gain.value = 0; // keep the graph pulled without audible output
    src.connect(worklet).connect(sink).connect(ac.destination);
    this.nodes = [src, worklet, sink];

    const frameMs = (FRAME_SAMPLES / ac.sampleRate) * 1000;
    const started = performance.now();
    let floor = 0;
    let calibrated = 0; // frames used for the initial floor
    let above = 0; // consecutive speech frames/windows (debounce)
    let speechAt = 0;
    let speechChunk = 0;
    let quietMs = 0;
    const sens = vad.sensitivity + (opts.sensitivityOffset ?? 0);
    // A caller (e.g. Brainstorm's per-profile dictation) overrides the global VAD pause/cap;
    // `Infinity` disables either check (continuous mode never ends on silence or a time cap).
    const endMs = opts.endSilenceMs ?? vad.endSilenceMs;
    const maxMs = opts.maxUtteranceMs ?? vad.maxUtteranceMs;

    /** Shared speech state machine; fed by Silero windows or, as a fallback, energy frames. */
    const step = (isSpeech: boolean, isQuiet: boolean, ms: number, debounce: number) => {
      if (this.done || !opts.onUtteranceEnd) return;
      const now = performance.now();
      if (!speechAt) {
        above = isSpeech ? above + 1 : 0;
        if (above >= debounce) {
          // Keep ~300 ms of pre-roll before the trigger.
          speechAt = now;
          speechChunk = Math.max(0, this.chunks.length - 3 - 14);
          opts.onSpeechStart?.();
        }
        return;
      }
      quietMs = isQuiet ? quietMs + ms : 0;
      if (utteranceShouldEnd(quietMs, endMs, now - speechAt, maxMs)) this.finish(ac.sampleRate, opts, speechChunk);
    };

    // Neural VAD: decides once its model is loaded; until then (or if it fails) energy decides.
    const silero = opts.onUtteranceEnd ? new SileroStream(ac.sampleRate, (p) => {
      const { on, off } = sileroThresholds(sens);
      Object.assign(vadMeter, { prob: p, probOn: on, probOff: off });
      step(p >= on, p < off, 32, 2); // 2 windows ≈ 64 ms of speech to start
    }) : null;
    this.silero = silero;

    worklet.port.onmessage = (e: MessageEvent<{ pcm: Float32Array; rms: number }>) => {
      if (this.done) return;
      const { pcm, rms } = e.data;
      if (!opts.meterOnly) this.chunks.push(pcm);
      voiceLevel.current += (Math.min(1, rms * 6) - voiceLevel.current) * 0.5;
      const neural = !!silero?.ready && !silero.failed;
      if (neural) silero.push(pcm);

      // Noise floor: average of the first ~250 ms, then tracked while not speaking.
      if (calibrated < 12) {
        floor = (floor * calibrated + rms) / (calibrated + 1);
        calibrated++;
      } else if (!speechAt) {
        floor = rms < floor * 2 ? floor * 0.95 + rms * 0.05 : floor * 0.997 + rms * 0.003;
      }
      floor = Math.min(floor, 0.05);
      const { on, off } = vadThresholds(floor, sens);
      Object.assign(vadMeter, { level: rms, floor, on, off, speaking: !!speechAt, neural });
      if (!opts.onUtteranceEnd || calibrated < 6) return;

      if (!speechAt && performance.now() - started > (opts.maxSilenceStartMs ?? 7000)) {
        this.done = true;
        this.stop();
        opts.onNoSpeech?.();
        return;
      }
      // ~60 ms of clear speech (3 frames) to start.
      if (!neural) step(rms > on, rms < off, frameMs, 3);
    };

    // Safety net if the audio thread stalls (device unplugged…): give up after the max utterance.
    // Measured from speech start once speech has begun (so a long pre-speech wait in relaxed/
    // continuous mode — maxSilenceStartMs can be Infinity there — doesn't eat into the budget);
    // before that, from mic start. Infinity thresholds correctly never trip this (Infinity-safe).
    this.timer = setInterval(() => {
      if (this.done) return;
      const now = performance.now();
      if (speechAt) {
        if (now - speechAt > maxMs + 2000) {
          if (opts.onUtteranceEnd && this.chunks.length) this.finish(ac.sampleRate, opts, speechChunk);
          else this.stop();
        }
      } else if (now - started > (opts.maxSilenceStartMs ?? 7000) + 2000) {
        this.stop();
      }
    }, 1000);
  }

  /** End now and hand over whatever was captured (used by the stop button). Nothing live → just stop. */
  flush(onUtteranceEnd: CaptureOpts["onUtteranceEnd"]) {
    if (this.done || !this.stream || !ctx) return this.stop();
    this.finish(ctx.sampleRate, { record: true, onUtteranceEnd }, 0);
  }

  private finish(rate: number, opts: CaptureOpts, fromChunk: number) {
    this.done = true;
    const chunks = this.chunks.slice(fromChunk);
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const pcm = new Float32Array(total);
    let o = 0;
    for (const c of chunks) {
      pcm.set(c, o);
      o += c.length;
    }
    this.stop();
    opts.onUtteranceEnd?.(pcm, rate);
  }

  /** Releases the mic (tracks stopped → OS indicator off). The shared AudioContext stays open for TTS. */
  stop() {
    this.session++;
    this.done = true;
    clearInterval(this.timer);
    this.silero?.close();
    this.silero = null;
    for (const n of this.nodes) n.disconnect();
    if (this.nodes[1] instanceof AudioWorkletNode) this.nodes[1].port.onmessage = null;
    this.nodes = [];
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    voiceLevel.current = 0;
    vadMeter.speaking = false;
  }
}

/** Float32 mic PCM → 16 kHz mono 16-bit WAV (what every Whisper server accepts). */
export function encodeWav16k(pcm: Float32Array, inRate: number): Uint8Array {
  const outRate = 16000;
  const ratio = inRate / outRate;
  const n = Math.floor(pcm.length / ratio);
  const out = new DataView(new ArrayBuffer(44 + n * 2));
  const w = (o: number, s: string) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF");
  out.setUint32(4, 36 + n * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, outRate, true);
  out.setUint32(28, outRate * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  w(36, "data");
  out.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    // Box-filter decimation: average the input samples this output sample covers.
    const a = Math.floor(i * ratio), b = Math.min(pcm.length, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = a; j < b; j++) s += pcm[j];
    const v = Math.max(-1, Math.min(1, s / Math.max(1, b - a)));
    out.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Uint8Array(out.buffer);
}

// ── Whisper STT (desktop) ────────────────────────────────────────────────────

export class WhisperStt implements SttEngine {
  readonly name = "Whisper";
  readonly supported = isTauri();
  private mic = new MicCapture();
  private handlers: SttHandlers | null = null;

  constructor() {
    // Load Silero now so the first utterance is already judged by the neural VAD.
    if (this.supported) void preloadSilero();
  }

  start(h: SttHandlers, opts?: { maxSilenceStartMs?: number; sensitivityOffset?: number; endSilenceMs?: number; maxUtteranceMs?: number }) {
    this.handlers = h;
    h.onPhase?.("waiting");
    const current = () => this.handlers === h;
    this.mic
      .start({
        record: true,
        maxSilenceStartMs: opts?.maxSilenceStartMs,
        sensitivityOffset: opts?.sensitivityOffset,
        endSilenceMs: opts?.endSilenceMs,
        maxUtteranceMs: opts?.maxUtteranceMs,
        onSpeechStart: () => current() && h.onPhase?.("speech"),
        onNoSpeech: () => current() && h.onFinal(""),
        onUtteranceEnd: (pcm, rate) => void this.transcribe(pcm, rate, h),
      })
      .catch(() => current() && h.onError("Microphone blocked — allow mic access"));
  }

  /** Stop button: transcribe what we have instead of discarding it. */
  stop() {
    const h = this.handlers;
    if (!h) return this.mic.stop();
    // Stopped before the mic even opened: nothing was captured, so the listen simply ends empty.
    if (this.mic.starting) {
      this.mic.stop();
      return h.onFinal("");
    }
    this.mic.flush((pcm, rate) => void this.transcribe(pcm, rate, h));
  }

  abort() {
    this.handlers = null;
    this.mic.stop();
  }

  private async transcribe(pcm: Float32Array, rate: number, h: SttHandlers) {
    if (this.handlers !== h) return;
    if (pcm.length < rate * 0.3) return h.onFinal("");
    h.onPhase?.("transcribing");
    try {
      const text = await nativeRaw<string>("stt_transcribe", encodeWav16k(pcm, rate));
      if (this.handlers === h) h.onFinal(text.trim());
    } catch (e) {
      if (this.handlers === h) h.onError(`Whisper: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

// ── Web Speech STT (PWA in Chrome/Android) ───────────────────────────────────

type SR = {
  continuous: boolean; interimResults: boolean; lang: string;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  onspeechstart: (() => void) | null;
  start(): void; stop(): void;
};

export class WebSpeechStt implements SttEngine {
  readonly name = "Web Speech";
  readonly supported: boolean;
  private rec: SR | null = null;
  private Ctor: (new () => SR) | undefined;
  private mic = new MicCapture();

  constructor() {
    const w = window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR };
    this.Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    this.supported = !!this.Ctor && !isTauri(); // WebView2 exposes the API but it never returns results
  }

  start(h: SttHandlers, opts?: { maxSilenceStartMs?: number; sensitivityOffset?: number; endSilenceMs?: number; maxUtteranceMs?: number }) {
    if (!this.Ctor) return h.onError("Speech recognition unavailable");
    void this.mic.start({ record: false, meterOnly: true }).catch(() => undefined); // level meter only
    const rec = new this.Ctor();
    // Chrome's own endpointing has no configurable pause length, so snappy/relaxed just use its
    // default (ends the session after a short pause). Continuous mode (endSilenceMs: Infinity)
    // asks Chrome to keep recognizing across pauses; the session then only ends via stop()/abort().
    rec.continuous = opts?.endSilenceMs === Infinity;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";
    let finalText = "";
    h.onPhase?.("waiting");
    rec.onspeechstart = () => h.onPhase?.("speech");
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      h.onPartial((finalText + interim).trim());
    };
    let aborted = false;
    this.abortCurrent = () => {
      aborted = true;
      rec.stop();
    };
    rec.onerror = (e) => {
      if (!aborted && e.error !== "no-speech" && e.error !== "aborted") h.onError(`Mic: ${e.error}`);
    };
    rec.onend = () => {
      this.rec = null;
      this.mic.stop();
      if (!aborted) h.onFinal(finalText.trim());
    };
    this.rec = rec;
    rec.start();
  }

  private abortCurrent: () => void = () => undefined;

  stop() {
    this.rec?.stop();
  }

  abort() {
    this.abortCurrent();
    this.mic.stop();
  }
}

// ── Kokoro TTS (desktop) ─────────────────────────────────────────────────────

export class KokoroTts implements TtsEngine {
  readonly name = "Kokoro";
  readonly supported = isTauri();
  private current: AudioBufferSourceNode | null = null;
  private generation = 0;
  private raf = 0;
  /** Synth requests started ahead of playback (sentence N+1 renders while N plays). */
  private ahead = new Map<string, { at: number; p: Promise<ArrayBuffer> }>();

  private key(s: string, opts?: SpeakOpts) {
    return `${opts?.agent ?? ""}|${opts?.voice ?? ""}|${opts?.previousText ?? ""}|${s}`;
  }

  /** Session cache for `cache: true` lines (intro lines). Holds the raw bytes; each play gets a
   * copy because decodeAudioData detaches the buffer it's given. */
  private pinned = new Map<string, Promise<ArrayBuffer>>();

  private synth(s: string, opts?: SpeakOpts): Promise<ArrayBuffer> {
    const key = this.key(s, opts);
    if (opts?.cache) {
      let p = this.pinned.get(key);
      if (!p) {
        p = cmd("tts_synthesize", { text: s, voice: opts.voice, agent: opts.agent });
        this.pinned.set(key, p);
        p.catch(() => this.pinned.delete(key)); // a failed synth is retried next time
      }
      return p.then((b) => b.slice(0));
    }
    const hit = this.ahead.get(key);
    if (hit) {
      this.ahead.delete(key);
      return hit.p;
    }
    return cmd("tts_synthesize", { text: s, voice: opts?.voice, agent: opts?.agent, previousText: opts?.previousText });
  }

  /** `sentences(text)` with each one's own opts, chaining `previousText` from
   * the sentence right before it (the caller's own `opts.previousText`, if
   * any, only applies to the first) — ElevenLabs prosody continuity (Part 6 §2). */
  private perSentenceOpts(text: string, opts?: SpeakOpts): { s: string; opts: SpeakOpts }[] {
    let prev = opts?.previousText;
    return sentences(text).map((s) => {
      const sOpts: SpeakOpts = { ...opts, previousText: prev };
      prev = s;
      return { s, opts: sOpts };
    });
  }

  prefetch(text: string, opts?: SpeakOpts) {
    const now = Date.now();
    for (const [k, v] of this.ahead) if (now - v.at > 60_000) this.ahead.delete(k);
    for (const { s, opts: sOpts } of this.perSentenceOpts(text, opts)) {
      const key = this.key(s, sOpts);
      if (this.ahead.has(key)) continue;
      const p = cmd("tts_synthesize", { text: s, voice: sOpts.voice, agent: sOpts.agent, previousText: sOpts.previousText });
      p.catch(() => this.ahead.delete(key));
      this.ahead.set(key, { at: now, p });
    }
  }

  // ── Phase 2: duck (barge-in) and pause/resume (hold) ──
  /** Level while the user talks over the reply. */
  static readonly DUCK_LEVEL = 0.15;
  private gain: GainNode | null = null;
  private ducked = false;
  private paused = false;
  /** The source pause() stopped (its onended must replay, not advance — even after a quick resume). */
  private pausedSrc: AudioBufferSourceNode | null = null;
  private waiters: (() => void)[] = [];

  duck(on: boolean) {
    this.ducked = on;
    const g = this.gain;
    // One audio frame-ish ramp: fast enough to feel instant, smooth enough not to click.
    if (g) g.gain.setTargetAtTime(on ? KokoroTts.DUCK_LEVEL : 1, g.context.currentTime, 0.01);
  }

  /** Keeps the sentence list and index (see speak()); the shared AudioContext keeps running for the mic. */
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.pausedSrc = this.current;
    try {
      this.current?.stop(); // its onended sees `pausedSrc` and replays that sentence on resume
    } catch {
      /* not started */
    }
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.flushWaiters();
  }

  private flushWaiters() {
    const w = this.waiters;
    this.waiters = [];
    w.forEach((f) => f());
  }

  /** Resolves on resume() or cancel() (the caller re-checks its generation). */
  private untilResumed(): Promise<void> {
    return this.paused ? new Promise((r) => this.waiters.push(r)) : Promise.resolve();
  }

  async speak(text: string, opts?: SpeakOpts): Promise<void> {
    this.stopCurrent();
    const gen = ++this.generation;
    const ac = await audioContext();
    const analyser = ac.createAnalyser();
    analyser.fftSize = 512;
    analyser.connect(ac.destination);
    // sources → gain (duck) → analyser (meter) → speakers
    const gain = ac.createGain();
    gain.gain.value = this.ducked ? KokoroTts.DUCK_LEVEL : 1;
    gain.connect(analyser);
    this.gain = gain;
    const buf = new Float32Array(analyser.fftSize);
    const meter = () => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const target = Math.min(1, Math.sqrt(sum / buf.length) * 5);
      voiceLevel.current += (target - voiceLevel.current) * 0.3;
      this.raf = requestAnimationFrame(meter);
    };
    this.raf = requestAnimationFrame(meter);

    // Fire all synth requests now; play strictly in order as each resolves.
    const pending = this.perSentenceOpts(text, opts).map(({ s, opts: sOpts }) => this.synth(s, sOpts).then((bytes) => ac.decodeAudioData(bytes)));
    try {
      for (let i = 0; i < pending.length; ) {
        const audio = await pending[i];
        if (gen !== this.generation) return;
        // Held before this sentence started (or a speak() that began during hold): wait.
        await this.untilResumed();
        if (gen !== this.generation) return;
        const finished = await new Promise<boolean>((resolve) => {
          const src = ac.createBufferSource();
          src.buffer = audio;
          src.connect(gain);
          // Ended on its own → next sentence; stopped by pause() → replay this one on resume.
          src.onended = () => resolve(this.pausedSrc !== src);
          this.current = src;
          src.start();
        });
        if (gen !== this.generation) return;
        if (finished) i++;
        else this.pausedSrc = null;
      }
    } finally {
      if (gen === this.generation) {
        cancelAnimationFrame(this.raf);
        voiceLevel.current = 0;
        analyser.disconnect();
        gain.disconnect();
        if (this.gain === gain) this.gain = null;
      }
    }
  }

  /** Stop playback without touching duck/pause state (a new speak() of the same reply). */
  private stopCurrent() {
    this.generation++;
    cancelAnimationFrame(this.raf);
    try {
      this.current?.stop();
    } catch {
      /* already stopped */
    }
    this.current = null;
    voiceLevel.current = 0;
    this.flushWaiters(); // a speak() waiting out a hold ends (its generation is stale)
  }

  /** Hard stop: drops the reply, any paused audio and the duck. */
  cancel() {
    this.paused = false;
    this.ducked = false;
    this.gain = null;
    this.stopCurrent();
  }
}

// ── Web Speech TTS (fallback everywhere) ────────────────────────────────────

export class WebSpeechTts implements TtsEngine {
  readonly name = "System voice";
  readonly supported = typeof window !== "undefined" && "speechSynthesis" in window;
  private raf = 0;
  /** No gain on speechSynthesis: a duck pauses instead, a hold pauses too; either keeps it paused. */
  private ducked = false;
  private held = false;
  private gen = 0;
  private waiters: (() => void)[] = [];

  private apply() {
    if (!this.supported) return;
    if (this.ducked || this.held) speechSynthesis.pause();
    else {
      speechSynthesis.resume();
      const w = this.waiters;
      this.waiters = [];
      w.forEach((f) => f());
    }
  }
  duck(on: boolean) {
    this.ducked = on;
    this.apply();
  }
  pause() {
    this.held = true;
    this.apply();
  }
  resume() {
    this.held = false;
    this.apply();
  }

  async speak(text: string): Promise<void> {
    if (!this.supported || !text) return;
    cancelAnimationFrame(this.raf);
    speechSynthesis.cancel();
    const gen = ++this.gen;
    // Started during a hold: wait (cancel() also releases this, with a stale generation).
    if (this.held) await new Promise<void>((r) => this.waiters.push(r));
    if (gen !== this.gen) return;
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(stripForSpeech(text).slice(0, 600));
      u.rate = 1.03;
      // No audio tap on speechSynthesis, so synthesise an envelope from word boundaries.
      let target = 0.35;
      u.onboundary = () => (target = 0.45 + Math.random() * 0.5);
      const tick = () => {
        target *= 0.94;
        voiceLevel.current += (target - voiceLevel.current) * 0.25;
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
      const done = () => {
        cancelAnimationFrame(this.raf);
        voiceLevel.current = 0;
        resolve();
      };
      u.onend = done;
      u.onerror = done;
      speechSynthesis.speak(u);
      if (this.ducked) speechSynthesis.pause();
    });
  }

  cancel() {
    cancelAnimationFrame(this.raf);
    this.gen++;
    this.ducked = false;
    this.held = false;
    const w = this.waiters;
    this.waiters = [];
    w.forEach((f) => f());
    if (this.supported) {
      speechSynthesis.cancel();
      speechSynthesis.resume(); // a paused synth stays paused for the next utterance otherwise
    }
  }
}

// ── Selection ───────────────────────────────────────────────────────────────
// `FallbackTts` lives in `./tts-fallback` (re-exported above).

export function createEngines(): { stt: SttEngine | null; tts: TtsEngine } {
  const whisper = new WhisperStt();
  const web = new WebSpeechStt();
  return {
    stt: whisper.supported ? whisper : web.supported ? web : null,
    tts: new FallbackTts(new KokoroTts(), new WebSpeechTts()),
  };
}
