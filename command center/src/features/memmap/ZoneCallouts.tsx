import { useMemo } from "react";
import type { ReactNode } from "react";
import type { SnapBus, SystemSnapshot, TraceZone } from "@/lib/platform";
import { useSettings } from "@/stores/settings";
import { STATE_LABEL, useVoice } from "@/features/voice/voice-store";
import { hopStats, useTrace } from "./trace-store";
import { busText, busTone, busWhy, fmtMs, latestTps } from "./format";
import { useMemmapData } from "./use-memmap-data";
import { Dash, Dot } from "./parts";
import { useZoneUi } from "./zone-store";

/**
 * The four callout cards around the car (ENGINE BAY, CARGO TRUNK, DASHBOARD & CONSOLE,
 * EXHAUST), each a live summary of its zone. `overlay` pins them to the corners of the
 * viewport (Part 5's HoloViewport draws the leader lines to `data-zone` anchors);
 * `stack` lists them for the narrow layout.
 */

/** Exhaust node pills: the external bridges the mockup names, by MCP server id. */
export const EXHAUST_NODES: { id: string; label: string }[] = [
  { id: "whatsapp", label: "WhatsApp Bridge" },
  { id: "spotify", label: "Spotify" },
  { id: "gmail", label: "Gmail" },
  { id: "brave-search", label: "Brave Search" },
];

const POS: Record<Exclude<TraceZone, "ecu">, string> = {
  engine: "left-3 top-3",
  cargo: "right-3 top-3",
  cockpit: "bottom-3 left-3",
  // Upper-right third: the bottom-right corner belongs to the Gabagool blueprint card. Never
  // above 8.5rem, so it clears the cargo card on a short stage.
  exhaust: "right-3 top-[max(31%,8.5rem)]",
};
/**
 * The exhaust card on a short stage: the right column has no room between the cargo card and
 * the Gabagool card, so it sits on the bottom row to the blueprint card's left (its width +
 * right-3 + a 0.5rem gap). Under 44rem of stage width that row would hit the cockpit card,
 * so the overlay card is hidden there (the bus is still on the left column's MCP card).
 * Needs the stage to be an `@container` (CentreStage).
 */
export const EXHAUST_COMPACT_POS = "bottom-3 right-[calc(min(200px,32%)+1.25rem)] hidden @min-[44rem]:block";

/** Overlay position classes for a callout card. */
export function calloutPos(zone: Exclude<TraceZone, "ecu">, compact: boolean): string {
  return zone === "exhaust" && compact ? EXHAUST_COMPACT_POS : POS[zone];
}

/** `compact` (a short stage): the exhaust card drops its node pills and moves to the bottom
 * row beside the Gabagool card (see EXHAUST_COMPACT_POS), so the two never overlap. */
export function ZoneCallouts({ layout, compact = false }: { layout: "overlay" | "stack"; compact?: boolean }) {
  const { snap, error } = useMemmapData();
  const steps = useTrace((s) => s.steps);
  const voice = useVoice((s) => s.state);
  const xray = useSettings((s) => s.systemMapMode) === "xray";
  const stats = useMemo(() => hopStats(steps), [steps]);
  const tps = useMemo(() => latestTps(steps), [steps]);
  const why = error ?? "Waiting for the first system snapshot";

  const cards: { zone: Exclude<TraceZone, "ecu">; title: string; body: ReactNode }[] = [
    { zone: "engine", title: "Engine bay // local inference & dispatch", body: <Engine snap={snap} why={why} tps={tps} xray={xray} /> },
    { zone: "cargo", title: "Cargo trunk // persistent memory & RAG", body: <Cargo snap={snap} why={why} /> },
    {
      zone: "cockpit",
      title: "Dashboard & console // I/O & voice",
      body: (
        <>
          <Line k="Voice" v={STATE_LABEL[voice]} />
          <Line k="STT" v={stats.stt ? `${xray ? `${fmtMs(stats.stt.lastMs)} · p50 ` : ""}${fmtMs(stats.stt.medianMs)}` : null} why="No speech transcribed yet this session" />
          <Line k="TTS" v={stats.tts ? `${xray ? `${fmtMs(stats.tts.lastMs)} · p50 ` : ""}${fmtMs(stats.tts.medianMs)}` : null} why="Nothing spoken yet this session" />
          <Line k="Turn" v={stats.ui ? fmtMs(stats.ui.medianMs) : null} why="No turn finished yet this session" />
        </>
      ),
    },
    { zone: "exhaust", title: "Exhaust // external MCP protocols", body: <Exhaust bus={snap?.bus ?? null} why={why} compact={compact && layout === "overlay"} /> },
  ];

  if (layout === "stack") {
    return (
      <div className="grid gap-2 sm:grid-cols-2">
        {cards.map((c) => (
          <Callout key={c.zone} zone={c.zone} title={c.title}>
            {c.body}
          </Callout>
        ))}
      </div>
    );
  }
  return (
    <>
      {cards.map((c) => (
        <div key={c.zone} className={`pointer-events-auto absolute w-[min(230px,38%)] ${calloutPos(c.zone, compact)}`}>
          <Callout zone={c.zone} title={c.title}>
            {c.body}
          </Callout>
        </div>
      ))}
    </>
  );
}

