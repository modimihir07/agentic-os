import { useState } from "react";
import { Image as ImageIcon, PiggyBank, Plus, Trash2 } from "lucide-react";
import { Card, Input, Select, money } from "@/components/ui";
import { cc, collections, useCollection, type Item } from "@/lib/cc-api";
import type { Check, Goal, Income } from "@/features/finance/types";
import type { Reminder } from "@/features/reminders/types";
import { useToasts } from "@/features/reminders/notify";
import { useSettings } from "@/stores/settings";

// ── Cheques ──────────────────────────────────────────────────────────────────

export function ChequesPanel() {
  const { items, update, remove, create } = useCollection<Check>("checks");
  const currency = useSettings((s) => s.business.currency);
  const [d, setD] = useState({ payer: "", amount: "", date: new Date().toISOString().slice(0, 10), chequeNumber: "" });
  const pending = items.filter((c) => !c.deposited);
  return (
    <Card title="Cheque vault" hint={`${pending.length} to deposit · ${money(pending.reduce((s, c) => s + c.amount, 0), currency)}. Scan a cheque in the Scan tab to attach its photo.`}>
      <form
        className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-[1.4fr_1fr_1fr_1fr_auto]"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!d.payer || !d.amount) return;
          await create({ payer: d.payer, amount: Number(d.amount), receivedAt: Date.parse(d.date + "T12:00:00"), chequeNumber: d.chequeNumber || undefined, deposited: false });
          setD({ ...d, payer: "", amount: "", chequeNumber: "" });
        }}
      >
        <Input value={d.payer} onChange={(e) => setD({ ...d, payer: e.target.value })} placeholder="Payer" className="!h-9 !py-1 text-[13px]" aria-label="Payer" />
        <Input inputMode="decimal" value={d.amount} onChange={(e) => setD({ ...d, amount: e.target.value })} placeholder="Amount" className="!h-9 !py-1 font-mono text-[13px]" aria-label="Amount" />
        <Input type="date" value={d.date} onChange={(e) => setD({ ...d, date: e.target.value })} className="!h-9 !py-1 text-[13px]" aria-label="Received" />
        <Input value={d.chequeNumber} onChange={(e) => setD({ ...d, chequeNumber: e.target.value })} placeholder="Cheque #" className="!h-9 !py-1 font-mono text-[13px]" aria-label="Cheque number" />
        <button className="pill-primary !h-9 text-xs">
          <Plus size={13} /> Log
        </button>
      </form>
      <ul className="space-y-1.5">
        {items.map((c) => (
          <li key={c.id} className="group flex flex-wrap items-center gap-3 rounded-[12px] border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-sm">
            <span className="font-mono text-[12px] text-ink-3">{new Date(c.receivedAt).toLocaleDateString()}</span>
            <span className="min-w-0 flex-1 truncate text-ink">{c.payer}</span>
            {c.chequeNumber && <span className="font-mono text-[11px] text-ink-3">#{c.chequeNumber}</span>}
            <span className="font-mono text-ink tabular">{money(c.amount, currency)}</span>
            <label className="flex items-center gap-1.5 text-xs text-ink-2">
              <input
                type="checkbox"
                checked={c.deposited}
                onChange={(e) => void update(c.id, { deposited: e.target.checked, depositedAt: e.target.checked ? Date.now() : undefined })}
                className="accent-teal"
              />
              deposited
            </label>
            {c.imageFileId && (
              <a href={cc.fileUrl(c.imageFileId)} target="_blank" rel="noreferrer" aria-label="View cheque scan" className="text-ink-3 hover:text-teal">
                <ImageIcon size={14} />
              </a>
            )}
            <button aria-label={`Delete cheque from ${c.payer}`} onClick={() => void remove(c.id)} className="text-ink-3 opacity-100 hover:text-alert md:opacity-0 md:group-hover:opacity-100">
              <Trash2 size={13} />
            </button>
          </li>
        ))}
        {!items.length && <li className="py-6 text-center text-sm text-ink-3">No cheques logged.</li>}
      </ul>
    </Card>
  );
}

// ── Income ───────────────────────────────────────────────────────────────────

