import { useEffect } from "react";
import { create } from "zustand";
import { cmd, isTauri, onNativeEvent, type AppUptime, type SlotView, type SystemSnapshot } from "@/lib/platform";
import { applySlot } from "./format";

/**
 * System Map data: `system_introspect` polled every 10 s (Rust caches it for 10 s too),
 * shared by every panel on the page. Ref-counted like `useServicesHealth`: polling runs
 * only while at least one component is mounted, and skips (then catches up on return)
 * while the window is hidden. `gpu-slot` events update the slot and the roster's
 * Active/Idle tags between polls. Desktop only; on the PWA `error` explains why.
 */

export const POLL_MS = 10_000;
export const DESKTOP_ONLY = "Live system data needs the desktop app (Rust introspection).";

interface MemmapState {
  snap: SystemSnapshot | null;
  /** Last refresh failure (the previous snapshot, if any, is kept). */
  error: string | null;
  /** Unix ms of the last successful refresh. */
  at: number;
  loading: boolean;
  /** A deep scan (re-probe + re-list every external MCP server) is running. */
  deep: boolean;
  uptime: AppUptime | null;
  refresh: (deep?: boolean) => Promise<void>;
}

let inflight: Promise<void> | null = null;

export const useMemmap = create<MemmapState>((set, get) => ({
  snap: null,
  error: isTauri() ? null : DESKTOP_ONLY,
  at: 0,
  loading: false,
  deep: false,
  uptime: null,
  refresh: async (deep = false) => {
    if (!isTauri()) return set({ error: DESKTOP_ONLY });
    // A deep scan waits for (then replaces) a plain refresh; plain refreshes share one call.
    if (inflight && !deep) return inflight;
    if (inflight) await inflight.catch(() => undefined);
    const run = (async () => {
      set({ loading: true, ...(deep ? { deep: true } : {}) });
      try {
        const snap = await cmd("system_introspect", deep ? { deep: true } : {});
        set({ snap, error: null, at: Date.now() });
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e) });
      } finally {
        set({ loading: false, deep: false });
      }
      if (!get().uptime) {
        try {
          set({ uptime: await cmd("app_uptime") });
        } catch {
          /* the snapshot's uptimeSecs is the fallback */
        }
      }
    })();
    inflight = run;
    try {
      await run;
    } finally {
      if (inflight === run) inflight = null;
    }
  },
}));

/** Apply a live `gpu-slot` view to the current snapshot (slot + roster tags). */
export function onSlot(v: SlotView) {
  const snap = useMemmap.getState().snap;
  if (!snap) return;
  const agents = applySlot(snap.agents, v.active);
  useMemmap.setState({ snap: { ...snap, slot: v, agents } });
}

let subscribers = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let offSlot: (() => void) | undefined;

function loop() {
  clearTimeout(timer);
  if (!document.hidden) void useMemmap.getState().refresh();
  timer = setTimeout(loop, POLL_MS);
}

function onVisibility() {
  // Back from hidden with a stale snapshot: refresh now instead of waiting out the timer.
  if (!document.hidden && Date.now() - useMemmap.getState().at >= POLL_MS) loop();
}

function start() {
  if (!isTauri()) return;
  loop();
  document.addEventListener("visibilitychange", onVisibility);
  let cancelled = false;
  void onNativeEvent<SlotView>("gpu-slot", onSlot).then((off) => {
    if (cancelled) off();
    else offSlot = off;
  });
  offSlot = () => {
    cancelled = true;
  };
}

function stop() {
  clearTimeout(timer);
  document.removeEventListener("visibilitychange", onVisibility);
  offSlot?.();
  offSlot = undefined;
}

/** Subscribe a component to the shared System Map poller. */
export function useMemmapData() {
  const state = useMemmap();
  useEffect(() => {
    if (++subscribers === 1) start();
    return () => {
      if (--subscribers === 0) stop();
    };
  }, []);
  return state;
}
