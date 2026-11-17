import type { ReactNode, SelectHTMLAttributes, InputHTMLAttributes } from "react";

/** Small shared form/data primitives so new tabs and widgets look like one system. */

export function Field({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={`block space-y-1.5 ${className}`}>
      <span className="label-caps text-ink-3">{label}</span>
      {children}
    </label>
  );
}

export function Select({ className = "", children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={`field appearance-none bg-[length:12px] bg-[right_12px_center] bg-no-repeat pr-8 ${className}`} style={{ backgroundImage: CHEVRON }}>
      {children}
    </select>
  );
}

const CHEVRON = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2 4l4 4 4-4' fill='none' stroke='%23A1A8B8' stroke-width='1.5'/%3E%3C/svg%3E")`;

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`field ${props.className ?? ""}`} />;
}

export function Card({ title, hint, action, children, className = "" }: { title?: string; hint?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`glass rounded-[20px] p-5 ${className}`}>
      {(title || action) && (
        <div className="mb-1 flex items-center gap-2">
          {title && <h2 className="label-caps text-amber-soft">{title}</h2>}
          {action && <div className="ml-auto flex items-center gap-2">{action}</div>}
        </div>
      )}
      {hint && <p className="mb-3 text-xs leading-relaxed text-ink-3">{hint}</p>}
      <div className={title && !hint ? "mt-3" : ""}>{children}</div>
    </section>
  );
}

export function Chip({ active, onClick, children, tone = "amber" }: { active?: boolean; onClick?: () => void; children: ReactNode; tone?: "amber" | "teal" }) {
  const on = tone === "amber" ? "border-amber/60 bg-amber/15 text-ink" : "border-teal/60 bg-teal/15 text-ink";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`h-8 shrink-0 rounded-full border px-3 text-[12px] transition-colors ${active ? on : "border-white/10 bg-[rgba(11,13,17,0.45)] text-ink-2 hover:text-ink"}`}
    >
      {children}
    </button>
  );
}

export function Stat({ label, value, sub, tone = "ink" }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "ink" | "teal" | "amber" | "alert" }) {
  const color = { ink: "text-ink", teal: "text-teal-soft", amber: "text-amber-light", alert: "text-alert" }[tone];
  return (
    <div className="min-w-0 rounded-[14px] border border-white/[0.06] bg-white/[0.02] p-3">
      <p className="label-caps truncate text-ink-3">{label}</p>
      <p className={`mt-1 truncate font-mono text-xl font-semibold tabular ${color}`}>{value}</p>
      {sub && <p className="mt-0.5 truncate text-[11px] text-ink-3">{sub}</p>}
    </div>
  );
}

export function SubTabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div role="tablist" className="well flex w-fit max-w-full gap-0.5 overflow-x-auto rounded-full p-1 [scrollbar-width:none]">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={`shrink-0 rounded-full px-3.5 py-1.5 text-[13px] transition-colors ${value === t.id ? "border border-white/10 bg-raised text-ink" : "text-ink-2 hover:text-ink"}`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-ink-3">{children}</p>;
}

export const money = (n: number | null | undefined, currency = "CAD") =>
  n == null || Number.isNaN(n) ? "—" : n.toLocaleString(undefined, { style: "currency", currency, maximumFractionDigits: 2 });

export const toLocalInput = (ms: number) => {
  const d = new Date(ms);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

export const fromLocalInput = (s: string) => (s ? new Date(s).getTime() : NaN);

/** Download text as a file (CSV exports). */
export function downloadText(name: string, text: string, mime = "text/csv") {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function toCsv(rows: Record<string, unknown>[], cols: { key: string; label: string }[]): string {
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.map((c) => esc(c.label)).join(","), ...rows.map((r) => cols.map((c) => esc(r[c.key])).join(","))].join("\n");
}
