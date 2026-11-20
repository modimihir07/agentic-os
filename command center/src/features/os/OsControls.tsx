import { Cloud, Cpu, Layers, ShieldAlert, ShieldCheck, ShieldOff } from "lucide-react";
import type { ComputeMode } from "@/lib/platform";
import { useNav } from "@/stores/nav";
import { useSettings } from "@/stores/settings";
import { useOs } from "./os-store";

const MODES: { id: ComputeMode; label: string; short: string; icon: typeof Cpu; hint: string }[] = [
  { id: "local", label: "Local only", short: "LOCAL", icon: Cpu, hint: "Air-gapped inference: LM Studio + local AnythingLLM only. Every cloud call is blocked." },
  { id: "hybrid", label: "Hybrid auto-overflow", short: "HYBRID", icon: Layers, hint: "Local first; a turn moves to the droplet / cloud when VRAM is over the threshold or the prompt is huge." },
  { id: "cloud", label: "Cloud / droplet priority", short: "CLOUD", icon: Cloud, hint: "Remote first, keeping the RTX 3060 free; local stays as the fallback." },
];

/** LOCAL · HYBRID · CLOUD — one click (top bar + Services). */
export function ComputeModeSwitch({ compact = false }: { compact?: boolean }) {
  const cfg = useOs((s) => s.cfg);
  const patch = useOs((s) => s.patch);
  if (!cfg) return null;
  return (
    <div role="radiogroup" aria-label="Compute mode" className={`glass-thin flex h-11 items-center gap-0.5 rounded-full p-1 ${compact ? "" : "w-fit"}`}>
      {MODES.map((m) => {
        const on = cfg.compute.mode === m.id;
        const Icon = m.icon;
        return (
          <button
            key={m.id}
            role="radio"
            aria-checked={on}
            title={`${m.label} — ${m.hint}`}
            onClick={() => !on && void patch({ compute: { mode: m.id } })}
            className={`flex h-9 items-center gap-1.5 rounded-full px-3 font-mono text-[11px] font-semibold tracking-wider transition-colors ${
              on ? (m.id === "local" ? "bg-teal/20 text-teal" : m.id === "cloud" ? "bg-volt/15 text-volt" : "bg-amber/20 text-amber-light") : "text-ink-3 hover:text-ink"
            }`}
          >
            <Icon size={13} />
            {compact ? m.short : m.label}
          </button>
        );
      })}
    </div>
  );
}

/** Instant local lockdown: severs cloud, verifier, overseer, droplet and ElevenLabs traffic. */
export function KillSwitch() {
  const cfg = useOs((s) => s.cfg);
  const patch = useOs((s) => s.patch);
  if (!cfg) return null;
  const on = cfg.privacy.killSwitch;
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={() => void patch({ privacy: { killSwitch: !on } })}
      title={on ? "Kill switch ON — everything stays on 127.0.0.1. Click to restore cloud routing." : "Outbound cloud kill switch — click for instant local lockdown"}
      className={`flex h-11 items-center gap-2 rounded-full px-3.5 transition-colors ${on ? "bg-alert/90 text-white shadow-[0_0_18px_rgba(255,77,77,0.55)]" : "glass-thin text-ink-2 hover:text-ink"}`}
    >
      {on ? <ShieldOff size={15} /> : <ShieldAlert size={15} />}
      <span className="label-caps hidden xl:inline">{on ? "Lockdown" : "Kill switch"}</span>
    </button>
  );
}

/** Privacy shield status; click → Settings → Integrations. */
export function PrivacyPill() {
  const cfg = useOs((s) => s.cfg);
  if (!cfg) return null;
  const p = cfg.privacy;
  const full = p.diffuser && p.networkLock && p.destructiveGate;
  const tone = p.killSwitch ? "text-alert" : full ? "text-teal" : "text-amber-soft";
  const label = p.killSwitch ? "Local lockdown" : full ? "Shield on" : "Shield partial";
  return (
    <button
      onClick={() => {
        try {
          sessionStorage.setItem("cc.settings.tab", "integrations");
        } catch {
          /* private mode */
        }
        useNav.getState().go("settings");
      }}
      title={`Diffuser ${p.diffuser ? "on" : "off"} · network lock ${p.networkLock ? "on" : "off"} · destructive gate ${p.destructiveGate ? "on" : "off"}`}
      className={`glass-thin flex h-11 items-center gap-2 rounded-full px-3.5 ${tone}`}
    >
      <ShieldCheck size={15} />
      <span className="label-caps hidden 2xl:inline">{label}</span>
    </button>
  );
}

