/**
 * Spotify on the fast path (typed / voice lines, before the planner).
 *
 * There is ONE Spotify grammar and it lives in Rust (`spotify_intent::parse`, IPC
 * `spotify_parse`); the same parse feeds Tony's deterministic plan in agents.rs. This file
 * only asks Rust what a line means and runs it through `spotify_tool`, which applies the kill
 * switch, the server switch, `may_read` (reads) and the MCP tier + destructive gate (writes).
 * The cue/Gabagool precedence stays in `os-intent-parse.ts` (it needs live cue state), plus
 * `cueOwnsVolume` here.
 *
 * Nothing here sees a token: replies are Rust's speakable text, cards carry names only.
 */
import { cmd, isTauri, type PendingSpotifyCall, type SpotifyIntent } from "@/lib/platform";
import { useSettings } from "@/stores/settings";
import { useVoice, type Channel } from "@/features/voice/voice-store";
import { useToasts } from "@/features/reminders/notify";
import { gated } from "@/features/bridge/gate";
import { connectSpotify } from "@/features/integrations/spotify-connect";
import { norm } from "@/features/cues/gaba";
import { spotifyErrorReply } from "./media-reply";
import type { OsIntentResult } from "./os-intents";

export const ASK_REPLY = "Spotify control is set to Ask — approve the card and I'll do it.";
export const CARD_OPEN_REPLY = "Spotify control needs your OK — answer the open card first.";
export const RECONNECT_REPLY = "Opening Spotify sign-in — approve it in your browser.";

/** What Rust's grammar makes of a line; null when it isn't a Spotify line (or off the desktop app / on any error). */
export async function parseSpotifyLine(text: string): Promise<SpotifyIntent | null> {
  if (!isTauri()) return null;
  try {
    const osName = useSettings.getState().osName || "Tony";
    return (await cmd("spotify_parse", { text, osName })) ?? null;
  } catch {
    return null;
  }
}

/**
 * Pure: a non-explicit `spotify.volume` intent while a cue's theme is playing belongs to the cue /
 * Tony, not Spotify ("volume 30" during Gabagool), unless the line names the music. Relative
 * volume during a cue is already claimed earlier by `os-intent-parse.ts volume()`.
 */
export function cueOwnsVolume(i: SpotifyIntent, cuePlaying: boolean, text: string): boolean {
  return cuePlaying && i.tool === "spotify.volume" && !i.explicit && !/\bmusic\b/.test(norm(text));
}

/** Run what `parseSpotifyLine` returned. Reads answer at once; writes may raise the approval card. */
export async function runSpotifyIntent(i: SpotifyIntent, channel?: Channel): Promise<OsIntentResult> {
  if (!isTauri()) return { reply: "Spotify control needs the desktop app." };
  if (i.tool === "spotify.reconnect") {
    void connectSpotify(() => undefined).then((r) => {
      if (r.ok) useToasts.getState().push({ title: "Spotify connected", body: r.account ? `Signed in as ${r.account}.` : "Signed in.", tone: "info" });
      else useToasts.getState().push({ title: "Spotify sign-in didn't finish", body: r.error ?? "Try Reconnect in Settings → Integrations.", tone: "error" });
    });
    return { reply: RECONNECT_REPLY };
  }
  const { tool: name, args } = i;
  const call = (approved: boolean) => cmd("spotify_tool", { name, args, approved });
  if (!i.mutating) {
    try {
      return { reply: await call(false) };
    } catch (e) {
      return { reply: spotifyErrorReply(e) };
    }
  }
  return spotifyControl(i.summary, call, channel);
}

/**
 * D14: run a Spotify write the Rust tool path held back (`OsTurnResult.pendingSpotify`). Same
 * card as a mutating fast-path intent, with `required` handed straight to `gated` (no first
 * `call(false)`); approving calls `spotify_tool(name, args, approved: true)` — never `os_turn`.
 */
export async function runPendingSpotify(p: PendingSpotifyCall, channel?: Channel): Promise<OsIntentResult> {
  if (!isTauri()) return { reply: "Spotify control needs the desktop app." };
  const call = (approved: boolean) => cmd("spotify_tool", { name: p.name, args: p.args, approved });
  return askCard(p.summary, p.required, call, channel);
}

/**
 * A Spotify write. Rust applies the kill switch, the MCP permission tier and (for removals) the
 * destructive gate; on `PERMISSION_REQUIRED:…` the standard confirmation card runs it after the
 * user's yes (its result then lands in the transcript from the approved plan).
 */
export async function spotifyControl(summary: string, call: (approved: boolean) => Promise<string>, channel?: Channel): Promise<OsIntentResult> {
  try {
    return { reply: await call(false) };
  } catch (e) {
    const required = permissionRequired(e);
    if (!required) return { reply: spotifyErrorReply(e) };
    return askCard(summary, required, call, channel);
  }
}

/** The `PERMISSION_REQUIRED:<scopes>` part of a gate error, or null. */
function permissionRequired(e: unknown): string | null {
  const m = /PERMISSION_REQUIRED:[^\s]*/.exec(e instanceof Error ? e.message : String(e));
  return m ? m[0] : null;
}

function askCard(summary: string, required: string, call: (approved: boolean) => Promise<string>, channel?: Channel): OsIntentResult {
  if (useVoice.getState().pending) return { reply: CARD_OPEN_REPLY };
  void gated({ action: "spotify", summary, required, channel: channel === "voice" ? "voice" : "text" }, call, (r) => r).catch(() => undefined);
  return { reply: ASK_REPLY, card: true };
}
