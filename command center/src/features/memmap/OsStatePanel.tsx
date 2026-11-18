import { useEffect, useState, type ReactNode } from "react";
import { Lock } from "lucide-react";
import { cmd, isTauri } from "@/lib/platform";
import { useOs } from "@/features/os/os-store";
import { useKeySources } from "@/features/integrations/key-sources";
import { useOsCfg } from "@/sections/settings/os-ui";
import { useDevQueue, QUEUE_DESKTOP_ONLY } from "./dev-queue";
import { apiKeyPresence, daemonState, fmtMs, openCounts, osSwitchBlock, pct, type Tone } from "./format";
import { useMemmapData } from "./use-memmap-data";
import { Dash, Dot, Panel } from "./parts";
import { useZoneUi } from "./zone-store";

/**
 * OS BACKEND ARCHITECTURE // CURRENT OS STATE: the five numbers that say whether the OS is
 * healthy (deployments, memory mapping, task queue, active API keys, system), then two
 * in-page switches — User Delegation and Overload Cap — that write os.json through the same
 * `useOsCfg` patcher Settings uses. Real values only; "—" says why when a source is missing.
 * API keys are counted by presence (service names and counts, never a value), from the
 * shared key-sources store (env → .env → keychain; refreshed on saves and window focus).
 */
export function OsStatePanel({ className = "" }: { className?: string }) {
  const { snap, error } = useMemmapData();
  const why = error ?? "Waiting for the first system snapshot";
  const ks = useKeySources();
  const q = useDevQueue();
  const desktop = isTauri();

  // Deployments: every probed local service.
  const sum = snap?.summary;
  const deployTone: Tone = !sum || !sum.servicesTotal ? "idle" : sum.servicesUp === sum.servicesTotal ? "ok" : sum.servicesUp ? "warn" : "down";
  const deployTip = snap?.services.map((s) => `${s.label}${s.port ? ` :${s.port}` : ""} — ${s.up ? `up, ${fmtMs(s.latencyMs) ?? "?"}` : `down${s.detail ? ` (${s.detail})` : ""}`}`).join("\n");

  // Memory mapping: stores + RAG vectors.
  const cc = snap?.stores.find((s) => s.id === "cc");
  const vectors = cc?.metrics.ragVectors;
  const memTone: Tone = !sum || !sum.storesTotal ? "idle" : sum.storesOk === sum.storesTotal ? "ok" : sum.storesOk ? "warn" : "down";

  // Task queue (TaskDock loads it on this page).
  const counts = openCounts(q.tasks);
  const wip = q.tasks.filter((t) => t.status === "In Progress").length;
  const queueWhy = !desktop ? QUEUE_DESKTOP_ONLY : q.error ? q.error : "Loading the dev queue…";
  const queueVal = desktop && q.loaded && !q.error ? `${counts.all} open · ${wip} in progress` : null;

  // API keys: presence only.
  const keys = apiKeyPresence(snap?.bus ?? null, ks.data?.keys ?? null);
  const keyTip = keys.keys.map((k) => `${k.name}: ${k.present == null ? "unknown" : k.present ? "set" : "not set"} (${k.via})`).join("\n");

  // System.
  const h = snap?.host;
  const vram = pct(h?.gpu?.vramUsedMb, h?.gpu?.vramTotalMb);
  const daemon = snap ? daemonState(snap.routines.loops) : null;
  const sysParts = [h?.cpuPct != null && `CPU ${Math.round(h.cpuPct)}%`, h?.gpu && `GPU ${Math.round(h.gpu.utilPct)}%`, vram != null && `VRAM ${Math.round(vram)}%`].filter(Boolean) as string[];
  const sysTone: Tone = !h ? "idle" : h.error ? "down" : (vram ?? 0) >= 92 || (h.cpuPct ?? 0) >= 92 ? "warn" : daemon && daemon.healthy < daemon.ran ? "warn" : "ok";
  const sysTip = [h?.error, h?.gpu?.name, h?.gpuNote, daemon ? `Daemon: ${daemon.healthy}/${daemon.total} loops healthy (${daemon.ran} ran)` : snap ? "Daemon: no background loop has run yet" : null].filter(Boolean).join("\n");

  return (
    <Panel title="OS backend architecture" className={`shrink-0 ${className}`} bodyClassName="!pt-2">
      <p className="label-caps mb-1.5 !text-[9px] text-ink-3">Current OS state</p>
      <div className="space-y-1.5">
        <Row k="Deployments" tone={deployTone} title={deployTip || why} v={sum && sum.servicesTotal ? `${sum.servicesUp}/${sum.servicesTotal} services up` : null} why={snap ? "No services configured" : why} />
        <Row
          k="Memory mapping"
          tone={memTone}
          title={snap ? `${snap.stores.map((s) => `${s.label}: ${s.health}`).join("\n")}\n\nClick: open the cargo inspector` : why}
          onClick={() => useZoneUi.getState().select("cargo")}
          v={sum && sum.storesTotal ? `${sum.storesOk}/${sum.storesTotal} stores${vectors != null ? ` · ${vectors.toLocaleString()} vectors` : ""}` : null}
          why={snap ? "No stores reported" : why}
        />
        <Row k="Task queue" tone={!queueVal ? "idle" : wip ? "ok" : counts.all ? "warn" : "ok"} title={queueVal ? "Dev task queue (devqueue.db): open = not Done" : queueWhy} v={queueVal} why={queueWhy} />
        <Row
          k="Active API keys"
          tone={keys.known === 0 ? "idle" : keys.warn ? "warn" : "ok"}
          title={`${keyTip}\n\nPresence only: names and counts, never values.${keys.warn ? "\nA connector's token was rejected (see MCP servers & APIs)." : ""}`}
          v={keys.known ? `${keys.active} active / ${keys.known} known` : null}
          why={ks.error ?? why}
        />
        <Row k="System" tone={sysTone} title={sysTip || why} v={sysParts.length ? sysParts.join(" · ") : null} why={h?.error ?? h?.gpuNote ?? why} />
      </div>
      <OsSwitches />
    </Panel>
  );
}

