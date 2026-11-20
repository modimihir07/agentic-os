import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Workflow } from "lucide-react";
import { useMediaQuery, usePrefersReducedMotion } from "@/lib/use-media-query";
import { useIpcRing } from "@/lib/ipc-ring";
import { useSettings } from "@/stores/settings";
import { useVoice } from "@/features/voice/voice-store";
import { frameDue, type Tone } from "./format";
import {
  EDGE_BY_ID,
  edgeSamples,
  edgesForIpc,
  edgesForStep,
  FLOW_EDGES,
  FLOW_NODES,
  flowLayout,
  flowNodeStatus,
  flowOrientation,
  freshIpc,
  freshTail,
  memWriteDelta,
  NODE_BY_ID,
  pathD,
  pillLabel,
  retimeToNow,
  samplePoint,
  type FlowEdgeId,
  type FlowHit,
  type FlowNode,
  type FlowNodeId,
  type FlowOrient,
  type NodeStatus,
} from "./flow-graph";
import { useTrace } from "./trace-store";
import { useMemmap, useMemmapData } from "./use-memmap-data";
import { Dot } from "./parts";
import { useZoneUi } from "./zone-store";

/**
 * ARCHITECTURE ROUTING: a horizontal flowchart over the car — sources → MCP hub / Brave /
 * Tony → destinations — with status LEDs from the live snapshot and pulses that travel the
 * Bezier wires when the trace says data moved (flow-graph.ts maps steps to edges). Pulses
 * inferred from the IPC ring or snapshot deltas are drawn dashed and titled "inferred".
 *
 * SVG (no second WebGL context). The frame loop runs at ≤ 30 fps only while a pulse or flash
 * is live, the window is visible and the strip is on screen; idle = no loop. Under
 * prefers-reduced-motion (and when collapsed) nothing travels: the wire / node lights up and
 * a single timeout clears it.
 */

const FRAME_MS = 1000 / 30;
const TRAVEL_MS = 900;
const STAGGER_MS = 140;
const FLASH_MS = 1200;
const STATIC_MS = 1500;
const MAX_PULSES = 16;
/** SVG heights (px): horizontal strip, and the stacked layout for narrow widths. */
const H_HEIGHT = 118;
const V_HEIGHT = 236;

interface LivePulse {
  id: number;
  edge: FlowEdgeId;
  /** performance.now() ms the pulse leaves (can be in the future: staggered hops). */
  born: number;
  ok: boolean;
  inferred: boolean;
  why: string;
}
interface Flash {
  at: number;
  ok: boolean;
  inferred: boolean;
  why: string;
}

let pulseSeq = 0;

const LED: Record<Tone, string> = { ok: "fill-teal", warn: "fill-ember", down: "fill-alert", idle: "fill-ink-3" };

