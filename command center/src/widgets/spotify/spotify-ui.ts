import type { SpotifyNowPlaying } from "@/lib/platform";

/** Which quick-select list the widget shows. */
export type QuickList = "recent" | "playlists";

export const POLL_MS = 4000;
/** The volume slider sends once the drag pauses this long. */
export const VOLUME_DEBOUNCE_MS = 300;
/** After a local volume edit, polls don't overwrite the slider for this long (Spotify reports the old value briefly). */
export const VOLUME_HOLD_MS = 2500;

/** "3:07" (or "1:02:09" past an hour). */
export function fmtTime(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** Playback position now, advanced locally from the last poll while playing; clamped to the track length. */
export function progressAt(np: Pick<SpotifyNowPlaying, "isPlaying" | "progressMs" | "durationMs">, polledAt: number, now: number): number {
  const p = np.progressMs + (np.isPlaying ? Math.max(0, now - polledAt) : 0);
  return np.durationMs > 0 ? Math.min(p, np.durationMs) : p;
}

/** Fill fraction 0–1 for the progress bar. */
export const progressFraction = (pos: number, duration: number) => (duration > 0 ? Math.max(0, Math.min(1, pos / duration)) : 0);

/** The slider's value: a recent local edit wins over what the last poll reported. */
export function shownVolume(polled: number | null, local: { value: number; at: number } | null, now: number): number | null {
  if (local && now - local.at < VOLUME_HOLD_MS) return local.value;
  return polled;
}

/** Errors that mean "connect again" (or that polling can't fix), so the widget stops polling
 * and re-reads its status, which then shows Connect / Re-authenticate with the reason. */
export const needsReconnect = (msg: string) => /isn't connected|session expired|revoked|owner of it in the developer dashboard|blocking this app/i.test(msg);
