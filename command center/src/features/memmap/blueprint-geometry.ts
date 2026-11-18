import type { SnapSummary, TraceStep } from "@/lib/platform";
import { DASH, fmtMs, pct } from "./format";

/**
 * Pure geometry and data shaping for the bottom-right SUB-COMPONENT callout (the
 * "Gabagool blueprint"): an exploded technical wireframe of the 325i's M54B25 inline-six —
 * the cylinder bank with live pistons, the intake manifold lifted off the top, the exhaust
 * headers pulled out to the side, and the drivetrain slid out the back — plus the live
 * telemetry rows shown under it. No DOM, deterministic, unit-tested in node.
 *
 * Module space: x along the crank (front +), y up, z across the engine; one cylinder
 * bore ≈ 0.36 units.
 */

export type P2 = readonly [number, number];
export type P3 = readonly [number, number, number];

/** mulberry32: a tiny deterministic PRNG in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Orthographic projection: yaw about y, then pitch about x; returns screen (x right, y down). */
export function project(p: P3, yaw: number, pitch: number, scale: number, cx: number, cy: number): P2 {
  const [x, y, z] = p;
  const cyw = Math.cos(yaw);
  const syw = Math.sin(yaw);
  const x1 = x * cyw + z * syw;
  const z1 = -x * syw + z * cyw;
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const y2 = y * cp - z1 * sp;
  return [cx + x1 * scale, cy - y2 * scale];
}

// ── Engine kinematics ────────────────────────────────────────────────────────

export const CYLINDERS = 6;
/** Cylinder pitch along the crank. */
export const BORE_PITCH = 0.42;
export const BORE_R = 0.17;
/** Crank throw and con-rod length (stroke = 2 × throw). */
export const THROW = 0.16;
export const ROD = 0.5;
/** Crank-pin phase per cylinder (deg) for the I6's 1-5-3-6-2-4 firing order: pairs 1/6, 2/5, 3/4. */
export const I6_PHASE_DEG = [0, 240, 120, 120, 240, 0] as const;

/** x of cylinder `i` (0 = cylinder 1 at the front). */
export const cylinderX = (i: number) => ((CYLINDERS - 1) / 2 - i) * BORE_PITCH;

/** Slider-crank: piston pin height above the crank axis at crank angle `theta` (0 = top dead centre). */
export function pistonLift(theta: number, throwR = THROW, rod = ROD): number {
  const s = throwR * Math.sin(theta);
  return throwR * Math.cos(theta) + Math.sqrt(rod * rod - s * s);
}

// ── Modules ──────────────────────────────────────────────────────────────────

export type ModuleId = "pistons" | "intake" | "exhaust" | "drivetrain";

export interface BlueprintModule {
  id: ModuleId;
  label: string;
  /** Polylines in module space, assembled position. */
  lines: P3[][];
  /** Where the module flies to when fully exploded (added to every point). */
  explode: P3;
  /** A point on the module for its label and its guide line back to the block. */
  anchor: P3;
}

function circleXZ(c: P3, r: number, n = 16): P3[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return [c[0] + r * Math.cos(a), c[1], c[2] + r * Math.sin(a)] as P3;
  });
}

function circleYZ(c: P3, r: number, n = 16): P3[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return [c[0], c[1] + r * Math.sin(a), c[2] + r * Math.cos(a)] as P3;
  });
}

function boxLines(c: P3, s: P3): P3[][] {
  const [hx, hy, hz] = [s[0] / 2, s[1] / 2, s[2] / 2];
  const p = (i: number, j: number, k: number): P3 => [c[0] + i * hx, c[1] + j * hy, c[2] + k * hz];
  return [
    [p(-1, -1, -1), p(1, -1, -1), p(1, -1, 1), p(-1, -1, 1), p(-1, -1, -1)],
    [p(-1, 1, -1), p(1, 1, -1), p(1, 1, 1), p(-1, 1, 1), p(-1, 1, -1)],
    [p(-1, -1, -1), p(-1, 1, -1)],
    [p(1, -1, -1), p(1, 1, -1)],
    [p(1, -1, 1), p(1, 1, 1)],
    [p(-1, -1, 1), p(-1, 1, 1)],
  ];
}

/** Deck height of the cylinder bank (crank axis at y = 0). */
const DECK = THROW + ROD + 0.22;
const BANK_HALF = (CYLINDERS * BORE_PITCH) / 2 + 0.06;

