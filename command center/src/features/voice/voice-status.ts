import type { VoiceState } from "./voice-store";

/** Where the current voice turn came from. Follow-up and barge-in listens inherit their parent turn's origin. */
export type TurnOrigin = "tap" | "wake" | "text";

export type ToggleAction = "submit" | "hard-stop" | "stop-voice" | "start";

/**
 * What the mic button / orb / hotkey does in each state. While listening it only submits
 * once the VAD has actually heard speech — stopping before that never sends silence to
 * Whisper (which invents "Thank you." from it).
 */
export function toggleAction(state: VoiceState, heardSpeech: boolean): ToggleAction {
  switch (state) {
    case "listening":
      return heardSpeech ? "submit" : "hard-stop";
    case "transcribing":
    case "thinking":
      return "hard-stop";
    case "speaking":
    case "holding": // the HUD's Resume button resumes; the mic button / Esc end everything
      return "stop-voice";
    default:
      return "start";
  }
}

const TRAILING_ACTIVE = /\bACTIVE\s*$/i;

/**
 * Header subtitle with a live status. A subtitle ending in "ACTIVE" (the default
 * "TONY ACTIVE") swaps that word for ACTIVE/STANDBY; any other custom subtitle is kept
 * verbatim and the caller shows a separate state chip instead.
 */
export function headerSubtitle(subtitle: string, live: boolean, holding = false): { text: string; chip: boolean } {
  if (!TRAILING_ACTIVE.test(subtitle)) return { text: subtitle, chip: true };
  return { text: subtitle.replace(TRAILING_ACTIVE, holding ? "HOLDING" : live ? "ACTIVE" : "STANDBY"), chip: false };
}
