import type { SnapBus, SystemSnapshot, TraceStep, TraceZone } from "@/lib/platform";
import type { IpcCall } from "@/lib/ipc-ring";
import type { VoiceState } from "@/features/voice/voice-store";
import { busText, busTone, busWhy, daemonState, type Tone } from "./format";

/**
 * System Map: the Architecture Routing Flowchart's graph, event mapping and geometry. Pure
 * (type-only imports plus the pure format helpers), unit-tested in flow-graph.test.ts.
 *
 * Sources (left) → routing (centre) → destinations (right). A pulse travels an edge when a
 * real trace step says data moved along it (`edgesForStep`). Pulses derived from the IPC ring
 * or snapshot deltas are *inferred* (`edgesForIpc`, `memWriteDelta`, telemetry polls): they
 * are at least one poll stale and are not os-trace hops, so the UI draws them dashed.
 */

export type FlowNodeId = "gmail" | "voice" | "telemetry" | "memory" | "fs" | "hub" | "brave" | "tony" | "memwrite" | "subagents" | "media";
export type FlowColumn = 0 | 1 | 2;

export interface FlowNode {
  id: FlowNodeId;
  label: string;
  /** For narrow pills. */
  short: string;
  /** 0 = source, 1 = routing, 2 = destination. */
  column: FlowColumn;
  /** The car zone a click opens. */
  zone: TraceZone;
}

/** In column order, top to bottom (ordered to keep edge crossings low). */
export const FLOW_NODES: readonly FlowNode[] = [
  { id: "gmail", label: "Gmail API", short: "Gmail", column: 0, zone: "exhaust" },
  { id: "fs", label: "Local Filesystem", short: "Files", column: 0, zone: "exhaust" },
  { id: "memory", label: "Memory Mapping", short: "Memory", column: 0, zone: "cargo" },
  { id: "voice", label: "Voice / Audio Engine", short: "Voice", column: 0, zone: "cockpit" },
  { id: "telemetry", label: "Telemetry", short: "Telemetry", column: 0, zone: "ecu" },
  { id: "brave", label: "Brave Search", short: "Brave", column: 1, zone: "exhaust" },
  { id: "hub", label: "MCP Server Hub", short: "MCP Hub", column: 1, zone: "exhaust" },
  { id: "tony", label: "Tony Dispatcher", short: "Tony", column: 1, zone: "engine" },
  { id: "media", label: "Spotify / Media Output", short: "Media", column: 2, zone: "exhaust" },
  { id: "memwrite", label: "Write to Memory Database", short: "Mem DB", column: 2, zone: "cargo" },
  { id: "subagents", label: "Sub-Agent Execution", short: "Sub-agents", column: 2, zone: "engine" },
];

export const NODE_BY_ID: Readonly<Record<FlowNodeId, FlowNode>> = Object.fromEntries(FLOW_NODES.map((n) => [n.id, n])) as Record<FlowNodeId, FlowNode>;

export type FlowEdgeId =
  | "gmail-hub"
  | "fs-hub"
  | "memory-hub"
  | "voice-tony"
  | "telemetry-tony"
  | "memory-tony"
  | "fs-tony"
  | "hub-brave"
  | "hub-tony"
  | "hub-media"
  | "tony-memwrite"
  | "tony-subagents"
  | "tony-voice";

export interface FlowEdge {
  id: FlowEdgeId;
  from: FlowNodeId;
  to: FlowNodeId;
  /** cyan = data coming in to be routed; amber = an outbound action (Tony or the hub acting). */
  tone: "cyan" | "amber";
}

const edge = (from: FlowNodeId, to: FlowNodeId): FlowEdge => ({
  id: `${from}-${to}` as FlowEdgeId,
  from,
  to,
  tone: from === "tony" || NODE_BY_ID[to].column === 2 ? "amber" : "cyan",
});

export const FLOW_EDGES: readonly FlowEdge[] = [
  edge("gmail", "hub"),
  edge("fs", "hub"),
  edge("memory", "hub"),
  edge("voice", "tony"),
  edge("telemetry", "tony"),
  edge("memory", "tony"),
  edge("fs", "tony"),
  edge("hub", "brave"),
  edge("hub", "tony"),
  edge("hub", "media"),
  edge("tony", "memwrite"),
  edge("tony", "subagents"),
  edge("tony", "voice"),
];