/** Live pulses + node flashes from the trace ring, the IPC ring and the snapshot poller. */
function useFlowActivity(travel: boolean, root: React.RefObject<HTMLElement | null>) {
  const live = useRef({ pulses: [] as LivePulse[], flashes: new Map<FlowNodeId, Flash>() });
  const [now, setNow] = useState(() => performance.now());

  useEffect(() => {
    const st = live.current;
    const life = travel ? TRAVEL_MS : STATIC_MS;
    const flashLife = travel ? FLASH_MS : STATIC_MS;
    let raf = 0;
    let last = 0;
    let inView = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const prune = (t: number) => {
      st.pulses = st.pulses.filter((p) => t - p.born <= life);
      for (const [k, f] of st.flashes) if (t - f.at > flashLife) st.flashes.delete(k);
    };
    const alive = () => st.pulses.length > 0 || st.flashes.size > 0;
    const tick = (t: number) => {
      raf = 0;
      if (frameDue(t, last, FRAME_MS)) {
        last = t;
        prune(t);
        setNow(t);
      }
      if (alive() && !document.hidden && inView) raf = requestAnimationFrame(tick);
    };
    const kick = () => {
      if (!travel) {
        // One repaint now, one after the highlight's life (no frame loop).
        setNow(performance.now());
        clearTimeout(timer);
        timer = setTimeout(() => {
          prune(performance.now());
          setNow(performance.now());
        }, STATIC_MS + 20);
        return;
      }
      if (raf || document.hidden || !inView) return;
      last = 0;
      raf = requestAnimationFrame(tick);
    };

    const add = (hit: FlowHit, inferred: boolean, why: string) => {
      const t = performance.now();
      hit.edges.forEach((edge, i) => st.pulses.push({ id: ++pulseSeq, edge, born: t + (travel ? i * STAGGER_MS : 0), ok: hit.ok, inferred, why }));
      if (st.pulses.length > MAX_PULSES) st.pulses = st.pulses.slice(-MAX_PULSES);
      const lastEdge = hit.edges[hit.edges.length - 1];
      if (lastEdge) st.flashes.set(EDGE_BY_ID[lastEdge].to, { at: t + (travel ? (hit.edges.length - 1) * STAGGER_MS + TRAVEL_MS : 0), ok: hit.ok, inferred, why });
      if (hit.flash) st.flashes.set(hit.flash, { at: t, ok: hit.ok, inferred, why });
      kick();
    };

    const offTrace = useTrace.subscribe((s, prev) => {
      for (const step of freshTail(s.steps, prev.steps[prev.steps.length - 1])) add(edgesForStep(step), false, `${step.hop} · ${step.label}${step.error ? ` — ${step.error}` : ""}`);
    });
    const offIpc = useIpcRing.subscribe((s, prev) => {
      for (const c of freshIpc(s.calls, prev.calls[prev.calls.length - 1])) {
        const hit = edgesForIpc(c);
        if (hit) add(hit, true, `inferred from IPC ${c.name}${c.ok ? "" : " (failed)"}`);
      }
    });
    const offSnap = useMemmap.subscribe((s, prev) => {
      if (s.at !== prev.at && prev.at > 0 && s.snap) add({ edges: ["telemetry-tony"], ok: !s.snap.host.error }, true, "inferred: telemetry snapshot refreshed (10 s poll)");
      const d = memWriteDelta(prev.snap, s.snap);
      if (d > 0) add({ edges: [], flash: "memwrite", ok: true }, true, `inferred: ${d} new row${d === 1 ? "" : "s"} in the stores since the last snapshot`);
    });

    const onVis = () => {
      if (!document.hidden && alive()) kick();
    };
    document.addEventListener("visibilitychange", onVis);
    const el = root.current;
    const io =
      el && typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver((entries) => {
            inView = entries.some((e) => e.isIntersecting);
            if (inView && alive()) kick();
          })
        : undefined;
    if (el) io?.observe(el);

    // Re-sync after a travel <-> static switch (collapse, expand, reduced-motion change): the
    // pulses and flashes carried over from the previous mode need a fresh clock, or they stay
    // frozen on screen until some unrelated event arrives.
    const t0 = performance.now();
    if (!travel) retimeToNow(st.pulses, st.flashes.values(), t0);
    prune(t0);
    if (alive()) kick();

    return () => {
      offTrace();
      offIpc();
      offSnap();
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
      io?.disconnect();
    };
  }, [travel, root]);

  return { now, pulses: live.current.pulses, flashes: live.current.flashes, life: travel ? TRAVEL_MS : STATIC_MS, flashLife: travel ? FLASH_MS : STATIC_MS };
}

/** Is the strip expanded? The persisted choice, else expanded only on tall screens. */
export function useFlowOpen(): boolean {
  const flag = useSettings((s) => s.systemMapFlowOpen);
  const roomy = useMediaQuery("(min-height: 900px)");
  return flag ?? roomy;
}

/** Width of an element (ResizeObserver; re-read at once whenever `remeasure` changes). */
function useWidth(el: React.RefObject<HTMLElement | null>, remeasure: unknown): number {
  const [w, setW] = useState(0);
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    setW(node.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setW(node.clientWidth));
    ro.observe(node);
    return () => ro.disconnect();
  }, [el, remeasure]);
  return w;
}

