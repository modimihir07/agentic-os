import { useState } from "react";
import { Box, ChevronRight, ExternalLink, Globe, TerminalSquare } from "lucide-react";
import type { SnapBus, SystemSnapshot } from "@/lib/platform";
import { useNav } from "@/stores/nav";
import { useSettings } from "@/stores/settings";
import { agentTag, busHeaderFix, busNeedsFix, busText, busTone, busWhy, daemonState, fmtAgo, fmtBytes, fmtMb, fmtMs, pct, sortBus, storeRows, storeShares } from "./format";
import { useMemmapData } from "./use-memmap-data";
import { Bar, Dash, Dot, loadTone, openSettings, Panel, Tag, useNow, Val } from "./parts";
import { OsStatePanel } from "./OsStatePanel";

const CARDS_KEY = "cc.memmap.cardsOpen";

/**
 * The left column: OS BACKEND ARCHITECTURE (current OS state + the User Delegation and
 * Overload Cap switches) on top, then the collapsible subsystem cards — agent roster &
 * skills, MCP servers & APIs, persistent stores and hardware telemetry, all from
 * `system_introspect`. The two switches are the only in-page settings (see
 * docs/memory-map-plan.md); every other "fix" is a deep link into Settings.
 */
export function LeftColumn({ className = "" }: { className?: string }) {
  const { snap, error } = useMemmapData();
  const why = error ?? "Waiting for the first system snapshot";
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(CARDS_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(CARDS_KEY, open ? "0" : "1");
    } catch {
      /* private mode: per-session only */
    }
  };
  return (
    <div className={`flex min-h-0 flex-col gap-3 ${className}`}>
      <OsStatePanel />
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="label-caps flex min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap px-1 text-ink-3 transition-colors hover:text-holo"
      >
        <ChevronRight size={11} className={`transition-transform ${open ? "rotate-90" : ""}`} />
        Subsystems
        <span className="min-w-0 truncate font-mono normal-case tracking-normal text-ink-3/70">roster · bus · stores · hw</span>
      </button>
      {open && (
        <>
          <AgentRoster snap={snap} why={why} />
          <BusCard snap={snap} why={why} />
          <StoresCard snap={snap} why={why} />
          <HardwareCard snap={snap} why={why} />
        </>
      )}
    </div>
  );
}

interface CardProps {
  snap: SystemSnapshot | null;
  /** Why there's no data (shown as the "—" tooltips). */
  why: string;
}

// ── Agent roster & skills ───────────────────────────────────────────────────

function AgentRoster({ snap, why }: CardProps) {
  const xray = useSettings((s) => s.systemMapMode) === "xray";
  const agents = snap?.agents ?? [];
  return (
    <Panel title={`Agent roster & skills (${snap ? agents.length : "—"} swarm)`} className="shrink-0">
      {!snap ? (
        <p className="font-mono text-[11px] text-ink-3">
          <Dash why={why} /> no roster yet
        </p>
      ) : (
        <>
          <ul className="grid grid-cols-2 gap-1.5">
            {agents.map((a) => {
              const tag = agentTag(a);
              const model = a.chatModel ?? (a.found === null ? null : "AnythingLLM default");
              return (
                <li
                  key={a.role}
                  className="flex min-w-0 flex-col gap-0.5 rounded-[10px] border border-white/[0.07] bg-white/[0.02] px-2 py-1.5"
                  title={[`${a.label} · workspace ${a.slug}`, model ? `chat model: ${model}` : snap.agentsNote, a.agentModel && `agent model: ${a.agentModel}`, a.threads != null && `${a.threads} threads`].filter(Boolean).join("\n")}
                >
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{a.label}</span>
                    <Tag tone={tag.tone}>{tag.text}</Tag>
                  </div>
                  {xray && <span className="truncate font-mono text-[9.5px] text-ink-3">{model ?? "models —"}</span>}
                </li>
              );
            })}
          </ul>
          <div className="mt-2 flex items-center gap-2 font-mono text-[10.5px] text-ink-2">
            <span className="label-caps text-ink-3">Skills</span>
            <span className="tabular text-ink">{snap.skills.total}</span>
            <span className="truncate text-ink-3" title={snap.skills.roots.map((r) => `${r.path}: ${r.exists ? r.count : "missing"}${r.sameAs ? ` (same as ${r.sameAs})` : ""}`).join("\n")}>
              in {snap.skills.roots.filter((r) => r.exists).length} root{snap.skills.roots.length === 1 ? "" : "s"}
            </span>
            {snap.skills.grantedMissing.length > 0 && (
              <Tag tone="warn" title={`Granted in os.json but not on disk: ${snap.skills.grantedMissing.join(", ")}`}>
                {snap.skills.grantedMissing.length} missing
              </Tag>
            )}
          </div>
          {snap.agentsNote && <p className="mt-1 truncate font-mono text-[10px] text-ember/80" title={snap.agentsNote}>{snap.agentsNote}</p>}
        </>
      )}
    </Panel>
  );
}

