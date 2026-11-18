import { create } from "zustand";
import { cc } from "@/lib/cc-api";
import { cmd, isTauri } from "@/lib/platform";
import type { AudioClip, CueWidget, ThemeClip } from "./types";

/**
 * Cue playback (Web Audio). Trims are non-destructive: the original file is
 * played from inPoint for (outPoint − inPoint) seconds with gain-ramped fades;
 * a looping theme loops just that window.
 *
 * Sequence ("Gabagool Mode"):
 *   theme starts at its inPoint, DUCKED → Tony speaks the intro → soundbite plays
 *   (theme still ducked underneath) → theme rises to its volume → stops at its
 *   outPoint (or loops until you stop it).
 */
let ctx: AudioContext | null = null;
const buffers = new Map<string, Promise<AudioBuffer>>();

export function audio(): AudioContext {
  ctx ??= new AudioContext();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

export function loadBuffer(fileId: string): Promise<AudioBuffer> {
  let p = buffers.get(fileId);
  if (!p) {
    p = fetch(cc.fileUrl(fileId))
      .then((r) => {
        if (!r.ok) throw new Error(`audio file ${r.status}`);
        return r.arrayBuffer();
      })
      .then((b) => audio().decodeAudioData(b));
    buffers.set(fileId, p);
    p.catch(() => buffers.delete(fileId));
  }
  return p;
}

/** Min/max peaks for a mini waveform. */
export function peaks(buf: AudioBuffer, bins = 160): number[] {
  const data = buf.getChannelData(0);
  const step = Math.max(1, Math.floor(data.length / bins));
  const out: number[] = [];
  for (let i = 0; i < bins; i++) {
    let m = 0;
    for (let j = i * step; j < Math.min(data.length, (i + 1) * step); j += 16) m = Math.max(m, Math.abs(data[j]));
    out.push(m);
  }
  return out;
}

export interface Playing {
  gain: GainNode;
  stop: (fadeMs?: number) => void;
  done: Promise<void>;
}

/** Play the trimmed window of a clip. `level` overrides the clip volume (0–1). */
export async function playClip(clip: AudioClip, level?: number): Promise<Playing> {
  const buf = await loadBuffer(clip.fileId);
  const a = audio();
  const start = Math.max(0, Math.min(clip.inPoint, buf.duration));
  const end = Math.max(start + 0.05, Math.min(clip.outPoint || buf.duration, buf.duration));
  const len = end - start;
  const src = a.createBufferSource();
  src.buffer = buf;
  const gain = a.createGain();
  src.connect(gain).connect(a.destination);
  const vol = level ?? clip.volume / 100;
  const t0 = a.currentTime;
  const fi = Math.min(clip.fadeInMs / 1000, len / 2);
  const fo = Math.min(clip.fadeOutMs / 1000, len / 2);
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(vol, t0 + Math.max(0.01, fi));
  if (clip.loop) {
    src.loop = true;
    src.loopStart = start;
    src.loopEnd = end;
    src.start(t0, start);
  } else {
    gain.gain.setValueAtTime(vol, t0 + Math.max(fi, len - fo));
    gain.gain.linearRampToValueAtTime(0, t0 + len);
    src.start(t0, start, len);
  }
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  src.onended = () => resolve();
  return {
    gain,
    done,
    stop: (fadeMs = 300) => {
      const now = a.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(0, now + fadeMs / 1000);
      try {
        src.stop(now + fadeMs / 1000 + 0.02);
      } catch {
        /* already stopped */
      }
    },
  };
}

function ramp(g: GainNode, to: number, ms: number) {
  const a = audio();
  const now = a.currentTime;
  g.gain.cancelScheduledValues(now);
  g.gain.setValueAtTime(g.gain.value, now);
  g.gain.linearRampToValueAtTime(to, now + ms / 1000);
}

// ── Running cue state (top-bar pill shows it) ───────────────────────────────

interface CueRun {
  running: string | null;
  /** Built-in id of the running cue ("gabagool"), if any. */
  builtin: string | null;
  /** When a cue last fired (ms epoch, 0 = never): bare "stop"/"turn off" stop it for 10 min. */
  lastCueAt: number;
  stopAll: () => void;
}
let current: Playing[] = [];
let generation = 0;

export const useCueRun = create<CueRun>((set) => ({
  running: null,
  builtin: null,
  lastCueAt: 0,
  stopAll: () => {
    generation++;
    current.forEach((p) => p.stop(400));
    current = [];
    set({ running: null, builtin: null });
  },
}));

/** Gabagool mode = the built-in Gabagool cue is playing. */
export const gabagoolOn = (s: Pick<CueRun, "running" | "builtin"> = useCueRun.getState()) => !!s.running && s.builtin === "gabagool";

/** A cue is playing or fired within `windowMs` (default 10 min). */
export function cueRecentlyActive(windowMs = 10 * 60_000, now = Date.now()): boolean {
  const s = useCueRun.getState();
  return !!s.running || (s.lastCueAt > 0 && now - s.lastCueAt < windowMs);
}

// Tony's TTS lives in the voice controller; it registers its cancel here (no import cycle).
let cancelSpeech: () => void = () => undefined;
export const registerSpeechCancel = (f: () => void) => {
  cancelSpeech = f;
};

/** Stop every cue clip AND Tony's speech (the intro line keeps talking otherwise). */
export function stopAllAudio() {
  useCueRun.getState().stopAll();
  try {
    cancelSpeech();
  } catch {
    /* best-effort */
  }
}

async function introText(w: CueWidget): Promise<string> {
  if (w.intro.mode === "static" || !w.intro.text.trim()) return w.intro.text;
  if (!isTauri()) return w.intro.text;
  try {
    const now = new Date().toLocaleString("en-CA", { weekday: "long", hour: "numeric", minute: "2-digit" });
    const r = await cmd("dispatch_chat", {
      req: { messages: [{ role: "system", content: `You are Tony. Reply with ONE short spoken line (max 20 words), no quotes. It is ${now}.` }, { role: "user", content: w.intro.text }], priority: "interactive", maxSecs: 15 },
    });
    return r.content.trim() || w.intro.text;
  } catch {
    return w.intro.text;
  }
}

/**
 * Run a cue widget. `speak` = Tony's TTS (passed in to avoid an import cycle).
 * Resolves when the sequence (not a looping theme) has finished.
 */
export async function runCue(w: CueWidget, speak: (text: string, voice?: string) => Promise<void>, onAction?: (w: CueWidget) => void) {
  useCueRun.getState().stopAll();
  const gen = ++generation;
  useCueRun.setState({ running: w.name, builtin: w.builtin ?? null, lastCueAt: Date.now() });
  const alive = () => gen === generation;
  try {
    audio();
    const theme: ThemeClip | null = w.theme;
    const targetVol = (theme?.volume ?? 100) / 100;
    const duckVol = theme?.duck ? (theme.duckLevel ?? 22) / 100 : targetVol;
    let themePlay: Playing | null = null;
    if (theme) {
      themePlay = await playClip(theme, duckVol);
      current.push(themePlay);
    }
    const line = await introText(w);
    if (line && alive()) await speak(line, w.intro.voice || undefined);
    if (w.soundbite && alive()) {
      const sb = await playClip(w.soundbite);
      current.push(sb);
      await sb.done;
    }
    if (themePlay && alive() && theme?.duck) ramp(themePlay.gain, targetVol, 600);
    if (alive()) onAction?.(w);
    if (themePlay && !theme?.loop) await themePlay.done;
  } finally {
    if (alive() && !(w.theme?.loop)) useCueRun.setState({ running: null, builtin: null });
  }
}
