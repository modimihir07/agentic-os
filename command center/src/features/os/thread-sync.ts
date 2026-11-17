import { useEffect } from "react";
import { gateway } from "@/lib/gateway";
import { isTauri } from "@/lib/platform";
import { useVoice, type VoiceTurn } from "@/features/voice/voice-store";
import { useSettings } from "@/stores/settings";
import { useOs } from "./os-store";
import { startPipelineFeed } from "./pipeline-store";

/**
 * Mobile companion readiness:
 *   desktop → pushes its isolated threads to the gateway (`PUT /api/os/threads`)
 *   phone   → pulls them on open and every 30 s (`GET /api/os/threads`)
 * so the Booking / Coder / Tony tabs read the same on both.
 */
export function useOsBoot() {
  useEffect(() => {
    void useOs.getState().load();
    startPipelineFeed();
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (isTauri()) {
      let last = "";
      const unsub = useVoice.subscribe((s) => {
        const ids = s.turns.length ? `${s.turns.length}:${s.turns.at(-1)!.id}` : "0";
        if (ids === last) return;
        last = ids;
        clearTimeout(timer);
        timer = setTimeout(() => {
          const turns = useVoice.getState().turns.filter((t) => t.who !== "system");
          const threads: Record<string, VoiceTurn[]> = {};
          for (const t of turns) (threads[t.thread] ??= []).push(t);
          for (const k of Object.keys(threads)) threads[k] = threads[k].slice(-60);
          void gateway("/api/os/threads", { method: "PUT", body: JSON.stringify({ threads }) }).catch(() => undefined);
        }, 1500);
      });
      return () => {
        unsub();
        clearTimeout(timer);
      };
    }
    const pull = () =>
      gateway<{ threads: Record<string, VoiceTurn[]> }>("/api/os/threads")
        .then((r) => useVoice.getState().mergeRemote(Object.values(r.threads ?? {}).flat()))
        .catch(() => undefined);
    void pull();
    const iv = setInterval(pull, 30_000);
    return () => clearInterval(iv);
  }, []);

  const name = useSettings((s) => s.osName);
  useEffect(() => {
    document.title = `${name || "Tony"} · Command Center`;
  }, [name]);

  // Ultra-glass opacity is a CSS variable so every glass-ultra panel follows the slider.
  const glass = useSettings((s) => s.glassOpacity);
  useEffect(() => {
    const a = Math.max(0, Math.min(100, glass)) / 100;
    const root = document.documentElement.style;
    root.setProperty("--ultra-alpha", a.toFixed(3));
    root.setProperty("--ultra-border", (0.04 + a * 0.14).toFixed(3));
    root.setProperty("--ultra-blur", `${(a * 18).toFixed(1)}px`);
  }, [glass]);
}