export const EDGE_BY_ID: Readonly<Record<FlowEdgeId, FlowEdge>> = Object.fromEntries(FLOW_EDGES.map((e) => [e.id, e])) as Record<FlowEdgeId, FlowEdge>;

// ── Labels ───────────────────────────────────────────────────────────────────

const SEP = " · ";

/** Pipeline steps carry a `<stage> · ` prefix (trace-store `pipelineToStep`); drop it. */
export function stripStage(label: string, traceId: string): string {
  if (!traceId.startsWith("pipeline:")) return label;
  const i = label.indexOf(SEP);
  return i < 0 ? label : label.slice(i + SEP.length);
}

/** The pipeline stage of a step (`ledger`, `build`, …), or null outside a pipeline. */
export function stageOf(s: Pick<TraceStep, "label" | "traceId">): string | null {
  if (!s.traceId.startsWith("pipeline:")) return null;
  const i = s.label.indexOf(SEP);
  return i < 0 ? null : s.label.slice(0, i);
}

export const toolName = (s: Pick<TraceStep, "label" | "traceId">): string => stripStage(s.label, s.traceId).trim();

/** Mirror of Rust `mcp::server_of_tool`. */
export function serverOfTool(name: string): string {
  const dot = name.indexOf(".");
  const prefix = dot < 0 ? name : name.slice(0, dot);
  switch (prefix) {
    case "fs":
      return "filesystem";
    case "kg":
      return "knowledge-graph";
    case "web":
      return "brave-search";
    default:
      return prefix;
  }
}

// ── Events → edges ───────────────────────────────────────────────────────────

export interface FlowHit {
  /** Edges a pulse travels, in order. */
  edges: FlowEdgeId[];
  /** A node lit in place (no edge to travel). */
  flash?: FlowNodeId;
  ok: boolean;
}

const SERVER_EDGE: Record<string, FlowEdgeId> = {
  gmail: "gmail-hub",
  "gmail-multi": "gmail-hub",
  filesystem: "fs-hub",
  git: "fs-hub",
  "knowledge-graph": "memory-hub",
  "brave-search": "hub-brave",
  spotify: "hub-media",
};

const SUBAGENT_MARK = "anythingllm/";

/** Which edges one trace step lights. See docs/memory-map-plan.md §8 for the table. */
export function edgesForStep(s: TraceStep): FlowHit {
  const pipeline = s.traceId.startsWith("pipeline:");
  const bare = stripStage(s.label, s.traceId).trim();
  const stage = stageOf(s);
  const tony = (): FlowHit => ({ edges: [], flash: "tony", ok: s.ok });
  switch (s.hop) {
    case "tool": {
      if (s.error?.startsWith("PERMISSION_")) return { edges: ["hub-tony"], flash: "hub", ok: false };
      const e = SERVER_EDGE[serverOfTool(bare)];
      return e ? { edges: [e, "hub-tony"], ok: s.ok } : { edges: ["hub-tony"], flash: "hub", ok: s.ok };
    }
    case "memory": {
      // The capture pipeline's ledger stage: the Librarian writing the Ideas & Tasks Ledger.
      if (pipeline && stage === "ledger" && bare.startsWith("librarian")) return { edges: ["tony-memwrite"], ok: s.ok };
      const edges: FlowEdgeId[] = ["memory-tony"];
      if (s.label.includes(SUBAGENT_MARK) || (pipeline && stage !== "ledger")) edges.push("tony-subagents");
      return { edges, ok: s.ok };
    }
    case "model":
      if (s.label.includes(SUBAGENT_MARK) || bare.startsWith("overseer") || (pipeline && stage !== "ledger")) return { edges: ["tony-subagents"], ok: s.ok };
      return tony();
    case "router":
      return pipeline && stage !== "ledger" ? { edges: ["tony-subagents"], ok: s.ok } : tony();
    case "rules":
      return pipeline && bare.startsWith("handoff verifier") ? { edges: ["tony-subagents"], ok: s.ok } : { edges: ["fs-tony"], ok: s.ok };
    case "vad":
    case "stt":
      return { edges: ["voice-tony"], ok: s.ok };
    case "input":
      return bare === "voice line" ? { edges: ["voice-tony"], ok: s.ok } : tony();
    case "tts":
      return { edges: ["tony-voice"], ok: s.ok };
    case "ui":
    default:
      return tony();
  }
}

