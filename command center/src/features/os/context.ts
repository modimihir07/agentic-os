import { useWeather } from "@/features/weather/weather-store";
import { useHealthStore } from "@/features/services/use-health";
import { gabagoolOn, useCueRun } from "@/features/cues/player";
import { cmd, isTauri } from "@/lib/platform";
import { useOs } from "./os-store";

/**
 * Live dashboard state as plain text for the OS system prompt, so Tony answers
 * "what's the weather / is the droplet up / how's the GPU" from what's on
 * screen instead of claiming it has no real-time access.
 */
let statsCache: { at: number; st: Awaited<ReturnType<typeof cmd<"system_stats">>> } | null = null;

export async function liveContext(): Promise<string> {
  const lines: string[] = [];
  const now = new Date();
  lines.push(`Local time: ${now.toLocaleString("en-CA", { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })}`);

  const w = useWeather.getState().now;
  if (w) {
    const age = Math.round((Date.now() - w.fetchedAt) / 60000);
    lines.push(`Weather (${w.place}): ${Math.round(w.tempC)}°C ${w.label}, wind ${Math.round(w.windKph)} km/h${age > 1 ? ` (updated ${age} min ago)` : ""}`);
  }

  const svc = useHealthStore.getState().services;
  if (svc.length) {
    const up = svc.filter((s) => s.up).map((s) => s.label);
    const off = svc.filter((s) => !s.up).map((s) => `${s.label} (${s.manual ? s.detail.toLowerCase() : s.detail})`);
    lines.push(`Nodes up: ${up.join(", ") || "none"}`);
    if (off.length) lines.push(`Nodes down/off: ${off.join(", ")}`);
  }

  if (isTauri()) {
    try {
      // Cached 15 s: reading the GPU spawns nvidia-smi, too slow for every turn.
      if (!statsCache || Date.now() - statsCache.at > 15_000) statsCache = { at: Date.now(), st: await cmd("system_stats") };
      const st = statsCache.st;
      const gpu = st.gpu ? `, GPU ${st.gpu.name} ${st.gpu.utilPct.toFixed(0)}% · VRAM ${(st.gpu.vramUsedMb / 1024).toFixed(1)}/${(st.gpu.vramTotalMb / 1024).toFixed(0)} GB` : "";
      lines.push(`System (${st.hostname ?? "desktop"}): CPU ${st.cpuPct.toFixed(0)}%, RAM ${(st.memUsedMb / 1024).toFixed(1)}/${(st.memTotalMb / 1024).toFixed(0)} GB${gpu}`);
    } catch {
      /* stats are best-effort */
    }
  }

  const cfg = useOs.getState().cfg;
  if (cfg) {
    lines.push(
      `Compute mode: ${cfg.compute.mode.toUpperCase()}${cfg.privacy.killSwitch ? " · KILL SWITCH ON (local only)" : ""} · droplet ${cfg.droplet.enabled ? "enabled" : "off (manual)"}`,
    );
  }
  const run = useCueRun.getState();
  lines.push(`Gabagool mode: ${gabagoolOn(run) ? `ON (${run.running})` : "OFF"}`);
  return lines.join("\n");
}
