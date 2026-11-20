import { useEffect, useRef } from "react";

/**
 * "An integration's credentials or connection changed" (a key saved or deleted, a Spotify
 * sign-in finished, a Gmail backend imported). Views that show integration status — the
 * MCP registry's per-server errors in particular — re-read it instead of keeping whatever
 * they loaded on mount.
 */
const EVENT = "cc:integrations-changed";

export function notifyIntegrationsChanged() {
  window.dispatchEvent(new Event(EVENT));
}

export function useOnIntegrationsChanged(fn: () => void) {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    const on = () => latest.current();
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
}
