import { cmd, isTauri, nativeRaw } from "@/lib/platform";
import { voiceLevel } from "./voice-store";

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
  start(h: SttHandlers, opts?: { maxSilenceStartMs?: number }): void;
  /** Finish early and deliver what was heard. */
  stop(): void;
  /** Cancel: discard audio, call no handlers. */
  abort(): void;
}

export interface TtsEngine {
  readonly name: string;
  readonly supported: boolean;
  speak(text: string): Promise<void>;
  cancel(): void;
}

// ── Shared audio context (created lazily inside a user gesture) ─────────────

let ctx: AudioContext | null = null;
export async function audioContext(): Promise<AudioContext> {
  if (!ctx || ctx.state === "closed") ctx = new AudioContext();
  if (ctx.state === "suspended") await ctx.resume();
  return ctx;
}

// ── Mic capture: level meter + optional PCM recording + voice-activity detection ──

interface CaptureOpts {
  record: boolean;
  /** Called once when speech has started and then stayed quiet for `endSilenceMs`. */
  onUtteranceEnd?: (pcm: Float32Array, sampleRate: number) => void;
  onNoSpeech?: () => void;
  onSpeechStart?: () => void;
  maxSilenceStartMs?: number;
}

const SPEECH_ON = 0.09; // normalised level that counts as speech
const SPEECH_OFF = 0.045;
const END_SILENCE_MS = 1100;
const MAX_UTTERANCE_MS = 20_000;

export class MicCapture {
  private stream: MediaStream | null = null;
  private nodes: AudioNode[] = [];
  private raf = 0;
  private chunks: Float32Array[] = [];
  private done = false;