/** The parts of the cylinder bank that never move: the open block outline, the crank axis and a bore ring per cylinder at the deck. */
function bankStatic(): P3[][] {
  const out: P3[][] = [...boxLines([0, DECK / 2 - 0.05, 0], [BANK_HALF * 2, DECK + 0.1, 0.5])];
  out.push([
    [BANK_HALF + 0.12, 0, 0],
    [-BANK_HALF - 0.12, 0, 0],
  ]);
  for (let i = 0; i < CYLINDERS; i++) out.push(circleXZ([cylinderX(i), DECK, 0], BORE_R));
  return out;
}

/** The moving parts at crank angle `theta`: per cylinder a piston (crown + skirt rings), its con-rod and crank throw. */
function bankMoving(theta: number): P3[][] {
  const out: P3[][] = [];
  for (let i = 0; i < CYLINDERS; i++) {
    const x = cylinderX(i);
    const a = theta + (I6_PHASE_DEG[i] * Math.PI) / 180;
    const pin: P3 = [x, pistonLift(a), 0];
    const crankPin: P3 = [x, THROW * Math.cos(a), THROW * Math.sin(a)];
    out.push(circleXZ([x, pin[1] + 0.09, 0], BORE_R * 0.92, 12));
    out.push(circleXZ([x, pin[1] - 0.05, 0], BORE_R * 0.92, 12));
    out.push([pin, crankPin]);
    out.push([[x, 0, 0], crankPin]);
  }
  return out;
}

/**
 * The cylinder bank at crank angle `theta`: the open block outline, a bore ring per
 * cylinder at the deck, and per cylinder a piston (crown + skirt rings), its con-rod and
 * crank throw, plus the crank axis.
 */
export function cylinderBank(theta: number): P3[][] {
  return [...BANK_STATIC, ...bankMoving(theta)];
}

/** The intake manifold: a plenum along the bank with six curved runners down to the ports. */
export function intakeManifold(): P3[][] {
  const out: P3[][] = [];
  const pz = -0.42;
  const py = DECK + 0.1;
  for (const dy of [-0.09, 0.09]) out.push([[BANK_HALF, py + dy, pz], [-BANK_HALF, py + dy, pz]]);
  out.push(circleYZ([BANK_HALF, py, pz], 0.09, 12), circleYZ([-BANK_HALF, py, pz], 0.09, 12));
  out.push(circleYZ([BANK_HALF + 0.14, py, pz], 0.11, 12));
  for (let i = 0; i < CYLINDERS; i++) {
    const x = cylinderX(i);
    out.push(
      Array.from({ length: 9 }, (_, k) => {
        const t = (k / 8) * Math.PI;
        return [x, py + 0.12 * Math.sin(t), pz + 0.32 * (1 - Math.cos(t)) * 0.5 + 0.06] as P3;
      }),
    );
  }
  return out;
}

/** Exhaust headers: six primaries swept down into two 3-into-1 collectors and a downpipe each. */
export function exhaustManifold(): P3[][] {
  const out: P3[][] = [];
  const port = (i: number): P3 => [cylinderX(i), DECK - 0.08, 0.3];
  for (let i = 0; i < CYLINDERS; i++) {
    const p = port(i);
    const cx = i < 3 ? cylinderX(1) : cylinderX(4);
    out.push([p, [p[0], p[1] - 0.16, p[2] + 0.22], [(p[0] + cx) / 2, p[1] - 0.42, p[2] + 0.3], [cx, p[1] - 0.62, p[2] + 0.3]]);
    out.push(circleXZ(p, 0.06, 10));
  }
  for (const cx of [cylinderX(1), cylinderX(4)]) {
    const c: P3 = [cx, DECK - 0.7, 0.6];
    out.push(circleXZ(c, 0.09, 12));
    out.push([c, [cx - 0.5, DECK - 1.05, 0.55]]);
  }
  return out;
}

