import { useEffect, useState } from "react";
import { AlertTriangle, CalendarClock, CheckCircle2, Cpu, FileDown, ListTodo, Loader2, NotebookPen, Repeat, Trash2, Workflow, Wrench } from "lucide-react";
import { DEV_TASK_CATEGORIES, isTauri, type DevTask, type DevTaskStatus } from "@/lib/platform";
import { useSettings } from "@/stores/settings";
import { useToasts } from "@/features/reminders/notify";
import { useDevQueue } from "./dev-queue";
import { briefButtonState, fmtAgo, fmtDue, futureRuns, nextStatus, openCounts, PRIORITY_LABEL, visibleTasks, type CategoryFilter, type FutureRun } from "./format";
import { useMemmapData } from "./use-memmap-data";
import { Panel, useNow } from "./parts";

const STATUS_PILL: Record<DevTaskStatus, string> = {
  Pending: "border-ember/50 bg-ember/10 text-ember",
  Queued: "border-holo/40 bg-holo/10 text-holo",
  "In Progress": "border-teal/50 bg-teal/10 text-teal-soft",
  Done: "border-white/10 bg-white/[0.04] text-ink-3",
};
/** Left accent per status (the row's coloured indicator). */
const STATUS_ACCENT: Record<DevTaskStatus, string> = {
  Pending: "border-l-ember",
  Queued: "border-l-holo",
  "In Progress": "border-l-teal shadow-[inset_8px_0_12px_-10px_rgba(0,229,195,0.7)]",
  Done: "border-l-white/15",
};
const PRIORITY_TONE = ["text-alert", "text-ember", "text-ink-2", "text-ink-3"];
const RUN_ICON = { job: CalendarClock, loop: Repeat, n8n: Workflow, slot: Cpu } as const;
const RUN_KIND = { job: "Scheduler", loop: "Daemon loop", n8n: "n8n", slot: "GPU slot" } as const;

type DockTab = "queue" | "scheduled";

/**
 * FUTURE TASKS & AUTONOMOUS QUEUE. "Dev queue": the dev task queue (devqueue.db); the
 * status pill cycles Pending → Queued → In Progress → Done and the P-badge cycles priority.
 * "Scheduled": what the OS runs next (gateway scheduler jobs, daemon loops, active n8n
 * workflows, the GPU slot queue), from the snapshot. Export Session Brief writes
 * memory/session_handoffs/<date>.md in Rust and copies the Markdown here.
 */
