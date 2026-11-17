import type { ReactNode } from "react";

export function WidgetHeader({ title, status, children }: { title: string; status?: ReactNode; children?: ReactNode }) {
  return (
    <header className="mb-3 flex items-center gap-2">
      <h2 className="label-caps text-ink-2">{title}</h2>
      {status && <div className="ml-auto flex items-center gap-1.5">{status}</div>}
      {children}
    </header>
  );
}

export function StatusDot({ tone, label }: { tone: "ok" | "warn" | "down" | "idle"; label: string }) {
  const color = { ok: "bg-teal shadow-[0_0_8px_#00e5c3]", warn: "bg-amber shadow-[0_0_8px_#ff7a2f]", down: "bg-alert", idle: "bg-ink-3" }[tone];
  return (
    <span className="label-caps flex items-center gap-1.5 text-ink-2">
      <span className={`size-1.5 rounded-full ${color}`} />
      {label}
    </span>
  );
}

/** Telemetry bar: recessed track + glowing fill with a white apex pip. */
export function Meter({ value, tone = "teal" }: { value: number; tone?: "teal" | "amber" | "alert" }) {
  const pct = Math.max(0, Math.min(100, value));
  const fill = { teal: "from-teal to-teal-light", amber: "from-amber to-amber-light", alert: "from-alert to-amber" }[tone];
  return (
    <div className="well relative h-1.5 w-full overflow-hidden rounded-full" role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className={`h-full rounded-full bg-gradient-to-r ${fill} transition-[width] duration-700 ease-out`} style={{ width: `${pct}%` }} />
      <span className="absolute top-1/2 size-1 -translate-y-1/2 rounded-full bg-white shadow-[0_0_6px_#fff]" style={{ left: `calc(${pct}% - 3px)` }} />
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm leading-relaxed text-ink-3">{children}</p>;
}
