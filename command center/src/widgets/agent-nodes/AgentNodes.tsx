import { useState } from "react";
import { Loader2, Power, RefreshCw } from "lucide-react";
import { StatusDot, WidgetHeader } from "@/components/WidgetHeader";
import { cmd, isTauri } from "@/lib/platform";
import { useServicesHealth } from "@/features/services/use-health";

const TAG: Record<string, string> = { local: "LOCAL", cloud: "CLOUD", "agentic-os": "AGENT", stt: "STT", tts: "TTS", n8n: "N8N" };

/** Every node is shown green only after a real probe answered (not just "configured"). */
export default function AgentNodes() {
  const { services, error, refresh, at } = useServicesHealth();
  const [starting, setStarting] = useState<string | null>(null);
  const up = services.filter((s) => s.up).length;
  const gateway = services.find((s) => s.id === "gateway");

  const startGateway = async () => {
    setStarting("Starting gateway…");
    try {
      const r = await cmd("gateway_ensure");
      setStarting(r.up ? null : r.detail);
      await refresh();
    } catch (e) {
      setStarting(String(e));
    }
  };

  return (
    <div className="flex h-full flex-col">
      <WidgetHeader
        title="Active nodes"
        status={
          <>
            <StatusDot tone={error ? "down" : up === services.length && up ? "ok" : up ? "warn" : "idle"} label={at ? `${up}/${services.length} up` : "probing"} />
            <button aria-label="Re-check nodes" onClick={() => void refresh()} className="grid size-6 place-items-center rounded-full text-ink-3 hover:text-ink">
              <RefreshCw size={11} />
            </button>
          </>
        }
      />
      {isTauri() && gateway && !gateway.up && (
        <button onClick={() => void startGateway()} disabled={!!starting && starting.startsWith("Starting")} className="pill-primary mb-2 !h-8 w-full text-xs">
          {starting?.startsWith("Starting") ? <Loader2 size={13} className="animate-spin" /> : <Power size={13} />} Start gateway (server.py)
        </button>
      )}
      {starting && !starting.startsWith("Starting") && <p className="mb-2 text-[11px] text-alert">{starting}</p>}
      <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
        {services.map((s) => (
          <li key={s.id} title={s.detail} className="flex items-center gap-2.5 rounded-full border border-white/[0.06] bg-white/[0.02] px-3 py-1.5">
            <span className={`size-1.5 shrink-0 rounded-full ${s.up ? "bg-teal shadow-[0_0_6px_#00e5c3]" : s.manual ? "bg-ink-3" : "bg-alert"}`} />
            <span className="truncate font-mono text-[12.5px] text-ink">{s.label}</span>
            <span className={`truncate font-mono text-[10.5px] ${s.up ? "text-ink-3" : s.manual ? "text-ink-3" : "text-alert/80"}`}>{s.up ? `${s.latencyMs}ms` : s.detail}</span>
            <span className="label-caps ml-auto shrink-0 text-amber-soft">{TAG[s.kind] ?? s.kind.toUpperCase()}</span>
          </li>
        ))}
        {!services.length && <li className="text-sm text-ink-3">{error ?? "Probing services…"}</li>}
      </ul>
    </div>
  );
}