const IPC_MEMWRITE = new Set(["dev_task_add", "dev_task_update", "dev_task_delete", "memory_harvest", "memory_flush", "memory_mount"]);
const IPC_MEDIA = new Set(["spotify_control", "spotify_play", "spotify_play_uri"]);

/**
 * Inferred hits from the IPC ring. Dev-task and memory writes are the app's (or the user's)
 * own writes, so they light the Memory DB node only — never a Tony edge. Spotify direct
 * commands bypass `call_tool` (no trace), so they only show up here.
 */
export function edgesForIpc(c: IpcCall): FlowHit | null {
  if (IPC_MEMWRITE.has(c.name)) return { edges: [], flash: "memwrite", ok: c.ok };
  if (IPC_MEDIA.has(c.name)) return { edges: [], flash: "media", ok: c.ok };
  return null;
}

/**
 * The entries appended since `prevLast` (the previous ring's newest entry), at most `max`.
 * By identity: the rings append and trim from the front and keep object identity.
 */
/**
 * Re-time live activity for static mode (collapsed strip / reduced motion): staggered pulse
 * births and flash arrivals scheduled in the future by travel mode are pulled to `t0`, so
 * the single static clear-timer prunes everything instead of leaving a frozen highlight.
 */
export function retimeToNow(pulses: readonly { born: number }[], flashes: Iterable<{ at: number }>, t0: number): void {
  for (const p of pulses) if (p.born > t0) p.born = t0;
  for (const f of flashes) if (f.at > t0) f.at = t0;
}

export function freshTail<T>(items: readonly T[], prevLast: T | null | undefined, max = 8): T[] {
  if (!items.length || prevLast === items[items.length - 1]) return [];
  const idx = prevLast ? items.lastIndexOf(prevLast) : -1;
  return (idx >= 0 ? items.slice(idx + 1) : items).slice(-max);
}

export const freshIpc = (calls: readonly IpcCall[], prevLast: IpcCall | null | undefined, max = 8) => freshTail(calls, prevLast, max);

/** Each write counter in a snapshot, by key (null values left out). */
function writeCounters(snap: SystemSnapshot): Map<string, number> {
  const out = new Map<string, number>();
  for (const st of snap.stores) {
    if (st.id === "devqueue") for (const t of st.tables) if (t.rows != null) out.set(`devqueue:${t.name}`, t.rows);
    if (st.id === "training-logs" && st.metrics.todayLines != null) out.set("training-logs:todayLines", st.metrics.todayLines);
    if (st.id === "cc" && st.metrics.vaultItems != null) out.set("cc:vaultItems", st.metrics.vaultItems);
  }
  return out;
}

/**
 * How many writes the stores grew by between two snapshots: devqueue table rows,
 * training-log lines today and cc vault items. Only counters present in both count, and
 * only growth (a delete or the midnight reset is not a write). 0 without a previous snapshot.
 */
export function memWriteDelta(prev: SystemSnapshot | null | undefined, next: SystemSnapshot | null | undefined): number {
  if (!prev || !next) return 0;
  const a = writeCounters(prev);
  let n = 0;
  for (const [k, v] of writeCounters(next)) {
    const was = a.get(k);
    if (was != null && v > was) n += v - was;
  }
  return n;
}

// ── Node status (the pill LEDs) ──────────────────────────────────────────────

export interface NodeStatus {
  tone: Tone;
  text: string;
  why: string;
}

const RANK: Record<Tone, number> = { down: 3, warn: 2, ok: 1, idle: 0 };
const worst = (a: Tone, b: Tone): Tone => (RANK[a] >= RANK[b] ? a : b);
const DASH_TEXT = "—";

function busStatus(bus: readonly SnapBus[], ids: string[], missing: string): NodeStatus {
  const found = ids.map((id) => bus.find((b) => b.id === id)).filter((b): b is SnapBus => !!b);
  if (!found.length) return { tone: "idle", text: DASH_TEXT, why: missing };
  const tone = found.map((b) => busTone(b.status)).reduce(worst);
  const lead = found.find((b) => busTone(b.status) === tone) ?? found[0];
  const src = found.map((b) => b.source).filter(Boolean);
  return { tone, text: busText(lead.status), why: [...found.map((b) => `${b.name}: ${busWhy(b)}`), ...(src.length ? [`key source: ${src.join(", ")}`] : [])].join("\n") };
}