export function IncomePanel() {
  const { items, create, remove } = useCollection<Income>("income");
  const goals = useCollection<Goal>("goals").items;
  const { currency, hstRate } = useSettings((s) => s.business);
  const [d, setD] = useState({ date: new Date().toISOString().slice(0, 10), client: "", description: "", amount: "", tax: "", method: "e-transfer" as Income["method"] });
  const ytd = items.filter((i) => i.date.startsWith(String(new Date().getFullYear())));

  const add = async () => {
    const amount = Number(d.amount);
    if (!d.client || !amount) return;
    const taxCollected = d.tax === "" ? Math.round(amount * hstRate) / 100 : Number(d.tax);
    await create({ date: d.date, client: d.client, description: d.description, amount, taxCollected, method: d.method });
    setD({ ...d, client: "", description: "", amount: "", tax: "" });
    suggestAllocations(amount, goals);
  };

  return (
    <Card title="Income" hint={`YTD ${money(ytd.reduce((s, i) => s + i.amount, 0), currency)} · tax collected ${money(ytd.reduce((s, i) => s + i.taxCollected, 0), currency)}. Logging income suggests your savings set-asides.`}>
      <form
        className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-[1fr_1.2fr_1.4fr_1fr_0.8fr_1fr_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <Input type="date" value={d.date} onChange={(e) => setD({ ...d, date: e.target.value })} className="!h-9 !py-1 text-[13px]" aria-label="Date" />
        <Input value={d.client} onChange={(e) => setD({ ...d, client: e.target.value })} placeholder="Client" className="!h-9 !py-1 text-[13px]" aria-label="Client" />
        <Input value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} placeholder="What for" className="!h-9 !py-1 text-[13px]" aria-label="Description" />
        <Input inputMode="decimal" value={d.amount} onChange={(e) => setD({ ...d, amount: e.target.value })} placeholder="Amount (pre-tax)" className="!h-9 !py-1 font-mono text-[13px]" aria-label="Amount" />
        <Input inputMode="decimal" value={d.tax} onChange={(e) => setD({ ...d, tax: e.target.value })} placeholder={`Tax (${hstRate}%)`} className="!h-9 !py-1 font-mono text-[13px]" aria-label="Tax collected" />
        <Select value={d.method} onChange={(e) => setD({ ...d, method: e.target.value as Income["method"] })} className="!h-9 !py-1 text-[13px]" aria-label="Method">
          {["e-transfer", "cheque", "cash", "card", "other"].map((m) => (
            <option key={m}>{m}</option>
          ))}
        </Select>
        <button className="pill-primary !h-9 text-xs">
          <Plus size={13} /> Add
        </button>
      </form>
      <ul className="space-y-1.5">
        {[...items].sort((a, b) => b.date.localeCompare(a.date)).map((i) => (
          <li key={i.id} className="group flex flex-wrap items-center gap-3 rounded-[12px] border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-sm">
            <span className="font-mono text-[12px] text-ink-3">{i.date}</span>
            <span className="min-w-0 flex-1 truncate text-ink">
              {i.client} <span className="text-ink-3">· {i.description}</span>
            </span>
            <span className="font-mono text-[11px] text-ink-3">+{money(i.taxCollected, currency)} tax</span>
            <span className="font-mono text-teal-soft tabular">{money(i.amount, currency)}</span>
            <button aria-label="Delete income entry" onClick={() => void remove(i.id)} className="text-ink-3 opacity-100 hover:text-alert md:opacity-0 md:group-hover:opacity-100">
              <Trash2 size={13} />
            </button>
          </li>
        ))}
        {!items.length && <li className="py-6 text-center text-sm text-ink-3">No income logged yet.</li>}
      </ul>
    </Card>
  );
}

/** "You were paid $X → set aside $Y for Taxes (25%) …" with one-tap apply. */
function suggestAllocations(amount: number, goals: Item<Goal>[]) {
  const alloc = goals.filter((g) => g.percentOfIncome > 0).map((g) => ({ g, amt: Math.round(amount * g.percentOfIncome) / 100 }));
  if (!alloc.length) return;
  const currency = useSettings.getState().business.currency;
  const toasts = useToasts.getState();
  const id = toasts.push({
    title: "Set aside from this income",
    body: alloc.map((a) => `${a.g.name}: ${money(a.amt, currency)} (${a.g.percentOfIncome}%)`).join(" · "),
    tone: "info",
    actions: [
      {
        label: "Mark as transferred",
        run: () => {
          for (const a of alloc) void collections.update<Goal>("goals", a.g.id, { saved: Math.round((a.g.saved + a.amt) * 100) / 100 });
          toasts.dismiss(id);
        },
      },
    ],
  });
}

// ── Savings goals ────────────────────────────────────────────────────────────

const COLORS = ["#00E5C3", "#FF7A2F", "#A855F7", "#00F0FF", "#FFB36B"];

