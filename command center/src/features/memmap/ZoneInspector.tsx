import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ExternalLink, X } from "lucide-react";
import type { SystemSnapshot, TraceStep, TraceZone } from "@/lib/platform";
import { useNav } from "@/stores/nav";
import { useSettings } from "@/stores/settings";
import { STATE_LABEL, useVoice } from "@/features/voice/voice-store";
import { hopStats, useTrace, ZONES } from "./trace-store";
import { agentTag, busNeedsFix, busText, busTone, busWhy, fmtAgo, fmtBytes, fmtClock, fmtMs, latestTps, slowestHop, sortBus, storeRows } from "./format";
import { useMemmapData } from "./use-memmap-data";
import { Dash, Dot, openSettings, Tag, useNow } from "./parts";
import { ZONE_TITLE, useZoneUi } from "./zone-store";

/**
 * ZONE INSPECTOR: the drawer that opens over the right column when a car zone (or its
 * callout card) is clicked. Live drill-downs per zone (plan §3), all from
 * `system_introspect` and the routing trace; "fix" actions deep-link to Settings.
 * Read-only: nothing here mutates anything. Esc or ✕ closes it.
 */

const ZONE_SHORT: Record<TraceZone, string> = { engine: "Engine", ecu: "ECU", cockpit: "Cockpit", cargo: "Cargo", exhaust: "Exhaust" };

export function ZoneInspector() {
  const zone = useZoneUi((s) => s.selected);
  const select = useZoneUi((s) => s.select);
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!zone) return;
    close.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") useZoneUi.getState().select(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zone]);

  if (!zone) return null;
  return (
    <aside
      aria-label={`${ZONE_TITLE[zone]} inspector`}
      className="fixed inset-x-2 bottom-2 z-40 flex max-h-[78vh] flex-col rounded-[14px] border border-holo/30 bg-[rgba(5,9,14,0.97)] shadow-[0_0_32px_-10px_rgba(0,210,255,0.55)] lg:absolute lg:inset-0 lg:z-20 lg:max-h-none"
    >
      <header className="flex min-h-9 items-center gap-2 border-b border-holo/15 px-3 py-2">
        <h2 className="label-caps min-w-0 flex-1 truncate text-holo" title={ZONE_TITLE[zone]}>
          {ZONE_TITLE[zone]}
        </h2>
        <button ref={close} type="button" onClick={() => select(null)} className="grid size-6 place-items-center rounded-full text-ink-3 hover:text-ink" aria-label="Close inspector">
          <X size={13} />
        </button>
      </header>
      <nav className="flex gap-1 border-b border-holo/10 px-2 py-1.5" aria-label="Zones">
        {ZONES.map((z) => (
          <button
            key={z}
            type="button"
            onClick={() => z !== zone && select(z)}
            aria-current={z === zone ? "true" : undefined}
            className={`label-caps rounded-full border px-2 py-0.5 !text-[9px] ${z === zone ? "border-ember/50 bg-ember/10 text-ember" : "border-white/10 text-ink-3 hover:text-holo"}`}
          >
            {ZONE_SHORT[z]}
          </button>
        ))}
      </nav>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 font-mono text-[10.5px]">
        <ZoneBody zone={zone} />
        <RecentSteps zone={zone} />
      </div>
    </aside>
  );
}

function ZoneBody({ zone }: { zone: TraceZone }) {
  const { snap, error } = useMemmapData();
  const why = error ?? "Waiting for the first system snapshot";
  switch (zone) {
    case "engine":
      return <EngineZone snap={snap} why={why} />;
    case "ecu":
      return <EcuZone snap={snap} why={why} />;
    case "cargo":
      return <CargoZone snap={snap} why={why} />;
    case "cockpit":
      return <CockpitZone />;
    case "exhaust":
      return <ExhaustZone snap={snap} why={why} />;
  }
}

// ── Primitives ───────────────────────────────────────────────────────────────