/** Drivetrain: bellhousing and gearbox (a tapered tube), the driveshaft and the differential. */
export function drivetrain(): P3[][] {
  const out: P3[][] = [];
  const xs = [0, -0.25, -0.6, -0.95];
  const rs = [0.42, 0.36, 0.24, 0.16];
  for (let k = 0; k < xs.length; k++) out.push(circleYZ([xs[k], 0, 0], rs[k], 18));
  for (let j = 0; j < 6; j++) {
    const a = (j / 6) * Math.PI * 2;
    out.push(xs.map((x, k) => [x, rs[k] * Math.sin(a), rs[k] * Math.cos(a)] as P3));
  }
  out.push([
    [-0.95, 0.04, 0],
    [-1.75, 0.04, 0],
  ]);
  out.push([
    [-0.95, -0.04, 0],
    [-1.75, -0.04, 0],
  ]);
  out.push(circleYZ([-1.35, 0, 0], 0.08, 10));
  out.push(circleYZ([-1.98, 0, 0], 0.24, 18), circleXZ([-1.98, 0, 0], 0.24, 18));
  out.push([
    [-1.98, 0, -0.24],
    [-1.98, 0, -0.62],
  ]);
  out.push([
    [-1.98, 0, 0.24],
    [-1.98, 0, 0.62],
  ]);
  return out;
}

// Built once: only the pistons, rods and throws depend on the crank angle. Shared, never mutated.
const BANK_STATIC: readonly P3[][] = bankStatic();
let STATIC_MODS: BlueprintModule[] | null = null;
function staticModules(): BlueprintModule[] {
  STATIC_MODS ??= [
    { id: "intake", label: "INTAKE", lines: intakeManifold(), explode: [0, 0.75, -0.25], anchor: [cylinderX(5), DECK + 0.22, -0.42] },
    { id: "exhaust", label: "EXH", lines: exhaustManifold(), explode: [0, -0.15, 0.7], anchor: [cylinderX(4), DECK - 0.7, 0.6] },
    { id: "drivetrain", label: "DRIVE", lines: drivetrain().map((l) => l.map(([x, y, z]) => [x - BANK_HALF - 0.1, y + 0.1, z] as P3)), explode: [-0.5, -0.15, 0], anchor: [-BANK_HALF - 2.08, 0.1, 0] },
  ];
  return STATIC_MODS;
}

/**
 * All four modules, assembled positions and their explode vectors. Deterministic for a given
 * `theta`. Only the pistons module is rebuilt per call; the intake, exhaust, drivetrain and
 * the block's static lines are cached and shared (treat them as read-only).
 */
export function blueprintModules(theta: number): BlueprintModule[] {
  return [{ id: "pistons", label: "CYL ×6", lines: cylinderBank(theta), explode: [0, 0, 0], anchor: [cylinderX(0), DECK, -0.25] }, ...staticModules()];
}

export interface BlueprintFit {
  scale: number;
  cx: number;
  cy: number;
}

/** Yaw swing of the animated view: 0.55 ± 0.28 rad. */
export const BLUEPRINT_YAW = 0.55;
export const BLUEPRINT_YAW_SWING = 0.28;
/** explodeAt's range. */
const EXPLODE_MIN = 0.72;

/**
 * One fixed fit for a `w`×`h` box: the union of projected bounds over the whole animation
 * (explode 0.72–1, the full yaw swing, a crank revolution), so the drawing never re-scales
 * frame to frame. `still` fits only the static frame (reduced motion: yaw 0.55, fully exploded).
 */
export function blueprintFit(w: number, h: number, pitch: number, still = false): BlueprintFit {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const yaws = still ? [BLUEPRINT_YAW] : Array.from({ length: 9 }, (_, k) => BLUEPRINT_YAW - BLUEPRINT_YAW_SWING + (k / 8) * 2 * BLUEPRINT_YAW_SWING);
  const es = still ? [1] : [EXPLODE_MIN, 1];
  const thetas = still ? [0] : Array.from({ length: 8 }, (_, k) => (k / 8) * Math.PI * 2);
  for (const theta of thetas) {
    const mods = blueprintModules(theta);
    for (const yaw of yaws)
      for (const e of es)
        for (const m of mods)
          for (const l of m.lines)
            for (const p of l) {
              const [sx, sy] = project(explodePoint(p, m, e), yaw, pitch, 1, 0, 0);
              if (sx < minX) minX = sx;
              if (sx > maxX) maxX = sx;
              if (sy < minY) minY = sy;
              if (sy > maxY) maxY = sy;
            }
  }
  const pad = 10;
  const scale = Math.max(1e-6, Math.min((w - 2 * pad) / Math.max(1e-6, maxX - minX), (h - 2 * pad - 6) / Math.max(1e-6, maxY - minY)));
  return { scale, cx: w / 2 - ((minX + maxX) / 2) * scale, cy: h / 2 + 3 - ((minY + maxY) / 2) * scale };
}

