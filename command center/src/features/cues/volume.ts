/** Pure cue-volume math (no Web Audio), shared by the player and CueStudio. */

/** Clip volume ceiling in %: up to 3× gain, kept clean by the master bus limiter + soft clip. */
export const MAX_CUE_VOLUME = 300;

/** Bus gain while Tony or the user is talking. */
export const DUCK_GAIN = 0.25;

export type DuckSource = "tts" | "user";

/** Clamp a volume % to 0–300 (non-numbers → 0). */
export function clampVolume(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  return Math.min(MAX_CUE_VOLUME, Math.max(0, pct));
}

/** Volume % → linear gain (0–3). */
export const volumeGain = (pct: number) => clampVolume(pct) / 100;

/** The new whole-number volume % after nudging `current` by `deltaPct`. */
export const nudgeVolume = (current: number, deltaPct: number) => Math.round(clampVolume(current + deltaPct));

/** Add/remove a duck source; returns whether the bus should now be ducked. */
export function updateDuckSources(sources: Set<DuckSource>, source: DuckSource, on: boolean): boolean {
  if (on) sources.add(source);
  else sources.delete(source);
  return sources.size > 0;
}

/**
 * Soft-clip transfer curve for a WaveShaper: identity up to `knee`, then a tanh
 * shoulder that approaches (but never reaches) ±1, so peaks round off instead of
 * clipping hard at the destination.
 */
export function softClipCurve(n = 2048, knee = 0.8): Float32Array {
  const curve = new Float32Array(n);
  const room = 1 - knee;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const m = Math.abs(x);
    curve[i] = m <= knee ? x : Math.sign(x) * (knee + room * Math.tanh((m - knee) / room));
  }
  return curve;
}
