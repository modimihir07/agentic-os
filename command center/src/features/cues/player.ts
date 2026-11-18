import { create } from "zustand";
import { cc, collections } from "@/lib/cc-api";
import { cmd, isTauri } from "@/lib/platform";
import type { AudioClip, CueWidget, ThemeClip } from "./types";
import { DUCK_GAIN, clampVolume, nudgeVolume, softClipCurve, updateDuckSources, volumeGain, type DuckSource } from "./volume";

/**
 * Cue playback (Web Audio). Trims are non-destructive: the original file is
 * played from inPoint for (outPoint − inPoint) seconds with gain-ramped fades;
 * a looping theme loops just that window.
 *
 * Sequence ("Gabagool Mode"):
 *   theme starts at its inPoint, DUCKED → Tony speaks the intro → soundbite plays
 *   (theme still ducked underneath) → theme rises to its volume → stops at its
 *   outPoint (or loops until you stop it).
 *
 * Every clip plays through one master bus: duck gain → limiter → soft clip → out.
 * Clip volumes go up to 300 %; the limiter and soft clip keep that from clipping hard.
 */
let ctx: AudioContext | null = null;
const buffers = new Map<string, Promise<AudioBuffer>>();

export function audio(): AudioContext {
  ctx ??= new AudioContext();
  if (ctx.state === "suspended" && !cueHeld) void ctx.resume();
  return ctx;
}

/** Phase 2 hold: cue audio is paused in place (its own AudioContext suspended — the mic and
 * Tony's TTS use a different one). While held, nothing (ducking, a new clip) wakes it. */
let cueHeld = false;

/** Pause every cue clip where it is. True only if something was actually playing (so a
 * resume only unpauses what the hold paused). */
export async function pauseCueAudio(): Promise<boolean> {
  if (cueHeld || !ctx || ctx.state !== "running" || !useCueRun.getState().running) return false;
  cueHeld = true;
  try {
    await ctx.suspend();
    return true;
  } catch {
    cueHeld = false;
    return false;
  }
}

