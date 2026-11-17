import { useState } from "react";
import { CheckCircle2, Plus, Printer, Send, Trash2, X } from "lucide-react";
import { Card, Field, Input, Select, money } from "@/components/ui";
import { collections, useCollection, type Item } from "@/lib/cc-api";
import { invoiceTotals, type Income, type Invoice, type InvoiceLine } from "@/features/finance/types";
import { useSettings } from "@/stores/settings";

const STATUS_TONE: Record<Invoice["status"], string> = {
  draft: "border-white/15 text-ink-2",
  sent: "border-amber/50 text-amber-light",
  overdue: "border-alert/60 text-alert",
  paid: "border-teal/60 text-teal",
  void: "border-white/10 text-ink-3",
};

/** Generate, log, print and archive client invoices. */
export function InvoicesPanel() {
  const { items, update, remove } = useCollection<Invoice>("invoices");
  const { currency } = useSettings((s) => s.business);
  const [editing, setEditing] = useState<Item<Invoice> | "new" | null>(null);
  const now = Date.now();
  const rows = items.map((i) => (i.status === "sent" && i.dueAt < now ? { ...i, status: "overdue" as const } : i)).sort((a, b) => b.issuedAt - a.issuedAt);
  const outstanding = rows.filter((i) => i.status === "sent" || i.status === "overdue").reduce((s, i) => s + invoiceTotals(i).total, 0);

  const markPaid = async (inv: Item<Invoice>) => {
    const t = invoiceTotals(inv);
    await update(inv.id, { status: "paid", paidAt: Date.now() });
    // Paying an invoice books the income (and the tax collected) automatically.
    await collections.create<Income>("income", {
      date: new Date().toISOString().slice(0, 10),
      client: inv.client,
      description: `Invoice ${inv.number}`,
      amount: t.subtotal,
      taxCollected: t.tax,
      method: "e-transfer",
      invoiceNumber: inv.number,
    });
  };

  return (
    <div className="space-y-4">
      <Card
        title="Invoices"
        hint={`Outstanding: ${money(outstanding, currency)}. Marking one paid books the income and the HST collected.`}
        action={
          <button onClick={() => setEditing("new")} className="pill-primary !h-8 text-xs">
            <Plus size={13} /> New invoice
          </button>
        }
      >
        <ul className="space-y-1.5">
          {rows.map((inv) => {
            const t = invoiceTotals(inv);
            return (
              <li key={inv.id} className="group flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[12px] border border-white/[0.06] bg-white/[0.02] px-3 py-2">
                <span className="font-mono text-[12px] text-ink-2">{inv.number}</span>
                <button onClick={() => setEditing(inv)} className="min-w-0 flex-1 truncate text-left text-sm text-ink hover:text-amber-light">
                  {inv.client}
                </button>
                <span className="font-mono text-[11px] text-ink-3">due {new Date(inv.dueAt).toLocaleDateString()}</span>
                <span className="w-24 text-right font-mono text-sm text-ink tabular">{money(t.total, currency)}</span>
                <span className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${STATUS_TONE[inv.status]}`}>{inv.status}</span>
                <div className="flex">
                  {inv.status === "draft" && (
                    <Btn label="Mark sent" onClick={() => void update(inv.id, { status: "sent" })}>
                      <Send size={13} />
                    </Btn>
                  )}
                  {(inv.status === "sent" || inv.status === "overdue") && (
                    <Btn label="Mark paid (books income)" onClick={() => void markPaid(inv)}>
                      <CheckCircle2 size={13} />
                    </Btn>
                  )}
                  <Btn label="Print / save PDF" onClick={() => printInvoice(inv)}>
                    <Printer size={13} />
                  </Btn>
                  <Btn label="Delete" onClick={() => void remove(inv.id)} danger>
                    <Trash2 size={13} />
                  </Btn>
                </div>
              </li>
            );
          })}
          {!rows.length && <li className="py-6 text-center text-sm text-ink-3">No invoices yet.</li>}
        </ul>
      </Card>
      {editing && <InvoiceEditor initial={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function Btn({ label, onClick, danger, children }: { label: string; onClick: () => void; danger?: boolean; children: React.ReactNode }) {
  return (
    <button aria-label={label} title={label} onClick={onClick} className={`grid size-8 place-items-center rounded-full text-ink-3 hover:bg-white/10 ${danger ? "hover:text-alert" : "hover:text-ink"}`}>
      {children}
    </button>
  );
}

function InvoiceEditor({ initial, onClose }: { initial: Item<Invoice> | null; onClose: () => void }) {
  const { create, update, items } = useCollection<Invoice>("invoices");
  const { hstRate, currency } = useSettings((s) => s.business);
  const [inv, setInv] = useState<Invoice>(
    initial ?? {
      number: `INV-${new Date().getFullYear()}-${String(items.length + 1).padStart(3, "0")}`,
      client: "",
      items: [{ desc: "", qty: 1, rate: 0 }],
      taxRate: hstRate,
      issuedAt: Date.now(),
      dueAt: Date.now() + 30 * 86_400_000,
      status: "draft",
    },
  );
  const t = invoiceTotals(inv);
  const setLine = (i: number, patch: Partial<InvoiceLine>) => setInv({ ...inv, items: inv.items.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  return (
    <Card
      title={initial ? `Edit ${initial.number}` : "New invoice"}
      action={
        <button onClick={onClose} aria-label="Close editor" className="grid size-8 place-items-center rounded-full text-ink-2 hover:text-ink">
          <X size={15} />
        </button>
      }
    >
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (initial) await update(initial.id, inv);
          else await create(inv);
          onClose();
        }}
      >
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="Invoice #">
            <Input value={inv.number} onChange={(e) => setInv({ ...inv, number: e.target.value })} className="font-mono" required />
          </Field>
          <Field label="Client">
            <Input value={inv.client} onChange={(e) => setInv({ ...inv, client: e.target.value })} required />
          </Field>
          <Field label="Client email">
            <Input type="email" value={inv.clientEmail ?? ""} onChange={(e) => setInv({ ...inv, clientEmail: e.target.value })} />
          </Field>
          <Field label="Issued">
            <Input type="date" value={day(inv.issuedAt)} onChange={(e) => setInv({ ...inv, issuedAt: Date.parse(e.target.value + "T12:00:00") })} />
          </Field>
          <Field label="Due">
            <Input type="date" value={day(inv.dueAt)} onChange={(e) => setInv({ ...inv, dueAt: Date.parse(e.target.value + "T12:00:00") })} />
          </Field>
          <Field label="Tax %">
            <Input type="number" step="0.5" value={inv.taxRate} onChange={(e) => setInv({ ...inv, taxRate: Number(e.target.value) })} className="font-mono" />
          </Field>
        </div>
        <div className="space-y-1.5">
          {inv.items.map((l, i) => (
            <div key={i} className="grid grid-cols-[1fr_70px_100px_32px] gap-1.5">
              <Input value={l.desc} onChange={(e) => setLine(i, { desc: e.target.value })} placeholder="Description" className="!h-9 !py-1 text-[13px]" aria-label="Line description" />
              <Input type="number" min={0} step="0.25" value={l.qty} onChange={(e) => setLine(i, { qty: Number(e.target.value) })} className="!h-9 !py-1 font-mono text-[13px]" aria-label="Quantity" />
              <Input type="number" min={0} step="0.01" value={l.rate} onChange={(e) => setLine(i, { rate: Number(e.target.value) })} className="!h-9 !py-1 font-mono text-[13px]" aria-label="Rate" />
              <button type="button" aria-label="Remove line" onClick={() => setInv({ ...inv, items: inv.items.filter((_, j) => j !== i) })} className="grid size-9 place-items-center text-ink-3 hover:text-alert" disabled={inv.items.length === 1}>
                <X size={13} />
              </button>
            </div>
          ))}
          <button type="button" onClick={() => setInv({ ...inv, items: [...inv.items, { desc: "", qty: 1, rate: 0 }] })} className="pill-glass !h-8 text-xs">
            <Plus size={12} /> Line
          </button>
        </div>
        <Field label="Notes / payment terms">
          <Input value={inv.notes ?? ""} onChange={(e) => setInv({ ...inv, notes: e.target.value })} placeholder="e-Transfer to … · Net 30" />
        </Field>
        <div className="flex flex-wrap items-center gap-4 border-t border-white/5 pt-3 font-mono text-sm tabular">
          <span className="text-ink-2">Subtotal {money(t.subtotal, currency)}</span>
          <span className="text-ink-2">
            Tax {inv.taxRate}% {money(t.tax, currency)}
          </span>
          <span className="text-amber-light">Total {money(t.total, currency)}</span>
          <Select value={inv.status} onChange={(e) => setInv({ ...inv, status: e.target.value as Invoice["status"] })} className="!h-9 !w-auto !py-1 font-sans text-[13px]" aria-label="Status">
            {["draft", "sent", "paid", "void"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
          <button className="pill-primary ml-auto">Save invoice</button>
        </div>
      </form>
    </Card>
  );
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** A clean, light printable invoice → the browser's Print → Save as PDF. */
function printInvoice(inv: Invoice) {
  const b = useSettings.getState().business;
  const t = invoiceTotals(inv);
  const m = (n: number) => money(n, b.currency);
  const taxLabel = ["ON", "NS", "NB", "NL", "PE"].includes(b.province) ? "HST" : "GST";
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(inv.number)}</title>
<style>body{font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#111;margin:48px;max-width:760px}
h1{font-size:28px;margin:0}table{width:100%;border-collapse:collapse;margin-top:28px}th,td{padding:8px 6px;border-bottom:1px solid #ddd;text-align:left}
th{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#666}.r{text-align:right}.tot td{border:0;padding:4px 6px}.big{font-size:18px;font-weight:700}
.muted{color:#666}.row{display:flex;justify-content:space-between;gap:24px;margin-top:24px}@media print{body{margin:24px}}</style></head><body>
<div class="row"><div><h1>INVOICE</h1><div class="muted">${esc(inv.number)}</div></div>
<div style="text-align:right"><b>${esc(b.name || "Your business")}</b><br>${esc(b.address)}<br>${esc(b.email)} ${esc(b.phone)}<br>${b.hstNumber ? `${taxLabel} # ${esc(b.hstNumber)}` : ""}</div></div>
<div class="row"><div><div class="muted">Bill to</div><b>${esc(inv.client)}</b><br>${esc(inv.clientAddress ?? "")}<br>${esc(inv.clientEmail ?? "")}</div>
<div style="text-align:right"><div class="muted">Issued</div>${new Date(inv.issuedAt).toLocaleDateString()}<div class="muted" style="margin-top:6px">Due</div>${new Date(inv.dueAt).toLocaleDateString()}</div></div>
<table><thead><tr><th>Description</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead><tbody>
${inv.items.map((l) => `<tr><td>${esc(l.desc)}</td><td class="r">${l.qty}</td><td class="r">${m(l.rate)}</td><td class="r">${m(l.qty * l.rate)}</td></tr>`).join("")}
</tbody></table>
<table style="width:auto;margin-left:auto"><tbody class="tot"><tr><td>Subtotal</td><td class="r">${m(t.subtotal)}</td></tr>
<tr><td>${taxLabel} ${inv.taxRate}%</td><td class="r">${m(t.tax)}</td></tr><tr><td class="big">Total</td><td class="r big">${m(t.total)}</td></tr></tbody></table>
${inv.notes ? `<p class="muted" style="margin-top:32px">${esc(inv.notes)}</p>` : ""}
<script>window.onload=()=>{window.print()}</script></body></html>`;
  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  const w = window.open(url, "_blank");
  if (!w) {
    // Popup blocked (or the desktop shell): download the HTML instead.
    const a = Object.assign(document.createElement("a"), { href: url, download: `${inv.number}.html` });
    a.click();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
