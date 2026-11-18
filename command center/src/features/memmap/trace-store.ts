import { create } from "zustand";
import { isTauri, onNativeEvent, type PipelineStepEvent, type TraceHop, type TraceStep, type TraceZone } from "@/lib/platform";

/**
 * System Map live routing trace (plan §2): the last 500 `TraceStep`s, grouped by `traceId`.
 * Fed by Rust's `os-trace` event (router / rules / memory / model / tool), the webview's own
 * hops (input / vad / stt / tts / ui, recorded by voice-controller through `client-trace.ts`)
 * and the Idea-to-Execution `pipeline-step` events. Drives the stream panel and the 3D pulses.
 *
 * Steps carry labels, timings and error text only; client labels never include what the user
 * said or what came back, and every error string is pattern-scrubbed and capped here as well.
 */

export const TRACE_CAP = 500;
const LABEL_MAX = 160;
const ERROR_MAX = 200;

export const HOPS: readonly TraceHop[] = ["input", "vad", "stt", "router", "rules", "memory", "model", "tool", "tts", "ui"];
export const ZONES: readonly TraceZone[] = ["cockpit", "engine", "ecu", "cargo", "exhaust"];

const HOP_ZONE: Record<TraceHop, TraceZone> = {
  input: "cockpit",
  vad: "cockpit",
  stt: "cockpit",
  tts: "cockpit",
  ui: "cockpit",
  router: "engine",
  model: "engine",
  rules: "ecu",
  memory: "cargo",
  tool: "exhaust",
};

/** input/vad/stt/tts/ui → cockpit, router/model → engine, rules → ecu, memory → cargo, tool → exhaust. */
export const zoneOf = (hop: TraceHop): TraceZone => HOP_ZONE[hop];

export const isHop = (h: unknown): h is TraceHop => typeof h === "string" && (HOPS as readonly string[]).includes(h);