/**
 * Status LED per node, from the live snapshot (and the voice state). A node with no source
 * reads idle with a "why" saying what is missing.
 */
export function flowNodeStatus(snap: SystemSnapshot | null, o: { voice?: VoiceState; why?: string } = {}): Record<FlowNodeId, NodeStatus> {
  const none = o.why ?? "Waiting for the first system snapshot";
  const idle = (why: string): NodeStatus => ({ tone: "idle", text: DASH_TEXT, why });
  if (!snap) {
    const all = Object.fromEntries(FLOW_NODES.map((n) => [n.id, idle(none)])) as Record<FlowNodeId, NodeStatus>;
    if (o.voice) all.voice = { tone: o.voice === "error" ? "down" : "idle", text: o.voice, why: `Voice state: ${o.voice}. ${none}` };
    return all;
  }
  const bus = snap.bus;

  // Voice: the STT / TTS services plus the controller's state.
  const av = snap.services.filter((s) => s.kind === "stt" || s.kind === "tts");
  let voice: NodeStatus;
  if (!av.length) voice = idle("No STT / TTS provider configured");
  else {
    const up = av.filter((s) => s.up).length;
    voice = {
      tone: o.voice === "error" ? "down" : up === av.length ? "ok" : up ? "warn" : "down",
      text: `${up}/${av.length} up`,
      why: [...av.map((s) => `${s.label}: ${s.up ? "up" : `down (${s.detail || "no answer"})`}`), o.voice ? `Voice state: ${o.voice}` : ""].filter(Boolean).join("\n"),
    };
  }

  // Telemetry: host sampling + the Rust background loops.
  const h = snap.host;
  const daemon = daemonState(snap.routines.loops);
  const telemetry: NodeStatus = h.error
    ? { tone: "down", text: "Error", why: h.error }
    : {
        tone: o.why ? "warn" : daemon && daemon.healthy < daemon.ran ? "warn" : "ok",
        text: h.cpuPct != null ? `CPU ${Math.round(h.cpuPct)}%` : "Sampling",
        why: [o.why && `Last refresh failed: ${o.why}`, h.gpu ? `GPU ${Math.round(h.gpu.utilPct)}%` : h.gpuNote, daemon ? `${daemon.healthy}/${daemon.total} loops healthy` : "No background loop has run yet"].filter(Boolean).join("\n"),
      };

  // Memory mapping: the persistent stores.
  const { storesOk, storesTotal } = snap.summary;
  const memory: NodeStatus = storesTotal
    ? { tone: storesOk === storesTotal ? "ok" : storesOk ? "warn" : "down", text: `${storesOk}/${storesTotal} ok`, why: snap.stores.map((s) => `${s.label}: ${s.health}${s.error ? ` (${s.error})` : ""}`).join("\n") }
    : idle("No stores reported");

  // MCP hub: every enabled server on the bus.
  const live = bus.filter((b) => b.status !== "off");
  const okN = live.filter((b) => b.status === "ok").length;
  const hubTone = live.length ? live.map((b) => busTone(b.status)).reduce(worst) : "idle";
  const hub: NodeStatus = live.length
    ? { tone: hubTone === "down" && okN > 0 ? "warn" : hubTone, text: `${okN}/${live.length} connected`, why: live.map((b) => `${b.name}: ${busText(b.status)}`).join("\n") }
    : idle("No MCP servers enabled");

  // Tony: the head of the provider chain.
  const head = snap.chain[0];
  const svc = head ? snap.services.find((s) => s.id === head.id) : undefined;
  const busy = snap.slot.active.some((l) => / · Tony\b/.test(l));
  const tony: NodeStatus = !head
    ? idle("No provider chain configured")
    : svc
      ? { tone: svc.up ? "ok" : "down", text: busy ? "Busy" : svc.up ? head.label : "Down", why: `${head.label}${head.model ? ` · ${head.model}` : ""}: ${svc.up ? `up, ${svc.latencyMs} ms` : svc.detail || "no answer"}` }
      : { tone: "idle", text: head.label, why: `${head.label} has no health probe` };

  // Memory DB writes: the writable stores.
  const sinks = snap.stores.filter((s) => s.id === "devqueue" || s.id === "cc" || s.id === "training-logs");
  const memwrite: NodeStatus = sinks.length
    ? {
        tone: sinks.some((s) => s.health === "error") ? "down" : sinks.some((s) => s.health !== "ok" || s.writable === false) ? "warn" : "ok",
        text: `${sinks.filter((s) => s.health === "ok" && s.writable !== false).length}/${sinks.length} writable`,
        why: sinks.map((s) => `${s.label}: ${s.health}${s.writable === false ? ", read-only" : ""}`).join("\n"),
      }
    : idle("No writable store reported");

  // Sub-agents: the AnythingLLM roster (everyone but Tony).
  const subs = snap.agents.filter((a) => a.role !== "general");
  const subagents: NodeStatus = !subs.length
    ? idle("No sub-agents in os.json")
    : subs.every((a) => a.found === null)
      ? idle(snap.agentsNote ?? "AnythingLLM unreachable")
      : {
          tone: subs.some((a) => a.found === false) ? "warn" : "ok",
          text: `${subs.filter((a) => a.active).length} active / ${subs.length}`,
          why: subs.map((a) => `${a.label}: ${a.active ? "active" : a.found === false ? "missing workspace" : "idle"}`).join("\n"),
        };

  return {
    gmail: busStatus(bus, ["gmail", "gmail-multi"], "Gmail isn't registered in os.json"),
    voice,
    telemetry,
    memory,
    fs: busStatus(bus, ["filesystem", "git"], "Filesystem / git servers aren't registered"),
    hub,
    brave: busStatus(bus, ["brave-search"], "Brave Search isn't registered in os.json"),
    tony,
    memwrite,
    subagents,
    media: busStatus(bus, ["spotify"], "Spotify isn't registered in os.json"),
  };
}

