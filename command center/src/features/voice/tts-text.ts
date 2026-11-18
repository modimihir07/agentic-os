/**
 * Pure text transforms applied before anything reaches a TTS engine. Split
 * out of `engines.ts` (same reason as `tts-types.ts`: no browser-only
 * imports, so these are unit-testable under Vitest's node environment).
 */

/** Strip markdown, code fences and emoji before anything is spoken — none of it should
 * ever be read aloud ("asterisk asterisk bold asterisk asterisk"). */
export function stripForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ") // fenced code blocks
    .replace(/`([^`]+)`/g, "$1") // inline code
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ") // images
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1") // links → link text
    .replace(/^#{1,6}\s+/gm, "") // headings
    .replace(/^\s*[-*+]\s+/gm, "") // bullet markers
    .replace(/^\s*\d+[.)]\s+/gm, "") // numbered-list markers
    .replace(/(\*\*|__)(.*?)\1/g, "$2") // bold
    .replace(/(\*|_)([^*_]+)\1/g, "$2") // italics
    .replace(/~~(.*?)~~/g, "$1") // strikethrough
    // Emoji & pictographs (leaves plain punctuation/symbols alone).
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** A single clause/sentence over `maxChars` is split on word boundaries — used so one
 * chunk never grows unboundedly (Rust rejects TTS text over 2000 characters). */
function splitLong(s: string, maxChars: number): string[] {
  if (s.length <= maxChars) return [s];
  const out: string[] = [];
  let rest = s;
  while (rest.length > maxChars) {
    const cut = rest.lastIndexOf(" ", maxChars);
    const at = cut > 0 ? cut : maxChars;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

const LIST_LINE = /^\s*(?:[-*+•]|\d+[.)])\s+/;

/** True when most non-blank lines are bulleted/numbered (a WhatsApp casting summary,
 * a checklist) rather than ordinary prose split across lines. */
function looksLikeList(text: string): boolean {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return false;
  const marked = lines.filter((l) => LIST_LINE.test(l)).length;
  return marked >= 2 && marked / lines.length >= 0.5;
}

/** Split for pipelining: speak sentence 1 while sentence 2 synthesises. Each chunk is
 * capped at `maxChars` (never dumped, unbounded, into a final chunk the way the old
 * count-based cap did past its 6th chunk). A chunk under 40 characters keeps absorbing
 * the sentences right after it (bounded by `maxChars`) until it's no longer short, so a
 * one-word sentence like "Ok." merges into what follows instead of its own round trip.
 *
 * A bulleted/numbered reply is the one exception: splitting on sentence-ending
 * punctuation there means one TTS request per bullet (each line usually ends with a
 * period of its own), stacking a full round trip's latency per line for what should
 * read as one list. Those are kept as a single chunk instead (still safety-capped at
 * `maxChars` via `splitLong`, same as any other long chunk). */
export function sentences(text: string, maxChars = 1800): string[] {
  const clean = stripForSpeech(text);
  if (looksLikeList(text)) return splitLong(clean.replace(/\s+/g, " ").trim(), maxChars);
  const parts = clean.replace(/\s+/g, " ").match(/[^.!?]+[.!?]+["')\]]*|\S[^.!?]*$/g) ?? [clean];
  const out: string[] = [];
  for (const raw of parts.map((s) => s.trim()).filter(Boolean)) {
    for (const p of splitLong(raw, maxChars)) {
      const prev = out.length ? out[out.length - 1] : undefined;
      if (prev !== undefined && prev.length < 40 && prev.length + 1 + p.length <= maxChars) out[out.length - 1] = `${prev} ${p}`;
      else out.push(p);
    }
  }
  return out;
}
