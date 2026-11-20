import { useMemo, useRef, useState } from "react";
import { Pause, Play, Trash2, Wrench } from "lucide-react";
import type { TraceStep } from "@/lib/platform";
import { isTauri } from "@/lib/platform";
import { useSettings } from "@/stores/settings";
import { useToasts } from "@/features/reminders/notify";
import { ipcSummary, useIpcRing } from "@/lib/ipc-ring";
import { groupTraces, stepsSince, useTrace, type TraceGroup } from "./trace-store";
import { fixTitle, fmtClock, fmtMs, slowestHop } from "./format";
import { useDevQueue } from "./dev-queue";
import { Panel, Tag, useNow } from "./parts";

/** A trace counts as live (the "Active" badge) this long after its last step. */
const ACTIVE_MS = 15_000;
const SHOWN = 40;

const HOP_WORD: Record<TraceStep["hop"], string> = {
  input: "Input",
  vad: "Voice detect",
  stt: "Speech-to-text",
  router: "Router",
  rules: "Rules",
  memory: "Memory",
  model: "Model",
  tool: "Tool",
  tts: "Speech",
  ui: "Screen",
};

const stepKey = (s: TraceStep) => `${s.traceId}#${s.seq}#${s.hop}#${s.at}`;

/**
 * REAL-TIME ACTION & STREAM: the live routing trace (`useTrace`), newest turn first.
 * Scrolling down pauses it (so a row doesn't move under the cursor); back at the top it
 * resumes. A failed step gets Queue Fix, which logs it to the dev queue with the step and
 * its error attached. Dev X-Ray adds per-hop ms, the slowest hop and the IPC ring.
 */
export function TraceStream({ className = "" }: { className?: string }) {
  const steps = useTrace((s) => s.steps);
  const clear = useTrace((s) => s.clear);
  const xray = useSettings((s) => s.systemMapMode) === "xray";
  const now = useNow(2000);
  const [frozen, setFrozen] = useState<TraceStep[] | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const shown = frozen ?? steps;
  const groups = useMemo(() => groupTraces(shown).slice(0, SHOWN), [shown]);
  const live = steps.length > 0 && now - steps[steps.length - 1].at < ACTIVE_MS;
  const fresh = frozen ? stepsSince(steps, frozen) : 0;

  const resume = () => {
    setFrozen(null);
    scroller.current?.scrollTo({ top: 0 });
  };

  return (
    <div className={`flex min-h-0 flex-col gap-3 ${className}`}>
      <Panel
        title="Real-time action & stream"
        className="min-h-[220px] flex-1"
        bodyClassName="!p-0 flex flex-col"
        badge={live ? <Tag tone="ok">Active</Tag> : <Tag tone="idle">Idle</Tag>}
        action={
          <>
            <button
              type="button"
              onClick={() => (frozen ? resume() : setFrozen(steps))}
              className="grid size-6 place-items-center rounded-full text-ink-3 hover:text-holo"
              title={frozen ? "Resume the stream" : "Pause the stream"}
              aria-label={frozen ? "Resume" : "Pause"}
            >
              {frozen ? <Play size={12} /> : <Pause size={12} />}
            </button>
            <button type="button" onClick={() => (clear(), setFrozen(null))} className="grid size-6 place-items-center rounded-full text-ink-3 hover:text-alert" title="Clear the stream (this window only)" aria-label="Clear">
              <Trash2 size={12} />
            </button>
          </>
        }
      >
        {frozen && (
          <button type="button" onClick={resume} className="label-caps border-b border-holo/10 bg-holo/[0.06] px-3 py-1 text-left text-holo">
            Paused{fresh > 0 ? ` · ${fresh} new step${fresh === 1 ? "" : "s"}` : ""} — resume
          </button>
        )}
        <div
          ref={scroller}
          onScroll={(e) => {
            const top = e.currentTarget.scrollTop;
            if (top > 24 && !frozen) setFrozen(steps);
            else if (top <= 2 && frozen) setFrozen(null);
          }}
          className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-[10.5px] leading-[1.55]"
          role="log"
          aria-live="off"
        >
          {groups.length === 0 ? (
            <p className="text-ink-3">
              {isTauri() ? "No turns yet. Talk to Tony or type a command — each hop of the route shows up here." : "The live trace comes from the desktop app."}
            </p>
          ) : (
            groups.map((g) => <TraceBlock key={g.traceId} g={g} xray={xray} />)
          )}
        </div>
      </Panel>
      {xray && <IpcPanel />}
    </div>
  );
}

