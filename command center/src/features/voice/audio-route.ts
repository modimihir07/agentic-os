/**
 * Audio route (Phase 2 Decision 2): is Tony coming out of a headset or open speakers?
 * Speakers mode is the safe default — his own voice can leak into the mic there, so
 * single-syllable holds are ignored while he's audible and barge-in is stricter.
 *
 * The classifier is pure (unit-tested); the detector only touches `navigator` inside
 * functions, so Vitest can import this file.
 */
import type { AudioRoute } from "@/stores/settings";

export type { AudioRoute };
export type EffectiveRoute = "headset" | "speakers";

const HEADSET = /\b(head ?phones?|head ?sets?|ear ?buds?|ear ?phones?|ear ?pods|air ?pods|buds\d*|hands[- ]?free|wh-?1000\w*|wf-?1000\w*)\b/i;

/** Output-device label → route. No label (no mic permission yet) → speakers. */
export function classifyOutputLabel(label: string | null | undefined): EffectiveRoute {
  return label && HEADSET.test(label) ? "headset" : "speakers";
}

/** The setting resolved against the detected device. */
export function effectiveRoute(setting: AudioRoute, detected: EffectiveRoute): EffectiveRoute {
  return setting === "auto" ? detected : setting;
}

/** Barge-in VAD offset: stricter through speakers (Tony's voice leaks in). */
export const bargeSensitivityOffset = (route: EffectiveRoute) => (route === "speakers" ? -35 : -25);

// ── Live detection (browser) ────────────────────────────────────────────────

let detected: EffectiveRoute = "speakers";
let detectedLabel = "";
const listeners = new Set<() => void>();
let watching = false;

/** Default output's label, or the first output's when there is no "default" entry. */
export async function detectRoute(): Promise<EffectiveRoute> {
  try {
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (!md?.enumerateDevices) return detected;
    const outs = (await md.enumerateDevices()).filter((d) => d.kind === "audiooutput");
    const dev = outs.find((d) => d.deviceId === "default") ?? outs[0];
    detectedLabel = dev?.label ?? "";
    const next = classifyOutputLabel(detectedLabel);
    if (next !== detected) {
      detected = next;
      listeners.forEach((l) => l());
    }
    if (!watching && md.addEventListener) {
      watching = true;
      md.addEventListener("devicechange", () => void detectRoute());
    }
  } catch {
    /* keep the last answer (speakers by default) */
  }
  return detected;
}

export const detectedRoute = () => detected;
/** Label behind the auto answer, for the Settings indicator ("" = unknown). */
export const detectedRouteLabel = () => detectedLabel;

export function onRouteChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
