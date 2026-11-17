import { useState } from "react";
import { Loader2, Plus, RotateCcw, Sparkles } from "lucide-react";
import { WidgetGrid } from "@/core/widgets/WidgetGrid";
import { availableWidgets } from "@/core/widgets/registry";
import { useLayout } from "@/core/widgets/layout-store";
import { cc } from "@/lib/cc-api";
import { GlassOpacitySlider } from "@/features/os/OsControls";
import { GENERATOR_SYSTEM, validateSpec, type CustomSpec } from "@/widgets/custom/spec";

export function CommandSection() {
  const editing = useLayout((s) => s.editing);
  return (
    <div className="flex h-full min-h-0 flex-col">
      {editing && <WidgetTray />}
      <div className="min-h-0 flex-1 overflow-y-auto md:overflow-visible">
        <WidgetGrid />
      </div>
    </div>
  );
}

const TEMPLATES: { label: string; spec: CustomSpec }[] = [
  { label: "Unpaid invoices", spec: { kind: "list", title: "Unpaid invoices", collection: "invoices", titleField: "client", subtitleField: "number", dateField: "dueAt", filter: { field: "status", equals: "sent" }, sort: "date-asc", limit: 8 } },
  { label: "Uncashed cheques", spec: { kind: "stat", title: "Cheques to deposit", collection: "checks", op: "sum", field: "amount", filter: { field: "deposited", equals: false }, prefix: "$" } },
  { label: "HST paid (receipts)", spec: { kind: "stat", title: "HST paid", collection: "receipts", op: "sum", field: "hst", prefix: "$" } },
  { label: "Brainstorm notes", spec: { kind: "list", title: "Latest ideas", collection: "notes", titleField: "title", subtitleField: "tags", sort: "newest", limit: 6 } },
  { label: "Bookings", spec: { kind: "list", title: "Bookings", collection: "pipeline", titleField: "title", subtitleField: "role", dateField: "dueAt", filter: { field: "status", equals: "booked" }, sort: "date-asc", limit: 6 } },
];

/** One switch for every widget's ultra-glass mode (each widget also has its own in edit mode). */
function GlassAllSwitch() {
  const instances = useLayout((s) => s.instances);
  const setGlassAll = useLayout((s) => s.setGlassAll);
  const on = instances.length > 0 && instances.every((i) => i.glass === "ultra");
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={() => setGlassAll(!on)}
      title="Make every widget near-transparent so the wallpaper shows through"
      className={`pill-glass ml-auto !h-9 shrink-0 !px-3 text-[13px] ${on ? "!border-teal/60 text-teal" : ""}`}
    >
      <span className={`relative h-4 w-7 rounded-full transition-colors ${on ? "bg-teal/80" : "bg-white/15"}`}>
        <span className={`absolute top-0.5 size-3 rounded-full bg-white shadow transition-[left] duration-200 ${on ? "left-3.5" : "left-0.5"}`} />
      </span>
      Ultra glass · all
    </button>
  );
}

/** "Add widget" tray (registry), templates, and the LLM widget generator. */
function WidgetTray() {
  const { add, reset } = useLayout();
  const [msg, setMsg] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);

  const addCustom = (spec: CustomSpec) => {
    const r = add("custom", { spec });
    setMsg(r.ok ? `Added “${spec.title}”.` : (r.reason ?? null));
  };

  const generate = async () => {
    const p = prompt.trim();
    if (!p) return;
    setBusy(true);
    setMsg(null);
    try {
      const raw = await cc.llmJson<unknown>(GENERATOR_SYSTEM, `${p}\n(Current date: ${new Date().toISOString()})`);
      const spec = validateSpec(raw);
      if (!spec) throw new Error("The model's widget didn't validate — try rephrasing, or pick a template.");
      addCustom(spec);
      setPrompt("");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-4 mb-3 space-y-2 md:mx-6 xl:mx-8">
      <div className="glass flex items-center gap-2 overflow-x-auto rounded-[18px] p-2">
        <span className="label-caps shrink-0 px-2 text-amber-soft">Add</span>
        {availableWidgets()
          .filter((w) => w.id !== "custom")
          .map((w) => {
            const Icon = w.icon;
            return (
              <button
                key={w.id}
                title={w.description}
                onClick={() => {
                  const r = add(w.id);
                  setMsg(r.ok ? null : (r.reason ?? null));
                }}
                className="pill-glass !h-9 shrink-0 !px-3 text-[13px]"
              >
                <Plus size={13} />
                <Icon size={14} className="text-teal" />
                {w.title}
              </button>
            );
          })}
        <GlassAllSwitch />
        <GlassOpacitySlider />
        <button onClick={reset} className="pill-glass !h-9 shrink-0 !px-3 text-[13px]" title="Restore the default layout">
          <RotateCcw size={13} /> Reset
        </button>
      </div>

      <div className="glass flex flex-wrap items-center gap-2 rounded-[18px] p-2">
        <span className="label-caps shrink-0 px-2 text-violet">Generate</span>
        <form
          className="flex min-w-64 flex-1 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void generate();
          }}
        >
          <input
            className="field !h-9 !py-1 text-[13px]"
            placeholder="Describe a widget: “HST paid on fuel receipts”, “countdown to my Dec 12 shoot”…"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            aria-label="Describe a widget"
          />
          <button className="pill-primary !h-9 shrink-0 !px-3 text-[13px]" disabled={busy || !prompt.trim()}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />} Generate
          </button>
        </form>
        <div className="flex gap-1.5 overflow-x-auto">
          {TEMPLATES.map((t) => (
            <button key={t.label} onClick={() => addCustom(t.spec)} className="pill-glass !h-8 shrink-0 !px-3 text-[12px]">
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {msg && <p className="px-2 text-xs text-ink-2">{msg}</p>}
      <p className="hidden px-2 text-xs text-ink-3 md:block">
        Drag a widget’s label to move it, its corner to resize. Red outline = no room there. Generated widgets are data-only views of your local store — they can’t run code.
      </p>
    </div>
  );
}
