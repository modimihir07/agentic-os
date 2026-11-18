import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { History, ListMusic, Loader2, Music2, Pause, Play, SkipBack, SkipForward, Volume2 } from "lucide-react";
import { Empty, WidgetHeader } from "@/components/WidgetHeader";
import type { WidgetProps } from "@/core/widgets/types";
import { cmd, isTauri, type SpotifyAction, type SpotifyItem, type SpotifyNowPlaying, type SpotifyStatus } from "@/lib/platform";
import { spotifyErrorReply } from "@/features/os/media-reply";
import { useSpotifyAuthRefresh, useSpotifyConnect } from "@/features/integrations/spotify-connect";
import { POLL_MS, VOLUME_DEBOUNCE_MS, fmtTime, needsReconnect, progressAt, progressFraction, shownVolume, type QuickList } from "./spotify-ui";

type Config = { quick: QuickList };

export default function Spotify(props: WidgetProps<Config>) {
  if (!isTauri())
    return (
      <div className="flex h-full flex-col">
        <WidgetHeader title="Spotify" />
        <Empty>Spotify control runs in the desktop app.</Empty>
      </div>
    );
  return <SpotifyDesktop {...props} />;
}

function SpotifyDesktop(props: WidgetProps<Config>) {
  const [status, setStatus] = useState<SpotifyStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const refresh = useCallback(
    () =>
      void cmd("spotify_status")
        .then((s) => (setStatus(s), setErr(null)))
        .catch((e) => setErr(spotifyErrorReply(e))),
    [],
  );
  useEffect(refresh, [refresh]);
  useSpotifyAuthRefresh(refresh);

  if (!status)
    return (
      <div className="flex h-full flex-col">
        <WidgetHeader title="Spotify" />
        <Empty>{err ?? "Checking Spotify…"}</Empty>
      </div>
    );
  if (!status.configured)
    return (
      <div className="flex h-full flex-col">
        <WidgetHeader title="Spotify" />
        <Empty>Spotify isn't set up yet — see Settings → Integrations.</Empty>
      </div>
    );
  if (!status.connected) return <ConnectPanel onDone={refresh} />;
  return <Player {...props} onDisconnected={refresh} />;
}

function ConnectPanel({ onDone }: { onDone: () => void }) {
  const { state, connect } = useSpotifyConnect(onDone);
  const waiting = state.phase === "waiting";
  return (
    <div className="flex h-full flex-col">
      <WidgetHeader title="Spotify" />
      <p className="mb-3 text-sm text-ink-2">Connect your Spotify account to see what's playing and control it from here.</p>
      <button onClick={() => void connect()} disabled={waiting} className="pill-primary !h-9 w-fit text-[13px]">
        {waiting ? <Loader2 size={13} className="animate-spin" /> : <Music2 size={13} />} Connect Spotify
      </button>
      {waiting && (
        <p className="mt-2 text-xs text-ink-2">
          Waiting for Spotify… finish signing in in your browser.{" "}
          {state.url && (
            <a href={state.url} target="_blank" rel="noreferrer" className="text-teal underline">
              Open the sign-in page
            </a>
          )}
        </p>
      )}
      {state.phase === "error" && <p className="mt-2 text-xs text-alert">{state.error}</p>}
    </div>
  );
}

