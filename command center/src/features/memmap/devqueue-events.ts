import type { DevUiState } from "@/lib/platform";

/**
 * Tiny bridge between code that writes the dev task queue from outside the System Map
 * chunk (the "log a dev note …" voice intent) and the TaskDock, without pulling the
 * dock's store into the main bundle.
 */
const EVENT = "devqueue-changed";

export function notifyDevQueueChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EVENT));
}

export function onDevQueueChanged(cb: () => void): () => void {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}

/** The whitelisted UI keys a task's context snapshot keeps (Rust drops anything else). Scalars only — never what was said. */
export function uiState(parts: { voiceState?: string; section?: string; thread?: string; sttEngine?: string; ttsEngine?: string; viewMode?: string; listening?: boolean; voiceChannel?: string }): DevUiState {
  const out: DevUiState = {};
  for (const [k, v] of Object.entries(parts) as [keyof DevUiState, string | boolean | undefined][]) {
    if (v === undefined || v === "") continue;
    (out as Record<string, string | boolean>)[k] = v;
  }
  return out;
}