export function TaskDock({ className = "" }: { className?: string }) {
  const q = useDevQueue();
  const xray = useSettings((s) => s.systemMapMode) === "xray";
  const desktop = isTauri();
  const now = useNow(15_000);
  const [tab, setTab] = useState<DockTab>("queue");
  const { snap, error } = useMemmapData();
  const future = futureRuns(snap, now);

  useEffect(() => {
    void useDevQueue.getState().load();
  }, []);

  const counts = openCounts(q.tasks);
  const rows = visibleTasks(q.tasks, q.filter, q.showDone);
  const done = q.tasks.filter((t) => t.status === "Done").length;
  const brief = briefButtonState({ desktop, exporting: q.exporting, open: counts.all });

  const exportBrief = async () => {
    try {
      const r = await q.exportBrief();
      let copied = true;
      try {
        await navigator.clipboard.writeText(r.markdown);
      } catch {
        copied = false;
      }
      useToasts.getState().push({ title: copied ? "Session brief exported · copied" : "Session brief exported (clipboard blocked)", body: r.path, tone: "info" });
    } catch (e) {
      useToasts.getState().push({ title: "Couldn't export the brief", body: e instanceof Error ? e.message : String(e), tone: "error" });
    }
  };

  return (
    <Panel
      title="Future tasks & autonomous queue"
      className={className}
      bodyClassName="flex flex-col gap-2 !pt-2"
      badge={<span className="font-mono text-[10px] text-ink-3">{counts.all} open</span>}
      action={
        <button
          type="button"
          onClick={() => void exportBrief()}
          disabled={brief.disabled}
          title={q.lastExport ? `${brief.title}\nLast export: ${q.lastExport.path}` : brief.title}
          className="flex h-7 items-center gap-1.5 rounded-full border border-holo/40 bg-holo/10 px-3 font-mono text-[10px] font-semibold uppercase tracking-wider text-holo transition-[filter] hover:brightness-125 disabled:opacity-40"
        >
          {q.exporting ? <Loader2 size={11} className="animate-spin" /> : <FileDown size={11} />} {brief.label}
        </button>
      }
    >
      <div role="tablist" aria-label="Dock view" className="flex items-center gap-1 border-b border-holo/10 pb-1.5">
        <DockTabButton id="queue" tab={tab} setTab={setTab} icon={ListTodo} label="Dev queue" count={counts.all} />
        <DockTabButton id="scheduled" tab={tab} setTab={setTab} icon={CalendarClock} label="Scheduled" count={future.runs.length} />
        <span className="ml-auto hidden items-center gap-2 font-mono text-[9px] text-ink-3 sm:flex" aria-hidden>
          {tab === "queue" ? (
            <>
              <Legend c="bg-ember" t="Pending" />
              <Legend c="bg-holo" t="Queued" />
              <Legend c="bg-teal" t="In progress" />
              <Legend c="bg-ink-3" t="Done" />
            </>
          ) : (
            <>
              <Legend c="bg-alert" t="Overdue" />
              <Legend c="bg-teal" t="Within 5 min" />
              <Legend c="bg-holo" t="Later" />
            </>
          )}
        </span>
      </div>
      {tab === "scheduled" ? (
        <ScheduledList runs={future.runs} notes={future.notes} now={now} why={!snap ? (error ?? "Waiting for the first system snapshot") : null} />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1">
            {(["all", ...DEV_TASK_CATEGORIES] as CategoryFilter[]).map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={q.filter === c}
                onClick={() => q.setFilter(c)}
                className={`label-caps h-6 rounded-full border px-2 !text-[9px] transition-colors ${q.filter === c ? "border-holo/50 bg-holo/10 text-holo" : "border-white/10 text-ink-3 hover:text-ink-2"}`}
              >
                {c} {counts[c] > 0 && <span className="text-ink-3">{counts[c]}</span>}
              </button>
            ))}
            <button
              type="button"
              aria-pressed={q.showDone}
              onClick={() => q.setShowDone(!q.showDone)}
              className={`label-caps ml-auto h-6 rounded-full px-2 !text-[9px] ${q.showDone ? "text-teal-soft" : "text-ink-3 hover:text-ink-2"}`}
            >
              {q.showDone ? "Hide" : "Show"} done ({done})
            </button>
          </div>
          {desktop && q.error && <p className="truncate font-mono text-[10px] text-ember" title={q.error}>{q.error}</p>}
          <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
            {rows.length === 0 ? (
              <li className="py-3 text-center font-mono text-[10.5px] text-ink-3">
                {!desktop ? "Desktop app only." : !q.loaded ? "Loading…" : q.tasks.length ? "Nothing open in this filter." : "Queue is empty. Dispatch a note, say \"log a dev note …\", or queue a failed trace step."}
              </li>
            ) : (
              rows.map((t) => <TaskRow key={t.id} t={t} xray={xray} now={now} />)
            )}
          </ul>
        </>
      )}
    </Panel>
  );
}

function Legend({ c, t }: { c: string; t: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className={`inline-block size-1.5 rounded-full ${c}`} />
      {t}
    </span>
  );
}

function DockTabButton({ id, tab, setTab, icon: Icon, label, count }: { id: DockTab; tab: DockTab; setTab: (t: DockTab) => void; icon: typeof ListTodo; label: string; count: number }) {
  const on = tab === id;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={on}
      onClick={() => setTab(id)}
      className={`label-caps flex h-6 items-center gap-1.5 rounded-full border px-2.5 !text-[9px] transition-colors ${on ? "border-holo/50 bg-holo/10 text-holo" : "border-transparent text-ink-3 hover:text-ink-2"}`}
    >
      <Icon size={11} /> {label} <span className="text-ink-3">{count}</span>
    </button>
  );
}

const RUN_TONE = {
  overdue: { row: "border-l-alert", icon: "text-alert", chip: "border-alert/50 bg-alert/10 text-alert" },
  soon: { row: "border-l-teal", icon: "text-teal-soft", chip: "border-teal/50 bg-teal/10 text-teal-soft" },
  later: { row: "border-l-holo", icon: "text-holo", chip: "border-holo/40 bg-holo/10 text-holo" },
  open: { row: "border-l-white/15", icon: "text-ink-3", chip: "border-white/10 text-ink-3" },
} as const;

