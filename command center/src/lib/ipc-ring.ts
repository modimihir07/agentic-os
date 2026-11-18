import { create } from "zustand";

/**
 * Dev X-Ray: the last 200 Tauri command invocations made through `cmd()` / `nativeRaw()`
 * (lib/platform.ts). Command NAMES, durations and outcomes only — never arguments or
 * results. Kept in TS because Tauri has no Rust-side hook for every invoke.
 */
export interface IpcCall {
  name: string;
  /** Wall time from invoke to settle. */
  ms: number;
  ok: boolean;
  /** Unix ms when the call settled. */
  at: number;
}

export const IPC_RING_CAP = 200;

/** Append `item`, keeping only the newest `cap` entries (oldest first). Pure. */
export function pushRing<T>(ring: readonly T[], item: T, cap: number): T[] {
  const next = ring.length >= cap ? ring.slice(ring.length - cap + 1) : ring.slice();
  next.push(item);
  return next;
}

interface IpcRingState {
  calls: IpcCall[];
  clear: () => void;
}

export const useIpcRing = create<IpcRingState>((set) => ({
  calls: [],
  clear: () => set({ calls: [] }),
}));

/** Record one settled invocation. `name` must be a command name, nothing caller-supplied. */
export function recordIpc(name: string, ms: number, ok: boolean, at = Date.now()) {
  const call: IpcCall = { name, ms: Math.max(0, Math.round(ms)), ok, at };
  useIpcRing.setState((s) => ({ calls: pushRing(s.calls, call, IPC_RING_CAP) }));
}

/** Per-command count / median / max / failures over the ring, slowest median first. */
export function ipcSummary(calls: readonly IpcCall[]): { name: string; count: number; medianMs: number; maxMs: number; failures: number }[] {
  const by = new Map<string, IpcCall[]>();
  for (const c of calls) by.set(c.name, [...(by.get(c.name) ?? []), c]);
  return [...by.entries()]
    .map(([name, cs]) => {
      const ms = cs.map((c) => c.ms).sort((a, b) => a - b);
      const mid = ms.length >> 1;
      const medianMs = ms.length % 2 ? ms[mid] : Math.round((ms[mid - 1] + ms[mid]) / 2);
      return { name, count: cs.length, medianMs, maxMs: ms[ms.length - 1], failures: cs.filter((c) => !c.ok).length };
    })
    .sort((a, b) => b.medianMs - a.medianMs || a.name.localeCompare(b.name));
}