export function RoutingFlowchart({ orient: forced, className = "" }: { orient?: FlowOrient; className?: string }) {
  const { snap, error } = useMemmapData();
  const voice = useVoice((s) => s.state);
  const osName = useSettings((s) => s.osName) || "Tony";
  const setSettings = useSettings((s) => s.set);
  const reduced = usePrefersReducedMotion();
  const open = useFlowOpen();
  const root = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const width = useWidth(body, open);
  const { now, pulses, flashes, life, flashLife } = useFlowActivity(open && !reduced, root);
  const status = useMemo(() => flowNodeStatus(snap, { voice, why: error ?? undefined }), [snap, voice, error]);

  const nodeOf = (n: FlowNode): FlowNode => (n.id === "tony" && osName !== "Tony" ? { ...n, label: `${osName} Dispatcher`, short: osName } : n);
  const flashOf = (id: FlowNodeId) => {
    const f = flashes.get(id);
    if (!f) return null;
    const age = now - f.at;
    return age >= 0 && age <= flashLife ? { ...f, k: age / flashLife } : null;
  };
  const toggle = () => setSettings({ systemMapFlowOpen: !open });

  return (
    <section
      ref={root}
      aria-label="Architecture routing flowchart"
      className={`relative shrink-0 overflow-hidden rounded-[14px] border border-holo/20 bg-[rgba(7,11,17,0.78)] shadow-[0_0_24px_-12px_rgba(0,210,255,0.35),inset_0_1px_0_rgba(0,210,255,0.06)] backdrop-blur-md ${className}`}
    >
      <header className={`flex min-h-[42px] items-center gap-2 px-3 ${open ? "border-b border-holo/10" : ""}`}>
        <Workflow size={12} className="shrink-0 text-holo" />
        <h2 className="label-caps shrink-0 text-holo">Architecture routing</h2>
        {open ? (
          <p className="ml-1 hidden min-w-0 truncate font-mono text-[9.5px] text-ink-3 sm:block" title="Cyan wires carry data in to be routed; amber wires are outbound actions. Dashed pulses are inferred from IPC calls or snapshot changes (≥ 10 s stale), not os-trace hops.">
            <span className="text-holo">━</span> in · <span className="text-ember">━</span> out · <span className="text-ink-2">┅</span> inferred
          </p>
        ) : (
          <CollapsedStrip status={status} nodeOf={nodeOf} flashOf={flashOf} />
        )}
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          title={open ? "Collapse the routing flowchart" : "Expand the routing flowchart"}
          className="ml-auto grid size-6 shrink-0 place-items-center rounded-full border border-holo/25 text-ink-2 transition-colors hover:text-holo"
        >
          {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          <span className="sr-only">{open ? "Collapse" : "Expand"}</span>
        </button>
      </header>
      <div ref={body} className={open ? "px-1.5 py-1" : "hidden"}>
        {open && width > 0 && <FlowSvg width={width - 12} orient={forced ?? flowOrientation(width)} status={status} nodeOf={nodeOf} flashOf={flashOf} pulses={pulses} now={now} life={life} travel={!reduced} />}
      </div>
    </section>
  );
}

type FlashView = (Flash & { k: number }) | null;

function selectZone(n: FlowNode) {
  useZoneUi.getState().select(n.zone);
}

function CollapsedStrip({ status, nodeOf, flashOf }: { status: Record<FlowNodeId, NodeStatus>; nodeOf: (n: FlowNode) => FlowNode; flashOf: (id: FlowNodeId) => FlashView }) {
  return (
    <ul className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto whitespace-nowrap py-1 [scrollbar-width:none]">
      {FLOW_NODES.map((raw) => {
        const n = nodeOf(raw);
        const st = status[n.id];
        const f = flashOf(n.id);
        return (
          <li key={n.id}>
            <button
              type="button"
              onClick={() => selectZone(n)}
              title={`${n.label}: ${st.text} — ${st.why}${f ? `\nLast: ${f.why}` : ""}`}
              className={`flex h-6 items-center gap-1 rounded-full border px-2 font-mono text-[9.5px] text-ink-2 transition-colors hover:text-ink ${
                f ? (f.ok ? "border-holo/70 bg-holo/10" : "border-alert/70 bg-alert/10") : "border-white/10 bg-white/[0.03]"
              } ${f?.inferred ? "border-dashed" : ""}`}
            >
              <Dot tone={st.tone} /> {n.short}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function FlowSvg({
  width,
  orient,
  status,
  nodeOf,
  flashOf,
  pulses,
  now,
  life,
  travel,
}: {
  width: number;
  orient: FlowOrient;
  status: Record<FlowNodeId, NodeStatus>;
  nodeOf: (n: FlowNode) => FlowNode;
  flashOf: (id: FlowNodeId) => FlashView;
  pulses: readonly LivePulse[];
  now: number;
  life: number;
  travel: boolean;
}) {
  const height = orient === "h" ? H_HEIGHT : V_HEIGHT;
  const layout = useMemo(() => flowLayout(width, height, orient), [width, height, orient]);
  const samples = useMemo(() => edgeSamples(layout), [layout]);
  const ui = useZoneUi.getState;
  const active = pulses.filter((p) => now - p.born >= 0 && now - p.born <= life);
  const litBy = new Map<FlowEdgeId, LivePulse>();
  for (const p of active) litBy.set(p.edge, p);

  return (
    <svg width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} className="block max-w-full overflow-visible" role="group" aria-label="Sources, routing nodes and destinations">
      {/* Wires: a faint glow under a hairline; brighter while a pulse is on them. */}
      <g fill="none">
        {FLOW_EDGES.map((e) => {
          const d = pathD(layout.paths[e.id]);
          const lit = litBy.get(e.id);
          const color = lit && !lit.ok ? "stroke-alert" : e.tone === "amber" ? "stroke-ember" : "stroke-holo";
          return (
            <g key={e.id}>
              <title>{`${nodeOf(NODE_BY_ID[e.from]).label} → ${nodeOf(NODE_BY_ID[e.to]).label}${lit ? `\n${lit.inferred ? "inferred · " : ""}${lit.why}` : ""}`}</title>
              <path d={d} className={color} strokeWidth={5} strokeOpacity={lit ? 0.22 : 0.05} strokeLinecap="round" />
              <path d={d} className={color} strokeWidth={lit ? 1.5 : 1} strokeOpacity={lit ? 0.95 : 0.32} strokeDasharray={lit?.inferred ? "4 3" : undefined} />
            </g>
          );
        })}
      </g>

      {/* Pulses: a dot and a short tail travelling the precomputed samples. */}
      {travel && (
        <g pointerEvents="none">
          {active.map((p) => {
            const t = (now - p.born) / TRAVEL_MS;
            const eased = 1 - (1 - t) * (1 - t);
            const pts = samples[p.edge];
            const head = samplePoint(pts, eased);
            if (!head) return null;
            const color = !p.ok ? "fill-alert" : EDGE_BY_ID[p.edge].tone === "amber" ? "fill-ember" : "fill-holo";
            const stroke = !p.ok ? "stroke-alert" : EDGE_BY_ID[p.edge].tone === "amber" ? "stroke-ember" : "stroke-holo";
            return (
              <g key={p.id}>
                <title>{p.inferred ? `inferred · ${p.why}` : p.why}</title>
                {[0.14, 0.08].map((lag, i) => {
                  const q = samplePoint(pts, Math.max(0, eased - lag));
                  return q ? <circle key={i} cx={q[0]} cy={q[1]} r={1.6 - i * 0.4} className={color} opacity={0.25 + i * 0.2} /> : null;
                })}
                <circle cx={head[0]} cy={head[1]} r={6} className={color} opacity={0.18} />
                {p.inferred ? (
                  <circle cx={head[0]} cy={head[1]} r={3} fill="none" className={stroke} strokeWidth={1.2} strokeDasharray="2 1.5" />
                ) : (
                  <circle cx={head[0]} cy={head[1]} r={2.6} className={color} />
                )}
              </g>
            );
          })}
        </g>
      )}

      {/* Nodes: dark-glass pills with a status LED. */}
      {FLOW_NODES.map((raw) => {
        const n = nodeOf(raw);
        const b = layout.nodes[n.id];
        const st = status[n.id];
        const f = flashOf(n.id);
        const r = b.h / 2;
        return (
          <g
            key={n.id}
            transform={`translate(${b.x.toFixed(1)},${b.y.toFixed(1)})`}
            role="button"
            tabIndex={0}
            aria-label={`${n.label}: ${st.text}. Open the ${n.zone} inspector`}
            onClick={() => selectZone(n)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              selectZone(n);
            }}
            onPointerEnter={() => ui().hover(n.zone)}
            onPointerLeave={() => ui().hovered === n.zone && ui().hover(null)}
            className="group cursor-pointer outline-none"
          >
            <title>{`${n.label}: ${st.text}\n${st.why}${f ? `\n\nLast: ${f.inferred ? "inferred · " : ""}${f.why}` : ""}`}</title>
            {f && (
              <rect
                x={-3}
                y={-3}
                width={b.w + 6}
                height={b.h + 6}
                rx={r + 3}
                className={f.ok ? "fill-holo/10 stroke-holo" : "fill-alert/10 stroke-alert"}
                strokeWidth={1}
                strokeDasharray={f.inferred ? "3 2" : undefined}
                opacity={1 - f.k}
              />
            )}
            <rect width={b.w} height={b.h} rx={r} className="fill-[rgba(7,11,17,0.92)] stroke-holo/25 transition-[stroke] group-hover:stroke-holo/60 group-focus-visible:stroke-holo" strokeWidth={1} />
            {st.tone !== "idle" && <circle cx={r + 1} cy={r} r={5} className={LED[st.tone]} opacity={0.22} />}
            <circle cx={r + 1} cy={r} r={2.6} className={LED[st.tone]} />
            <text x={r + 8} y={r} dominantBaseline="central" className="pointer-events-none fill-ink-2 font-mono text-[9.5px] group-hover:fill-ink">
              {pillLabel(n, b.w)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