/** A callout card. Clicking it (or Enter/Space) opens the zone's inspector; hovering it
 * glows the zone on the car, like hovering the zone itself. */
function Callout({ zone, title, children }: { zone: TraceZone; title: string; children: ReactNode }) {
  const hot = useZoneUi((s) => s.hovered === zone);
  const open = useZoneUi((s) => s.selected === zone);
  const ui = useZoneUi.getState;
  return (
    <section
      data-zone={zone}
      role="button"
      tabIndex={0}
      aria-pressed={open}
      aria-label={`${title}: open the inspector`}
      onClick={() => ui().select(zone)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        ui().select(zone);
      }}
      onPointerEnter={() => ui().hover(zone)}
      onPointerLeave={() => ui().hovered === zone && ui().hover(null)}
      className={`cursor-pointer rounded-[10px] border bg-[rgba(5,9,14,0.84)] px-2.5 py-2 shadow-[0_0_18px_-8px_rgba(0,210,255,0.5)] outline-none transition-colors focus-visible:border-holo ${open ? "border-ember/55" : hot ? "border-holo/60" : "border-holo/25"}`}
    >
      <h3 className="label-caps mb-1 truncate !text-[9px] text-holo" title={title}>
        {title}
      </h3>
      <div className="space-y-0.5 font-mono text-[10px]">{children}</div>
    </section>
  );
}

function Line({ k, v, why, tone }: { k: string; v: ReactNode | null | undefined; why?: string; tone?: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="shrink-0 uppercase text-ink-3">{k}</span>
      <span className={`ml-auto min-w-0 truncate text-right ${tone ?? "text-ink-2"}`}>{v == null || v === "" ? <Dash why={why ?? "No live source"} /> : v}</span>
    </div>
  );
}

function Engine({ snap, why, tps, xray }: { snap: SystemSnapshot | null; why: string; tps: number | null; xray: boolean }) {
  if (!snap) return <Line k="Chain" v={null} why={why} />;
  const head = snap.chain[0];
  const svc = head ? snap.services.find((s) => s.id === head.id) : undefined;
  const subs = snap.agents.filter((a) => a.role !== "general");
  return (
    <>
      <Line
        k="Tony →"
        v={head ? `${head.label}${xray && head.model ? ` · ${head.model}` : ""}` : null}
        why="No provider chain configured"
        tone={svc ? (svc.up ? "text-teal-soft" : "text-alert") : undefined}
      />
      {svc && <Line k="Latency" v={svc.up ? fmtMs(svc.latencyMs) : null} why={`${head?.label} is down: ${svc.detail || "no answer"}`} />}
      <Line k="Tokens/s" v={tps != null ? `${tps}` : null} why="Measured from the next streamed reply" />
      <Line k="Sub-agents" v={`${subs.filter((a) => a.active).length} active / ${subs.length}`} />
    </>
  );
}

function Cargo({ snap, why }: { snap: SystemSnapshot | null; why: string }) {
  if (!snap) return <Line k="Stores" v={null} why={why} />;
  const cc = snap.stores.find((s) => s.id === "cc");
  const kg = snap.stores.find((s) => s.id === "knowledge-graph");
  const mem = snap.stores.find((s) => s.id === "memory");
  return (
    <>
      <Line k="Stores" v={`${snap.summary.storesOk}/${snap.summary.storesTotal} healthy`} tone={snap.summary.storesOk === snap.summary.storesTotal ? "text-teal-soft" : "text-ember"} />
      <Line k="RAG vectors" v={cc?.metrics.ragVectors != null ? cc.metrics.ragVectors.toLocaleString() : null} why={cc?.error ?? "cc.db vault count unavailable"} />
      <Line k="Memory FTS" v={mem ? (mem.health === "ok" ? `${mem.tables.reduce((n, t) => n + (t.rows ?? 0), 0)} rows` : mem.health) : null} why="memory.db not found" />
      <Line
        k="Knowledge graph"
        v={kg ? (kg.exists ? `${kg.metrics.entities ?? 0} entities` : "missing") : null}
        why="Not reported"
        tone={kg && !kg.exists ? "text-ember" : undefined}
      />
    </>
  );
}

function Exhaust({ bus, why, compact }: { bus: SnapBus[] | null; why: string; compact: boolean }) {
  if (!bus) return <Line k="Bus" v={null} why={why} />;
  const ok = bus.filter((b) => b.status === "ok").length;
  return (
    <>
      <Line k="Connected" v={`${ok}/${bus.length}`} />
      <div className={`mt-1 flex-wrap gap-1 ${compact ? "hidden" : "flex"}`}>
        {EXHAUST_NODES.map((n) => {
          const b = bus.find((x) => x.id === n.id);
          const tone = b ? busTone(b.status) : "idle";
          return (
            <span key={n.id} title={b ? `${busText(b.status)} — ${busWhy(b)}` : "Not registered in os.json"} className="flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.03] px-1.5 py-px text-[9px] text-ink-2">
              <Dot tone={tone} /> {n.label}
            </span>
          );
        })}
      </div>
    </>
  );
}
