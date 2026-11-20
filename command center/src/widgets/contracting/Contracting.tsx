import { useState } from "react";
import { FileText, Plus, Trash2, X } from "lucide-react";
import { WidgetHeader } from "@/components/WidgetHeader";
import { money, fromLocalInput } from "@/components/ui";
import { collections, useCollection, useNow } from "@/lib/cc-api";
import { useSettings } from "@/stores/settings";
import { useNav } from "@/stores/nav";
import { formatWhen } from "@/features/reminders/when";
import type { Invoice } from "@/features/finance/types";

export interface Project {
  client: string;
  job: string;
  estimate: number;
  status: "lead" | "estimating" | "bid-sent" | "won" | "in-progress" | "invoiced" | "paid" | "lost";
  followUpAt?: number;
  notes?: string;
}

const STATUSES: Project["status"][] = ["lead", "estimating", "bid-sent", "won", "in-progress", "invoiced", "paid", "lost"];

export default function Contracting() {
  const { items, create, update, remove } = useCollection<Project>("projects");
  const now = useNow(60_000);
  const [adding, setAdding] = useState(false);
  const currency = useSettings((s) => s.business.currency);
  const open = items.filter((p) => !["paid", "lost"].includes(p.status));
  const bidValue = items.filter((p) => p.status === "bid-sent").reduce((s, p) => s + (p.estimate || 0), 0);
  const wonValue = items.filter((p) => ["won", "in-progress"].includes(p.status)).reduce((s, p) => s + (p.estimate || 0), 0);
  const sorted = [...open].sort((a, b) => (a.followUpAt ?? Infinity) - (b.followUpAt ?? Infinity));

  return (
    <div className="flex h-full flex-col">
      <WidgetHeader
        title="Contracting"
        status={
          <button aria-label={adding ? "Cancel" : "Add job"} onClick={() => setAdding((a) => !a)} className="grid size-6 place-items-center rounded-full text-ink-2 hover:bg-white/10 hover:text-ink">
            {adding ? <X size={13} /> : <Plus size={13} />}
          </button>
        }
      />
      <div className="mb-2 grid grid-cols-2 gap-1.5 font-mono text-[11px]">
        <p className="rounded-[10px] border border-white/[0.06] px-2 py-1 text-ink-3">
          Bids out <span className="float-right text-amber-light tabular">{money(bidValue, currency)}</span>
        </p>
        <p className="rounded-[10px] border border-white/[0.06] px-2 py-1 text-ink-3">
          Won <span className="float-right text-teal-soft tabular">{money(wonValue, currency)}</span>
        </p>
      </div>
      {adding && <AddForm onAdd={(p) => void create(p).then(() => setAdding(false))} />}
      <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
        {sorted.map((p) => {
          const due = p.followUpAt && p.followUpAt <= now;
          return (
            <li key={p.id} className={`group rounded-[12px] border px-2.5 py-2 ${due ? "border-amber/50 bg-amber/[0.07]" : "border-white/[0.06] bg-white/[0.02]"}`}>
              <div className="flex items-center gap-2">
                <p className="min-w-0 flex-1 truncate text-[13px] text-ink">
                  {p.client} <span className="text-ink-3">· {p.job}</span>
                </p>
                <span className="shrink-0 font-mono text-[12px] text-ink tabular">{money(p.estimate, currency)}</span>
              </div>
              <div className="mt-1.5 flex items-center gap-1.5">
                <button
                  onClick={() => void update(p.id, { status: STATUSES[(STATUSES.indexOf(p.status) + 1) % STATUSES.length] })}
                  title="Advance status"
                  className="rounded-full border border-white/15 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-2 hover:text-ink"
                >
                  {p.status}
                </button>
                {p.followUpAt && <span className={`truncate text-[10.5px] ${due ? "text-amber-light" : "text-ink-3"}`}>follow up {formatWhen(p.followUpAt, now)}</span>}
                <div className="ml-auto flex opacity-100 md:opacity-0 md:group-hover:opacity-100">
                  {["won", "in-progress"].includes(p.status) && (
                    <button aria-label="Create invoice draft" title="Create invoice draft" onClick={() => void toInvoice(p)} className="grid size-6 place-items-center rounded-full text-ink-3 hover:text-teal">
                      <FileText size={11} />
                    </button>
                  )}
                  <button aria-label={`Delete ${p.job}`} onClick={() => void remove(p.id)} className="grid size-6 place-items-center rounded-full text-ink-3 hover:text-alert">
                    <Trash2 size={11} />
                  </button>
                </div>
              </div>
            </li>
          );
        })}
        {!sorted.length && <li className="py-4 text-center text-xs text-ink-3">No open jobs.</li>}
      </ul>
    </div>
  );
}

async function toInvoice(p: Project & { id: string }) {
  const { hstRate } = useSettings.getState().business;
  const n = collections.snapshot<Invoice>("invoices").length + 1;
  await collections.create<Invoice>("invoices", {
    number: `INV-${new Date().getFullYear()}-${String(n).padStart(3, "0")}`,
    client: p.client,
    items: [{ desc: p.job, qty: 1, rate: p.estimate }],
    taxRate: hstRate,
    issuedAt: Date.now(),
    dueAt: Date.now() + 30 * 86_400_000,
    status: "draft",
    projectId: p.id,
  });
  await collections.update<Project>("projects", p.id, { status: "invoiced" });
  useNav.getState().go("finance");
}

function AddForm({ onAdd }: { onAdd: (p: Project) => void }) {
  const [d, setD] = useState({ client: "", job: "", estimate: "", follow: "" });
  return (
    <form
      className="mb-2 grid grid-cols-2 gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!d.client.trim() || !d.job.trim()) return;
        const f = fromLocalInput(d.follow);
        onAdd({ client: d.client.trim(), job: d.job.trim(), estimate: Number(d.estimate) || 0, status: "estimating", followUpAt: Number.isNaN(f) ? undefined : f });
      }}
    >
      <input className="field !h-8 !py-1 text-[13px]" placeholder="Client" value={d.client} onChange={(e) => setD({ ...d, client: e.target.value })} autoFocus aria-label="Client" />
      <input className="field !h-8 !py-1 text-[13px]" placeholder="Job" value={d.job} onChange={(e) => setD({ ...d, job: e.target.value })} aria-label="Job" />
      <input className="field !h-8 !py-1 text-[13px]" inputMode="decimal" placeholder="Estimate $" value={d.estimate} onChange={(e) => setD({ ...d, estimate: e.target.value })} aria-label="Estimate" />
      <input type="datetime-local" className="field !h-8 !py-1 text-[12px]" value={d.follow} onChange={(e) => setD({ ...d, follow: e.target.value })} aria-label="Follow up" />
      <button className="pill-primary col-span-2 !h-8 text-xs">Add job</button>
    </form>
  );
}
