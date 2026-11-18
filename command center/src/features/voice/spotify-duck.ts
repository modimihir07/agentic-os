import { cmd, isTauri } from "@/lib/platform";
import { useSettings } from "@/stores/settings";

/**
 * Spotify ducking while you talk (Phase 2). Speech onset drops Spotify to a low level so Whisper
 * hears you; it comes back `restoreMs` after the utterance ends, once a command has been handed
 * off, or once a cut / hold's pause has landed (so a later resume isn't at the ducked level).
 *
 * Best effort and silent, like `media-hold.ts`: no card, no error, no log. Rust (`spotify_duck`)
 * decides whether to duck at all (playing on THIS PC, volume control, not gated) and keeps the
 * snapshot, so a restore here is just "unduck if the volume is still ours".
 */

/** No re-duck this soon after a restore for a line that wasn't a command: music vocals can trip
 * the VAD through speakers (duck → noise → restore → duck …). */
export const COOLDOWN_MS = 4000;
/** Past the utterance cap: `stt.abort()` fires no callbacks, so this bounds a duck nobody ends. */
export const CEILING_PAD_MS = 3000;
/** A command line restores once its turn settles, or after this. Long enough for a Spotify volume
 * line to finish first (Rust `h_volume` then consumes the duck instead of racing the restore). */
export const COMMAND_RESTORE_CAP_MS = 3000;
/** A cut / hold's pause that never settles (a hung IPC) still restores after this. */
export const PAUSE_WAIT_CAP_MS = 10_000;
/** Ceiling base when the utterance cap is off (`Infinity`). */
const UNCAPPED_UTTERANCE_MS = 60_000;

type Timer = ReturnType<typeof setTimeout>;

const st = {
  /** The duck call (in flight or settled); null = nothing to restore. */
  call: null as Promise<boolean> | null,
  /** Bumped by every restore decision, so a superseded deferred restore stays quiet. */
  gen: 0,
  /** A cut / hold / command restore is waiting for its pause or turn; plain restores leave it be. */
  deferred: false,
  /** The last duck said Spotify is playing on this PC (and nothing paused it since). */
  playingHere: false,
  restoreTimer: undefined as Timer | undefined,
  ceiling: undefined as Timer | undefined,
  /** When the last no-command restore ran (anti-pumping cooldown). */
  noopAt: -Infinity,
};

const cfg = () => useSettings.getState().conversation.spotifyDuck;

function clearTimers() {
  clearTimeout(st.restoreTimer);
  clearTimeout(st.ceiling);
  st.restoreTimer = st.ceiling = undefined;
}

function armCeiling() {
  clearTimeout(st.ceiling);
  const cap = useSettings.getState().vad.maxUtteranceMs;
  st.ceiling = setTimeout(() => void restore(), (Number.isFinite(cap) && cap > 0 ? cap : UNCAPPED_UTTERANCE_MS) + CEILING_PAD_MS);
}

/** Pure: the anti-pumping rule. */
export function inCooldown(now: number, noopAt: number): boolean {
  return now - noopAt < COOLDOWN_MS;
}

/** Spotify is (as far as the last duck knew) playing on this PC: "oh" / "eh" may be lyrics. */
export function musicPlayingHere(): boolean {
  return st.playingHere;
}

/** VAD speech onset. `passive`: a hands-free wake listen (ducks only with `onWakeListen`). */
export function duckOnSpeech(passive = false): void {
  const c = cfg();
  if (!c?.enabled || !isTauri() || (passive && !c.onWakeListen)) return;
  if (st.call) {
    // Talking again before the restore: stay ducked, and take over any deferred restore.
    clearTimers();
    st.gen++;
    st.deferred = false;
    armCeiling();
    return;
  }
  if (inCooldown(Date.now(), st.noopAt)) return;
  const call: Promise<boolean> = cmd("spotify_duck", { level: c.level })
    .then((ok) => {
      if (st.call === call) st.playingHere = ok;
      return ok;
    })
    .catch(() => false);
  st.call = call;
  armCeiling();
}

/** The utterance ended (`transcribing`): restore after `restoreMs` unless a decision comes first. */
export function scheduleRestore(noop = false): void {
  if (!st.call || st.deferred) return;
  clearTimers();
  st.restoreTimer = setTimeout(() => void restore(noop), Math.max(0, cfg()?.restoreMs ?? 2500));
}

/** A line that wasn't for Tony (silence, noise, room talk without the wake word): restore on the
 * normal delay, then hold off re-ducking for a moment. */
export function settleNoise(): void {
  scheduleRestore(true);
}

/** A command was handed off: restore once its turn settles (bounded). */
export function settleCommand(turn: Promise<unknown>): void {
  restoreAfter(turn, COMMAND_RESTORE_CAP_MS);
}

/** Cut / hold: restore once the pause has landed, so a later resume isn't stuck at the duck level. */
export function restoreAfterPause(paused: Promise<unknown>): void {
  st.playingHere = false;
  restoreAfter(paused, PAUSE_WAIT_CAP_MS);
}

/** Restore when `p` settles or after `capMs`, whichever comes first. */
function restoreAfter(p: Promise<unknown>, capMs: number): void {
  if (!st.call) return;
  clearTimers();
  st.deferred = true;
  const gen = ++st.gen;
  void Promise.race([p.catch(() => undefined), new Promise((r) => setTimeout(r, capMs))])
    .then(() => {
      if (gen === st.gen) return restore();
    });
}

/** Unduck now (abort / error / hard stop / hands-free off). Idempotent; a deferred cut / hold /
 * command restore keeps its own timing. */
export function restoreDuck(): void {
  if (st.call && !st.deferred) void restore();
}

async function restore(noop = false): Promise<void> {
  const call = st.call;
  clearTimers();
  st.gen++;
  st.call = null;
  st.deferred = false;
  if (!call) return;
  await call; // wait out a duck still in flight
  if (noop) st.noopAt = Date.now();
  // A new duck began meanwhile: it owns Rust's snapshot now (and restores it itself).
  if (st.call) return;
  // Always asked, even after `false`: a duck that timed out mid-PUT may still have landed, and
  // Rust's read-back decides. A no-op in Rust when nothing is ducked.
  await cmd("spotify_unduck").catch(() => undefined);
}
