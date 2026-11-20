import { isGabaLike, norm } from "@/features/cues/gaba";

const words = (s: string) => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/**
 * The command after a wake word ("Hey, Tony, turn it off" → "turn it off"), "" for a bare
 * wake word, null if the line doesn't start with one. Compared word by word, so punctuation
 * Whisper puts between the words doesn't matter; the original text is sliced after the
 * last matched word. A gabagool-like wake word ("gaba gu") is never treated as one: it
 * would eat the first word of "gaba gu mode off".
 */
export function wakeCommand(text: string, wakeWords: readonly string[]): string | null {
  const candidates = wakeWords
    .map(words)
    .filter((w) => w.length && !isGabaLike(w.join("")) && !norm(w.join(" ")).includes("gabagool"))
    .sort((a, b) => b.length - a.length || b.join("").length - a.join("").length);
  const tokens = [...text.matchAll(/[a-z0-9]+/gi)];
  for (const w of candidates) {
    if (w.length > tokens.length || !w.every((word, i) => tokens[i][0].toLowerCase() === word)) continue;
    const last = tokens[w.length - 1];
    return text.slice(last.index! + last[0].length).replace(/^[\s,.!?:;'’-]+/, "").trim();
  }
  return null;
}
