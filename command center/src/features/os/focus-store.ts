import { create } from "zustand";

/** Cross-section "jump to" targets: a Comms thread, a Play Place card. */
export const useFocus = create<{ commsThread: string | null; card: string | null; set: (p: Partial<{ commsThread: string | null; card: string | null }>) => void }>((set) => ({
  commsThread: null,
  card: null,
  set: (p) => set(p),
}));