/** A point moved along its module's explode vector by `e` (0 = assembled, 1 = fully exploded). */
export function explodePoint(p: P3, m: Pick<BlueprintModule, "explode">, e: number): P3 {
  return [p[0] + m.explode[0] * e, p[1] + m.explode[1] * e, p[2] + m.explode[2] * e];
}

/** Gentle breathing of the explode factor (0.72–1.0, period 7 s). */
export const explodeAt = (tSec: number) => 0.86 + 0.14 * Math.sin((tSec * 2 * Math.PI) / 7);

/** Crank speed in rad/s: idles at 0.4 rev/s, up to 2 rev/s at 100 % CPU; idle when CPU load is unknown. */
export function crankSpeed(cpuPct: number | null | undefined): number {
  const load = cpuPct == null || !Number.isFinite(cpuPct) ? 0 : Math.max(0, Math.min(100, cpuPct)) / 100;
  return 2 * Math.PI * (0.4 + 1.6 * load);
}

// ── Telemetry ────────────────────────────────────────────────────────────────

export interface TelemetryRow {
  key: "cpu" | "gpu" | "vram" | "tps";
  module: ModuleId;
  label: string;
  /** Display text, DASH when the source is missing. */
  value: string;
  /** 0–100 for a gauge, null when there's no live share to show. */
  pct: number | null;
  /** Tooltip: where the number comes from, or why it's missing. */
  why: string;
}

const pctText = (v: number | null) => (v == null ? DASH : `${Math.round(v)}%`);

/**
 * The four live rows under the exploded view, each tied to a module: CPU → pistons,
 * GPU → intake, VRAM → exhaust, tokens/s (or the last model hop's latency) → drivetrain.
 * Only real sources: the system snapshot's summary and the trace ring. Missing → DASH.
 */
export function telemetryRows(summary: SnapSummary | null | undefined, steps: readonly TraceStep[]): TelemetryRow[] {
  const noSnap = "No system snapshot yet (desktop app only)";
  const clampPct = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? null : Math.max(0, Math.min(100, v)));
  const cpu = clampPct(summary?.cpuPct);
  const gpu = clampPct(summary?.gpuUtilPct);
  const vram = summary ? pct(summary.vramUsedMb, summary.vramTotalMb) : null;
  // The drive row reports the newest model hop only: its tokens/s, else its latency, else a
  // dash. Never an older hop's tokens/s presented as current.
  let lastModel: TraceStep | null = null;
  for (let i = steps.length - 1; i >= 0; i--)
    if (steps[i].hop === "model") {
      lastModel = steps[i];
      break;
    }
  const tps = lastModel?.tps != null && Number.isFinite(lastModel.tps) ? lastModel.tps : null;
  const lat = lastModel ? fmtMs(lastModel.ms) : null;
  const drive: TelemetryRow =
    tps != null
      ? { key: "tps", module: "drivetrain", label: "TOK/S", value: tps >= 10 ? `${Math.round(tps)}` : tps.toFixed(1), pct: null, why: "Tokens per second of the newest model reply" }
      : lat
        ? { key: "tps", module: "drivetrain", label: "LAT", value: lat, pct: null, why: "Latency of the newest model hop (its tokens/s wasn't measured)" }
        : { key: "tps", module: "drivetrain", label: "TOK/S", value: DASH, pct: null, why: lastModel ? "Newest model hop had no timing" : "No model turn traced yet" };
  return [
    { key: "cpu", module: "pistons", label: "CPU", value: pctText(cpu), pct: cpu, why: summary ? (cpu == null ? "CPU load not reported" : "Host CPU load (system snapshot)") : noSnap },
    { key: "gpu", module: "intake", label: "GPU", value: pctText(gpu), pct: gpu, why: summary ? (gpu == null ? "No GPU stats (see Hardware)" : "GPU utilisation (system snapshot)") : noSnap },
    { key: "vram", module: "exhaust", label: "VRAM", value: pctText(vram), pct: vram, why: summary ? (vram == null ? "No VRAM stats (see Hardware)" : "VRAM in use (system snapshot)") : noSnap },
    drive,
  ];
}
