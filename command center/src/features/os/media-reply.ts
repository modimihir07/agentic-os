import type { SpotifyNowPlaying } from "@/lib/platform";

const sentence = (s: string) => {
  const t = s.trim();
  if (!t) return t;
  const up = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(up) ? up : `${up}.`;
};

/** A spoken line for a failed Spotify command. The Rust messages are already plain words; this only tidies them.
 * (`PERMISSION_REQUIRED:` never reaches here: the callers raise the approval card for it.) */
export function spotifyErrorReply(raw: unknown): string {
  const msg = (raw instanceof Error ? raw.message : String(raw)).replace(/^Error:\s*/, "");
  if (msg.startsWith("PERMISSION_DENIED:")) return "Spotify control is blocked: the MCP permission is set to Deny in Settings → Permissions.";
  if (/isn't connected/i.test(msg)) return "Spotify isn't connected — connect it in Settings → Integrations.";
  if (/kill switch/i.test(msg)) return "The kill switch is on, and Spotify is a cloud service.";
  return sentence(msg) || "Spotify didn't answer.";
}

/** "Now playing Song by Artist." from `spotify_now_playing`. */
export function nowPlayingReply(np: SpotifyNowPlaying): string {
  if (!np.track) return "Nothing is playing on Spotify right now.";
  const by = np.artists.length ? ` by ${np.artists.join(", ")}` : "";
  return `${np.isPlaying ? "Now playing" : "Paused on"} ${np.track}${by}.`;
}