export function GoalsPanel() {
  const { items, create, update, remove } = useCollection<Goal>("goals");
  const currency = useSettings((s) => s.business.currency);
  const [d, setD] = useState({ name: "", target: "", percent: "", monthly: "", day: "1" });

  const add = async () => {
    if (!d.name || !d.target) return;
    const goal: Goal = {
      name: d.name,
      target: Number(d.target),
      saved: 0,
      percentOfIncome: Number(d.percent) || 0,
      monthlyAmount: Number(d.monthly) || 0,
      reminderDay: Math.min(28, Math.max(0, Number(d.day) || 0)),
      color: COLORS[items.length % COLORS.length],
    };
    await create(goal);
    if (goal.reminderDay && goal.monthlyAmount) await scheduleTransferReminder(goal);
    setD({ name: "", target: "", percent: "", monthly: "", day: "1" });
  };

  return (
    <Card title="Savings goals" hint="Structure your savings by % of income (e.g. 25% for tax, 10% for gear) and/or a fixed monthly amount with a reminder on the day you choose.">
      <form
        className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-[1.4fr_1fr_0.8fr_1fr_0.7fr_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <Input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="Goal (Tax reserve, E46 build…)" className="!h-9 !py-1 text-[13px]" aria-label="Goal name" />
        <Input inputMode="decimal" value={d.target} onChange={(e) => setD({ ...d, target: e.target.value })} placeholder="Target $" className="!h-9 !py-1 font-mono text-[13px]" aria-label="Target" />
        <Input inputMode="decimal" value={d.percent} onChange={(e) => setD({ ...d, percent: e.target.value })} placeholder="% income" className="!h-9 !py-1 font-mono text-[13px]" aria-label="Percent of income" />
        <Input inputMode="decimal" value={d.monthly} onChange={(e) => setD({ ...d, monthly: e.target.value })} placeholder="$ / month" className="!h-9 !py-1 font-mono text-[13px]" aria-label="Monthly amount" />
        <Input inputMode="numeric" value={d.day} onChange={(e) => setD({ ...d, day: e.target.value })} placeholder="Day" className="!h-9 !py-1 font-mono text-[13px]" aria-label="Reminder day of month" />
        <button className="pill-primary !h-9 text-xs">
          <Plus size={13} /> Goal
        </button>
      </form>
      <ul className="grid gap-2 sm:grid-cols-2">
        {items.map((g) => {
          const pct = g.target ? Math.min(100, (g.saved / g.target) * 100) : 0;
          return (
            <li key={g.id} className="group rounded-[14px] border border-white/[0.07] bg-white/[0.02] p-3">
              <div className="flex items-center gap-2">
                <PiggyBank size={15} style={{ color: g.color }} />
                <span className="flex-1 truncate font-medium text-ink">{g.name}</span>
                <button aria-label={`Delete ${g.name}`} onClick={() => void remove(g.id)} className="text-ink-3 opacity-100 hover:text-alert md:opacity-0 md:group-hover:opacity-100">
                  <Trash2 size={13} />
                </button>
              </div>
              <div className="well mt-2 h-2 overflow-hidden rounded-full">
                <div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${pct}%`, background: g.color }} />
              </div>
              <div className="mt-1.5 flex items-center justify-between font-mono text-[12px] tabular">
                <span className="text-ink">
                  {money(g.saved, currency)} <span className="text-ink-3">/ {money(g.target, currency)}</span>
                </span>
                <span className="text-ink-3">
                  {g.percentOfIncome ? `${g.percentOfIncome}% of income` : ""}
                  {g.monthlyAmount ? ` · ${money(g.monthlyAmount, currency)}/mo` : ""}
                </span>
              </div>
              <AddToGoal onAdd={(amt) => void update(g.id, { saved: Math.round((g.saved + amt) * 100) / 100 })} />
            </li>
          );
        })}
        {!items.length && <li className="col-span-2 py-6 text-center text-sm text-ink-3">No goals yet.</li>}
      </ul>
    </Card>
  );
}

function AddToGoal({ onAdd }: { onAdd: (n: number) => void }) {
  const [v, setV] = useState("");
  return (
    <form
      className="mt-2 flex gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        const n = Number(v);
        if (n) onAdd(n);
        setV("");
      }}
    >
      <Input inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} placeholder="+ / − amount" className="!h-8 !py-1 font-mono text-[12px]" aria-label="Adjust saved amount" />
      <button className="pill-glass !h-8 shrink-0 text-xs">Update</button>
    </form>
  );
}

async function scheduleTransferReminder(g: Goal) {
  const now = new Date();
  const due = new Date(now.getFullYear(), now.getMonth(), g.reminderDay, 9, 0, 0);
  if (due <= now) due.setMonth(due.getMonth() + 1);
  const currency = useSettings.getState().business.currency;
  await collections.create<Reminder>("reminders", {
    title: `Transfer ${money(g.monthlyAmount, currency)} → ${g.name}`,
    kind: "reminder",
    dueAt: due.getTime(),
    repeat: "monthly",
    source: "local",
  });
}

