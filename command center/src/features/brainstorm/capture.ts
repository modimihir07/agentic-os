import { create } from "zustand";
import { cc, collections } from "@/lib/cc-api";
import { platform } from "@/lib/platform";
import { useSettings } from "@/stores/settings";
import { WebSpeechStt, WhisperStt, type SttEngine } from "@/features/voice/engines";
import { LISTEN_PROFILES } from "./listen-profiles";

export { LISTEN_PROFILES };

export interface BrainstormNote {
  title: string;
  titleLocked?: boolean;
  rawText: string;
  segments: { t: number; text: string; device: string }[];
  organized?: {
    title?: string;
    summary?: string;
    categories?: { name: string; bullets: string[] }[];
    actions?: { text: string; due?: string | null }[];
    tags?: string[];
  };
  organizedAt?: number;
  tags?: string[];
}

/**
 * Continuous "Brainstorm Listen Mode".
 *
 * Its own STT engine instance, deliberately separate from the voice
 * command pipeline: brain-dumps are captured verbatim and never dispatched
 * as commands. Each utterance is appended to the note in the shared store
 * as it's heard (so the phone and desktop see it live), and the local LLM
 * re-organizes every N segments and when you stop.
 */
interface CaptureState {
  noteId: string | null;
  listening: boolean;
  phase: "idle" | "waiting" | "speech" | "transcribing";
  sinceOrganize: number;
  organizing: boolean;
  error: string | null;
  start: (noteId?: string) => Promise<void>;
  stop: () => Promise<void>;
  /** Flush the current utterance and restart the loop with the (possibly just-changed) profile. No-op when not listening. */
  restartProfile: () => void;
  organize: (id?: string) => Promise<void>;
}

let engine: SttEngine | null = null;
const getEngine = () => (engine ??= ((w) => (w.supported ? w : new WebSpeechStt()))(new WhisperStt()));

/** Resolves once the in-flight utterance (if any) has been transcribed and appended. `stop()` awaits this instead of discarding it. */
let pendingFinal: Promise<void> = Promise.resolve();
let resolvePendingFinal: (() => void) | null = null;

export const useBrainstorm = create<CaptureState>((set, get) => ({
  noteId: null,
  listening: false,
  phase: "idle",
  sinceOrganize: 0,
  organizing: false,
  error: null,

  start: async (existing) => {
    const stt = getEngine();
    if (!stt.supported) return set({ error: "No speech-to-text available here (desktop needs Whisper; phones need Chrome)." });
    let id = existing ?? get().noteId;
    if (!id) {
      const note = await collections.create<BrainstormNote>("notes", {
        title: `Brainstorm · ${new Date().toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`,
        rawText: "",
        segments: [],
      });
      id = note.id;
    }
    set({ noteId: id, listening: true, error: null, sinceOrganize: 0 });
    loop(id);
  },

  stop: async () => {
    set({ listening: false, phase: "idle" });
    // Flush (not abort): transcribe whatever was captured since the last pause instead of
    // throwing it away, and wait for it to land before organizing.
    engine?.stop();
    await pendingFinal;
    const id = get().noteId;
    if (id && get().sinceOrganize > 0) await get().organize(id);
  },

  restartProfile: () => {
    // The in-flight onFinal handler re-invokes loop() with the freshly-read profile once it
    // resolves, as long as we're still listening — so flushing here is enough.
    if (get().listening) engine?.stop();
  },

  organize: async (id) => {
    const target = id ?? get().noteId;
    if (!target) return;
    set({ organizing: true, error: null });
    try {
      await cc.organize(target);
      await collections.sync("notes");
      set({ sinceOrganize: 0 });
    } catch (e) {
      set({ error: `Organize: ${e instanceof Error ? e.message : e}` });
    } finally {
      set({ organizing: false });
    }
  },
}));

function loop(noteId: string) {
  const s = useBrainstorm.getState();
  if (!s.listening || s.noteId !== noteId) return;
  pendingFinal = new Promise<void>((resolve) => (resolvePendingFinal = resolve));
  const settle = () => {
    resolvePendingFinal?.();
    resolvePendingFinal = null;
  };
  const profile = useSettings.getState().brainstorm.listenProfile;
  getEngine().start(
    {
      onPartial: () => undefined,
      onPhase: (phase) => useBrainstorm.setState({ phase }),
      onFinal: (text) => {
        void (async () => {
          try {
            if (text) await append(noteId, text);
          } finally {
            settle();
          }
          // Keep listening until the user turns it off (or re-reads a just-changed profile).
          if (useBrainstorm.getState().listening) setTimeout(() => loop(noteId), 120);
        })();
      },
      onError: (e) => {
        settle();
        useBrainstorm.setState({ error: e });
        if (useBrainstorm.getState().listening) setTimeout(() => loop(noteId), 1500);
      },
    },
    LISTEN_PROFILES[profile],
  );
}

async function append(noteId: string, text: string) {
  await collections.sync("notes");
  const note = collections.snapshot<BrainstormNote>("notes").find((n) => n.id === noteId);
  const segments = [...(note?.segments ?? []), { t: Date.now(), text, device: platform }];
  await collections.update<BrainstormNote>("notes", noteId, {
    segments,
    rawText: segments.map((s) => s.text).join("\n"),
  });
  const n = useBrainstorm.getState().sinceOrganize + 1;
  useBrainstorm.setState({ sinceOrganize: n });
  const every = useSettings.getState().brainstorm.autoOrganizeEvery;
  if (every > 0 && n >= every && !useBrainstorm.getState().organizing) void useBrainstorm.getState().organize(noteId);
}
