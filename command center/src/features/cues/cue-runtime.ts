import { useEffect } from "react";
import { collections, useCollection } from "@/lib/cc-api";
import { useNav, SECTIONS, type Section } from "@/stores/nav";
import { useVoice, THREADS, type ThreadId } from "@/features/voice/voice-store";
import { useToasts } from "@/features/reminders/notify";
import { DEFAULT_CUES, type CueWidget } from "./types";
import { runCue, useCueRun } from "./player";

/**
 * Cue triggers: voice/text phrase, time of day, app startup. The voice
 * controller registers Tony's TTS and the input handler here (no import cycle).
 */
type Speak = (text: string, voice?: string) => Promise<void>;
type Prompt = (text: string) => void;
let speak: Speak = async () => undefined;
let prompt: Prompt = () => undefined;
export const registerCueIO = (s: Speak, p: Prompt) => {
  speak = s;
  prompt = p;
};

/** Whisper hears "gabagool" a dozen ways: gaba gu, gabagoul, gabba gool, gabbagool… */
const GABA = /gab+a\s*-?\s*g(?:oo|ou|u|o)(?:l|le|ul)?|gab+agoo?u?l/g;
const norm = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim().replace(GABA, "gabagool");

/**
 * "stop gabagool mode", "stop gaba gu mode", "end the music", "kill the theme"… — or a
 * bare "stop" / "enough" while a cue is playing.
 */
export function isStopCue(text: string): boolean {
  const t = norm(text);
  const verb = /(stop|end|exit|quit|kill|cancel|turn off|shut off|shut it off|leave|enough|cut)/.test(t);
  if (verb && /(gabagool|music|theme|song|cue)/.test(t)) return true;
  return !!useCueRun.getState().running && /^(hey tony |yo tony |tony )?(stop|stop it|enough|that s enough|cut it|kill it|shut it off|turn it off)$/.test(t);
}

/** A cue whose phrase is in what the user said/typed ("hey tony, enter gabagool mode"). */
export function matchCue(text: string): (CueWidget & { id: string }) | null {
  const t = ` ${norm(text)} `;
  const cues = collections.snapshot<CueWidget>("cues").filter((c) => c.enabled && !c._deleted);
  // Longest phrase wins ("enter gabagool mode" before "gabagool").
  let best: { cue: CueWidget & { id: string }; len: number } | null = null;
  for (const c of cues) {
    for (const p of c.phrases) {
      const n = norm(p);
      if (n && t.includes(` ${n} `) && (!best || n.length > best.len)) best = { cue: c, len: n.length };
    }
  }
  return best?.cue ?? null;
}

function runAction(w: CueWidget) {
  const { kind, value } = w.action;
  if (kind === "tab" && SECTIONS.some((s) => s.id === value)) useNav.getState().go(value as Section);
  else if (kind === "thread" && THREADS.includes(value as ThreadId)) {
    useVoice.getState().setActiveThread(value as ThreadId);
    useNav.getState().go("agents");
  } else if (kind === "prompt" && value.trim()) prompt(value.trim());
}

export function fireCue(w: CueWidget) {
  void runCue(w, speak, runAction).catch((e) => useToasts.getState().push({ title: `${w.name} couldn't play`, body: String(e), tone: "error" }));
}

/** Toggle from the top-bar pill: stop if running, else start Gabagool Mode. */
export function toggleGabagool() {
  if (useCueRun.getState().running) return useCueRun.getState().stopAll();
  const w = collections.snapshot<CueWidget>("cues").find((c) => c.builtin === "gabagool" && !c._deleted);
  if (w) fireCue(w);
  else useToasts.getState().push({ title: "Gabagool Mode", body: "Set it up in Settings → Voice & Triggers.", tone: "info" });
}

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/** Seeds the built-in widgets, fires startup cues once, and runs the time-of-day schedule. */
export function useCueScheduler() {
  const { items, loaded, create, update } = useCollection<CueWidget>("cues");

  useEffect(() => {
    if (!loaded) return;
    for (const d of DEFAULT_CUES) if (!items.some((i) => i.builtin === d.builtin)) void create(d);
  }, [loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!loaded) return;
    let fired = false;
    try {
      fired = sessionStorage.getItem("cc.cues.startup") === "1";
      sessionStorage.setItem("cc.cues.startup", "1");
    } catch {
      /* private mode */
    }
    if (fired) return;
    const t = setTimeout(() => {
      for (const c of collections.snapshot<CueWidget>("cues")) if (c.enabled && c.startup && !c._deleted) fireCue(c);
    }, 2500);
    return () => clearTimeout(t);
  }, [loaded]);

  useEffect(() => {
    const tick = () => {
      const now = new Date();
      const slot = `${now.toISOString().slice(0, 10)} ${hhmm(now)}`;
      for (const c of collections.snapshot<CueWidget & { id: string }>("cues")) {
        if (!c.enabled || c._deleted || !c.time || c.time !== hhmm(now) || c.lastFired === slot) continue;
        if (c.days.length && !c.days.includes(now.getDay())) continue;
        void update(c.id, { lastFired: slot });
        fireCue(c);
      }
    };
    const iv = setInterval(tick, 15_000);
    return () => clearInterval(iv);
  }, [update]);
}