function Sub({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="space-y-1">
      <div className="flex items-center gap-2">
        <h3 className="label-caps !text-[9px] text-holo/80">{title}</h3>
        {aside && <div className="ml-auto flex items-center gap-1.5">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

function Row({ k, v, why, tone, title }: { k: ReactNode; v: ReactNode | null | undefined; why?: string; tone?: string; title?: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2" title={title}>
      <span className="min-w-0 shrink truncate text-ink-2">{k}</span>
      <span className={`ml-auto shrink-0 text-right tabular ${tone ?? "text-ink"}`}>{v == null || v === "" ? <Dash why={why ?? "No live source"} /> : v}</span>
    </div>
  );
}

function NoSnap({ why }: { why: string }) {
  return (
    <p className="text-ink-3">
      <Dash why={why} /> no system snapshot yet
    </p>
  );
}

const useXray = () => useSettings((s) => s.systemMapMode) === "xray";

// ── Engine: Tony's provider chain, sub-agents, tokens/s ─────────────────────

function EngineZone({ snap, why }: { snap: SystemSnapshot | null; why: string }) {
  const xray = useXray();
  const steps = useTrace((s) => s.steps);
  const tps = useMemo(() => latestTps(steps), [steps]);
  const model = useMemo(() => hopStats(steps).model, [steps]);
  if (!snap) return <NoSnap why={why} />;
  const subs = snap.agents.filter((a) => a.role !== "general");
  const tony = snap.agents.find((a) => a.role === "general");
  return (
    <>
      <Sub title="Tony → provider chain">
        {snap.chain.length === 0 ? (
          <Row k="Chain" v={null} why="No provider chain in providers.json (policy.chain)" />
        ) : (
          <ol className="space-y-1">
            {snap.chain.map((c, i) => {
              const svc = snap.services.find((s) => s.id === c.id);
              const state = svc ? (svc.up ? "up" : svc.manual ? "off" : "down") : null;
              return (
                <li key={c.id} className="flex min-w-0 items-center gap-2" title={[c.label, c.kind, c.model, svc?.detail].filter(Boolean).join(" · ")}>
                  <span className="w-3 shrink-0 text-ink-3">{i + 1}</span>
                  <Dot tone={state === "up" ? "ok" : state === "down" ? "down" : "idle"} />
                  <span className="min-w-0 truncate text-ink">{c.label}</span>
                  <Tag tone={c.local ? "ok" : "idle"}>{c.local ? "Local" : "Remote"}</Tag>
                  <span className="ml-auto shrink-0 text-ink-2">
                    {state === "up" ? fmtMs(svc?.latencyMs) : state ? state : <Dash why={c.local ? "Not in the loopback probe list" : "Remote providers aren't probed (no network calls from the map)"} />}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
        {xray && snap.chain.length > 0 && <p className="truncate text-ink-3">{snap.chain.map((c) => `${c.id}:${c.model || "—"}`).join(" → ")}</p>}
      </Sub>
      <Sub title="Last reply">
        <Row k="Tokens/s" v={tps != null ? `${tps}` : null} why="Measured from the next streamed reply" />
        <Row k="Model hop" v={model ? `${fmtMs(model.lastMs)}${xray ? ` · p50 ${fmtMs(model.medianMs)} · ${model.count}×` : ""}` : null} why="No model hop traced yet this session" />
        <Row k="Tony's workspace" v={tony ? (tony.chatModel ?? (tony.found === null ? null : "AnythingLLM default")) : null} why={snap.agentsNote ?? "Not reported"} />
      </Sub>
      <Sub title={`Sub-agents (${subs.filter((a) => a.active).length} active / ${subs.length})`}>
        <ul className="space-y-1">
          {subs.map((a) => {
            const tag = agentTag(a);
            const model = a.chatModel ?? (a.found === null ? null : "AnythingLLM default");
            return (
              <li key={a.role} className="flex min-w-0 items-center gap-2" title={[`workspace ${a.slug}`, a.agentModel && `agent model: ${a.agentModel}`, a.threads != null && `${a.threads} threads`].filter(Boolean).join("\n")}>
                <span className="min-w-0 flex-1 truncate text-ink">
                  {a.label}
                  {xray && <span className="text-ink-3"> · {a.slug}</span>}
                </span>
                <span className="max-w-[45%] truncate text-ink-2">{model ?? <Dash why={snap.agentsNote ?? "AnythingLLM unreachable"} />}</span>
                <Tag tone={tag.tone}>{tag.text}</Tag>
              </li>
            );
          })}
        </ul>
      </Sub>
      <Sub title="GPU slot">
        <Row k="Holding it" v={snap.slot.active.length ? snap.slot.active.join(", ") : "idle"} />
        <Row k="Queued" v={`${snap.slot.queuedForeground} fg · ${snap.slot.queuedBackground} bg`} />
        <Row k="Capacity" v={`${snap.slot.capacity}`} />
      </Sub>
    </>
  );
}

// ── ECU: rules, skills, routines ─────────────────────────────────────────────

function EcuZone({ snap, why }: { snap: SystemSnapshot | null; why: string }) {
  const xray = useXray();
  const now = useNow(5000);
  const [q, setQ] = useState("");
  const skills = useMemo(() => {
    const items = snap?.skills.items ?? [];
    const t = q.trim().toLowerCase();
    if (!t) return items;
    return items.filter((s) => s.name.toLowerCase().includes(t) || s.description.toLowerCase().includes(t) || s.agents.some((a) => a.toLowerCase().includes(t)));
  }, [snap, q]);
  if (!snap) return <NoSnap why={why} />;
  const { rules, routines } = snap;
  const id = rules.identity;
  return (
    <>
      <Sub title="Rules">
        <Row
          k="MASTER_IDENTITY.md"
          v={id ? `${fmtBytes(id.bytes) ?? "?"} · ${id.headings} headings · ${id.bullets} bullets` : null}
          why={rules.identityError ?? "Not found"}
          tone={id ? "text-teal-soft" : "text-ember"}
          title={id ? id.path : undefined}
        />
        {id && <Row k="In the system prompt" v={`${id.promptChars.toLocaleString()} chars`} />}
        {id && <Row k="Edited" v={fmtAgo(id.modifiedMs, now)} why="No modification time" />}
        <Row k="Root directive" v={rules.rootDirective ? "present" : "absent"} tone={rules.rootDirective ? "text-teal-soft" : "text-ink-3"} />
        <Row k="HANDOFF guardrails" v={rules.guardrails != null ? `${rules.guardrails}` : null} why={rules.guardrailsNote ?? "HANDOFF.md not found"} title={rules.guardrailsPath} />
        {xray && id && <p className="truncate text-ink-3" title={id.path}>{id.path}</p>}
        {xray && id && id.sections.length > 0 && <p className="text-ink-3">§ {id.sections.slice(0, 12).join(" · ")}</p>}
      </Sub>

      <Sub title={`Skills (${snap.skills.total})`} aside={<span className="text-ink-3">{snap.skills.roots.filter((r) => r.exists).length} roots</span>}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search skills or agents…"
          aria-label="Search skills"
          className="h-7 w-full rounded-md border border-holo/20 bg-black/30 px-2 text-[11px] text-ink outline-none placeholder:text-ink-3 focus:border-holo/50"
        />
        <ul className="max-h-[220px] space-y-0.5 overflow-y-auto pr-1">
          {skills.slice(0, 80).map((s) => (
            <li key={`${s.root}/${s.folder}`} className="flex min-w-0 items-center gap-2" title={[s.description, xray ? s.path : null].filter(Boolean).join("\n")}>
              <span className="min-w-0 flex-1 truncate text-ink">{s.name}</span>
              {s.agents.length ? (
                <span className="max-w-[55%] truncate text-teal-soft">{s.agents.join(", ")}</span>
              ) : (
                <span className="text-ink-3">ungranted</span>
              )}
            </li>
          ))}
          {skills.length === 0 && <li className="text-ink-3">No skill matches.</li>}
          {skills.length > 80 && <li className="text-ink-3">+{skills.length - 80} more — narrow the search</li>}
        </ul>
        {snap.skills.grantedMissing.length > 0 && <p className="text-ember" title={snap.skills.grantedMissing.join(", ")}>Granted but missing on disk: {snap.skills.grantedMissing.length}</p>}
        {xray && snap.skills.roots.map((r) => <p key={r.path} className="truncate text-ink-3" title={r.path}>{r.path}: {r.exists ? r.count : "missing"}{r.truncated ? " (truncated)" : ""}{r.sameAs ? ` = ${r.sameAs}` : ""}</p>)}
      </Sub>

      <Sub title="Routines · Rust loops">
        {routines.loops.map((l) => (
          <Row
            key={l.id}
            k={l.label}
            v={l.lastRun != null ? `${fmtAgo(l.lastRun, now)}${xray ? ` · every ${l.intervalSecs}s · ${l.runs}×` : ""}` : null}
            why="Hasn't run since the app started"
            tone={l.lastRun == null ? undefined : l.overdue ? "text-ember" : l.lastOk === false ? "text-alert" : "text-teal-soft"}
            title={[l.source, l.detail].filter(Boolean).join("\n")}
          />
        ))}
      </Sub>
      <Sub title="Routines · gateway scheduler">
        {routines.schedulerJobs == null ? (
          <Row k="Jobs" v={null} why={routines.schedulerNote ?? "The gateway didn't answer"} />
        ) : routines.schedulerJobs.length === 0 ? (
          <p className="text-ink-3">No scheduled jobs.</p>
        ) : (
          routines.schedulerJobs.map((j, i) => (
            <Row key={j.id ?? i} k={j.name ?? j.skill ?? j.id ?? "job"} v={j.lastRun ?? null} why="Never run" tone={j.enabled === false ? "text-ink-3" : undefined} title={[j.cron, j.nextRun && `next: ${j.nextRun}`].filter(Boolean).join("\n")} />
          ))
        )}
      </Sub>
      <Sub title="Routines · n8n">
        {routines.n8nConfigured.length > 0 && <p className="text-ink-2">Configured: {routines.n8nConfigured.map((w) => w.name).join(", ")}</p>}
        {routines.n8n.length === 0 ? (
          <Row k="Instances" v={null} why={routines.n8nNote ?? "No n8n instance configured"} />
        ) : (
          routines.n8n.map((n) => (
            <div key={n.id} className="space-y-0.5">
              <Row k={n.label} v={n.status} tone={n.status === "online" ? "text-teal-soft" : "text-ember"} title={n.detail} />
              {n.workflows.slice(0, 20).map((w, j) => (
                <Row key={w.id ?? `${j}:${w.name}`} k={<span className="pl-3">{w.name}</span>} v={w.lastRun ? `${w.lastStatus} · ${w.lastRun}` : w.active ? "active" : "inactive"} tone={w.active ? undefined : "text-ink-3"} />
              ))}
            </div>
          ))
        )}
      </Sub>
    </>
  );
}

// ── Cargo: stores ────────────────────────────────────────────────────────────

function CargoZone({ snap, why }: { snap: SystemSnapshot | null; why: string }) {
  const xray = useXray();
  const now = useNow(10000);
  if (!snap) return <NoSnap why={why} />;
  const cc = snap.stores.find((s) => s.id === "cc");
  const kg = snap.stores.find((s) => s.id === "knowledge-graph");
  return (
    <>
      <Sub title="Stores">
        <table className="w-full table-fixed text-left">
          <thead className="label-caps !text-[8.5px] text-ink-3">
            <tr>
              <th className="w-[38%] pb-1 font-normal">Store</th>
              <th className="pb-1 font-normal">Health</th>
              <th className="pb-1 text-right font-normal">Rows</th>
              <th className="pb-1 text-right font-normal">Size</th>
            </tr>
          </thead>
          <tbody>
            {snap.stores.map((s) => {
              const rows = storeRows(s);
              return (
                <tr key={s.id} title={[s.path, s.error, s.modifiedMs != null ? `modified ${fmtAgo(s.modifiedMs, now)}` : null, s.writable === false ? "read-only" : null].filter(Boolean).join("\n")}>
                  <td className="truncate py-0.5 text-ink">{s.label}</td>
                  <td className="py-0.5">
                    <Tag tone={s.health === "ok" ? "ok" : s.health === "missing" ? "warn" : "down"}>{s.health}</Tag>
                  </td>
                  <td className="py-0.5 text-right tabular text-ink-2">{rows != null ? rows.toLocaleString() : <Dash why={s.error ?? (s.exists ? "Row count failed" : "Not on disk")} />}</td>
                  <td className="py-0.5 text-right tabular text-ink-2">{fmtBytes(s.bytes) ?? <Dash why={s.exists ? "Size unknown" : "Not on disk"} />}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Sub>
      <Sub title="RAG & graph">
        <Row k="RAG vectors (cc.db vault)" v={cc?.metrics.ragVectors != null ? cc.metrics.ragVectors.toLocaleString() : null} why={cc?.error ?? "cc.db vault count unavailable"} />
        <Row k="Vault items" v={cc?.metrics.vaultItems != null ? cc.metrics.vaultItems.toLocaleString() : null} why={cc?.error ?? "Not reported"} />
        <Row
          k="Knowledge graph"
          v={kg ? (kg.exists ? `${kg.metrics.entities ?? 0} entities` : "missing on disk") : null}
          why="Not reported"
          tone={kg && !kg.exists ? "text-ember" : undefined}
          title={kg?.path}
        />
      </Sub>
      {xray && (
        <Sub title="Tables">
          {snap.stores
            .filter((s) => s.tables.length)
            .map((s) => (
              <p key={s.id} className="text-ink-3">
                <span className="text-ink-2">{s.id}</span>: {s.tables.map((t) => `${t.name}=${t.rows ?? "?"}`).join(" ")}
                {s.tablesTruncated ? " …" : ""}
              </p>
            ))}
        </Sub>
      )}
    </>
  );
}

// ── Cockpit: the voice/text pipeline hop by hop ──────────────────────────────

const COCKPIT_CHAIN: { hop: TraceStep["hop"]; label: string; why: string }[] = [
  { hop: "input", label: "Mic / text", why: "No turn started yet this session" },
  { hop: "vad", label: "VAD", why: "No voice activity detected yet this session" },
  { hop: "stt", label: "Whisper (STT)", why: "No speech transcribed yet this session" },
  { hop: "router", label: "Intent router", why: "No turn routed yet this session" },
  { hop: "tts", label: "TTS", why: "Nothing spoken yet this session" },
  { hop: "ui", label: "Turn total", why: "No turn finished yet this session" },
];

function CockpitZone() {
  const xray = useXray();
  const steps = useTrace((s) => s.steps);
  const voice = useVoice((s) => s.state);
  const stats = useMemo(() => hopStats(steps), [steps]);
  const slow = useMemo(() => (xray ? slowestHop(steps) : null), [steps, xray]);
  return (
    <>
      <Sub title="Voice">
        <Row k="State" v={STATE_LABEL[voice]} />
      </Sub>
      <Sub title="Pipeline (last · median)">
        <ol className="space-y-1">
          {COCKPIT_CHAIN.map((c, i) => {
            const s = stats[c.hop];
            const flagged = slow?.hop === c.hop;
            return (
              <li key={c.hop} className="flex min-w-0 items-center gap-2" title={s ? `${s.count} samples this session` : c.why}>
                <span className="w-3 shrink-0 text-ink-3">{i === 0 ? "" : "→"}</span>
                <Dot tone={!s ? "idle" : s.lastOk ? "ok" : "down"} />
                <span className="min-w-0 flex-1 truncate text-ink">{c.label}</span>
                {flagged && <Tag tone="warn">slowest</Tag>}
                <span className="shrink-0 tabular text-ink-2">{s ? `${fmtMs(s.lastMs)} · ${fmtMs(s.medianMs)}` : <Dash why={c.why} />}</span>
              </li>
            );
          })}
        </ol>
      </Sub>
    </>
  );
}

// ── Exhaust: bus topology ────────────────────────────────────────────────────

function ExhaustZone({ snap, why }: { snap: SystemSnapshot | null; why: string }) {
  const xray = useXray();
  const go = useNav((s) => s.go);
  const now = useNow(5000);
  if (!snap) return <NoSnap why={why} />;
  const bus = sortBus(snap.bus);
  return (
    <Sub
      title={`Bus (${bus.filter((b) => b.status === "ok").length}/${bus.length} connected)`}
      aside={
        <button type="button" onClick={() => openSettings(go)} className="label-caps flex items-center gap-1 !text-[9px] text-holo hover:text-ink">
          Open in Settings <ExternalLink size={9} />
        </button>
      }
    >
      <ul className="space-y-1.5">
        {bus.map((b) => (
          <li key={b.id} className="rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-1">
            <div className="flex min-w-0 items-center gap-2">
              <Dot tone={busTone(b.status)} />
              <span className="min-w-0 flex-1 truncate text-ink">{b.name}</span>
              {xray && <span className="text-ink-3">{b.transport}</span>}
              <span className={busTone(b.status) === "ok" ? "text-teal-soft" : busTone(b.status) === "idle" ? "text-ink-3" : "text-ember"} title={busWhy(b)}>
                {busText(b.status)}
              </span>
            </div>
            <div className="mt-0.5 flex flex-wrap gap-x-3 text-ink-3">
              <span>tools {b.tools ?? <Dash why={b.status === "off" ? "Disabled" : "Not listed recently — run a deep scan"} />}</span>
              <span>last {b.lastMs != null ? fmtMs(b.lastMs) : <Dash why="Not called since the app started" />}</span>
              {b.calls != null && (
                <span>
                  {b.calls} calls{b.failures ? ` · ${b.failures} failed` : ""}
                </span>
              )}
              {b.lastAt != null && <span>{fmtAgo(b.lastAt * 1000, now)}</span>}
              {xray && b.source && <span>cred: {b.source}</span>}
            </div>
            {(b.error || (b.lastOk === false && b.lastError)) && <p className="mt-0.5 line-clamp-2 text-alert/90">{b.error ?? b.lastError}</p>}
            {busNeedsFix(b.status) && (
              <button type="button" onClick={() => openSettings(go)} className="label-caps mt-0.5 flex items-center gap-1 !text-[9px] text-ember hover:text-ink">
                Fix in Settings <ExternalLink size={9} />
              </button>
            )}
          </li>
        ))}
      </ul>
    </Sub>
  );
}

// ── Recent steps in this zone ────────────────────────────────────────────────

function RecentSteps({ zone }: { zone: TraceZone }) {
  const steps = useTrace((s) => s.steps);
  const xray = useXray();
  const recent = useMemo(() => {
    const out: TraceStep[] = [];
    for (let i = steps.length - 1; i >= 0 && out.length < 6; i--) if (steps[i].zone === zone) out.push(steps[i]);
    return out;
  }, [steps, zone]);
  return (
    <Sub title="Recent traffic">
      {recent.length === 0 ? (
        <p className="text-ink-3">Nothing has passed through here yet this session.</p>
      ) : (
        <ul className="space-y-0.5">
          {recent.map((s) => (
            <li key={`${s.traceId}#${s.seq}#${s.hop}#${s.at}`} className="flex min-w-0 items-center gap-2" title={s.error}>
              <span className="shrink-0 text-ink-3">{fmtClock(s.at)}</span>
              <Dot tone={s.ok ? "ok" : "down"} />
              <span className="min-w-0 flex-1 truncate text-ink-2">
                {xray ? `${s.hop} · ` : ""}
                {s.label}
              </span>
              <span className="shrink-0 tabular text-ink-3">{fmtMs(s.ms)}</span>
            </li>
          ))}
        </ul>
      )}
    </Sub>
  );
}
