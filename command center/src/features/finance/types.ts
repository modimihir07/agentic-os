/**
 * Finance & bookkeeping — 100 % local. No bank, Plaid or card connections:
 * every number here is entered by you or read off your own scans by a local
 * model, and it lives in the gateway's SQLite store on your machine.
 */

export interface InvoiceLine {
  desc: string;
  qty: number;
  rate: number;
}

export interface Invoice {
  number: string;
  client: string;
  clientEmail?: string;
  clientAddress?: string;
  items: InvoiceLine[];
  /** Sales tax % applied to the subtotal (13 = Ontario HST). */
  taxRate: number;
  issuedAt: number;
  dueAt: number;
  status: "draft" | "sent" | "paid" | "overdue" | "void";
  paidAt?: number;
  notes?: string;
  projectId?: string;
}

export interface Check {
  payer: string;
  amount: number;
  receivedAt: number;
  chequeNumber?: string;
  memo?: string;
  deposited: boolean;
  depositedAt?: number;
  invoiceNumber?: string;
  imageFileId?: string;
  notes?: string;
}

export interface Receipt {
  vendor: string;
  date: string; // YYYY-MM-DD
  subtotal: number | null;
  gst: number | null;
  hst: number | null;
  pst: number | null;
  qst: number | null;
  tip: number | null;
  total: number | null;
  currency: string;
  category: string;
  regime?: string | null;
  flags?: string[];
  imageFileId?: string;
  ocrEngine?: string;
  ocrText?: string;
  confidence?: number;
  verified: boolean;
  notes?: string;
}

export interface Income {
  date: string;
  client: string;
  description: string;
  amount: number; // before tax
  taxCollected: number;
  method: "e-transfer" | "cheque" | "cash" | "card" | "other";
  invoiceNumber?: string;
}

export interface Goal {
  name: string;
  target: number;
  saved: number;
  /** % of each income entry to set aside (e.g. 25 for taxes). 0 = fixed amounts only. */
  percentOfIncome: number;
  monthlyAmount: number;
  /** Day of month to be reminded to transfer (1–28, 0 = off). */
  reminderDay: number;
  deadline?: string;
  color?: string;
}

export const CATEGORIES = ["meals", "fuel", "vehicle", "office", "equipment", "software", "travel", "wardrobe", "training", "subcontract", "materials", "utilities", "other"];

export const invoiceTotals = (inv: Pick<Invoice, "items" | "taxRate">) => {
  const subtotal = inv.items.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.rate) || 0), 0);
  const tax = Math.round(subtotal * (inv.taxRate / 100) * 100) / 100;
  return { subtotal, tax, total: Math.round((subtotal + tax) * 100) / 100 };
};

/** Sales tax paid on a receipt (input tax credits come from GST/HST only). */
export const receiptItc = (r: Pick<Receipt, "gst" | "hst">) => (r.gst ?? 0) + (r.hst ?? 0);

export const quarterOf = (iso: string) => {
  const d = new Date(iso + "T12:00:00");
  return `${d.getFullYear()} Q${Math.floor(d.getMonth() / 3) + 1}`;
};
