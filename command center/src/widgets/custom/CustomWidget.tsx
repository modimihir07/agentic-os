import { useEffect, useState } from "react";
import type { WidgetProps } from "@/core/widgets/types";
import { WidgetHeader, Empty } from "@/components/WidgetHeader";
import { useCollection, useNow } from "@/lib/cc-api";
import { cmd, isTauri } from "@/lib/platform";
import { countdown } from "@/features/reminders/when";
import type { CustomSpec } from "./spec";

export default function CustomWidget({ config }: WidgetProps<{ spec: CustomSpec | null }>) {
  const spec = config.spec;
  if (!spec) return <Empty>This widget has no definition. Remove it and use Widgets → Generate.</Empty>;
  switch (spec.kind) {
    case "list":
      return <ListView spec={spec} />;
    case "stat":
      return <StatView spec={spec} />;
    case "countdown":
      return <CountdownView spec={spec} />;
    case "note":
      return (
        <div>
          <WidgetHeader title={spec.title} />
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">{spec.text}</p>
        </div>
      );
    case "workflow":
      return <WorkflowView spec={spec} />;
  }
}

const matches = (it: Record<string, unknown>, f?: { field: string; equals: unknown }) => !f || String(it[f.field]) === String(f.equals);
const fmt = (v: unknown) => {
  if (typeof v === "number" && v > 1e11) return new Date(v).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  if (Array.isArray(v)) return v.join(", ");
  return v == null ? "" : String(v);
};

function ListView({ spec }: { spec: Extract<CustomSpec, { kind: "list" }> }) {
  const { items, error } = useCollection<Record<string, unknown>>(spec.collection);
  let rows = items.filter((i) => matches(i, spec.filter));
  if (spec.sort === "oldest") rows = [...rows].reverse();
  if (spec.sort === "date-asc" && spec.dateField) rows = [...rows].sort((a, b) => Number(a[spec.dateField!] ?? Infinity) - Number(b[spec.dateField!] ?? Infinity));
  return (
    <div className="flex h-full flex-col">
      <WidgetHeader title={spec.title} status={<span className="label-caps text-ink-3">{rows.length}</span>} />
      {error && <p className="text-[11px] text-alert">{error}</p>}
      <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto">
        {rows.slice(0, spec.limit).map((r) => (
          <li key={r.id} className="flex items-center gap-2 rounded-[10px] border border-white/[0.06] px-2.5 py-1.5 text-[13px]">
            <span className="min-w-0 flex-1 truncate text-ink">{fmt(r[spec.titleField]) || "—"}</span>
            {spec.subtitleField && <span className="truncate text-[11px] text-ink-3">{fmt(r[spec.subtitleField])}</span>}
            {spec.dateField && <span className="shrink-0 font-mono text-[11px] text-ink-2">{fmt(r[spec.dateField])}</span>}
          </li>
        ))}
        {!rows.length && <li className="py-3 text-center text-xs text-ink-3">Nothing matches yet.</li>}
      </ul>
    </div>
  );
}

function StatView({ spec }: { spec: Extract<CustomSpec, { kind: "stat" }> }) {
  const { items } = useCollection<Record<string, unknown>>(spec.collection);
  const rows = items.filter((i) => matches(i, spec.filter));
  const value = spec.op === "count" ? rows.length : rows.reduce((s, r) => s + (Number(r[spec.field!]) || 0), 0);
  return (
    <div className="flex h-full flex-col">
      <WidgetHeader title={spec.title} />
      <p className="my-auto font-mono text-4xl font-semibold text-amber-light tabular">
        {spec.prefix}
        {spec.op === "sum" ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : value}
        {spec.suffix && <span className="ml-1 text-base text-ink-3">{spec.suffix}</span>}
      </p>
      <p className="font-mono text-[11px] text-ink-3">
        {spec.op} {spec.field ?? ""} · {spec.collection}
        {spec.filter ? ` where ${spec.filter.field} = ${spec.filter.equals}` : ""}
      </p>
    </div>
  );
}

function CountdownView({ spec }: { spec: Extract<CustomSpec, { kind: "countdown" }> }) {
  const now = useNow(1000);
  return (
    <div className="flex h-full flex-col">
      <WidgetHeader title={spec.title} />
      <p className="my-auto font-mono text-4xl font-semibold text-teal-soft tabular">{countdown(spec.dueAt, now)}</p>
      <p className="font-mono text-[11px] text-ink-3">{new Date(spec.dueAt).toLocaleString()}</p>
    </div>
  );
}

function WorkflowView({ spec }: { spec: Extract<CustomSpec, { kind: "workflow" }> }) {
  const [data, setData] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!isTauri()) return setError("Workflow widgets run on the desktop app.");
    const run = () =>
      cmd("n8n_fetch", { name: spec.workflow })
        .then((d) => {
          setData(d);
          setError(null);
        })
        .catch((e) => setError(String(e)));
    run();
    const t = setInterval(run, spec.refreshMin * 60_000);
    return () => clearInterval(t);
  }, [spec.workflow, spec.refreshMin]);
  const rows = Array.isArray(data) ? data : data && typeof data === "object" ? Object.entries(data as object) : [];
  return (
    <div className="flex h-full flex-col">
      <WidgetHeader title={spec.title} status={<span className="label-caps text-ink-3">n8n · {spec.workflow}</span>} />
      {error ? (
        <p className="text-[12px] text-alert">{error}</p>
      ) : (
        <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto font-mono text-[11px] text-ink-2">
          {rows.slice(0, 30).map((r, i) => (
            <li key={i} className="truncate rounded-[8px] border border-white/[0.05] px-2 py-1">
              {Array.isArray(r) ? `${r[0]}: ${fmt(r[1])}` : typeof r === "object" ? Object.values(r as object).slice(0, 3).map(fmt).join(" · ") : fmt(r)}
            </li>
          ))}
          {!rows.length && <li className="text-ink-3">{data == null ? "Loading…" : String(data)}</li>}
        </ul>
      )}
    </div>
  );
}
