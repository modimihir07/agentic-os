import type { Collection } from "@/lib/cc-api";

/**
 * A generated widget is pure data — a spec rendered by one generic component.
 * The local LLM (or the template picker) can only produce these shapes, and
 * `validateSpec` rejects anything else, so a "generated" widget can never run
 * code or reach the network.
 */
export type CustomSpec =
  | { kind: "list"; title: string; collection: Collection; titleField: string; subtitleField?: string; dateField?: string; filter?: { field: string; equals: string | number | boolean }; sort?: "newest" | "oldest" | "date-asc"; limit: number }
  | { kind: "stat"; title: string; collection: Collection; op: "count" | "sum"; field?: string; filter?: { field: string; equals: string | number | boolean }; prefix?: string; suffix?: string }
  | { kind: "countdown"; title: string; dueAt: number }
  | { kind: "note"; title: string; text: string }
  | { kind: "workflow"; title: string; workflow: string; refreshMin: number };

export const SPEC_COLLECTIONS: Collection[] = ["notes", "reminders", "pipeline", "projects", "income", "goals", "invoices", "checks", "receipts", "documents"];

/** Field hints per collection, given to the generator so it uses real field names. */
export const COLLECTION_FIELDS: Record<string, string[]> = {
  notes: ["title", "rawText", "tags"],
  reminders: ["title", "kind", "dueAt", "repeat", "source"],
  pipeline: ["title", "role", "kind", "status", "dueAt", "casting"],
  projects: ["client", "job", "estimate", "status", "followUpAt"],
  income: ["date", "client", "description", "amount", "taxCollected", "method"],
  goals: ["name", "target", "saved", "percentOfIncome"],
  invoices: ["number", "client", "status", "issuedAt", "dueAt"],
  checks: ["payer", "amount", "receivedAt", "deposited"],
  receipts: ["vendor", "date", "total", "hst", "gst", "category", "verified"],
  documents: ["title", "notes"],
};

const isStr = (v: unknown, max = 200): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const field = (v: unknown) => isStr(v, 40) && /^[A-Za-z][A-Za-z0-9_]*$/.test(v);

export function validateSpec(raw: unknown): CustomSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const title = isStr(s.title, 60) ? s.title : null;
  if (!title) return null;
  const coll = SPEC_COLLECTIONS.includes(s.collection as Collection) ? (s.collection as Collection) : null;
  const filter =
    s.filter && typeof s.filter === "object" && field((s.filter as Record<string, unknown>).field) && ["string", "number", "boolean"].includes(typeof (s.filter as Record<string, unknown>).equals)
      ? (s.filter as { field: string; equals: string | number | boolean })
      : undefined;
  switch (s.kind) {
    case "list":
      if (!coll || !field(s.titleField)) return null;
      return {
        kind: "list",
        title,
        collection: coll,
        titleField: s.titleField as string,
        subtitleField: field(s.subtitleField) ? (s.subtitleField as string) : undefined,
        dateField: field(s.dateField) ? (s.dateField as string) : undefined,
        filter,
        sort: ["newest", "oldest", "date-asc"].includes(s.sort as string) ? (s.sort as "newest") : "newest",
        limit: Math.min(50, Math.max(1, Number(s.limit) || 8)),
      };
    case "stat":
      if (!coll || !["count", "sum"].includes(s.op as string)) return null;
      if (s.op === "sum" && !field(s.field)) return null;
      return { kind: "stat", title, collection: coll, op: s.op as "count", field: field(s.field) ? (s.field as string) : undefined, filter, prefix: isStr(s.prefix, 4) ? s.prefix : undefined, suffix: isStr(s.suffix, 8) ? s.suffix : undefined };
    case "countdown": {
      const t = typeof s.dueAt === "number" ? s.dueAt : Date.parse(String(s.dueAt ?? ""));
      return Number.isFinite(t) ? { kind: "countdown", title, dueAt: t } : null;
    }
    case "note":
      return isStr(s.text, 2000) ? { kind: "note", title, text: s.text } : null;
    case "workflow":
      return typeof s.workflow === "string" && /^[A-Za-z0-9_-]{1,48}$/.test(s.workflow)
        ? { kind: "workflow", title, workflow: s.workflow, refreshMin: Math.min(240, Math.max(1, Number(s.refreshMin) || 15)) }
        : null;
    default:
      return null;
  }
}

export const GENERATOR_SYSTEM = `You design dashboard widgets as JSON for a local command center. Return ONLY one JSON object, one of:
{"kind":"list","title":str,"collection":C,"titleField":F,"subtitleField":F?,"dateField":F?,"filter":{"field":F,"equals":value}?,"sort":"newest"|"oldest"|"date-asc","limit":n}
{"kind":"stat","title":str,"collection":C,"op":"count"|"sum","field":F (required for sum),"filter":{...}?,"prefix":"$"?,"suffix":str?}
{"kind":"countdown","title":str,"dueAt":"ISO date-time"}
{"kind":"note","title":str,"text":str}
{"kind":"workflow","title":str,"workflow":"<read-only n8n workflow name>","refreshMin":n}
C and its fields F must come from: ${JSON.stringify(COLLECTION_FIELDS)}.
Pick the simplest widget that answers the request. Titles under 30 characters.`;
