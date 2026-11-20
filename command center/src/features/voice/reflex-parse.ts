import { norm } from "@/features/cues/gaba";

/**
 * Voice reflexes (Phase 2 §2): "cut it", "take it ease", "whoa", "keep going", "go ahead".
 * Pure and import-light (only `norm`), so Vitest runs it without browser code — the same
 * pattern as `wake-word.ts`. Every phrase that shows up in live use goes in the tables
 * below AND in `reflex-parse.test.ts`.
 */
export type Reflex = {
  kind: "cut" | "hold" | "resume" | "submit";
  rest: string;
  /** A bare hard stop ("stop", "shut it off"): a passive hands-free listen acts on it only after the wake word. */
  needsAddress?: true;
} | null;

export interface ReflexCtx {
  /** Tony/an agent is speaking OR a turn is thinking/executing. */
  busy: boolean;
  /** Already in hold mode. */
  holding: boolean;
  /** Speakers mode only: TTS is audible right now, so Tony's own "oh" could leak into the mic. */
  ttsAudible?: boolean;
  /** Speakers mode only: Spotify plays on this PC (ducked, still audible), so a lyric's "oh" could too. */
  musicAudible?: boolean;
}

/** Whole-word phrase tables, written as `norm()` produces them ("that's" → "that s"). */
export const CUT = ["cut it", "cut it out", "cut that", "cutit", "yo tony cut it", "tony cut it", "stop talking", "stop stop"];
/** Hard stops only as the whole utterance (address words before, politeness after): never a
 * prefix or a "contains" match, so "don't stop the music" / "stop the timer" stay ordinary lines. */
export const CUT_STANDALONE = ["stop", "stop it", "shut it off", "shut it down"];
export const HOLD_MULTI = [
  "take it ease", "take it easy", "take it eas", "take it ees", "take it knees", "take at ease", "take it is",
  "madone", "madonna", "ma donna", "my donna", "mad one",
  "aspetta", "aspett", "aspet", "a spetta", "ah spet",
];
export const HOLD_SINGLE = ["whoa", "woah", "oh", "eh", "aye", "ay"];
/** Whisper's "take it ease" — a hold only as the whole utterance, never a prefix. */
export const HOLD_STANDALONE = ["hey kitties"];
export const RESUME = ["keep going", "go on", "continue", "carry on", "where were you", "you were saying"];
export const SUBMIT = ["go ahead", "run that", "over to you", "that s it", "thats it", "send it"];

/** Address words in front of a reflex ("hey Tony, take it ease"). */
const LEAD = new Set(["hey", "yo", "ok", "okay", "alright", "so", "um", "uh", "tony", "yeah"]);
/** Trailing politeness after a standalone resume/submit ("keep going please"). */
const TAIL = new Set(["please", "tony", "now", "then", "yeah", "man"]);

const toks = (s: string) => (s ? s.split(" ") : []);
const PHRASES = (list: string[]) => list.map(toks).sort((a, b) => b.length - a.length);
const T_CUT = PHRASES(CUT);
const T_CUT_STANDALONE = PHRASES(CUT_STANDALONE);
const T_HOLD = PHRASES(HOLD_MULTI);
const T_RESUME = PHRASES(RESUME);
const T_SUBMIT = PHRASES(SUBMIT);
const SINGLE = new Set(HOLD_SINGLE);
const STANDALONE = new Set(HOLD_STANDALONE);

const startsWith = (w: string[], p: string[], at = 0) => p.length <= w.length - at && p.every((x, i) => w[at + i] === x);
const contains = (w: string[], p: string[]) => w.some((_, i) => startsWith(w, p, i));
/** Longest phrase `w` starts with (at `at`), as its token count; 0 if none. */
const prefixLen = (w: string[], table: string[][], at = 0) => table.find((p) => startsWith(w, p, at))?.length ?? 0;

/** Leading address words to skip (never all of them: "tony" alone stays a word). */
function leadCount(w: string[]): number {
  let i = 0;
  while (i < w.length - 1 && LEAD.has(w[i])) i++;
  return i;
}

/** The original text after its first `n` words (punctuation and a joining "and/so" dropped). */
function restAfter(text: string, n: number): string {
  if (n <= 0) return text.trim();
  const words = [...text.matchAll(/[a-z0-9]+/gi)];
  const last = words[n - 1];
  if (!last) return "";
  return text
    .slice(last.index! + last[0].length)
    .replace(/^[\s,.!?:;'’…-]+/, "")
    .replace(/^(and|so|then)\b[\s,]*/i, "")
    .trim();
}

/** `w` (after `from`) is exactly the phrase, allowing trailing politeness. */
function standalone(w: string[], table: string[][], from: number): boolean {
  const n = prefixLen(w, table, from);
  if (!n) return false;
  return w.slice(from + n).every((x) => TAIL.has(x));
}

export function parseReflex(text: string, ctx: ReflexCtx): Reflex {
  const n = norm(text);
  if (!n) return null;
  const w = toks(n);

  // 1. Cut: every state. Short line containing a cut phrase, or a line that starts with one.
  if (w.length <= 5 && T_CUT.some((p) => contains(w, p))) return { kind: "cut", rest: "" };
  const lead = leadCount(w);
  const cutLen = prefixLen(w, T_CUT, lead);
  if (cutLen) return { kind: "cut", rest: restAfter(text, lead + cutLen) };
  if (standalone(w, T_CUT_STANDALONE, lead)) return { kind: "cut", rest: "", needsAddress: true };

  // 4. Resume / submit only mean something while holding.
  if (ctx.holding) {
    if (standalone(w, T_RESUME, lead)) return { kind: "resume", rest: "" };
    const sub = prefixLen(w, T_SUBMIT, lead);
    if (sub) return { kind: "submit", rest: restAfter(text, lead + sub) };
  }

  // Standalone-only mishearing.
  if (STANDALONE.has(n) || STANDALONE.has(w.slice(lead).join(" "))) return { kind: "hold", rest: "" };

  // 3. Multi-word holds: standalone or as a prefix, in any state ("thought-form lock").
  const hold = prefixLen(w, T_HOLD, lead);
  if (hold) return { kind: "hold", rest: restAfter(text, lead + hold) };

  // 2. Single-syllable holds: only over a busy/held turn, only as the whole line (repeats ok),
  //    and never while Tony or music is audible through speakers (an "oh" can leak into the mic).
  if ((ctx.busy || ctx.holding) && !ctx.ttsAudible && !ctx.musicAudible && w.every((x) => SINGLE.has(x))) return { kind: "hold", rest: "" };

  return null;
}
