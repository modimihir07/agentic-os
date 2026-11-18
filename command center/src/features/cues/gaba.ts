/**
 * Pure text normalisation for cue phrases (no imports: unit-tested with `node --test`).
 *
 * Whisper hears "gabagool" a dozen ways — "gaba gool", "gabba goule", "gobba gool",
 * "gaba ghoul", "gaba goom", "cabbage cool", "gobble"… `norm` lowercases, strips
 * punctuation and rewrites any such token run (1–3 adjacent words) to "gabagool",
 * without touching ordinary words like "garbage", "cabbage" or "gabby".
 */

/** ga·ba·gool skeleton: onset g/c/k, vowel, b(b), vowel, g/c/k (+ cabbage-"gec"), oo/ou/u/o, l/le/ul/m. */
const SKELETON = /^[gck]h?[aou]b+(?:a|e|i|o|u|er|ah)(?:g|c|k|gh|ge?c|ge?k)h?(?:oo|ou|u|o|ew|oe|ue)(?:l|le|ll|ul|ule|m|ml|ol)?$/;
/** Whole-token mangles the skeleton can't describe. */
const KNOWN = new Set(["gobble", "gobbel", "gobbles", "gabagool", "gabagul", "gabbagool", "gabagoul", "gabagoo", "gabbagoo"]);
const TARGET = "gabagool";

/** Levenshtein distance (small strings only). */
export function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** True when a run of letters (spaces removed) is a way of saying "gabagool". */
export function isGabaLike(joined: string): boolean {
  const w = joined.replace(/[^a-z]/g, "");
  if (w.length < 5 || w.length > 13) return false;
  if (KNOWN.has(w) || SKELETON.test(w)) return true;
  // Token-level fuzzy match: close to "gabagool", starting like it and keeping the b·g shape.
  return /^[gck]/.test(w) && /b.*[gck]/.test(w.slice(1)) && w.length >= 7 && editDistance(w, TARGET) <= 2;
}

/** Lowercase, punctuation → spaces, collapse whitespace, and canonicalise "gabagool". */
export function norm(s: string): string {
  const base = s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!base) return base;
  const tokens = base.split(" ");
  const out: string[] = [];
  for (let i = 0; i < tokens.length; ) {
    let took = 0;
    // Longest span first: "ga ba gool" → 3 tokens, "gaba gool" → 2, "gobble" → 1.
    for (let n = Math.min(3, tokens.length - i); n >= 1; n--) {
      if (isGabaLike(tokens.slice(i, i + n).join(""))) {
        took = n;
        break;
      }
    }
    if (took) {
      out.push(TARGET);
      i += took;
    } else {
      out.push(tokens[i]);
      i++;
    }
  }
  return out.join(" ");
}