  async start(opts: CaptureOpts): Promise<void> {
    this.stop();
    this.done = false;
    this.chunks = [];
    const ac = await audioContext();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    const src = ac.createMediaStreamSource(this.stream);
    const analyser = ac.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    this.nodes = [src, analyser];

    if (opts.record) {
      await ac.audioWorklet.addModule("/worklets/pcm-capture.js");
      const worklet = new AudioWorkletNode(ac, "pcm-capture");
      worklet.port.onmessage = (e: MessageEvent<Float32Array>) => this.chunks.push(e.data);
      const sink = ac.createGain();
      sink.gain.value = 0; // keep the graph pulled without audible output
      src.connect(worklet).connect(sink).connect(ac.destination);
      this.nodes.push(worklet, sink);
    }

    const buf = new Float32Array(analyser.fftSize);
    const started = performance.now();
    let speechAt = 0;
    let quietSince = 0;
    const loop = () => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const target = Math.min(1, Math.sqrt(sum / buf.length) * 6);
      voiceLevel.current += (target - voiceLevel.current) * (target > voiceLevel.current ? 0.5 : 0.08);

      const now = performance.now();
      if (!this.done && opts.onUtteranceEnd) {
        if (!speechAt && voiceLevel.current > SPEECH_ON) {
          speechAt = now;
          opts.onSpeechStart?.();
        }
        if (speechAt) {
          quietSince = voiceLevel.current < SPEECH_OFF ? quietSince || now : 0;
          if ((quietSince && now - quietSince > END_SILENCE_MS) || now - speechAt > MAX_UTTERANCE_MS) this.finish(ac.sampleRate, opts);
        } else if (now - started > (opts.maxSilenceStartMs ?? 7000)) {
          this.done = true;
          this.stop();
          opts.onNoSpeech?.();
          return;
        }
      }
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  /** End now and hand over whatever was captured (used by the stop button). */
  flush(onUtteranceEnd: CaptureOpts["onUtteranceEnd"]) {
    if (this.done || !ctx) return this.stop();
    this.finish(ctx.sampleRate, { record: true, onUtteranceEnd });
  }

  private finish(rate: number, opts: CaptureOpts) {
    this.done = true;
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const pcm = new Float32Array(total);
    let o = 0;
    for (const c of this.chunks) {
      pcm.set(c, o);
      o += c.length;
    }
    this.stop();
    opts.onUtteranceEnd?.(pcm, rate);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    for (const n of this.nodes) n.disconnect();
    this.nodes = [];
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    voiceLevel.current = 0;
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

  start(h: SttHandlers, opts?: { maxSilenceStartMs?: number }) {
    this.handlers = h;
    h.onPhase?.("waiting");
    this.mic
      .start({
        record: true,
        maxSilenceStartMs: opts?.maxSilenceStartMs,
        onSpeechStart: () => h.onPhase?.("speech"),
        onNoSpeech: () => h.onFinal(""),
        onUtteranceEnd: (pcm, rate) => void this.transcribe(pcm, rate),
      })
      .catch(() => h.onError("Microphone blocked — allow mic access"));
  }

  /** Stop button: transcribe what we have instead of discarding it. */
  stop() {
    this.mic.flush((pcm, rate) => void this.transcribe(pcm, rate));
  }

  abort() {
    this.handlers = null;
    this.mic.stop();
  }

  private async transcribe(pcm: Float32Array, rate: number) {
    const h = this.handlers;
    if (!h) return;
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

  start(h: SttHandlers) {
    if (!this.Ctor) return h.onError("Speech recognition unavailable");
    void this.mic.start({ record: false }).catch(() => undefined); // level meter only
    const rec = new this.Ctor();
    rec.continuous = false;
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

/** Split for pipelining: speak sentence 1 while sentence 2 synthesises. */
export function sentences(text: string, max = 6): string[] {
  const parts = text.replace(/\s+/g, " ").match(/[^.!?]+[.!?]+["')\]]*|\S[^.!?]*$/g) ?? [text];
  const out: string[] = [];
  for (const p of parts.map((s) => s.trim()).filter(Boolean)) {
    if (out.length && (out.at(-1)!.length < 40 || out.length >= max)) out[out.length - 1] += ` ${p}`;
    else out.push(p);
  }
  return out;
}

export class KokoroTts implements TtsEngine {
  readonly name = "Kokoro";
  readonly supported = isTauri();
  private current: AudioBufferSourceNode | null = null;
  private generation = 0;
  private raf = 0;

  async speak(text: string): Promise<void> {
    this.cancel();
    const gen = ++this.generation;
    const ac = await audioContext();
    const analyser = ac.createAnalyser();
    analyser.fftSize = 512;
    analyser.connect(ac.destination);
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
    const pending = sentences(text).map((s) =>
      cmd("tts_synthesize", { text: s }).then((bytes) => ac.decodeAudioData(bytes)),
    );
    try {
      for (const p of pending) {
        const audio = await p;
        if (gen !== this.generation) return;
        await new Promise<void>((resolve) => {
          const src = ac.createBufferSource();
          src.buffer = audio;
          src.connect(analyser);
          src.onended = () => resolve();
          this.current = src;
          src.start();
        });
      }
    } finally {
      if (gen === this.generation) {
        cancelAnimationFrame(this.raf);
        voiceLevel.current = 0;
        analyser.disconnect();
      }
    }
  }

  cancel() {
    this.generation++;
    cancelAnimationFrame(this.raf);
    try {
      this.current?.stop();
    } catch {
      /* already stopped */
    }
    this.current = null;
    voiceLevel.current = 0;
  }
}

// ── Web Speech TTS (fallback everywhere) ────────────────────────────────────

export class WebSpeechTts implements TtsEngine {
  readonly name = "System voice";
  readonly supported = typeof window !== "undefined" && "speechSynthesis" in window;
  private raf = 0;

  speak(text: string): Promise<void> {
    if (!this.supported || !text) return Promise.resolve();
    this.cancel();
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text.slice(0, 600));
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
    });
  }

  cancel() {
    cancelAnimationFrame(this.raf);
    if (this.supported) speechSynthesis.cancel();
  }
}

// ── Selection ───────────────────────────────────────────────────────────────

/** Primary TTS with automatic fallback to the system voice if Kokoro is down. */
export class FallbackTts implements TtsEngine {
  readonly supported: boolean;
  private active: TtsEngine;
  constructor(private primary: TtsEngine, private backup: TtsEngine) {
    this.supported = primary.supported || backup.supported;
    this.active = primary.supported ? primary : backup;
  }
  get name() {
    return this.active.name;
  }
  async speak(text: string) {
    if (this.active === this.primary) {
      try {
        return await this.primary.speak(text);
      } catch (e) {
        console.warn("[tts] primary failed, using system voice", e);
        this.active = this.backup;
      }
    }
    return this.backup.speak(text);
  }
  cancel() {
    this.primary.cancel();
    this.backup.cancel();
  }
}

export function createEngines(): { stt: SttEngine | null; tts: TtsEngine } {
  const whisper = new WhisperStt();
  const web = new WebSpeechStt();
  return {
    stt: whisper.supported ? whisper : web.supported ? web : null,
    tts: new FallbackTts(new KokoroTts(), new WebSpeechTts()),
  };
}
