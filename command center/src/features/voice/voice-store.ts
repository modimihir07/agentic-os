import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";
import type { AgentRole } from "@/features/dispatcher/agents";
import type { ActionPlan } from "@/features/orchestrator/plan";

/**
 * The conversation store. The floating HUD, the Voice Console widget, the
 * confirmation card and the Agents section are all views of this.
 *
 * Conversations are split into isolated threads, one per Dispatcher tab:
 * "auto" (Auto-route), each sub-agent (librarian, coder, booking, ops) and
 * "general" (the OS itself, "Tony"). Inter-agent traffic (TONY → BOOKING
 * AGENT and back) is logged as `relay` turns in that agent's thread.
 */
export type VoiceState =
  | "idle"
  | "listening" // mic open, waiting for / hearing speech
  | "transcribing" // Whisper is converting the utterance
  | "thinking" // planning, verifying or executing
  | "confirming" // a mutating plan is waiting for yes/no
  | "speaking"
  | "holding" // Phase 2: "take it ease" — reply paused, collecting your thought
  | "error";

export type Channel = "voice" | "text";
export type ThreadId = "auto" | AgentRole;
export const THREADS: ThreadId[] = ["auto", "general", "prompter", "designer", "coder", "booking", "librarian", "ops"];

export interface VoiceTurn {
  id: string;
  /** relay = an agent-to-agent message (shown with FROM → TO badges). */
  who: "user" | "agent" | "system" | "relay";
  text: string;
  thread: ThreadId;
  at: number;
  role?: AgentRole;
  meta?: string;
  tone?: "ok" | "warn" | "error";
  /** Speaker id for agent/relay turns: "os", "booking", "overseer"… */
  from?: string;
  to?: string;
  /** "View in Booking Desk →" pill. */
  link?: ThreadId;
  /** "Jump to Thread in Comms →" pill (comms thread key). */
  commsThread?: string;
  /** "Open in Play Place →" pill. */
  cardId?: string;
  /** One-tap answers under the message ("Yes, run the pipeline"). */
  actions?: { label: string; run: string }[];
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
  /** The tab new input goes to (and the HUD shows). */
  activeThread: ThreadId;
  pending: PendingConfirmation | null;
  error: string | null;
  /** Hold mode: what you've said since "take it ease" (live in the HUD); null when not holding. */
  held: string[] | null;
  setHeld: (h: string[] | null) => void;
  setState: (s: VoiceState) => void;
  setExpanded: (v: boolean) => void;
  setConsoleVisible: (v: boolean) => void;
  setPartial: (t: string) => void;
  setActiveThread: (t: ThreadId) => void;
  pushTurn: (t: Omit<VoiceTurn, "id" | "at" | "thread"> & { thread?: ThreadId }) => VoiceTurn;
  /** Patch a turn in place (token streaming). */
  updateTurn: (id: string, patch: Partial<VoiceTurn>) => void;
  setPending: (p: PendingConfirmation | null) => void;
  setError: (e: string | null) => void;
  /** Clear one thread (default: the active one). */
  clear: (thread?: ThreadId) => void;
  /** Replace threads from the gateway (phone sync). */
  mergeRemote: (turns: VoiceTurn[]) => void;
}

const PER_THREAD = 120;

function cap(turns: VoiceTurn[]): VoiceTurn[] {
  const counts = new Map<ThreadId, number>();
  const out: VoiceTurn[] = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const n = counts.get(turns[i].thread) ?? 0;
    if (n < PER_THREAD) {
      out.push(turns[i]);
      counts.set(turns[i].thread, n + 1);
    }
  }
  return out.reverse();
}

export const useVoice = create<VoiceStore>()(
  persist(
    (set, get) => ({
      state: "idle",
      expanded: false,
      consoleVisible: false,
      partial: "",
      turns: [],
      activeThread: "auto",
      pending: null,
      error: null,
      held: null,
      setHeld: (held) => set({ held }),
      // While holding, the interrupted turn keeps running quietly; its state changes
      // ("speaking", "thinking"…) must not knock HOLDING off the orb/HUD/header.
      setState: (state) => {
        if (get().held && state !== "holding") return;
        set({ state, ...(state !== "error" ? { error: null } : {}) });
      },
      setExpanded: (expanded) => set({ expanded }),
      setConsoleVisible: (consoleVisible) => set({ consoleVisible }),
      setPartial: (partial) => set({ partial }),
      setActiveThread: (activeThread) => set({ activeThread }),
      pushTurn: (t) => {
        const turn: VoiceTurn = { ...t, thread: t.thread ?? get().activeThread, id: crypto.randomUUID(), at: Date.now() };
        set((s) => ({ turns: cap([...s.turns, turn]) }));
        return turn;
      },
      updateTurn: (id, patch) => set((s) => ({ turns: s.turns.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),
      setPending: (pending) => set({ pending }),
      setError: (error) => set({ error, state: error ? "error" : "idle" }),
      clear: (thread) => {
        const th = thread ?? get().activeThread;
        set((s) => ({ turns: s.turns.filter((t) => t.thread !== th), partial: "", error: null }));
      },
      mergeRemote: (remote) =>
        set((s) => {
          const seen = new Set(s.turns.map((t) => t.id));
          const merged = [...s.turns, ...remote.filter((t) => !seen.has(t.id) && THREADS.includes(t.thread))].sort((a, b) => a.at - b.at);
          return { turns: cap(merged) };
        }),
    }),
    {
      name: "cc.voice.threads",
      version: 1,
      // Only the conversation persists; live voice state always boots idle.
      // `activeThread` is NOT persisted — the main bars (VoiceConsole/VoiceHUD)
      // always pass thread "auto" explicitly, and a resumed session should
      // never silently inherit whatever tab was open when it was last closed
      // (that's how a stale "Prompter" tab used to swallow every request).
      partialize: (s) => ({ turns: s.turns }),
    },
  ),
);

/** Turns of one thread (hook). */
export const useThreadTurns = (thread?: ThreadId) =>
  useVoice(
    useShallow((s) => {
      const th = thread ?? s.activeThread;
      return s.turns.filter((t) => t.thread === th);
    }),
  );

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
  holding: "Holding",
  error: "Fault",
};
