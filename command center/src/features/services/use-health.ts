import { create } from "zustand";
import { useEffect } from "react";
import { api } from "@/lib/gateway";
import { cc } from "@/lib/cc-api";
import { cmd, isTauri, type ServiceHealth } from "@/lib/platform";

/**
 * Live service health, shared by every widget that shows nodes.
 * Desktop: real probes from Rust (no CORS, includes LM Studio, Whisper, Kokoro, n8n, gateway).
 * PWA: what the gateway itself can report.
 */
interface HealthState {
  services: ServiceHealth[];
  at: number;
  error: string | null;
  refresh: () => Promise<void>;
}

let subscribers = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

export const useHealthStore = create<HealthState>((set) => ({
  services: [],
  at: 0,
  error: null,
  refresh: async () => {
    try {
      const services = isTauri() ? await cmd("services_health") : await pwaHealth();
      set({ services, at: Date.now(), error: null });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e), at: Date.now() });
    }
  },
}));

async function pwaHealth(): Promise<ServiceHealth[]> {
  const t0 = performance.now();
  const out: ServiceHealth[] = [];
  try {
    const h = await cc.health();
    out.push({ id: "gateway", label: "Gateway (server.py)", kind: "agentic-os", up: true, latencyMs: Math.round(performance.now() - t0), detail: "200" });
    out.push({ id: "llm", label: "Local LLM", kind: "local", up: h.llm.ok, latencyMs: 0, detail: h.llm.ok ? `${h.llm.models?.length ?? 0} models` : (h.llm.error ?? "down") });
    const agents = await api.agentsHealth().catch(() => null);
    for (const a of agents?.agents ?? []) out.push({ id: a.name, label: a.name, kind: "agentic-os", up: a.status === "online", latencyMs: 0, detail: a.status });
  } catch (e) {
    out.push({ id: "gateway", label: "Gateway (server.py)", kind: "agentic-os", up: false, latencyMs: 0, detail: e instanceof Error ? e.message : "unreachable" });
  }
  return out;
}

export function useServicesHealth(intervalMs = 15_000) {
  const state = useHealthStore();
  useEffect(() => {
    subscribers++;
    if (subscribers === 1) {
      const loop = async () => {
        if (!document.hidden) await useHealthStore.getState().refresh();
        timer = setTimeout(loop, intervalMs);
      };
      void loop();
    }
    return () => {
      subscribers--;
      if (subscribers === 0) clearTimeout(timer);
    };
  }, [intervalMs]);
  return state;
}