function Row({ k, v, why, tone, title, onClick }: { k: string; v: ReactNode | null; why: string; tone: Tone; title?: string; onClick?: () => void }) {
  const inner = (
    <>
      <span className="mt-[5px] flex">
        <Dot tone={tone} />
      </span>
      <span className="label-caps mt-px shrink-0 !text-[9.5px] text-ink-3">{k}</span>
      <span className="ml-auto min-w-0 text-right font-mono text-[10.5px] leading-tight text-ink tabular [overflow-wrap:anywhere]">{v == null || v === "" ? <Dash why={why} /> : v}</span>
    </>
  );
  const cls = "flex w-full min-w-0 items-start gap-2 rounded-[8px] border border-white/[0.05] bg-white/[0.02] px-2 py-1.5";
  return onClick ? (
    <button type="button" onClick={onClick} title={title} className={`${cls} text-left transition-colors hover:border-holo/40`}>
      {inner}
    </button>
  ) : (
    <div title={title} className={cls}>
      {inner}
    </div>
  );
}

// ── In-page switches (os.json) ──────────────────────────────────────────────

function OsSwitches() {
  const { cfg, error, saving, save } = useOsCfg();
  const desktop = isTauri();
  const offline = !desktop ? "Needs the desktop app (os.json lives in Rust)" : !cfg ? (error ?? "Loading os.json…") : null;

  const [blocked, setBlocked] = useState<string | null>(null);

  // os.json can change outside this page (the phone's compute-mode command goes straight to
  // Rust): refresh on mount and on window focus so the switches show the live state.
  useEffect(() => {
    if (!isTauri()) return;
    void useOs.getState().load();
    const onFocus = () => void useOs.getState().load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  /** Re-read os.json right before writing and refuse a toggle the live config no longer allows. */
  const guarded = (kind: "delegation" | "overload", write: () => void) => async () => {
    const fresh = await cmd("os_config_get").catch(() => null);
    if (fresh) useOs.setState({ cfg: fresh });
    const why = osSwitchBlock(kind, fresh);
    setBlocked(why);
    if (!why) write();
  };

  const delegation = cfg?.permissions.delegation;
  const mode = cfg?.compute.mode;
  const vram = cfg?.compute.vramThresholdPct;

  return (
    <div className="mt-3 space-y-2 border-t border-holo/10 pt-2.5">
      <Switch
        label="User delegation"
        on={delegation === "allow"}
        locked={delegation === "deny"}
        disabled={!!offline || saving || delegation === "deny"}
        onChange={(v) => void guarded("delegation", () => save({ permissions: { delegation: v ? "allow" : "ask" } }))()}
        state={offline ? null : delegation === "deny" ? "deny · locked" : delegation === "allow" ? "allow" : "ask first"}
        hint={
          delegation === "deny"
            ? "Delegation is set to deny: sub-agents never run. Change it in Settings → OS → Permissions."
            : "On: Tony hands work to sub-agents without asking. Off: he asks before each delegation."
        }
        why={offline}
      />
      <Switch
        label="Overload cap"
        on={mode === "hybrid"}
        disabled={!!offline || saving || mode === "cloud"}
        onChange={(v) => void guarded("overload", () => save({ compute: { mode: v ? "hybrid" : "local" } }))()}
        state={offline ? null : mode === "cloud" ? "cloud · locked" : mode === "hybrid" ? "hybrid" : "local only"}
        hint={
          mode === "cloud"
            ? "Compute mode is cloud: everything already runs off this machine. Change it in Settings → OS."
            : `On (hybrid): offload to the cloud when VRAM ≥ ${vram != null ? `${vram}%` : "the threshold"} or the context is heavy. Off: stay local.`
        }
        why={offline}
        extra={vram != null && <span className="font-mono text-[9.5px] text-ink-3" title="VRAM threshold (read-only here; edit it in Settings → OS)">VRAM ≥ {vram}%</span>}
      />
      {desktop && blocked && <p className="rounded-[8px] border border-ember/30 bg-ember/10 px-2 py-1 font-mono text-[10px] text-ember">{blocked}</p>}
      {desktop && cfg && error && <p className="rounded-[8px] border border-alert/30 bg-alert/10 px-2 py-1 font-mono text-[10px] text-alert">{error}</p>}
    </div>
  );
}

function Switch({
  label,
  on,
  onChange,
  disabled,
  locked,
  state,
  hint,
  why,
  extra,
}: {
  label: string;
  on: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  locked?: boolean;
  state: string | null;
  hint: string;
  why: string | null;
  extra?: ReactNode;
}) {
  return (
    <div className={`flex items-start gap-2.5 ${disabled ? "opacity-60" : ""}`} title={why ?? hint}>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!on)}
        className={`relative mt-0.5 h-[18px] w-8 shrink-0 rounded-full border transition-colors disabled:cursor-not-allowed ${on ? "border-holo/60 bg-holo/25 shadow-[0_0_10px_-2px_rgba(0,210,255,0.6)]" : "border-white/15 bg-white/[0.06]"}`}
      >
        <span className={`absolute top-[2px] grid size-3 place-items-center rounded-full transition-[left] duration-200 ${on ? "left-[16px] bg-holo" : "left-[2px] bg-ink-3"}`}>{locked && <Lock size={7} className="text-[#06080c]" />}</span>
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="label-caps !text-[9.5px] text-ink-2">{label}</span>
          <span className={`ml-auto font-mono text-[10px] ${locked ? "text-alert" : on ? "text-holo" : "text-ember"}`}>{state ?? <Dash why={why ?? "Unavailable"} />}</span>
        </div>
        <p className="mt-0.5 text-[10.5px] leading-snug text-ink-3">{hint}</p>
        {extra}
      </div>
    </div>
  );
}
