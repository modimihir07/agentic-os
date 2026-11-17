import type { WidgetProps } from "@/core/widgets/types";
import { Empty, Meter, StatusDot, WidgetHeader } from "@/components/WidgetHeader";
import { cmd, isTauri } from "@/lib/platform";
import { api } from "@/lib/gateway";
import { usePoll } from "@/lib/use-poll";
import { useServicesHealth } from "@/features/services/use-health";

export default function SystemStats({ config }: WidgetProps<{ pollMs: number }>) {
  return isTauri() ? <DesktopStats pollMs={config.pollMs} /> : <GatewayStats />;
}

function DesktopStats({ pollMs }: { pollMs: number }) {
  const { data, error } = usePoll(() => cmd("system_stats"), pollMs);
  if (error) return <Empty>Telemetry error: {error}</Empty>;
  if (!data) return <WidgetHeader title="System" />;
  const memPct = (data.memUsedMb / data.memTotalMb) * 100;
  const gpu = data.gpu;
  const vramPct = gpu ? (gpu.vramUsedMb / gpu.vramTotalMb) * 100 : 0;
  return (
    <div className="space-y-3">
      <WidgetHeader title={data.hostname ?? "System"} status={<StatusDot tone="ok" label="Live" />} />
      <Row label="CPU" value={`${data.cpuPct.toFixed(0)}%`} pct={data.cpuPct} />
      <Row label="RAM" value={`${(data.memUsedMb / 1024).toFixed(1)} / ${(data.memTotalMb / 1024).toFixed(0)}G`} pct={memPct} />
      {gpu ? (
        <>
          <Row label={gpu.name.replace(/NVIDIA GeForce /i, "")} value={`${gpu.utilPct.toFixed(0)}%`} pct={gpu.utilPct} tone="amber" />
          <Row label="VRAM" value={`${(gpu.vramUsedMb / 1024).toFixed(1)} / ${(gpu.vramTotalMb / 1024).toFixed(0)}G`} pct={vramPct} tone="amber" />
        </>
      ) : (
        <p className="font-mono text-[11px] text-ink-3">No NVIDIA GPU detected (nvidia-smi)</p>
      )}
      <NodeStrip />
    </div>
  );
}

/** One dot per live-probed node, so telemetry and node health sit together. */
function NodeStrip() {
  const { services } = useServicesHealth();
  if (!services.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t border-white/5 pt-2.5">
      <span className="label-caps mr-1 text-ink-3">Nodes</span>
      {services.map((s) => (
        <span key={s.id} title={`${s.label}: ${s.up ? "up" : s.detail}`} className={`size-2 rounded-full ${s.up ? "bg-teal shadow-[0_0_6px_#00e5c3]" : "bg-alert/80"}`} />
      ))}
      <span className="ml-auto font-mono text-[10.5px] text-ink-3">
        {services.filter((s) => s.up).length}/{services.length}
      </span>
    </div>
  );
}

function Row({ label, value, pct, tone = "teal" }: { label: string; value: string; pct: number; tone?: "teal" | "amber" }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="label-caps truncate text-ink-2">{label}</span>
        <span className={`font-mono text-sm tabular ${tone === "amber" ? "text-amber-soft" : "text-teal-soft"}`}>{value}</span>
      </div>
      <Meter value={pct} tone={pct > 90 ? "alert" : tone} />
    </div>
  );
}

function GatewayStats() {
  const { data, error } = usePoll(async () => {
    const t = performance.now();
    await api.status();
    return Math.round(performance.now() - t);
  }, 10_000);
  return (
    <div>
      <WidgetHeader title="Gateway" status={<StatusDot tone={error ? "down" : data != null ? "ok" : "idle"} label={error ? "Offline" : "Online"} />} />
      {error ? (
        <Empty>Can’t reach the desktop gateway. Check NetBird and the URL in Settings.</Empty>
      ) : (
        <p className="font-mono text-2xl text-teal-soft tabular">{data ?? "—"} <span className="text-sm text-ink-3">ms RTT</span></p>
      )}
      <p className="mt-2 text-xs text-ink-3">Full CPU/GPU telemetry is available in the desktop app.</p>
    </div>
  );
}
