import { pauseCueAudio, resumeCueAudio, stopAllAudio } from "@/features/cues/player";
import { cmd, isTauri } from "@/lib/platform";

/**
 * Background audio around the Phase 2 reflexes. Everything here is best-effort and silent:
 * no card, no spoken error. A Spotify control that the MCP tier sets to Ask/Deny simply
 * doesn't happen (`approved: false` never opens a card from here).
 *
 * Spotify goes through the existing `spotify_control` IPC (action "pause"/"resume") — the
 * Spotify intent code itself is untouched.
 */

/** What a hold paused, so its resume only unpauses that. */
export interface HeldMedia {
  spotify: boolean;
  cue: boolean;
}

async function spotifyPlaying(): Promise<boolean> {
  try {
    return (await cmd("spotify_now_playing")).isPlaying;
  } catch {
    return false; // not connected / no permission / offline
  }
}

async function spotify(action: "pause" | "resume"): Promise<boolean> {
  try {
    await cmd("spotify_control", { action, approved: false });
    return true;
  } catch {
    return false;
  }
}

/** Hold: pause Spotify (only if it was playing) and the cue theme (only if playing). */
export async function holdMedia(): Promise<HeldMedia> {
  const [cue, sp] = await Promise.all([pauseCueAudio(), isTauri() ? spotifyPlaying().then((p) => p && spotify("pause")) : Promise.resolve(false)]);
  return { spotify: sp, cue };
}

/** Resume exactly what `holdMedia` paused. */
export async function releaseMedia(held: HeldMedia | null): Promise<void> {
  if (!held) return;
  if (held.cue) void resumeCueAudio();
  if (held.spotify) await spotify("resume");
}

/** "Cut it" (Decision 1): stop the cue theme and pause Spotify. Never disconnects, never auto-resumes. */
export function cutMedia(): void {
  stopAllAudio(); // also cancels Tony's speech (registered cancel), already done by the caller
  if (isTauri()) void spotify("pause"); // an already-paused / idle player is a harmless no-op
}