// ── Geometry ─────────────────────────────────────────────────────────────────

export type P2 = [number, number];
export type FlowOrient = "h" | "v";

export interface NodeBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FlowLayout {
  orient: FlowOrient;
  width: number;
  height: number;
  nodes: Record<FlowNodeId, NodeBox>;
  /** Cubic Bezier per edge: start, control 1, control 2, end. */
  paths: Record<FlowEdgeId, [P2, P2, P2, P2]>;
}

/** Horizontal (left → right) at or above this width; stacked rows below it. */
export const FLOW_H_MIN_WIDTH = 360;
export const flowOrientation = (width: number): FlowOrient => (width >= FLOW_H_MIN_WIDTH ? "h" : "v");

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const PAD = 6;

function columns(): FlowNode[][] {
  const cols: FlowNode[][] = [[], [], []];
  for (const n of FLOW_NODES) cols[n.column].push(n);
  return cols;
}

/** Node boxes and edge curves for a `width` × `height` box (px). */
export function flowLayout(width: number, height: number, orient: FlowOrient): FlowLayout {
  const w = Math.max(width, 120);
  const h = Math.max(height, 60);
  const nodes = {} as Record<FlowNodeId, NodeBox>;
  const cols = columns();
  if (orient === "h") {
    const ph = clamp((h - 2 * PAD) / 5 - 4, 14, 24);
    const pw = clamp(w * 0.22, 96, 210);
    const xs = [PAD, (w - pw) / 2, w - PAD - pw];
    cols.forEach((col, c) => {
      const slot = (h - 2 * PAD) / col.length;
      col.forEach((n, i) => (nodes[n.id] = { x: xs[c], y: PAD + slot * (i + 0.5) - ph / 2, w: pw, h: ph }));
    });
  } else {
    const ph = 22;
    const ys = [PAD, (h - ph) / 2, h - PAD - ph];
    cols.forEach((col, c) => {
      const gap = 6;
      const pw = Math.min(170, (w - 2 * PAD - gap * (col.length - 1)) / col.length);
      const total = pw * col.length + gap * (col.length - 1);
      const x0 = (w - total) / 2;
      col.forEach((n, i) => (nodes[n.id] = { x: x0 + i * (pw + gap), y: ys[c], w: pw, h: ph }));
    });
  }

  const paths = {} as Record<FlowEdgeId, [P2, P2, P2, P2]>;
  for (const e of FLOW_EDGES) {
    const a = nodes[e.from];
    const b = nodes[e.to];
    const ca = NODE_BY_ID[e.from].column;
    const cb = NODE_BY_ID[e.to].column;
    paths[e.id] = orient === "h" ? curveH(a, b, ca, cb) : curveV(a, b, ca, cb);
  }
  return { orient, width: w, height: h, nodes, paths };
}

