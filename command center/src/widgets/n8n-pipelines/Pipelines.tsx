import { useCallback, useEffect, useRef, useState } from "react";
import { CloudUpload, FolderSync, Loader2, Play, RefreshCw } from "lucide-react";
import type { WidgetProps } from "@/core/widgets/types";
import { cmd, type InstanceStatus, type PipelinesSettings, type PipelinesView, type SyncResult, type WorkflowStatus } from "@/lib/platform";
import { useNow } from "@/lib/cc-api";
import { gated } from "@/features/bridge/gate";
import { useToasts } from "@/features/reminders/notify";

/**
 * n8n Pipelines & Drive Sync — a compact live feed (no node graphs).
 * Teal = active/healthy/synced · Coral = running live or failed · Slate = idle/paused/offline.
 * Every Run / toggle / sync goes through the Permission Bridge (Execute + Network).
 */
export default function Pipelines({ size }: WidgetProps) {
  const [view, setView] = useState<PipelinesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [syncing, setSyncing] = useState(false);
  const [paths, setPaths] = useState<PipelinesSettings["resolvedPaths"]>([]);
  const now = useNow(15_000);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const intervalSec = useRef(15);

  const poll = useCallback(async () => {
    try {
      const v = await cmd("pipelines_status");
      intervalSec.current = v.pollIntervalSeconds;
      setView(v);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  // Non-blocking poll loop at the configured interval; paused while hidden.
  useEffect(() => {
    let alive = true;
    const loop = async () => {
      if (!document.hidden) await poll();
      if (alive) timer.current = setTimeout(loop, intervalSec.current * 1000);
    };
    void loop();
    void cmd("pipelines_settings").then((s) => setPaths(s.resolvedPaths)).catch(() => undefined);
    return () => {
      alive = false;
      clearTimeout(timer.current);
    };
  }, [poll]);

  const toast = useToasts.getState().push;
  const key = (w: WorkflowStatus) => `${w.instanceId}/${w.workflowId}`;

  const run = async (w: WorkflowStatus) => {
    setBusy((b) => ({ ...b, [key(w)]: true }));
    try {
      const r = await gated(
        { action: "n8n.run", summary: `Run “${w.name}” on ${w.instanceLabel}`, detail: { workflowId: w.workflowId } },
        (approved) => cmd("pipeline_run", { instanceId: w.instanceId, workflowId: w.workflowId, approved }),
        (r) => `${w.name}: ${r.status} — ${r.detail}`,
      );
      if (r) toast({ title: `${w.name}: ${r.status}`, body: r.detail, tone: r.status === "error" ? "error" : "info" });
    } catch (e) {
      toast({ title: `Couldn't run ${w.name}`, body: String(e), tone: "error" });
    } finally {
      setBusy((b) => ({ ...b, [key(w)]: false }));
      void poll();
    }
  };

  const toggle = async (w: WorkflowStatus) => {
    setBusy((b) => ({ ...b, [key(w)]: true }));
    try {
      await gated(
        { action: "n8n.toggle", summary: `${w.isActive ? "Pause" : "Activate"} “${w.name}” on ${w.instanceLabel}`, detail: { workflowId: w.workflowId } },
        (approved) => cmd("pipeline_set_active", { instanceId: w.instanceId, workflowId: w.workflowId, active: !w.isActive, approved }),
        (active) => `${w.name} is now ${active ? "active" : "paused"}.`,
      );
    } catch (e) {
      toast({ title: `Couldn't change ${w.name}`, body: String(e), tone: "error" });
    } finally {
      setBusy((b) => ({ ...b, [key(w)]: false }));
      void poll();
    }
  };

  const sync = async () => {
    setSyncing(true);
    try {
      const r = await gated(
        { action: "gdrive.sync", summary: "Sync tracked folders to Google Drive" },
        (approved) => cmd("trigger_gdrive_sync", { approved }),
        (r: SyncResult) => `Drive sync: ${r.status} — ${r.detail}`,
      );
      if (r) toast({ title: `Drive sync: ${r.status}`, body: r.detail, tone: r.status === "synced" || r.status === "up-to-date" ? "info" : "error" });
    } catch (e) {
      toast({ title: "Drive sync failed", body: String(e), tone: "error" });
    } finally {
      setSyncing(false);
      void poll();
    }
  };

  const workflows = (view?.instances ?? []).flatMap((i) => i.workflows);
  const problems = (view?.instances ?? []).filter((i) => i.status !== "online");
  const online = view?.online ?? false;
  const compact = size.h <= 2;

  return (
    <div className="flex h-full min-h-48 flex-col">
      {/* Top bar */}
      <header className="mb-2 flex flex-wrap items-center gap-2">
        <span
          className={`label-caps flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${online ? "border-pipe-ok/50 text-pipe-ok" : "border-pipe-idle/60 text-pipe-idle"}`}
          title={problems.map((p) => `${p.label}: ${p.detail}`).join("\n")}
        >
          <span className={`size-1.5 rounded-full ${online ? "bg-pipe-ok shadow-[0_0_8px_#14b8a6]" : "bg-pipe-idle"}`} />
          n8n {view ? (online ? "online" : "offline") : "…"}
        </span>
        <span className="font-mono text-[11px] text-ink-2 tabular">
          {view?.activeSessions ?? 0} active
          {view?.running ? <span className="text-pipe-live"> · {view.running} running</span> : null}
        </span>
        <button onClick={() => void poll()} aria-label="Refresh pipelines" className="grid size-6 place-items-center rounded-full text-ink-3 hover:text-ink">
          <RefreshCw size={11} />
        </button>
        <button onClick={() => void sync()} disabled={syncing} className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-full border border-pipe-ok/50 bg-pipe-ok/15 px-3 text-[12px] font-medium text-ink transition-colors hover:bg-pipe-ok/25 disabled:opacity-60">
          {syncing ? <Loader2 size={13} className="animate-spin" /> : <CloudUpload size={13} />} Sync to Google Drive
        </button>
      </header>

      {/* Instance problems (offline / needs key) */}
      {problems.map((p) => (
        <InstanceNotice key={p.id} i={p} />
      ))}
      {error && <p className="mb-1.5 text-[11px] text-pipe-live">{error.startsWith("PERMISSION_") ? `Permission Bridge: ${error}` : error}</p>}

      {/* Pipeline feed */}
      <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto">
        {workflows.map((w) => (
          <Row key={key(w)} w={w} now={now} busy={!!busy[key(w)]} onRun={() => void run(w)} onToggle={() => void toggle(w)} multi={(view?.instances.length ?? 0) > 1} />
        ))}
        {view && !workflows.length && !problems.length && <li className="py-3 text-center text-xs text-ink-3">No workflows on this instance yet.</li>}
        {!view && !error && (
          <li className="flex items-center gap-2 py-3 text-xs text-ink-3">
            <Loader2 size={12} className="animate-spin" /> Polling n8n…
          </li>
        )}
      </ul>

      {/* Drive sync footer */}
      <footer className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-white/5 pt-2 text-[11px]">
        <span className="flex items-center gap-1.5 text-ink-2">
          <FolderSync size={12} className={syncTone(view?.lastSync?.status)} />
          Last Drive backup: <b className="font-medium text-ink">{view?.lastSync ? ago(view.lastSync.at, now) : "never"}</b>
          {view?.lastSync && <span className={syncTone(view.lastSync.status)}>· {view.lastSync.status}</span>}
        </span>
        {!compact && view?.lastSync?.detail && <span className="truncate text-ink-3">{view.lastSync.detail}</span>}
        <span className="ml-auto flex flex-wrap gap-1">
          {paths.map((p) => (
            <span key={p.path} title={p.path + (p.exists ? "" : " (missing)")} className={`rounded-full border px-1.5 py-px font-mono text-[10px] ${p.exists ? "border-white/10 text-ink-2" : "border-white/5 text-ink-3 line-through"}`}>
              {base(p.path)}
            </span>
          ))}
        </span>
      </footer>
    </div>
  );
}

function Row({ w, now, busy, onRun, onToggle, multi }: { w: WorkflowStatus; now: number; busy: boolean; onRun: () => void; onToggle: () => void; multi: boolean }) {
  const dot =
    w.lastStatus === "running"
      ? "bg-pipe-live shadow-[0_0_8px_#f43f5e] animate-pulse"
      : w.lastStatus === "error"
        ? "bg-pipe-live"
        : w.isActive
          ? "bg-pipe-ok shadow-[0_0_6px_#14b8a6]"
          : "bg-pipe-idle";
  const ts = w.lastRunTimestamp ? Date.parse(w.lastRunTimestamp) : NaN;
  const when = Number.isFinite(ts) ? `${ago(ts, now)}${w.durationMs != null ? ` • ${fmtMs(w.durationMs)}` : ""}` : "never run";
  return (
    <li className="group flex items-center gap-2.5 rounded-[10px] border border-white/[0.05] bg-pipe-surface/30 px-2.5 py-1.5">
      <span className={`size-2 shrink-0 rounded-full ${dot}`} title={w.lastStatus} />
      <span className="min-w-0 flex-1 truncate text-[13px] text-ink" title={w.name}>
        {w.name}
      </span>
      {(multi || w.instanceLabel) && <span className="hidden shrink-0 rounded-full bg-pipe-raised/70 px-2 py-px font-mono text-[10px] text-ink-2 sm:inline">{w.instanceLabel.replace(/^n8n\s*/i, "") || "local"}</span>}
      <span className={`w-28 shrink-0 text-right font-mono text-[11px] tabular ${w.lastStatus === "error" ? "text-pipe-live" : "text-ink-3"}`}>{w.lastStatus === "running" ? "running now" : when}</span>
      <button
        onClick={onRun}
        disabled={busy || !w.runnable || !w.isActive}
        title={!w.runnable ? "Add a Webhook trigger to run it from here" : !w.isActive ? "Activate it first" : "Run now (asks first)"}
        aria-label={`Run ${w.name}`}
        className="grid size-7 shrink-0 place-items-center rounded-full border border-white/10 text-ink-2 hover:border-pipe-ok/60 hover:text-pipe-ok disabled:opacity-30"
      >
        {busy ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} fill="currentColor" />}
      </button>
      <button
        role="switch"
        aria-checked={w.isActive}
        aria-label={`${w.isActive ? "Pause" : "Activate"} ${w.name}`}
        title={w.isActive ? "Active — click to pause" : "Paused — click to activate"}
        disabled={busy}
        onClick={onToggle}
        className={`relative h-4 w-7 shrink-0 rounded-full transition-colors disabled:opacity-50 ${w.isActive ? "bg-pipe-ok/80" : "bg-pipe-idle/60"}`}
      >
        <span className={`absolute top-0.5 size-3 rounded-full bg-white shadow transition-[left] duration-200 ${w.isActive ? "left-3.5" : "left-0.5"}`} />
      </button>
    </li>
  );
}

function InstanceNotice({ i }: { i: InstanceStatus }) {
  const msg: Record<InstanceStatus["status"], string> = {
    online: "",
    offline: "OFFLINE",
    "no-key": "needs API key",
    unauthorized: "API key rejected",
    error: "error",
  };
  return (
    <p className="mb-1.5 flex items-center gap-2 rounded-[10px] border border-pipe-idle/30 bg-pipe-surface/40 px-2.5 py-1.5 text-[11px]">
      <span className="size-1.5 shrink-0 rounded-full bg-pipe-idle" />
      <b className="font-medium text-ink">{i.label}</b>
      <span className="label-caps text-pipe-idle">{msg[i.status]}</span>
      <span className="truncate text-ink-3">{i.detail}</span>
    </p>
  );
}

function syncTone(s?: SyncResult["status"]) {
  if (s === "synced" || s === "up-to-date") return "text-pipe-ok";
  if (s === "failed" || s === "offline") return "text-pipe-live";
  return "text-pipe-idle";
}

function ago(ms: number, now: number) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

function fmtMs(ms: number) {
  return ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 60_000)}m`;
}

function base(p: string) {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}
