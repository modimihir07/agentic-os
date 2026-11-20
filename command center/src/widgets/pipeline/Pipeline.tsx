import { useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { WidgetHeader } from "@/components/WidgetHeader";
import { Select, fromLocalInput } from "@/components/ui";
import { useCollection, useNow } from "@/lib/cc-api";
import { countdown } from "@/features/reminders/when";

export interface PipelineItem {
  title: string; // project / production
  role?: string;
  kind: "audition" | "self-tape" | "callback" | "booking" | "shoot";
  status: "received" | "prepping" | "submitted" | "callback" | "booked" | "passed";
  dueAt?: number;
  casting?: string;
  notes?: string;
  script?: string; // pasted sides / script text (embedded in the vault)
}

const STATUSES: PipelineItem["status"][] = ["received", "prepping", "submitted", "callback", "booked", "passed"];
const STATUS_TONE: Record<PipelineItem["status"], string> = {
  received: "text-ink-2 border-white/15",
  prepping: "text-amber-light border-amber/40",
  submitted: "text-teal border-teal/40",
  callback: "text-violet border-violet/50",
  booked: "text-canvas bg-teal border-teal",
  passed: "text-ink-3 border-white/10",
};

export default function Pipeline() {
  const { items, create, update, remove } = useCollection<PipelineItem>("pipeline");
  const now = useNow(30_000);
  const [adding, setAdding] = useState(false);
  const active = items
    .filter((i) => i.status !== "passed" && !(i.status === "booked" && (i.dueAt ?? Infinity) < now - 86_400_000))
    .sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity));
  const booked = items.filter((i) => i.status === "booked").length;

  return (
    <div className="flex h-full flex-col">
      <WidgetHeader
        title="Audition & production"
        status={
          <>
            <span className="label-caps text-teal">{booked} booked</span>
            <button aria-label={adding ? "Cancel" : "Add audition"} onClick={() => setAdding((a) => !a)} className="grid size-6 place-items-center rounded-full text-ink-2 hover:bg-white/10 hover:text-ink">
              {adding ? <X size={13} /> : <Plus size={13} />}
            </button>
          </>
        }
      />
      {adding && <AddForm onAdd={(d) => void create(d).then(() => setAdding(false))} />}
      <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
        {active.map((i) => {
          const urgent = i.dueAt && i.dueAt - now < 86_400_000 && i.dueAt > now && i.status !== "booked";
          return (
            <li key={i.id} className={`group rounded-[12px] border px-2.5 py-2 ${urgent ? "border-alert/50 bg-alert/[0.06]" : "border-white/[0.06] bg-white/[0.02]"}`}>
              <div className="flex items-center gap-2">
                <span className="label-caps shrink-0 text-ink-3">{i.kind}</span>
                <p className="min-w-0 flex-1 truncate text-[13px] text-ink">
                  {i.title}
                  {i.role && <span className="text-ink-3"> · {i.role}</span>}
                </p>
                {i.dueAt && <span className={`shrink-0 font-mono text-[11px] tabular ${urgent ? "text-alert" : "text-ink-2"}`}>{i.dueAt > now ? countdown(i.dueAt, now) : "due"}</span>}
              </div>
              <div className="mt-1.5 flex items-center gap-1.5">
                <button
                  onClick={() => void update(i.id, { status: STATUSES[(STATUSES.indexOf(i.status) + 1) % STATUSES.length] })}
                  title="Advance status"
                  className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${STATUS_TONE[i.status]}`}
                >
                  {i.status}
                </button>
                {i.casting && <span className="truncate text-[11px] text-ink-3">{i.casting}</span>}
                <button aria-label={`Delete ${i.title}`} onClick={() => void remove(i.id)} className="ml-auto grid size-6 place-items-center rounded-full text-ink-3 opacity-100 hover:text-alert md:opacity-0 md:group-hover:opacity-100">
                  <Trash2 size={11} />
                </button>
              </div>
            </li>
          );
        })}
        {!active.length && <li className="py-4 text-center text-xs text-ink-3">No open auditions. Add one with +.</li>}
      </ul>
    </div>
  );
}

function AddForm({ onAdd }: { onAdd: (d: PipelineItem) => void }) {
  const [d, setD] = useState<PipelineItem>({ title: "", role: "", kind: "self-tape", status: "received", casting: "" });
  const [due, setDue] = useState("");
  return (
    <form
      className="mb-2 grid grid-cols-2 gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!d.title.trim()) return;
        const dueAt = fromLocalInput(due);
        onAdd({ ...d, dueAt: Number.isNaN(dueAt) ? undefined : dueAt });
      }}
    >
      <input className="field col-span-2 !h-8 !py-1 text-[13px]" placeholder="Production" value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} autoFocus aria-label="Production" />
      <input className="field !h-8 !py-1 text-[13px]" placeholder="Role" value={d.role} onChange={(e) => setD({ ...d, role: e.target.value })} aria-label="Role" />
      <Select className="!h-8 !py-1 text-[13px]" value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value as PipelineItem["kind"] })} aria-label="Type">
        {["audition", "self-tape", "callback", "booking", "shoot"].map((k) => (
          <option key={k}>{k}</option>
        ))}
      </Select>
      <input className="field !h-8 !py-1 text-[13px]" placeholder="Casting / agent" value={d.casting} onChange={(e) => setD({ ...d, casting: e.target.value })} aria-label="Casting" />
      <input type="datetime-local" className="field !h-8 !py-1 text-[12px]" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Deadline" />
      <button className="pill-primary col-span-2 !h-8 text-xs">Add</button>
    </form>
  );
}