export async function resumeCueAudio(): Promise<void> {
  if (!cueHeld) return;
  cueHeld = false;
  try {
    await ctx?.resume();
  } catch {
    /* best-effort */
  }
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

// ── Master bus ──────────────────────────────────────────────────────────────

interface Bus {
  duck: GainNode;
}
let busNode: Bus | null = null;
const duckSources = new Set<DuckSource>();

function bus(): Bus {
  if (busNode) return busNode;
  const a = audio();
  const duck = a.createGain();
  duck.gain.value = duckSources.size ? DUCK_GAIN : 1;
  const limiter = a.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;
  const shaper = a.createWaveShaper();
  shaper.curve = softClipCurve();
  shaper.oversample = "2x";
  duck.connect(limiter).connect(shaper).connect(a.destination);
  busNode = { duck };
  return busNode;
}

/**
 * Duck all cue audio while Tony (`tts`) or the user (`user`, VAD speech onset) is talking:
 * down to 25 % in 120 ms; once nobody is, hold 300 ms then back up over 500 ms. It moves
 * only the bus gain, so a clip's own volume is never touched (or snapshotted) by ducking.
 */
export function setCueDuck(source: DuckSource, on: boolean) {
  const was = duckSources.size > 0;
  const ducked = updateDuckSources(duckSources, source, on);
  if (ducked === was || !busNode) return; // a bus created later starts at the right level
  const g = busNode.duck.gain;
  const now = audio().currentTime;
  g.cancelScheduledValues(now);
  g.setValueAtTime(g.value, now);
  if (ducked) g.linearRampToValueAtTime(DUCK_GAIN, now + 0.12);
  else {
    g.setValueAtTime(g.value, now + 0.3);
    g.linearRampToValueAtTime(1, now + 0.8);
  }
}

export type ClipRole = "theme" | "soundbite" | "preview";

export interface Playing {
  role: ClipRole;
  /** The clip's own target gain (0–3): its volume, or the duck level a theme is held at under the intro. */
  base: number;
  gain: GainNode;
  /** Ramp the clip's own gain to `to` (0–3), keeping a one-shot clip's fade-out. No-op once stopped. */
  setLevel: (to: number, ms?: number) => void;
  stop: (fadeMs?: number) => void;
  done: Promise<void>;
}

/** Play the trimmed window of a clip. `level` overrides the clip volume (linear gain, 0–3). */
export async function playClip(clip: AudioClip, level?: number, role: ClipRole = "preview"): Promise<Playing> {
  const buf = await loadBuffer(clip.fileId);
  const a = audio();
  const start = Math.max(0, Math.min(clip.inPoint, buf.duration));
  const end = Math.max(start + 0.05, Math.min(clip.outPoint || buf.duration, buf.duration));
  const len = end - start;
  const src = a.createBufferSource();
  src.buffer = buf;
  const gain = a.createGain();
  src.connect(gain).connect(bus().duck);
  const vol = level === undefined ? volumeGain(clip.volume) : Math.min(3, Math.max(0, level));
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
  let stopped = false;
  const playing: Playing = {
    role,
    base: vol,
    gain,
    done,
    setLevel: (to, ms = 200) => {
      if (stopped) return;
      playing.base = to;
      const g = gain.gain;
      const now = a.currentTime;
      const at = now + ms / 1000;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(to, at);
      const stopAt = t0 + len;
      if (!clip.loop && at < stopAt) {
        g.setValueAtTime(to, Math.max(at, stopAt - fo));
        g.linearRampToValueAtTime(0, stopAt);
      }
    },
    stop: (fadeMs = 300) => {
      stopped = true;
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
  return playing;
}

// ── Running cue state (top-bar pill shows it) ───────────────────────────────

interface CueRun {
  running: string | null;
  /** Collection id of the running cue, if it has one. */
  cueId: string | null;
  /** Built-in id of the running cue ("gabagool"), if any. */
  builtin: string | null;
  /** When a cue last fired (ms epoch, 0 = never): bare "stop"/"turn off" stop it for 10 min. */
  lastCueAt: number;
  stopAll: () => void;
}
let current: Playing[] = [];
let generation = 0;

/** The running cue's theme, for live volume changes. `introDuck`: still held at its duck level under the intro. */
const live: { cueId: string | null; theme: Playing | null; base: number; introDuck: boolean } = { cueId: null, theme: null, base: 1, introDuck: false };

function track(p: Playing) {
  current.push(p);
  void p.done.then(() => {
    current = current.filter((x) => x !== p);
    if (live.theme === p) live.theme = null;
  });
}

export const useCueRun = create<CueRun>((set) => ({
  running: null,
  cueId: null,
  builtin: null,
  lastCueAt: 0,
  stopAll: () => {
    generation++;
    current.forEach((p) => p.stop(400));
    current = [];
    Object.assign(live, { cueId: null, theme: null, introDuck: false });
    // An explicit stop also closes the "recently active" window for bare stop words; runCue
    // stamps lastCueAt again right after its own stopAll().
    set({ running: null, cueId: null, builtin: null, lastCueAt: 0 });
  },
}));

/** Set the running cue's theme volume (0–300 %) live. Not persisted. */
export function setThemeVolume(pct: number) {
  live.base = volumeGain(pct);
  if (live.theme && !live.introDuck) live.theme.setLevel(live.base, 200);
}

/**
 * Nudge a cue's theme volume by `deltaPct` (clamped 0–300 %): the running cue's theme,
 * else the built-in Gabagool cue's. Applied live and persisted. Returns the new %, or
 * null when there's no theme clip loaded.
 */
export async function nudgeCueVolume(deltaPct: number): Promise<number | null> {
  const cues = collections.snapshot<CueWidget>("cues").filter((c) => !c._deleted && c.theme);
  const target = cues.find((c) => c.id === live.cueId) ?? cues.find((c) => c.builtin === "gabagool");
  if (!target?.theme) return null;
  const running = target.id === live.cueId;
  const next = nudgeVolume(running ? live.base * 100 : clampVolume(target.theme.volume ?? 100), deltaPct);
  if (running) setThemeVolume(next);
  try {
    await collections.update<CueWidget>("cues", target.id, { theme: { ...target.theme, volume: next } });
  } catch {
    /* the live change stands; Settings keeps showing the last saved volume */
  }
  return next;
}

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
  // A cue stopped while held must not stay frozen: the next cue starts on a running context.
  void resumeCueAudio();
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
export async function runCue(w: CueWidget & { id?: string }, speak: (text: string, voice?: string) => Promise<void>, onAction?: (w: CueWidget) => void) {
  useCueRun.getState().stopAll();
  const gen = ++generation;
  const cueId = w.id ?? null;
  // Only a cue that plays music opens the 10-minute bare-"stop" window; a spoken-only cue
  // (the startup welcome) must not turn "stop" into "Gabagool mode off" after every launch.
  const playsAudio = !!(w.theme || w.soundbite) || w.builtin === "gabagool";
  useCueRun.setState({ running: w.name, cueId, builtin: w.builtin ?? null, lastCueAt: playsAudio ? Date.now() : 0 });
  const alive = () => gen === generation;
  try {
    audio();
    const theme: ThemeClip | null = w.theme;
    Object.assign(live, { cueId, theme: null, base: volumeGain(theme?.volume ?? 100), introDuck: !!theme?.duck });
    const duckVol = theme?.duck ? (theme.duckLevel ?? 22) / 100 : live.base;
    let themePlay: Playing | null = null;
    if (theme) {
      themePlay = await playClip(theme, duckVol, "theme");
      // Stopped while the buffer loaded: never start audio after the stop.
      if (!alive()) return themePlay.stop(0);
      track(themePlay);
      live.theme = themePlay;
      if (!live.introDuck && themePlay.base !== live.base) themePlay.setLevel(live.base, 200); // nudged while loading
    }
    const line = await introText(w);
    if (line && alive()) await speak(line, w.intro.voice || undefined);
    if (w.soundbite && alive()) {
      const sb = await playClip(w.soundbite, undefined, "soundbite");
      if (!alive()) return sb.stop(0);
      track(sb);
      await sb.done;
    }
    if (themePlay && alive() && live.introDuck) {
      live.introDuck = false;
      themePlay.setLevel(live.base, 600);
    }
    if (alive()) onAction?.(w);
    if (themePlay && !theme?.loop) await themePlay.done;
  } finally {
    if (alive() && !(w.theme?.loop)) {
      live.cueId = null;
      useCueRun.setState({ running: null, cueId: null, builtin: null });
    }
  }
}
