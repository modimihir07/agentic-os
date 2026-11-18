/**
 * Pure end-of-utterance rule shared by `MicCapture`'s live frame check and its stalled-audio
 * safety-net timer (`engines.ts`). Kept in its own module (no other imports) so it can be unit
 * tested without pulling in `silero.ts`, which touches `location` at import time.
 *
 * `Infinity` thresholds — Brainstorm's "continuous" dictation profile — always evaluate to
 * `false` here, by normal IEEE-754 comparison (`x >= Infinity` is false for any finite `x`,
 * and `x > Infinity` is false for any finite `x`), so no special-casing is needed.
 */
export function utteranceShouldEnd(quietMs: number, endSilenceMs: number, elapsedSinceSpeechMs: number, maxUtteranceMs: number): boolean {
  return quietMs >= endSilenceMs || elapsedSinceSpeechMs > maxUtteranceMs;
}
