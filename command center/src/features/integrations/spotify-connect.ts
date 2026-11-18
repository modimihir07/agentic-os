import { useEffect, useRef, useState } from "react";
import { cmd, onNativeEvent, type SpotifyAuthEvent } from "@/lib/platform";
import { spotifyErrorReply } from "@/features/os/media-reply";
import { setMcpEnabled } from "./mcp-enable";

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
  };
  return { state, connect, reset };
}

/** Re-run `refresh` whenever any Spotify sign-in finishes, including one started by another
 * view or before this one mounted (the widget and the Settings card both show status). */
export function useSpotifyAuthRefresh(refresh: () => void) {
  useEffect(() => {
    let off: (() => void) | undefined;
    let dead = false;
    void onNativeEvent<SpotifyAuthEvent>("spotify-auth", () => refresh()).then((u) => (dead ? u() : (off = u)));
    return () => {
      dead = true;
      off?.();
    };
  }, [refresh]);
}
