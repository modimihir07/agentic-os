import { create } from "zustand";
import type { AgentRole } from "@/features/dispatcher/agents";
import type { ActionPlan } from "@/features/orchestrator/plan";

/**
 * The single conversation store. The floating HUD, the Voice Console widget,
 * the confirmation card and the Agents section are all views of this.
 */
export type VoiceState =
  | "idle"
  | "listening" // mic open, waiting for / hearing speech
  | "transcribing" // Whisper is converting the utterance
  | "thinking" // planning, verifying or executing
  | "confirming" // a mutating plan is waiting for yes/no
  | "speaking"
  | "error";

export type Channel = "voice" | "text";

export interface VoiceTurn {
  id: string;
  who: "user" | "agent" | "system";
  text: string;
  role?: AgentRole;
  meta?: string;
  tone?: "ok" | "warn" | "error";
}

export interface PendingConfirmation {
  plan: ActionPlan;
  channel: Channel;
  deadline: number;
  reprompted: boolean;
}

interface VoiceStore {
  state: VoiceState;
  /** HUD expanded (panel) vs collapsed (pill). */
  expanded: boolean;
  /** The Voice Console widget is on screen, so the floating HUD steps aside. */
  consoleVisible: boolean;
  partial: string;
  turns: VoiceTurn[];
  pending: PendingConfirmation | null;
  error: string | null;
  setState: (s: VoiceState) => void;
  setExpanded: (v: boolean) => void;
  setConsoleVisible: (v: boolean) => void;
  setPartial: (t: string) => void;
  pushTurn: (t: Omit<VoiceTurn, "id">) => void;
  setPending: (p: PendingConfirmation | null) => void;
  setError: (e: string | null) => void;
  clear: () => void;
}

export const useVoice = create<VoiceStore>((set) => ({
  state: "idle",
  expanded: false,
  consoleVisible: false,
  partial: "",
  turns: [],
  pending: null,
  error: null,
  setState: (state) => set({ state, ...(state !== "error" ? { error: null } : {}) }),
  setExpanded: (expanded) => set({ expanded }),
  setConsoleVisible: (consoleVisible) => set({ consoleVisible }),
  setPartial: (partial) => set({ partial }),
  pushTurn: (t) => set((s) => ({ turns: [...s.turns.slice(-49), { ...t, id: crypto.randomUUID() }] })),
  setPending: (pending) => set({ pending }),
  setError: (error) => set({ error, state: error ? "error" : "idle" }),
  clear: () => set({ turns: [], partial: "", error: null }),
}));

/**
 * Audio level 0..1, written ~60×/s by the mic capture or TTS playback and
 * read by the waveform loop. Deliberately NOT React state.
 */
export const voiceLevel = { current: 0 };

export const STATE_LABEL: Record<VoiceState, string> = {
  idle: "Standby",
  listening: "Listening",
  transcribing: "Transcribing",
  thinking: "Dispatching",
  confirming: "Awaiting confirmation",
  speaking: "Speaking",
  error: "Fault",
};