const SECRET_PATTERNS: [RegExp, string][] = [
  [/\b(?:sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g, "[redacted]"],
  [/\b(bearer|basic)(\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1$2[redacted]"],
  [/\b(authorization|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|token|key)(\s*[:=]\s*)[^\s,;]{6,}/gi, "$1$2[redacted]"],
];

/** Defence in depth for text that reached the webview (Rust already scrubs its own steps). */
export function scrubText(s: string): string {
  let out = s;
  for (const [re, by] of SECRET_PATTERNS) out = out.replace(re, by);
  return out.replace(/[A-Za-z0-9_\-+/=]{32,}/g, (run) => (/[A-Z]/.test(run) && /[a-z]/.test(run) && /\d/.test(run) ? "[redacted]" : run));
}

function cap(s: string, n: number): string {
  const t = s.trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}

/** Validate and normalise an incoming step (an event payload is untrusted shape-wise). `null` = drop it. */
export function normalizeStep(raw: unknown): TraceStep | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.traceId !== "string" || !r.traceId || !isHop(r.hop)) return null;
  const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const step: TraceStep = {
    traceId: cap(r.traceId, 80),
    seq: Math.max(0, Math.floor(num(r.seq))),
    hop: r.hop,
    zone: zoneOf(r.hop),
    label: cap(scrubText(typeof r.label === "string" ? r.label : ""), LABEL_MAX),
    ok: r.ok !== false,
    ms: Math.max(0, Math.round(num(r.ms))),
    at: num(r.at, Date.now()),
  };
  if (typeof r.error === "string" && r.error.trim()) step.error = cap(scrubText(r.error), ERROR_MAX);
  if (num(r.tps) > 0) step.tps = Math.round(num(r.tps) * 10) / 10;
  return step;
}

export interface TraceGroup {
  traceId: string;
  /** Steps in order: by `at`, then `seq`. */
  steps: TraceStep[];
  startedAt: number;
  endedAt: number;
  /** Wall time from the first step's start to the last step's end. */
  ms: number;
  ok: boolean;
  /** Zones in the order the trace first reached them (the pulse path). */
  path: TraceZone[];
  /** The slowest step (Dev X-Ray flags it). */
  slowest: TraceStep | null;
}

const order = (a: TraceStep, b: TraceStep) => a.at - b.at || a.seq - b.seq;

/** Group steps by `traceId`, newest trace first. Pure. */
export function groupTraces(steps: readonly TraceStep[]): TraceGroup[] {
  const by = new Map<string, TraceStep[]>();
  for (const s of steps) {
    const list = by.get(s.traceId);
    if (list) list.push(s);
    else by.set(s.traceId, [s]);
  }
  const groups: TraceGroup[] = [];
  for (const [traceId, list] of by) {
    const sorted = [...list].sort(order);
    const startedAt = Math.min(...sorted.map((s) => s.at - s.ms));
    const endedAt = Math.max(...sorted.map((s) => s.at));
    const path: TraceZone[] = [];
    for (const s of sorted) if (path[path.length - 1] !== s.zone) path.push(s.zone);
    const slowest = sorted.reduce<TraceStep | null>((m, s) => (!m || s.ms > m.ms ? s : m), null);
    groups.push({ traceId, steps: sorted, startedAt, endedAt, ms: Math.max(0, endedAt - startedAt), ok: sorted.every((s) => s.ok), path, slowest });
  }
  return groups.sort((a, b) => b.endedAt - a.endedAt);
}

/** Last and median ms of each hop across the ring (Cockpit inspector). Pure. */
export function hopStats(steps: readonly TraceStep[]): Partial<Record<TraceHop, { lastMs: number; medianMs: number; count: number; lastOk: boolean }>> {
  const out: Partial<Record<TraceHop, { lastMs: number; medianMs: number; count: number; lastOk: boolean }>> = {};
  for (const hop of HOPS) {
    const hs = steps.filter((s) => s.hop === hop).sort(order);
    if (!hs.length) continue;
    const ms = hs.map((s) => s.ms).sort((a, b) => a - b);
    const mid = ms.length >> 1;
    const last = hs[hs.length - 1];
    out[hop] = { lastMs: last.ms, medianMs: ms.length % 2 ? ms[mid] : Math.round((ms[mid - 1] + ms[mid]) / 2), count: hs.length, lastOk: last.ok };
  }
  return out;
}

/** Keep the newest `cap` steps (arrival order). Pure. */
export function appendSteps(ring: readonly TraceStep[], add: readonly TraceStep[], capN = TRACE_CAP): TraceStep[] {
  const next = ring.concat(add);
  return next.length > capN ? next.slice(next.length - capN) : next;
}

interface TraceState {
  steps: TraceStep[];
  push: (s: TraceStep) => void;
  clear: () => void;
}

export const useTrace = create<TraceState>((set) => ({
  steps: [],
  push: (s) => set((st) => ({ steps: appendSteps(st.steps, [s]) })),
  clear: () => set({ steps: [] }),
}));

/** Feed one raw step (event payload or client hop); invalid shapes are dropped. */
export function ingest(raw: unknown) {
  const s = normalizeStep(raw);
  if (s) useTrace.getState().push(s);
}

// ── Client-side hops ─────────────────────────────────────────────────────────

const clientSeq = new Map<string, number>();

/** A fresh trace id (`[A-Za-z0-9-]`, accepted by Rust's `trace::valid_id`). */
export function newTraceId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `t${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Record a webview-measured hop into `traceId`. `label` must not include what the user said. */
export function recordHop(traceId: string, hop: TraceHop, label: string, opts: { ok?: boolean; ms?: number; error?: string; at?: number } = {}) {
  if (!traceId) return;
  const seq = clientSeq.get(traceId) ?? 0;
  clientSeq.set(traceId, seq + 1);
  if (clientSeq.size > TRACE_CAP) clientSeq.delete(clientSeq.keys().next().value as string);
  ingest({ traceId, seq, hop, zone: zoneOf(hop), label, ok: opts.ok ?? true, ms: opts.ms ?? 0, error: opts.error, at: opts.at ?? Date.now() });
}

// ── Pipeline steps → trace steps ─────────────────────────────────────────────

/** Map one Idea-to-Execution `pipeline-step` into a trace step (agents and stage only, never the
 * step's text — except a failure's error text). `seq` is assigned by the caller. Pure. */
export function pipelineToStep(e: PipelineStepEvent, seq: number, at = Date.now()): TraceStep | null {
  if (!e || typeof e.pipelineId !== "string") return null;
  const librarian = e.from === "librarian" || e.to === "librarian";
  let hop: TraceHop;
  let label: string;
  switch (e.kind) {
    case "delegate":
    case "step-in":
      hop = "router";
      label = `${e.from} → ${e.to}`;
      break;
    case "tool":
      hop = "tool";
      label = e.to;
      break;
    case "verify":
      hop = "rules";
      label = "handoff verifier";
      break;
    case "overseer":
      hop = "model";
      label = `overseer · ${e.from}`;
      break;
    case "reply":
      hop = librarian ? "memory" : "model";
      label = `${e.from} replied`;
      break;
    default:
      hop = librarian ? "memory" : "model";
      label = `${e.from} failed`;
  }
  if (e.stage === "done") {
    hop = "ui";
    label = "Play Place card ready";
  }
  const failed = !e.ok;
  const error = failed ? (e.kind === "verify" ? "verifier flagged issues" : e.text || "failed") : undefined;
  return normalizeStep({ traceId: `pipeline:${e.pipelineId}`, seq, hop, label: `${e.stage} · ${label}`, ok: e.ok, ms: e.ms, error, at });
}

const pipelineSeq = new Map<string, number>();

function onPipelineStep(e: PipelineStepEvent) {
  const key = e?.pipelineId ?? "";
  const seq = pipelineSeq.get(key) ?? 0;
  pipelineSeq.set(key, seq + 1);
  if (pipelineSeq.size > 100) pipelineSeq.delete(pipelineSeq.keys().next().value as string);
  const s = pipelineToStep(e, seq);
  if (s) useTrace.getState().push(s);
}

let feed: Promise<() => void> | null = null;

/** Subscribe once to `os-trace` + `pipeline-step` (desktop only; a no-op on the PWA). Idempotent. */
export function startTraceFeed(): Promise<() => void> {
  if (!isTauri()) return Promise.resolve(() => undefined);
  feed ??= Promise.all([onNativeEvent<unknown>("os-trace", ingest), onNativeEvent<PipelineStepEvent>("pipeline-step", onPipelineStep)]).then(
    (offs) => () => {
      for (const off of offs) off();
      feed = null;
    },
  );
  return feed;
}

// Start at boot (this module loads with voice-controller), so turns made before the System
// Map is opened are already in the ring when it is.
void startTraceFeed();

/**
 * Steps that arrived after the paused snapshot. Counted by identity, not length: once the
 * 500-step ring is full both arrays are the same length. If the snapshot's last step has
 * already been evicted, everything in the ring is new.
 */
export function stepsSince(steps: readonly TraceStep[], frozen: readonly TraceStep[]): number {
  const last = frozen[frozen.length - 1];
  if (!last) return steps.length;
  const i = steps.lastIndexOf(last);
  return i >= 0 ? steps.length - 1 - i : steps.length;
}
