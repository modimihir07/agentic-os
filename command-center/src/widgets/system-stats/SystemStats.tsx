import type { WidgetProps } from "@/core/widgets/types";
import { Empty, Meter, StatusDot, WidgetHeader } from "@/components/WidgetHeader";
import { cmd, isTauri } from "@/lib/platform";
import { api } from "@/lib/gateway";
import { usePoll } from "@/lib/use-poll";

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