function ScheduledList({ runs, notes, now, why }: { runs: FutureRun[]; notes: string[]; now: number; why: string | null }) {
  return (
    <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
      {notes.map((n) => (
        <li key={n} className="truncate font-mono text-[10px] text-ember" title={n}>
          {n}
        </li>
      ))}
      {runs.length === 0 ? (
        <li className="py-3 text-center font-mono text-[10.5px] text-ink-3">{why ?? "Nothing scheduled: no enabled scheduler job, daemon loop, active n8n workflow or queued GPU work."}</li>
      ) : (
        runs.map((r) => {
          const Icon = RUN_ICON[r.kind];
          const tone = RUN_TONE[r.overdue ? "overdue" : r.due == null ? "open" : r.due - now < 5 * 60_000 ? "soon" : "later"];
          return (
            <li key={r.key} className={`flex min-w-0 items-center gap-2 rounded-[8px] border border-l-2 border-white/[0.05] bg-white/[0.015] px-2 py-1.5 ${tone.row}`}>
              <Icon size={13} className={`shrink-0 ${tone.icon}`} aria-hidden />
              <div className="min-w-0 flex-1" title={`${r.label}\n${r.detail}`}>
                <p className="truncate text-[12px] text-ink">{r.label}</p>
                <p className="truncate font-mono text-[9.5px] text-ink-3">
                  {RUN_KIND[r.kind]} · {r.detail}
                </p>
              </div>
              <span
                className={`label-caps inline-flex h-6 shrink-0 items-center rounded-full border px-2 !text-[9px] ${tone.chip}`}
                title={r.due != null ? new Date(r.due).toLocaleString() : "No fixed time: runs on its own trigger"}
              >
                {fmtDue(r.due, now) ?? (r.kind === "n8n" ? "on trigger" : r.kind === "slot" ? "waiting" : "first run")}
              </span>
            </li>
          );
        })
      )}
    </ul>
  );
}

function TaskRow({ t, xray, now }: { t: DevTask; xray: boolean; now: number }) {
  const { cycleStatus, cyclePriority, remove } = useDevQueue.getState();
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    if (!confirmDelete) return;
    const id = setTimeout(() => setConfirmDelete(false), 3000);
    return () => clearTimeout(id);
  }, [confirmDelete]);
  const KindIcon = t.kind === "fix" ? Wrench : t.kind === "note" ? NotebookPen : null;
  const snap = t.contextSnapshot;
  const ctx = [
    snap.git?.branch && `branch ${snap.git.branch}${snap.git.head ? ` @ ${snap.git.head.slice(0, 7)}` : ""}`,
    snap.system?.servicesUp != null && `services ${snap.system.servicesUp}/${snap.system.servicesTotal ?? "?"} up`,
    snap.trace?.hop && `trace: ${snap.trace.hop} ${snap.trace.label ?? ""}${snap.trace.error ? ` — ${snap.trace.error}` : ""}`,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <li className={`group flex min-w-0 items-center gap-2 rounded-[8px] border border-l-2 border-white/[0.05] bg-white/[0.015] px-2 py-1.5 ${STATUS_ACCENT[t.status]} ${t.status === "Done" ? "opacity-55" : ""}`}>
      <button type="button" onClick={() => void cyclePriority(t.id)} title={`${PRIORITY_LABEL[t.priority]} — click to change`} className={`w-6 shrink-0 font-mono text-[10px] font-bold ${PRIORITY_TONE[t.priority]}`}>
        P{t.priority}
      </button>
      {t.status === "Done" ? (
        <CheckCircle2 size={13} className="shrink-0 text-teal-soft" aria-label="done" />
      ) : t.kind === "fix" || t.priority === 0 ? (
        <AlertTriangle size={13} className={`shrink-0 ${t.priority === 0 ? "text-alert" : "text-ember"}`} aria-label={t.priority === 0 ? "urgent" : "fix"} />
      ) : (
        <span className="size-[13px] shrink-0" />
      )}
      <div className="min-w-0 flex-1" title={[t.title, t.body, ctx].filter(Boolean).join("\n\n")}>
        <p className={`truncate text-[12px] ${t.status === "Done" ? "text-ink-3 line-through" : "text-ink"}`}>
          {KindIcon && <KindIcon size={10} className="mr-1 inline text-ink-3" />}
          {t.title}
        </p>
        <p className="truncate font-mono text-[9.5px] text-ink-3">
          {t.category} · {fmtAgo(t.createdAt, now)}
          {t.source !== "typed" && ` · ${t.source}`}
          {xray && ` · ${t.id.slice(0, 8)}${snap.git?.branch ? ` · ${snap.git.branch}` : ""}`}
        </p>
      </div>
      <button
        type="button"
        onClick={() => void cycleStatus(t.id)}
        title={`Click: ${t.status} → ${nextStatus(t.status)}`}
        className={`label-caps h-6 shrink-0 rounded-full border px-2 !text-[9px] transition-colors ${STATUS_PILL[t.status]}`}
      >
        {t.status}
      </button>
      <button
        type="button"
        onClick={() => (confirmDelete ? void remove(t.id) : setConfirmDelete(true))}
        title={confirmDelete ? "Click again to delete" : "Delete"}
        aria-label={confirmDelete ? "Confirm delete" : "Delete"}
        className={`flex h-6 shrink-0 items-center rounded-full px-1.5 transition-colors ${confirmDelete ? "bg-alert/15 text-alert" : "text-ink-3 opacity-60 hover:text-alert group-hover:opacity-100"}`}
      >
        <Trash2 size={11} />
        {confirmDelete && <span className="ml-1 font-mono text-[9px] uppercase">sure?</span>}
      </button>
    </li>
  );
}