function TraceBlock({ g, xray }: { g: TraceGroup; xray: boolean }) {
  const slow = xray ? slowestHop(g.steps) : null;
  return (
    <div className="mb-2 border-l border-holo/20 pl-2">
      <div className="flex items-center gap-2 text-ink-3">
        <span className="tabular">{fmtClock(g.endedAt)}</span>
        <span className="min-w-0 flex-1 truncate uppercase tracking-wider text-holo/80">{g.path.join(" → ")}</span>
        {xray ? <span className="tabular">{fmtMs(g.ms)}</span> : null}
        <span className={g.ok ? "text-teal-soft" : "text-alert"}>{g.ok ? "ok" : "failed"}</span>
      </div>
      {g.steps.map((s) => (
        <StepLine key={stepKey(s)} s={s} xray={xray} slowest={slow === s} />
      ))}
    </div>
  );
}

function StepLine({ s, xray, slowest }: { s: TraceStep; xray: boolean; slowest: boolean }) {
  return (
    <div className="pl-1">
      <div className="flex min-w-0 items-center gap-2">
        <span className={`size-1.5 shrink-0 rounded-full ${s.ok ? "bg-teal/80" : "bg-alert"}`} />
        <span className={`w-[92px] shrink-0 truncate ${s.ok ? "text-ink-2" : "text-alert"}`}>{xray ? s.hop.toUpperCase() : HOP_WORD[s.hop]}</span>
        <span className="min-w-0 flex-1 truncate text-ink" title={s.label}>
          {s.label}
        </span>
        {xray && s.tps != null && <span className="shrink-0 text-ink-3">{s.tps} t/s</span>}
        {xray && <span className={`shrink-0 tabular ${slowest ? "text-ember" : "text-ink-3"}`}>{fmtMs(s.ms) ?? "—"}</span>}
        {slowest && <span className="shrink-0 text-[9px] uppercase text-ember">slowest</span>}
      </div>
      {!s.ok && (
        <div className="ml-3.5 flex items-start gap-2">
          <span className="min-w-0 flex-1 break-words text-ink-3">{s.error ?? "failed"}</span>
          <QueueFix s={s} />
        </div>
      )}
    </div>
  );
}

const queued = new Set<string>();

function QueueFix({ s }: { s: TraceStep }) {
  const add = useDevQueue((q) => q.add);
  const [state, setState] = useState<"idle" | "busy" | "done">(() => (queued.has(stepKey(s)) ? "done" : "idle"));
  if (!isTauri()) return null;
  const run = async () => {
    setState("busy");
    try {
      const { traceId, seq, hop, zone, label, ok, ms, error, at } = s;
      await add({ title: fixTitle(s), body: error ?? "", kind: "fix", source: "trace", trace: { traceId, seq, hop, zone, label, ok, ms, error, at } });
      queued.add(stepKey(s));
      setState("done");
    } catch (e) {
      setState("idle");
      useToasts.getState().push({ title: "Couldn't queue the fix", body: e instanceof Error ? e.message : String(e), tone: "error" });
    }
  };
  return (
    <button
      type="button"
      disabled={state !== "idle"}
      onClick={() => void run()}
      className={`flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[9px] uppercase tracking-wider transition-colors ${state === "done" ? "border-teal/30 text-teal-soft" : "border-ember/40 text-ember hover:bg-ember/10"} disabled:cursor-default`}
      title="Log this failure to the dev task queue (the step and its error are attached)"
    >
      <Wrench size={9} /> {state === "done" ? "Queued" : state === "busy" ? "…" : "Queue fix"}
    </button>
  );
}

/** Dev X-Ray: recent Tauri command names with timings (names only — never arguments). */
function IpcPanel() {
  const calls = useIpcRing((s) => s.calls);
  const rows = useMemo(() => ipcSummary(calls).slice(0, 10), [calls]);
  const recent = calls.slice(-1)[0];
  const now = useNow(2000);
  return (
    <Panel title="IPC ring" className="max-h-[200px] shrink-0" bodyClassName="overflow-y-auto" badge={recent && now - recent.at < ACTIVE_MS ? <Tag tone="ok">Active</Tag> : undefined} action={<span className="font-mono text-[10px] text-ink-3">{calls.length}/200</span>}>
      {rows.length === 0 ? (
        <p className="font-mono text-[10.5px] text-ink-3">{isTauri() ? "No commands invoked yet." : "IPC timings come from the desktop app."}</p>
      ) : (
        <table className="w-full font-mono text-[10px]">
          <thead className="text-left text-ink-3">
            <tr>
              <th className="font-normal">command</th>
              <th className="text-right font-normal">n</th>
              <th className="text-right font-normal">p50</th>
              <th className="text-right font-normal">max</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className={r.failures ? "text-alert" : "text-ink-2"} title={r.failures ? `${r.failures} failed` : undefined}>
                <td className="max-w-[150px] truncate">{r.name}</td>
                <td className="text-right tabular">{r.count}</td>
                <td className="text-right tabular">{r.medianMs}</td>
                <td className="text-right tabular">{r.maxMs}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