/** True while the widget is on screen and the window isn't hidden — polling only runs then. */
function useVisible(ref: RefObject<HTMLElement | null>): boolean {
  const [inView, setInView] = useState(true);
  const [docVisible, setDocVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  useEffect(() => {
    const on = () => setDocVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return inView && docVisible;
}

function Player({ config, setConfig, size, onDisconnected }: WidgetProps<Config> & { onDisconnected: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const visible = useVisible(rootRef);
  const [np, setNp] = useState<{ data: SpotifyNowPlaying; at: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [localVol, setLocalVol] = useState<{ value: number; at: number } | null>(null);
  const [lists, setLists] = useState<Partial<Record<QuickList, SpotifyItem[]>>>({});
  const [listErr, setListErr] = useState<string | null>(null);
  const seq = useRef(0);
  const followUp = useRef<ReturnType<typeof setTimeout>>(undefined);
  const volTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const fail = useCallback(
    (e: unknown) => {
      const msg = spotifyErrorReply(e);
      setErr(msg);
      if (needsReconnect(msg)) onDisconnected();
    },
    [onDisconnected],
  );

  const poll = useCallback(async () => {
    const my = ++seq.current;
    try {
      const data = await cmd("spotify_now_playing");
      if (my !== seq.current) return;
      const at = Date.now();
      setNp({ data, at });
      setNow(at);
      setErr(null);
    } catch (e) {
      if (my === seq.current) fail(e);
    }
  }, [fail]);

  useEffect(() => {
    if (!visible) return;
    void poll();
    const t = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(t);
  }, [visible, poll]);

  const playing = !!np?.data.isPlaying;
  useEffect(() => {
    if (!visible || !playing) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [visible, playing]);

  useEffect(
    () => () => {
      clearTimeout(followUp.current);
      clearTimeout(volTimer.current);
    },
    [],
  );

  /** Re-poll now, and once more shortly after: Spotify reports the old state for a moment after a change. */
  const pollAfterChange = () => {
    void poll();
    clearTimeout(followUp.current);
    followUp.current = setTimeout(() => void poll(), 900);
  };

  // A click on the widget is the user's own action, so it counts as approval; Deny and the kill switch still refuse in Rust.
  const run = async (call: () => Promise<string>) => {
    try {
      await call();
      setErr(null);
    } catch (e) {
      fail(e);
    }
    pollAfterChange();
  };
  const control = (action: SpotifyAction, value?: number) => {
    if (action === "pause" || action === "resume") {
      seq.current++; // an in-flight poll would undo the optimistic flip
      setNp((p) => {
        if (!p) return p;
        const at = Date.now();
        return { data: { ...p.data, isPlaying: action === "resume", progressMs: progressAt(p.data, p.at, at) }, at };
      });
    }
    void run(() => cmd("spotify_control", { action, value, approved: true }));
  };
  const setVolume = (value: number) => {
    setLocalVol({ value, at: Date.now() });
    clearTimeout(volTimer.current);
    volTimer.current = setTimeout(() => void run(() => cmd("spotify_control", { action: "volume", value, approved: true })), VOLUME_DEBOUNCE_MS);
  };

  const showList = size.h >= 3;
  const tab = config.quick === "playlists" ? "playlists" : "recent";
  const loadList = useCallback(
    (which: QuickList) =>
      void (which === "recent" ? cmd("spotify_recent") : cmd("spotify_playlists"))
        .then((items) => (setLists((l) => ({ ...l, [which]: items })), setListErr(null)))
        .catch((e) => setListErr(spotifyErrorReply(e))),
    [],
  );
  const listLoaded = lists[tab] !== undefined;
  useEffect(() => {
    if (showList && visible && !listLoaded) loadList(tab);
  }, [showList, visible, listLoaded, tab, loadList]);

  const d = np?.data;
  const pos = d ? progressAt(d, np.at, now) : 0;
  const vol = shownVolume(d?.volume ?? null, localVol, now);
  const items = lists[tab];

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col">
      <WidgetHeader title="Spotify" status={d?.device ? <span className="label-caps max-w-32 truncate text-ink-3">{d.device}</span> : undefined} />

      <div className="flex min-w-0 items-center gap-3">
        {d?.artUrl ? (
          <img src={d.artUrl} alt="" className={`${showList ? "size-14" : "size-11"} shrink-0 rounded-[10px] object-cover`} />
        ) : (
          <div className={`${showList ? "size-14" : "size-11"} well grid shrink-0 place-items-center rounded-[10px] text-ink-3`}>
            <Music2 size={18} />
          </div>
        )}
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-ink">{d?.track ?? (np ? "Nothing playing" : "…")}</p>
          <p className="truncate text-xs text-ink-2">{d?.track ? d.artists.join(", ") : np ? "Open Spotify on a device, or pick something below." : ""}</p>
        </div>
      </div>

      {d?.track && (
        <div className="mt-2">
          <div className="well h-1 w-full overflow-hidden rounded-full" role="progressbar" aria-label="Track position" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progressFraction(pos, d.durationMs) * 100)}>
            <div className="h-full rounded-full bg-gradient-to-r from-teal to-teal-light" style={{ width: `${progressFraction(pos, d.durationMs) * 100}%` }} />
          </div>
          <div className="mt-0.5 flex justify-between font-mono text-[10px] text-ink-3 tabular">
            <span>{fmtTime(pos)}</span>
            <span>{fmtTime(d.durationMs)}</span>
          </div>
        </div>
      )}

      <div className="mt-2 flex items-center gap-1.5">
        <button aria-label="Previous track" onClick={() => control("previous")} className="well grid size-8 place-items-center rounded-full text-ink-2 hover:text-ink">
          <SkipBack size={14} />
        </button>
        <button
          aria-label={playing ? "Pause" : "Play"}
          onClick={() => control(playing ? "pause" : "resume")}
          className="grid size-9 place-items-center rounded-full bg-gradient-to-tr from-teal to-teal-light text-canvas"
        >
          {playing ? <Pause size={15} /> : <Play size={15} className="translate-x-px" />}
        </button>
        <button aria-label="Next track" onClick={() => control("next")} className="well grid size-8 place-items-center rounded-full text-ink-2 hover:text-ink">
          <SkipForward size={14} />
        </button>
        {vol != null && (
          <label className="ml-auto flex min-w-0 items-center gap-1.5 text-ink-3">
            <Volume2 size={13} className="shrink-0" />
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={vol}
              onChange={(e) => setVolume(Number(e.target.value))}
              aria-label="Spotify volume"
              className="w-20 min-w-0 accent-teal"
            />
          </label>
        )}
      </div>

      {err && <p className="mt-1.5 text-xs text-amber-light">{err}</p>}

      {showList && (
        <div className="mt-2 flex min-h-0 flex-1 flex-col">
          <div role="tablist" aria-label="Quick select" className="well mb-1.5 flex w-fit gap-0.5 rounded-full p-0.5">
            {(
              [
                ["recent", "Recent", History],
                ["playlists", "Playlists", ListMusic],
              ] as const
            ).map(([id, label, Icon]) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                onClick={() => (tab === id ? loadList(id) : setConfig({ quick: id }))}
                title={tab === id ? "Refresh" : label}
                className={`flex h-6 items-center gap-1 rounded-full px-2.5 text-[11px] ${tab === id ? "bg-white/10 text-ink" : "text-ink-3 hover:text-ink"}`}
              >
                <Icon size={11} /> {label}
              </button>
            ))}
          </div>
          <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
            {listErr && <li className="text-xs text-amber-light">{listErr}</li>}
            {!listErr && !items && <li className="text-xs text-ink-3">Loading…</li>}
            {items?.length === 0 && <li className="text-xs text-ink-3">{tab === "recent" ? "Nothing played recently." : "No playlists yet."}</li>}
            {items?.map((it) => (
              <li key={it.uri}>
                <button
                  onClick={() => void run(() => cmd("spotify_play_uri", { uri: it.uri, approved: true }))}
                  className={`flex w-full min-w-0 items-center gap-2 rounded-[10px] px-1.5 py-1 text-left hover:bg-white/[0.06] ${d?.uri === it.uri ? "text-teal" : ""}`}
                  title={`Play ${it.title}`}
                >
                  {it.artUrl ? <img src={it.artUrl} alt="" loading="lazy" className="size-7 shrink-0 rounded-[6px] object-cover" /> : <span className="well size-7 shrink-0 rounded-[6px]" />}
                  <span className="min-w-0">
                    <span className="block truncate text-xs text-ink">{it.title}</span>
                    {it.subtitle && <span className="block truncate text-[11px] text-ink-3">{it.subtitle}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
