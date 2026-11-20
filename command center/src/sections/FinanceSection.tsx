import { useState } from "react";
import { Lock } from "lucide-react";
import { Card, Stat, SubTabs, money } from "@/components/ui";
import { useCollection } from "@/lib/cc-api";
import { invoiceTotals, receiptItc, type Check, type Goal, type Income, type Invoice, type Receipt } from "@/features/finance/types";
import { useSettings } from "@/stores/settings";
import { ScanPanel } from "./finance/ScanPanel";
import { ReceiptsTable } from "./finance/ReceiptsTable";
import { InvoicesPanel } from "./finance/InvoicesPanel";
import { ChequesPanel, GoalsPanel, IncomePanel } from "./finance/LedgerPanels";

type Tab = "overview" | "scan" | "receipts" | "invoices" | "cheques" | "income" | "goals";
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "scan", label: "Scan" },
  { id: "receipts", label: "Tax table" },
  { id: "invoices", label: "Invoices" },
  { id: "cheques", label: "Cheques" },
  { id: "income", label: "Income" },
  { id: "goals", label: "Goals" },
];

/** Finance & bookkeeping — strictly local. No bank / Plaid / card linking exists here. */
export function FinanceSection() {
  const [tab, setTab] = useState<Tab>("overview");
  return (
    <div className="mx-auto h-full w-full max-w-6xl space-y-4 overflow-y-auto px-4 pb-32 md:px-6 md:pb-8">
      <div className="flex flex-wrap items-center gap-3">
        <SubTabs tabs={TABS} value={tab} onChange={setTab} />
        <span className="ml-auto flex items-center gap-1.5 text-[11px] text-ink-3">
          <Lock size={12} /> 100% local · no bank connections
        </span>
      </div>
      {tab === "overview" && <Overview go={setTab} />}
      {tab === "scan" && <ScanPanel onSaved={(where) => setTab(where === "checks" ? "cheques" : "receipts")} />}
      {tab === "receipts" && <ReceiptsTable />}
      {tab === "invoices" && <InvoicesPanel />}
      {tab === "cheques" && <ChequesPanel />}
      {tab === "income" && <IncomePanel />}
      {tab === "goals" && <GoalsPanel />}
    </div>
  );
}

function Overview({ go }: { go: (t: Tab) => void }) {
  const { currency } = useSettings((s) => s.business);
  const income = useCollection<Income>("income").items;
  const receipts = useCollection<Receipt>("receipts").items;
  const invoices = useCollection<Invoice>("invoices").items;
  const checks = useCollection<Check>("checks").items;
  const goals = useCollection<Goal>("goals").items;
  const { error } = useCollection<Income>("income");

  const year = String(new Date().getFullYear());
  const month = new Date().toISOString().slice(0, 7);
  const q = Math.floor(new Date().getMonth() / 3);
  const inQ = (iso: string) => iso.startsWith(year) && Math.floor((Number(iso.slice(5, 7)) - 1) / 3) === q;

  const incMonth = income.filter((i) => i.date.startsWith(month)).reduce((s, i) => s + i.amount, 0);
  const incYtd = income.filter((i) => i.date.startsWith(year)).reduce((s, i) => s + i.amount, 0);
  const collectedQ = income.filter((i) => inQ(i.date)).reduce((s, i) => s + i.taxCollected, 0);
  const itcQ = receipts.filter((r) => inQ(r.date)).reduce((s, r) => s + receiptItc(r), 0);
  const expensesYtd = receipts.filter((r) => r.date.startsWith(year)).reduce((s, r) => s + (r.subtotal ?? r.total ?? 0), 0);
  const outstanding = invoices.filter((i) => i.status === "sent" || i.status === "overdue").reduce((s, i) => s + invoiceTotals(i).total, 0);
  const overdue = invoices.filter((i) => (i.status === "sent" || i.status === "overdue") && i.dueAt < Date.now()).length;
  const toDeposit = checks.filter((c) => !c.deposited).reduce((s, c) => s + c.amount, 0);
  const net = collectedQ - itcQ;

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-alert">Gateway unreachable — finance data lives there: {error}</p>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Income this month" value={money(incMonth, currency)} tone="teal" />
        <Stat label="Income YTD" value={money(incYtd, currency)} sub={`Expenses ${money(expensesYtd, currency)}`} />
        <Stat label={`HST/GST owing · Q${q + 1}`} value={money(net, currency)} sub={`collected ${money(collectedQ, currency)} − ITCs ${money(itcQ, currency)}`} tone={net > 0 ? "amber" : "teal"} />
        <Stat label="Outstanding invoices" value={money(outstanding, currency)} sub={overdue ? `${overdue} overdue` : "none overdue"} tone={overdue ? "alert" : "ink"} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Savings goals" action={<button className="text-xs text-ink-3 hover:text-ink" onClick={() => go("goals")}>Manage →</button>}>
          <ul className="space-y-2.5">
            {goals.map((g) => (
              <li key={g.id}>
                <div className="flex justify-between text-sm">
                  <span className="text-ink">{g.name}</span>
                  <span className="font-mono text-ink-2 tabular">
                    {money(g.saved, currency)} / {money(g.target, currency)}
                  </span>
                </div>
                <div className="well mt-1 h-1.5 overflow-hidden rounded-full">
                  <div className="h-full rounded-full" style={{ width: `${g.target ? Math.min(100, (g.saved / g.target) * 100) : 0}%`, background: g.color ?? "#00E5C3" }} />
                </div>
              </li>
            ))}
            {!goals.length && <li className="text-sm text-ink-3">No goals yet.</li>}
          </ul>
        </Card>
        <Card title="To do">
          <ul className="space-y-2 text-sm">
            <Todo show={toDeposit > 0} onClick={() => go("cheques")}>
              Deposit {money(toDeposit, currency)} in cheques
            </Todo>
            <Todo show={overdue > 0} onClick={() => go("invoices")}>
              Follow up on {overdue} overdue invoice{overdue > 1 ? "s" : ""}
            </Todo>
            <Todo show={receipts.some((r) => (r.flags?.length ?? 0) > 0)} onClick={() => go("receipts")}>
              Review flagged receipts ({receipts.filter((r) => (r.flags?.length ?? 0) > 0).length})
            </Todo>
            <Todo show onClick={() => go("scan")}>
              Scan today's receipts
            </Todo>
          </ul>
          <p className="mt-3 text-[11px] text-ink-3">The HST estimate is a bookkeeping aid, not tax advice — confirm with your accountant before filing.</p>
        </Card>
      </div>
    </div>
  );
}

function Todo({ show, onClick, children }: { show: boolean; onClick: () => void; children: React.ReactNode }) {
  if (!show) return null;
  return (
    <li>
      <button onClick={onClick} className="flex w-full items-center gap-2 rounded-[10px] border border-white/[0.06] px-3 py-2 text-left text-ink hover:border-amber/40">
        <span className="size-1.5 rounded-full bg-amber" /> {children}
      </button>
    </li>
  );
}