// ── MCP servers & APIs ──────────────────────────────────────────────────────

const TRANSPORT_ICON = { builtin: Box, stdio: TerminalSquare, http: Globe } as const;

function BusCard({ snap, why }: CardProps) {
  const go = useNav((s) => s.go);
  const xray = useSettings((s) => s.systemMapMode) === "xray";
  const now = useNow(5000);
  const bus = snap ? sortBus(snap.bus) : [];
  // Failing servers make the header link loud; servers merely awaiting a token keep it muted.
  const { failing, awaiting } = busHeaderFix(bus);
  return (
    <Panel
      title="MCP servers & APIs"
      className="max-h-[300px] shrink-0"
      bodyClassName="overflow-y-auto"
      badge={snap && <span className="font-mono text-[10px] text-ink-3">{bus.filter((b) => b.status === "ok").length}/{bus.length}</span>}
      action={
        failing + awaiting > 0 && (
          <button
            type="button"
            onClick={() => openSettings(go)}
            className={`label-caps flex items-center gap-1 hover:text-ink ${failing > 0 ? "text-ember" : "text-ink-3"}`}
            title={failing > 0 ? "Fix tokens and servers in Settings → Integrations" : "Add tokens in Settings → Integrations"}
          >
            Settings <ExternalLink size={10} />
          </button>
        )
      }
    >
      {!snap ? (
        <p className="font-mono text-[11px] text-ink-3">
          <Dash why={why} /> no bus data yet
        </p>
      ) : (
        <ul className="space-y-1">
          {bus.map((b) => (
            <BusRow key={b.id} b={b} xray={xray} now={now} onFix={() => openSettings(go)} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function BusRow({ b, xray, now, onFix }: { b: SnapBus; xray: boolean; now: number; onFix: () => void }) {
  const Icon = TRANSPORT_ICON[b.transport as keyof typeof TRANSPORT_ICON] ?? Globe;
  const tone = busTone(b.status);
  const err = b.error ?? (b.lastOk === false ? b.lastError : null);
  return (
    <li className={`rounded-[8px] px-1.5 py-1 ${b.status === "off" ? "opacity-50" : ""}`} title={busWhy(b)}>
      <div className="flex min-w-0 items-center gap-2">
        <Icon size={12} className="shrink-0 text-holo/70" />
        <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{b.name}</span>
        {busNeedsFix(b.status) ? (
          <button type="button" onClick={onFix} className="flex shrink-0 items-center gap-1" title={`${busWhy(b)}\n\nOpen Settings → Integrations to fix`}>
            <Dot tone={tone} />
            <span className={`font-mono text-[10.5px] ${tone === "warn" ? "text-ember" : tone === "idle" ? "text-ink-3" : "text-alert"} hover:underline`}>{busText(b.status)}</span>
          </button>
        ) : (
          <span className="flex shrink-0 items-center gap-1">
            <Dot tone={tone} />
            {b.status === "unknown" ? <Dash why={busWhy(b)} /> : <span className={`font-mono text-[10.5px] ${tone === "ok" ? "text-teal-soft" : "text-ink-3"}`}>{busText(b.status)}</span>}
          </span>
        )}
      </div>
      {err && b.status !== "ok" && <p className="ml-5 truncate font-mono text-[9.5px] text-ink-3">{err}</p>}
      {xray && (
        <p className="ml-5 truncate font-mono text-[9.5px] text-ink-3">
          {b.transport}
          {b.tools != null && ` · ${b.tools} tools`}
          {b.calls != null && ` · ${b.calls} calls${b.failures ? ` (${b.failures} failed)` : ""}`}
          {b.lastMs != null && ` · last ${fmtMs(b.lastMs)}`}
          {b.lastAt != null && ` ${fmtAgo(b.lastAt * 1000, now)}`}
          {b.source && ` · key: ${b.source}`}
        </p>
      )}
    </li>
  );
}

// ── Persistent stores ───────────────────────────────────────────────────────

function StoresCard({ snap, why }: CardProps) {
  const xray = useSettings((s) => s.systemMapMode) === "xray";
  const stores = snap?.stores ?? [];
  const shares = storeShares(stores);
  return (
    <Panel
      title="Persistent stores"
      className="shrink-0"
      badge={snap && <span className="font-mono text-[10px] text-ink-3">{snap.summary.storesOk}/{snap.summary.storesTotal} ok</span>}
    >
      {!snap ? (
        <p className="font-mono text-[11px] text-ink-3">
          <Dash why={why} /> no store data yet
        </p>
      ) : (
        <ul className="space-y-2">
          {stores.map((s) => {
            const rows = storeRows(s);
            const share = shares.get(s.id) ?? null;
            const tone = s.health === "ok" ? "ok" : s.health === "missing" ? "warn" : "down";
            const metric = s.metrics.ragVectors != null ? `${s.metrics.ragVectors} vectors` : s.metrics.todayLines != null ? `${s.metrics.todayLines} lines today` : s.metrics.entities != null ? `${s.metrics.entities} entities` : null;
            return (
              <li key={s.id} title={[s.path, s.error, ...s.tables.map((t) => `${t.name}: ${t.rows ?? "?"}`)].filter(Boolean).join("\n")}>
                <div className="flex min-w-0 items-center gap-2">
                  <Dot tone={tone} />
                  <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{s.label}</span>
                  <span className="shrink-0 font-mono text-[10.5px] text-ink-2 tabular">
                    {s.health === "missing" ? <span className="text-ember">missing</span> : <Val value={fmtBytes(s.bytes)} why={s.error ?? "Size unknown"} />}
                  </span>
                </div>
                <div className="ml-3.5 mt-1">
                  <Bar value={share} tone={s.health === "ok" ? "holo" : "ember"} why={s.health === "ok" ? "Size unknown" : (s.error ?? "Store not found")} />
                </div>
                <p className="ml-3.5 mt-0.5 truncate font-mono text-[9.5px] text-ink-3">
                  {s.health === "error" && s.error ? (
                    <span className="text-alert">{s.error}</span>
                  ) : (
                    <>
                      {rows != null ? `${rows.toLocaleString()} rows` : s.tables.length ? "rows —" : s.kind}
                      {metric && ` · ${metric}`}
                      {s.writable === false && " · read-only"}
                      {xray && s.path && ` · ${s.path}`}
                    </>
                  )}
                </p>
              </li>
            );
          })}
        </ul>
      )}
      {snap && <p className="mt-2 font-mono text-[9px] text-ink-3">bar = share of total on-disk size</p>}
    </Panel>
  );
}

// ── Hardware ────────────────────────────────────────────────────────────────

function HardwareCard({ snap, why }: CardProps) {
  const xray = useSettings((s) => s.systemMapMode) === "xray";
  const now = useNow(5000);
  const h = snap?.host;
  const gpuWhy = h?.gpuNote ?? h?.error ?? why;
  const vram = pct(h?.gpu?.vramUsedMb, h?.gpu?.vramTotalMb);
  const ram = pct(h?.memUsedMb, h?.memTotalMb);
  const cpu = h?.cpuPct ?? null;
  const daemon = snap ? daemonState(snap.routines.loops) : null;
  return (
    <Panel title="Hardware workstation telemetry" className="shrink-0">
      <div className="space-y-2.5">
        <Meter label="VRAM" value={vram} why={gpuWhy} text={h?.gpu ? `${fmtMb(h.gpu.vramUsedMb)} / ${fmtMb(h.gpu.vramTotalMb)}` : null} />
        <Meter label="GPU" value={h?.gpu?.utilPct ?? null} why={gpuWhy} text={h?.gpu ? `${Math.round(h.gpu.utilPct)}%` : null} />
        <Meter label="CPU" value={cpu} why={h?.error ?? why} text={cpu != null ? `${Math.round(cpu)}%` : null} />
        <Meter label="RAM" value={ram} why={h?.error ?? why} text={h?.memUsedMb != null && h.memTotalMb != null ? `${fmtMb(h.memUsedMb)} / ${fmtMb(h.memTotalMb)}` : null} />
      </div>
      <div
        className="mt-3 flex items-center gap-2 border-t border-white/[0.06] pt-2"
        title={snap ? snap.routines.loops.map((l) => `${l.label}: ${l.lastRun ? `${fmtAgo(l.lastRun, now)}${l.overdue ? " (overdue)" : ""}${l.lastOk === false ? ` — ${l.detail ?? "failed"}` : ""}` : "not run yet"}`).join("\n") : why}
      >
        {daemon ? (
          <>
            <Dot tone={daemon.healthy === daemon.ran ? "ok" : "warn"} />
            <span className={`label-caps ${daemon.healthy === daemon.ran ? "text-teal-soft" : "text-ember"}`}>{daemon.healthy === daemon.ran ? "Daemon active" : "Daemon degraded"}</span>
            <span className="ml-auto font-mono text-[10px] text-ink-3">
              {daemon.healthy}/{daemon.total} loops
            </span>
          </>
        ) : (
          <>
            <Dot tone="idle" />
            <span className="label-caps text-ink-3">Daemon</span>
            <span className="ml-auto">
              <Dash why={snap ? "No background loop has run since the app started" : why} />
            </span>
          </>
        )}
      </div>
      {xray && h && (
        <p className="mt-1 truncate font-mono text-[9.5px] text-ink-3" title={h.cpuBrand ?? undefined}>
          {h.hostname ?? "host"} · {h.cpuBrand ?? "cpu —"} · {h.cpuThreads}t
        </p>
      )}
    </Panel>
  );
}

function Meter({ label, value, text, why }: { label: string; value: number | null; text: string | null; why: string }) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className="label-caps text-ink-3">{label}</span>
        <span className="ml-auto font-mono text-[10.5px] text-ink-2 tabular">{text ?? <Dash why={why} />}</span>
      </div>
      <Bar value={value} tone={loadTone(value)} why={why} />
    </div>
  );
}
