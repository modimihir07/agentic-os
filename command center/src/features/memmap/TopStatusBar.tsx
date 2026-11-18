import { useEffect, useState } from "react";
import { RefreshCw, ScanLine, ShieldCheck, ShieldOff } from "lucide-react";
import { cmd, isTauri } from "@/lib/platform";
import { useOs } from "@/features/os/os-store";
import { useSettings } from "@/stores/settings";
import { fmtAgo, fmtMs, fmtUptime, gatewayRtt, hardwareChip } from "./format";
import { useMemmapData } from "./use-memmap-data";
import { Dash, useNow } from "./parts";

/**
 * "TONY OS // Gabagool Command Center" + live uptime, gateway RTT, active agents, the
 * hardware chip, the view mode and an auth pill showing the real gateway state (there is
 * no user-auth system: the gateway is either loopback-only or bearer-token protected).
 */
export function TopStatusBar({ className = "" }: { className?: string }) {
  const { snap, error, at, uptime, loading, deep, refresh } = useMemmapData();
  const osName = useSettings((s) => s.osName) || "Tony";
  const mode = useSettings((s) => s.systemMapMode);
  const setSettings = useSettings((s) => s.set);
  const now = useNow(1000);
  const xray = mode === "xray";

  // App uptime ticks locally from the Rust start time; the snapshot's figure is the fallback.
  const upSecs = uptime ? (now - uptime.startedAt) / 1000 : snap ? snap.uptimeSecs + (now - at) / 1000 : null;
  const rtt = gatewayRtt(snap);
  const gw = snap?.services.find((s) => s.id === "gateway");
  const chip = hardwareChip(snap);
  const slot = snap?.slot;
  const queued = slot ? slot.queuedForeground + slot.queuedBackground : 0;
  const noData = error ?? "Waiting for the first system snapshot";

  return (
    <header className={`flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[14px] border border-holo/20 bg-[rgba(7,11,17,0.82)] px-4 py-2.5 shadow-[0_0_24px_-12px_rgba(0,210,255,0.35)] ${className}`}>
      <h1 className="label-caps w-full min-w-0 truncate !text-[11px] text-holo xl:w-auto">
        {osName.toUpperCase()} OS <span className="text-ink-3">//</span> <span className="text-ink">Gabagool Command Center</span>
      </h1>

      <dl className="flex min-w-0 flex-1 flex-wrap items-center justify-start gap-x-5 gap-y-1 xl:justify-center">
        <Stat label="Uptime" title="Since the desktop app started">
          {upSecs == null ? <Dash why={noData} /> : fmtUptime(upSecs)}
        </Stat>
        <Stat label="Latency" title={`Gateway round trip (loopback probe${xray && gw?.port ? ` :${gw.port}` : ""})`}>
          {"ms" in rtt ? fmtMs(rtt.ms) : <Dash why={error ?? rtt.why} />}
        </Stat>
        <Stat label="Active agents" title={slot ? (slot.active.length ? `GPU slot: ${slot.active.join(", ")}` : `GPU slot idle · capacity ${slot.capacity}`) : undefined}>
          {slot ? (
            <>
              {slot.active.length}
              <span className="text-ink-3">/{snap?.agents.length ?? 0}</span>
              {queued > 0 && <span className="ml-1 text-ember">+{queued}q</span>}
            </>
          ) : (
            <Dash why={noData} />
          )}
        </Stat>
        <span
          className="label-caps max-w-[220px] truncate rounded-full border border-holo/25 bg-holo/[0.06] px-2.5 py-1 text-holo"
          title={snap ? [snap.host.gpu?.name, snap.host.cpuBrand && `${snap.host.cpuBrand} · ${snap.host.cpuThreads} threads`, snap.host.gpuNote].filter(Boolean).join("\n") : noData}
        >
          {chip ?? "HW —"}
        </span>
        {xray && snap && (
          <span className="label-caps text-ink-3" title={`system_introspect took ${snap.tookMs} ms${snap.deep ? " (deep)" : ""}`}>
            SNAP {fmtAgo(at, now)} · {snap.tookMs}MS
          </span>
        )}
      </dl>

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setSettings({ systemMapMode: xray ? "streamlined" : "xray" })}
          aria-pressed={xray}
          title={xray ? "Dev X-Ray: ports, paths, IPC and per-hop ms. Click for Streamlined." : "Streamlined OS: status colours and plain words. Click for Dev X-Ray."}
          className={`label-caps flex h-7 items-center gap-1.5 rounded-full border px-2.5 transition-colors ${xray ? "border-ember/50 bg-ember/10 text-ember" : "border-holo/25 text-ink-2 hover:text-holo"}`}
        >
          <ScanLine size={12} /> {xray ? "X-Ray" : "Streamlined"}
        </button>
        {isTauri() && (
          <button
            type="button"
            onClick={() => void refresh(true)}
            disabled={deep}
            title="Deep scan: re-probe every local service and re-list every external MCP server (read-only)"
            className="grid size-7 place-items-center rounded-full border border-holo/25 text-ink-2 transition-colors hover:text-holo disabled:opacity-50"
            aria-label="Deep scan"
          >
            <RefreshCw size={12} className={deep || loading ? "animate-spin" : ""} />
          </button>
        )}
        <AuthPill />
      </div>
    </header>
  );
}

function Stat({ label, title, children }: { label: string; title?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-1.5" title={title}>
      <dt className="label-caps text-ink-3">{label}</dt>
      <dd className="font-mono text-[12px] text-ink tabular">{children}</dd>
    </div>
  );
}

/** Real gateway auth state, presence only (the token itself never reaches the webview here). */
function AuthPill() {
  const [tokenSet, setTokenSet] = useState<boolean | null>(null);
  const lock = useOs((s) => s.cfg?.privacy.networkLock);
  const phoneToken = useSettings((s) => !!s.gatewayToken);
  useEffect(() => {
    if (!isTauri()) return;
    void cmd("os_secret_status")
      .then((s) => setTokenSet(!!s["gateway-token"]))
      .catch(() => setTokenSet(null));
  }, []);
  const desktop = isTauri();
  const set = desktop ? tokenSet : phoneToken;
  if (desktop && set == null) {
    return (
      <span className="label-caps flex h-7 items-center gap-1.5 rounded-full border border-white/10 px-2.5 text-ink-3" title="Couldn't read the keychain status">
        AUTH <Dash why="Keychain status unavailable" />
      </span>
    );
  }
  const title = desktop
    ? set
      ? `A gateway bearer token is in the keychain. Network lock is ${lock == null ? "unknown" : lock ? "on: the phone must present it" : "off: the gateway answers without it"}. The desktop (loopback) is always trusted.`
      : "No gateway token: the gateway trusts loopback only (turn on the network lock in Settings to create one)."
    : set
      ? "This session sends a bearer token to the gateway."
      : "No bearer token in this session (the desktop's network lock may refuse requests).";
  return (
    <span
      title={title}
      className={`label-caps flex h-7 items-center gap-1.5 rounded-full border px-2.5 ${set ? "border-teal/40 bg-teal/10 text-teal-soft" : "border-holo/25 text-ink-2"}`}
    >
      {set ? <ShieldCheck size={12} /> : <ShieldOff size={12} />}
      {set ? "Gateway token set" : "Local"}
    </span>
  );
}
