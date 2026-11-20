import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { DASH, type Tone } from "./format";

/**
 * System Map primitives: dark glass panels with a thin cyan edge, mono caps labels,
 * hairline bars. No backdrop-filter here — these panels sit over a WebGL canvas, and
 * stacked blur layers flicker in WebView2 (index.css flicker rules).
 */

export function Panel({ title, badge, action, children, className = "", bodyClassName = "" }: { title: ReactNode; badge?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={`flex min-h-0 flex-col rounded-[14px] border border-holo/20 bg-[rgba(7,11,17,0.82)] shadow-[0_0_24px_-12px_rgba(0,210,255,0.35),inset_0_1px_0_rgba(0,210,255,0.06)] ${className}`}>
      <header className="flex min-h-9 items-center gap-2 border-b border-holo/10 px-3 py-2">
        <h2 className="label-caps truncate text-holo">{title}</h2>
        {badge}
        {action && <div className="ml-auto flex shrink-0 items-center gap-1.5">{action}</div>}
      </header>
      <div className={`min-h-0 flex-1 p-3 ${bodyClassName}`}>{children}</div>
    </section>
  );
}

/** "—" for a value with no live source, with the reason as its tooltip. */
export function Dash({ why }: { why: string }) {
  return (
    <span title={why} aria-label={`unavailable: ${why}`} className="cursor-help text-ink-3">
      {DASH}
    </span>
  );
}

/** `value` when present, else a Dash explaining `why`. */
export function Val({ value, why, className = "" }: { value: ReactNode | null | undefined; why: string; className?: string }) {
  if (value == null || value === "") return <Dash why={why} />;
  return <span className={className}>{value}</span>;
}

const TAG: Record<Tone, string> = {
  ok: "border-teal/40 bg-teal/10 text-teal-soft",
  warn: "border-ember/40 bg-ember/10 text-ember",
  down: "border-alert/40 bg-alert/10 text-alert",
  idle: "border-ember/30 bg-ember/[0.06] text-ember/80",
};

export function Tag({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`label-caps inline-flex h-[18px] shrink-0 items-center rounded-full border px-1.5 !text-[9px] ${TAG[tone]}`}>
      {children}
    </span>
  );
}

const DOT: Record<Tone, string> = {
  ok: "bg-teal shadow-[0_0_6px_#00e5c3]",
  warn: "bg-ember shadow-[0_0_6px_#f59e0b]",
  down: "bg-alert shadow-[0_0_6px_#ff5a5f]",
  idle: "bg-ink-3",
};

export function Dot({ tone, title }: { tone: Tone; title?: string }) {
  return <span title={title} className={`inline-block size-1.5 shrink-0 rounded-full ${DOT[tone]}`} />;
}

/** Hairline telemetry bar. `value` null = no source (empty track, Dash tooltip on hover). */
export function Bar({ value, tone = "holo", why }: { value: number | null; tone?: "holo" | "ember" | "alert" | "teal"; why?: string }) {
  const fill = { holo: "bg-holo shadow-[0_0_6px_#00d2ff]", ember: "bg-ember shadow-[0_0_6px_#f59e0b]", alert: "bg-alert", teal: "bg-teal" }[tone];
  const v = value == null ? null : Math.max(0, Math.min(100, value));
  return (
    <div
      className="h-[3px] w-full overflow-hidden rounded-full bg-white/[0.06]"
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={v == null ? undefined : Math.round(v)}
      title={v == null ? why : undefined}
    >
      {v != null && <div className={`h-full rounded-full transition-[width] duration-700 ease-out ${fill}`} style={{ width: `${v}%` }} />}
    </div>
  );
}

/** A tone for a 0–100 load (ember from 75 %, alert from 92 %). */
export const loadTone = (v: number | null): "holo" | "ember" | "alert" => (v == null || v < 75 ? "holo" : v < 92 ? "ember" : "alert");

/** A clock that ticks every `ms` while the window is visible (for "12s ago" and uptime). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => {
      if (!document.hidden) setNow(Date.now());
    };
    const id = setInterval(tick, ms);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [ms]);
  return now;
}

/** Open Settings → Integrations (where the MCP registry, Gmail, Spotify and Brave cards live). */
export function openSettings(go: (s: "settings") => void, tab: "integrations" | "services" | "voice" = "integrations") {
  try {
    sessionStorage.setItem("cc.settings.tab", tab);
  } catch {
    /* private mode */
  }
  go("settings");
}
