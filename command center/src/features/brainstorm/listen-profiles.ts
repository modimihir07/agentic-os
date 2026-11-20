import type { ListenProfile } from "@/stores/settings";

/**
 * Per-profile dictation timing for Brainstorm Listen Mode (header segmented control in
 * BrainstormSection.tsx, read from `useSettings().brainstorm.listenProfile`).
 *  - snappy: ends a thought on a short pause — good for quick, separate notes.
 *  - relaxed (default): tolerates long thinking pauses mid-thought.
 *  - continuous: never ends on silence — records until Stop, like push-to-talk.
 *
 * Kept in its own module (only a type-only import, erased at build time) so the table itself
 * is unit-testable without pulling in `engines.ts` → `silero.ts`, which touches `location` at
 * import time and so can't be imported outside a browser/jsdom environment.
 */
export const LISTEN_PROFILES: Record<ListenProfile, { endSilenceMs: number; maxUtteranceMs: number; maxSilenceStartMs: number }> = {
  snappy: { endSilenceMs: 1000, maxUtteranceMs: 30_000, maxSilenceStartMs: 30_000 },
  relaxed: { endSilenceMs: 3000, maxUtteranceMs: 120_000, maxSilenceStartMs: 30_000 },
  continuous: { endSilenceMs: Infinity, maxUtteranceMs: Infinity, maxSilenceStartMs: Infinity },
};
