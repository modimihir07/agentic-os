import { useEffect, useRef, useState } from "react";

export interface PollState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

/**
 * Poll an async source. Pauses while the tab/window is hidden so a
 * backgrounded PWA doesn't burn battery or hammer the gateway.
 */
export function usePoll<T>(fn: () => Promise<T>, intervalMs: number, deps: unknown[] = []): PollState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const run = async () => {
      if (document.hidden) {
        timer = setTimeout(run, intervalMs);
        return;
      }
      try {
        const result = await fnRef.current();
        if (!alive) return;
        setData(result);
        setError(null);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive) {
          setLoading(false);
          timer = setTimeout(run, intervalMs);
        }
      }
    };
    run();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, tick, ...deps]);

  return { data, error, loading, refresh: () => setTick((t) => t + 1) };
}