/** 0–100 % opacity for every ultra-glass panel (0–5 % = crystal-clear floating HUD). */
export function GlassOpacitySlider({ className = "" }: { className?: string }) {
  const v = useSettings((s) => s.glassOpacity);
  const set = useSettings((s) => s.set);
  return (
    <label className={`pill-glass !h-9 shrink-0 gap-2 !px-3 text-[13px] ${className}`} title="Ultra-glass opacity — 0–5 % is a crystal-clear HUD over the wallpaper">
      <span className="label-caps text-ink-3">Opacity</span>
      <input type="range" min={0} max={100} step={1} value={v} onChange={(e) => set({ glassOpacity: Number(e.target.value) })} className="w-24 accent-teal" aria-label="Ultra-glass opacity" />
      <span className="w-9 text-right font-mono text-[11px] text-ink-2">{v}%</span>
    </label>
  );
}

// ── Phase 2 status pills ────────────────────────────────────────────────────

import { useEffect as useEffect2, useState as useState2 } from "react";
import { cmd as cmd2, isTauri as isTauri2, onNativeEvent as onNativeEvent2, type DropletLink, type SlotView } from "@/lib/platform";
import { useCueRun } from "@/features/cues/player";
import { toggleGabagool } from "@/features/cues/cue-runtime";

/** "ACTIVE GPU SLOT" — who holds the local GPU baton, and what's queued. */
export function ActiveSlotPill() {
  const [v, setV] = useState2<SlotView | null>(null);
  useEffect2(() => {
    if (!isTauri2()) return;
    void cmd2("gpu_slot_view").then(setV).catch(() => undefined);
    let off: (() => void) | undefined;
    void onNativeEvent2<SlotView>("gpu-slot", setV).then((u) => (off = u));
    return () => off?.();
  }, []);
  if (!v) return null;
  const busy = v.active.length > 0;
  const queued = v.queuedForeground + v.queuedBackground;
  return (
    <span
      className={`glass-thin flex h-11 items-center gap-2 rounded-full px-3.5 font-mono text-[10px] tracking-wider ${busy ? "text-amber-light" : "text-ink-3"}`}
      title={busy ? `GPU: ${v.active.join(", ")}${queued ? ` · queued: ${v.queuedForeground} Tony, ${v.queuedBackground} background` : ""}` : `GPU idle · ${v.capacity} slot${v.capacity === 1 ? "" : "s"}`}
    >
      <span className={`size-2 rounded-full ${busy ? "animate-pulse bg-amber" : "bg-teal/70"}`} />
      <span className="hidden xl:inline">{busy ? `GPU · ${v.active[0].split(" · ").pop()?.toUpperCase()}` : "GPU IDLE"}</span>
      {queued > 0 && <span className="rounded-full bg-white/10 px-1.5">+{queued}</span>}
    </span>
  );
}

/** "DROPLET: CONNECTED" — fed by the auto-reconnect manager. */
export function DropletBadge() {
  const [d, setD] = useState2<DropletLink | null>(null);
  useEffect2(() => {
    if (!isTauri2()) return;
    void cmd2("droplet_link").then(setD).catch(() => undefined);
    let off: (() => void) | undefined;
    void onNativeEvent2<DropletLink>("droplet-status", setD).then((u) => (off = u));
    return () => off?.();
  }, []);
  if (!d || d.state === "disabled") return null;
  const tone = d.state === "connected" ? "text-teal" : d.state === "offline" ? "text-alert" : "text-amber-soft";
  return (
    <span className={`glass-thin hidden h-11 items-center gap-1.5 rounded-full px-3.5 font-mono text-[10px] tracking-wider lg:flex ${tone}`} title={`${d.detail}${d.latencyMs ? ` · ${d.latencyMs}ms` : ""}`}>
      <Cloud size={13} /> DROPLET: {d.state.toUpperCase()}
    </span>
  );
}

/** 🍝 GABAGOOL MODE — starts the Gabagool cue; tap again to stop. */
export function GabagoolPill() {
  const running = useCueRun((s) => s.running);
  return (
    <button
      onClick={toggleGabagool}
      aria-pressed={!!running}
      title={running ? `Stop “${running}”` : "Enter Gabagool Mode"}
      className={`flex h-11 items-center gap-1.5 rounded-full px-3.5 font-mono text-[10px] font-semibold tracking-wider transition-colors ${running ? "bg-amber/90 text-canvas glow-amber" : "glass-thin text-ink-2 hover:text-ink"}`}
    >
      🍝 <span className="hidden 2xl:inline">{running ? "GABAGOOL ON" : "GABAGOOL MODE"}</span>
    </button>
  );
}