/** Left → right; a backward edge (destination column left of the source) runs just under its forward twin. */
function curveH(a: NodeBox, b: NodeBox, ca: number, cb: number): [P2, P2, P2, P2] {
  if (ca === cb) {
    // Same column: bottom → top (or top → bottom), bowing out to the right.
    const down = b.y > a.y;
    const s: P2 = [a.x + a.w * 0.62, down ? a.y + a.h : a.y];
    const t: P2 = [b.x + b.w * 0.62, down ? b.y : b.y + b.h];
    const dy = (t[1] - s[1]) * 0.5;
    return [s, [s[0] + 14, s[1] + dy], [t[0] + 14, t[1] - dy], t];
  }
  const fwd = ca < cb;
  const off = fwd ? 0 : Math.min(5, a.h * 0.3);
  const s: P2 = [fwd ? a.x + a.w : a.x, a.y + a.h / 2 + off];
  const t: P2 = [fwd ? b.x : b.x + b.w, b.y + b.h / 2 + off];
  const dx = (t[0] - s[0]) * 0.5;
  return [s, [s[0] + dx, s[1]], [t[0] - dx, t[1]], t];
}

/** Top → bottom; same-row edges run side to side. */
function curveV(a: NodeBox, b: NodeBox, ca: number, cb: number): [P2, P2, P2, P2] {
  if (ca === cb) {
    const right = b.x > a.x;
    const s: P2 = [right ? a.x + a.w : a.x, a.y + a.h / 2];
    const t: P2 = [right ? b.x : b.x + b.w, b.y + b.h / 2];
    const dx = (t[0] - s[0]) * 0.5;
    return [s, [s[0] + dx, s[1] - 8], [t[0] - dx, t[1] - 8], t];
  }
  const fwd = ca < cb;
  const off = fwd ? 0 : Math.min(6, a.w * 0.1);
  const s: P2 = [a.x + a.w / 2 + off, fwd ? a.y + a.h : a.y];
  const t: P2 = [b.x + b.w / 2 + off, fwd ? b.y : b.y + b.h];
  const dy = (t[1] - s[1]) * 0.5;
  return [s, [s[0], s[1] + dy], [t[0], t[1] - dy], t];
}

/** Point on a cubic Bezier at t ∈ [0, 1]. */
export function cubicAt([p0, p1, p2, p3]: readonly [P2, P2, P2, P2], t: number): P2 {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
}

/** SVG path data for a cubic. */
export const pathD = ([s, c1, c2, t]: readonly [P2, P2, P2, P2]): string =>
  `M${s[0].toFixed(1)},${s[1].toFixed(1)} C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${t[0].toFixed(1)},${t[1].toFixed(1)}`;

/** `n + 1` points along every edge, precomputed so a frame never measures an SVG path. */
export function edgeSamples(layout: FlowLayout, n = 24): Record<FlowEdgeId, P2[]> {
  const out = {} as Record<FlowEdgeId, P2[]>;
  for (const e of FLOW_EDGES) {
    const c = layout.paths[e.id];
    out[e.id] = Array.from({ length: n + 1 }, (_, i) => cubicAt(c, i / n));
  }
  return out;
}

/** Point at `t` (clamped) along sampled points, linearly interpolated. */
export function samplePoint(pts: readonly P2[], t: number): P2 | null {
  if (!pts.length) return null;
  if (pts.length === 1) return pts[0];
  const f = clamp(t, 0, 1) * (pts.length - 1);
  const i = Math.min(pts.length - 2, Math.floor(f));
  const k = f - i;
  return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * k, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * k];
}

/** The full label when it fits the pill (mono ~5.8 px/char at 9.5 px, plus LED and padding),
 * else the short one, cut with "…" when even that doesn't fit. */
export function pillLabel(n: FlowNode, pillWidth: number): string {
  const fits = (s: string) => s.length * 5.8 + 26 <= pillWidth;
  if (fits(n.label)) return n.label;
  if (fits(n.short)) return n.short;
  const room = Math.max(1, Math.floor((pillWidth - 26) / 5.8) - 1);
  return `${n.short.slice(0, room)}…`;
}
