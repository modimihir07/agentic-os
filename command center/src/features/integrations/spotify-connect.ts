import { useEffect, useRef, useState } from "react";
import { cmd, onNativeEvent, type SpotifyAuthEvent, type SpotifyReauthEvent } from "@/lib/platform";
import { spotifyErrorReply } from "@/features/os/media-reply";
import { useToasts } from "@/features/reminders/notify";
import { setMcpEnabled } from "./mcp-enable";
import { notifyIntegrationsChanged } from "./changed";

export interface ConnectOutcome {
  ok: boolean;
  account?: string | null;
  error?: string;
  /** Connected, but something after it (switching on the MCP server) failed. */
  warning?: string;
}

/** Rust gives up after 3 minutes and emits a failure; this only covers a flow that never reports back. */
const WAIT_MS = 200_000;

/**
 * Spotify OAuth: opens the consent page in the system browser (Rust) and waits
 * for the `spotify-auth` event. `onUrl` gets the same URL as a fallback link.
 * On success the `spotify` MCP server is switched on, so Tony's tools see it —
 * even if the component that started the flow has unmounted by then.
 */
export async function connectSpotify(onUrl: (url: string) => void): Promise<ConnectOutcome> {
  let resolve!: (e: SpotifyAuthEvent) => void;
  const outcome = new Promise<SpotifyAuthEvent>((r) => (resolve = r));
  let off: () => void = () => undefined;
  const timer = setTimeout(() => resolve({ ok: false, error: "Timed out waiting for Spotify sign-in — press Connect to try again" }), WAIT_MS);
  try {
    // Subscribe before starting, so a fast sign-in can't fire the event unheard.
    off = await onNativeEvent<SpotifyAuthEvent>("spotify-auth", (e) => resolve(e));
    const { url } = await cmd("spotify_auth_start");
    onUrl(url);
    const e = await outcome;
    if (!e.ok) return { ok: false, error: spotifyErrorReply(e.error ?? "Spotify sign-in failed") };
    const warning = await setMcpEnabled("spotify", true).then(
      () => undefined,
      () => "Connected, but the Spotify tools couldn't be switched on — enable Spotify in the MCP registry.",
    );
    notifyIntegrationsChanged();
    return { ok: true, account: e.account ?? null, warning };
  } catch (err) {
    return { ok: false, error: spotifyErrorReply(err) };
  } finally {
    off();
    clearTimeout(timer);
  }
}

export type ConnectState = { phase: "idle" } | { phase: "waiting"; url: string | null } | { phase: "done"; account: string | null; warning?: string } | { phase: "error"; error: string };

/** The Connect button's state; shared by Settings → Integrations and the Spotify widget. */
export function useSpotifyConnect(onDone?: (r: ConnectOutcome) => void) {
  const [state, setState] = useState<ConnectState>({ phase: "idle" });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // A newer connect() or a reset() (Disconnect) supersedes any flow still waiting, so its
  // late timeout/result can't flip the button back to an error mid-way through a new flow.
  const gen = useRef(0);
  const connect = async () => {
    const my = ++gen.current;
    const current = () => alive.current && gen.current === my;
    setState({ phase: "waiting", url: null });
    const r = await connectSpotify((url) => current() && setState({ phase: "waiting", url }));
    if (!current()) return;
    setState(r.ok ? { phase: "done", account: r.account ?? null, warning: r.warning } : { phase: "error", error: r.error ?? "Spotify sign-in failed" });
    onDone?.(r);
  };
  const reset = () => {
    gen.current++;
    setState({ phase: "idle" });
    notifyIntegrationsChanged(); // Disconnect
  };
  return { state, connect, reset };
}

/** Events after which a Spotify status must be re-read: a sign-in finished (`spotify-auth`), a
 * background refresh found the sign-in dead (`spotify-session` — deliberately not `spotify-auth`,
 * which would resolve an interactive Connect in flight), Rust opened a consent page on its own
 * (`spotify-reauth`), or the tool set changed (`tools-changed`: connect / disconnect / revoke /
 * MCP registry saved). */
export const SPOTIFY_REFRESH_EVENTS = ["spotify-auth", "spotify-session", "spotify-reauth", "tools-changed"] as const;

/** The toast for a `spotify-reauth` event. Never includes the URL (Settings → Integrations shows the link). */
export function reauthToast(e: Pick<SpotifyReauthEvent, "reason" | "silent">): { title: string; body: string; tone: "info" } {
  if (e.silent) return { title: "Renewing Spotify sign-in", body: "A Spotify tab opened to renew access — it should close on its own.", tone: "info" };
  const body = e.reason === "expired" ? "Your Spotify sign-in expired — approve the tab I opened to renew it." : "Spotify needs new permissions — approve the tab I opened.";
  return { title: "Spotify needs your OK", body, tone: "info" };
}

let reauthNotice = false;
/**
 * Called once from App.tsx: whenever Rust opens a Spotify consent page by itself (scopes changed,
 * a 403 for a missing scope, the 6-month sign-in expired or is about to), explain the browser tab
 * with a toast. Idempotent: a second call is a no-op.
 */
export function installSpotifyReauthNotice(): void {
  if (reauthNotice) return;
  reauthNotice = true;
  void onNativeEvent<SpotifyReauthEvent>("spotify-reauth", (e) => void useToasts.getState().push(reauthToast(e)));
}

/** Re-run `refresh` whenever any Spotify sign-in finishes (including one started by another
 * view or before this one mounted), the session dies in the background, the tool set changes,
 * and whenever the window comes back into focus — the stored token can be revoked or replaced
 * while a view sits open, and a status read once on mount would keep showing "Connected"
 * (with no Connect button) after that. */
export function useSpotifyAuthRefresh(refresh: () => void) {
  useEffect(() => {
    const offs: (() => void)[] = [];
    let dead = false;
    for (const ev of SPOTIFY_REFRESH_EVENTS) void onNativeEvent(ev, () => refresh()).then((u) => (dead ? u() : offs.push(u)));
    let last = Date.now();
    const onFocus = () => {
      if (document.visibilityState !== "visible" || Date.now() - last < 2000) return; // focus + visibility fire together
      last = Date.now();
      refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      dead = true;
      offs.forEach((u) => u());
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refresh]);
}
