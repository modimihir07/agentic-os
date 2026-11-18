import { create } from "zustand";
import { WebSpeechStt, WhisperStt, type SttEngine } from "@/features/voice/engines";
import { toggleAction } from "@/features/voice/voice-status";
import { useVoice } from "@/features/voice/voice-store";
import { useBrainstorm } from "@/features/brainstorm/capture";
import { holdWake, isPassiveWakeListen } from "@/features/voice/voice-controller";
import { dictVoiceState, tonyMicBusy, type DictPhase } from "./format";

/**
 * Dictation for the System Map's INTENT & RUNTIME NOTE box. Its own STT engine instance
 * (like Brainstorm Listen Mode), deliberately separate from the voice pipeline: what you
 * say lands in the textarea and is NEVER sent to Tony or the router.
 *
 * Same mic-button rules as the main voice controls (`toggleAction`, the Part 1 hard stop):
 * tapping while listening submits only once the VAD has heard speech, otherwise it discards;
 * tapping while transcribing discards. It refuses to open while Tony's mic or Brainstorm is
 * listening, and drops out (discarding) the moment Tony's mic opens.
 */

export type { DictPhase };

interface DictationState {
  phase: DictPhase;
  error: string | null;
  /** Tap the mic: start, submit (flush) or hard-stop, per `toggleAction`. */
  toggle: (onText: (text: string) => void) => void;
  /** Discard whatever is being captured and release the mic. */
  hardStop: () => void;
}

let engine: SttEngine | null = null;
const getEngine = () => (engine ??= ((w) => (w.supported ? w : new WebSpeechStt()))(new WhisperStt()));

let heard = false;
let unwatch: (() => void) | null = null;
/** This dictation holds hands-free re-arming off (see `holdWake`). */
let holding = false;

const release = () => {
  if (holding) holdWake(false);
  holding = false;
};

const end = () => {
  unwatch?.();
  unwatch = null;
  heard = false;
  release();
  useDictation.setState({ phase: "idle" });
};

export const useDictation = create<DictationState>((set, get) => ({
  phase: "idle",
  error: null,

  hardStop: () => {
    if (get().phase === "idle") return;
    engine?.abort(); // abort() calls no handlers: nothing is transcribed
    end();
  },

  toggle: (onText) => {
    const action = toggleAction(dictVoiceState(get().phase), heard);
    if (action === "submit") return void engine?.stop(); // flush → onFinal
    if (action === "hard-stop" || action === "stop-voice") return get().hardStop();

    if (useBrainstorm.getState().listening) return set({ error: "Brainstorm Listen Mode has the mic — stop it first." });
    const stt = getEngine();
    if (!stt.supported) return set({ error: "No speech-to-text here (desktop needs Whisper; phones need Chrome)." });
    // Hands-free waiting for a wake word isn't a turn: pause it (it drops that passive listen)
    // so it can't reopen Tony's mic mid-note. A listen the user opened still wins.
    const passive = isPassiveWakeListen();
    if (!passive && tonyMicBusy(useVoice.getState().state)) return set({ error: "Tony's mic is open — finish or stop that first." });
    holdWake(true);
    holding = true;

    heard = false;
    set({ phase: "waiting", error: null });
    // Tony's mic opening wins: drop this capture rather than fight over the device.
    unwatch = useVoice.subscribe((s, prev) => {
      if (s.state !== prev.state && tonyMicBusy(s.state)) get().hardStop();
    });
    stt.start(
      {
        onPartial: () => undefined,
        onPhase: (p) => {
          if (p === "speech") heard = true;
          set({ phase: p });
        },
        onFinal: (text) => {
          end();
          const t = text.trim();
          if (t) onText(t);
        },
        onError: (e) => {
          end();
          set({ error: e });
        },
      },
      // One note at a time: a patient pause, a long cap.
      { maxSilenceStartMs: 8000, endSilenceMs: 1400, maxUtteranceMs: 60_000 },
    );
  },
}));
