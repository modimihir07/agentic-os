import type { TraceStep, TraceZone } from "@/lib/platform";
import { bodyShell, bodyWireframe, CAR, chassisWireframe, type BodyShell, type V2, type V3 } from "./e46-body";
import { wheelGeometry } from "./wheel-geometry";

export { CAR, UPPER_PROFILE } from "./e46-body";
export type { V2, V3 } from "./e46-body";

/**
 * Pure geometry for the System Map's holographic E46 Touring (2004 325i, "GABAGOUL") —
 * no three.js import, so it unit-tests in node and stays tree-shakeable. Everything is in
 * metres: x runs rear (−) to front (+), y is up from the ground, z is the car's width
 * (+z = right side). Real E46 Touring proportions: 4.48 m long, 1.74 m wide, ~1.45 m
 * tall, 2.725 m wheelbase.
 *
 * Wireframe output is flat segment lists ([x1,y1,z1, x2,y2,z2, …]) grouped by colour:
 * `base` (Orient Blue body lines), `cyan` (glass, beltline, wheels, grille and lamps) and
 * `amber` (tail lamps, exhaust). The body itself (profile spline, loft, details, shell,
 * inner chassis) lives in e46-body.ts and the wheels in wheel-geometry.ts; this module
 * keeps the original exports as a facade and adds the zone, pulse, leader, camera and
 * pedestal helpers.
 */

/** Sample `n` points (inclusive of both ends) along an arc over a wheel. */
function arch(cx: number, r: number, fromDeg: number, toDeg: number, n: number): V2[] {
  const out: V2[] = [];
  for (let i = 0; i <= n; i++) {
    const a = ((fromDeg + ((toDeg - fromDeg) * i) / n) * Math.PI) / 180;
    out.push([cx + r * Math.cos(a), CAR.wheelRadius + r * Math.sin(a)]);
  }
  return out;
}

/** Lower edge, front bumper bottom → rear bumper bottom, with both wheel arches cut in. */
export function lowerProfile(): V2[] {
  const r = 0.4;
  return [
    [2.22, 0.3],
    [CAR.frontAxle + r + 0.02, 0.28],
    ...arch(CAR.frontAxle, r, 0, 180, 10),
    [CAR.frontAxle - r - 0.08, 0.24],
    [CAR.rearAxle + r + 0.08, 0.24],
    ...arch(CAR.rearAxle, r, 0, 180, 10),
    [CAR.rearAxle - r - 0.02, 0.28],
    [-2.22, 0.3],
  ];
}

/** Half-width of the body at height `y`: full at and below the beltline, tucking in to the roof. */
export function halfWidthAt(y: number, factor = 1): number {
  const t = Math.max(0, Math.min(1, (y - CAR.belt) / (CAR.roof - CAR.belt)));
  return (CAR.halfWidth - (CAR.halfWidth - CAR.roofHalfWidth) * t) * factor;
}

function polyline(points: readonly V3[], out: number[], closed = false) {
  for (let i = 0; i + 1 < points.length; i++) out.push(...points[i], ...points[i + 1]);
  if (closed && points.length > 2) out.push(...points[points.length - 1], ...points[0]);
}

function seg(a: V3, b: V3, out: number[]) {
  out.push(...a, ...b);
}

/** Circle of `n` segments around the x-axis-facing normal `axis` ("x": in the yz plane, "z": in the xy plane). */
export function circle(c: V3, r: number, axis: "x" | "z", n = 24): V3[] {
  const pts: V3[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push(axis === "z" ? [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a), c[2]] : [c[0], c[1] + r * Math.sin(a), c[2] + r * Math.cos(a)]);
  }
  return pts;
}

/** A rounded rectangle on a face (axis "x" = the car's nose or tail face, in the yz plane). */
export function roundedRect(c: V3, w: number, h: number, axis: "x" | "z", corner = 0.3, n = 3): V3[] {
  const hw = w / 2;
  const hh = h / 2;
  const r = Math.min(hw, hh) * corner;
  const corners: [number, number, number][] = [
    [hw - r, hh - r, 0],
    [-hw + r, hh - r, 90],
    [-hw + r, -hh + r, 180],
    [hw - r, -hh + r, 270],
  ];
  const pts: V3[] = [];
  for (const [u0, v0, start] of corners) {
    for (let i = 0; i <= n; i++) {
      const a = ((start + (90 * i) / n) * Math.PI) / 180;
      const u = u0 + r * Math.cos(a);
      const v = v0 + r * Math.sin(a);
      pts.push(axis === "x" ? [c[0], c[1] + v, c[2] + u] : [c[0] + u, c[1] + v, c[2]]);
    }
  }
  return pts;
}

export interface Wireframe {
  base: number[];
  cyan: number[];
  amber: number[];
  /** Inner chassis and drivetrain (engine, gearbox, shaft, diff, exhaust run, subframes): an x-ray layer. */
  inner?: number[];
  /** The closed body skin, for a depth-only occluder and the Fresnel rim. */
  shell?: BodyShell;
}

/** Legacy simple wheel (tyre faces, tread lines, rim, five double spokes). The car now uses
 * `wheelGeometry` (wheel-geometry.ts); kept for API compatibility. */
export function wheel(cx: number, side: 1 | -1, out: Wireframe) {
  const outer = side * (CAR.track + 0.11);
  const inner = side * (CAR.track - 0.1);
  const cy = CAR.wheelRadius;
  const n = 28;
  const tyreOut = circle([cx, cy, outer], CAR.wheelRadius, "z", n);
  const tyreIn = circle([cx, cy, inner], CAR.wheelRadius, "z", n);
  polyline(tyreOut, out.cyan, true);
  polyline(tyreIn, out.base, true);
  for (let i = 0; i < n; i += 2) seg(tyreOut[i], tyreIn[i], out.base);
  const rimR = 0.21;
  polyline(circle([cx, cy, outer], rimR, "z", n), out.cyan, true);
  polyline(circle([cx, cy, outer], 0.05, "z", 10), out.cyan, true);
  for (let k = 0; k < 5; k++) {
    for (const off of [-0.09, 0.09]) {
      const a = (k / 5) * Math.PI * 2 + Math.PI / 2;
      const hub: V3 = [cx + 0.05 * Math.cos(a), cy + 0.05 * Math.sin(a), outer];
      const rim: V3 = [cx + rimR * Math.cos(a + off), cy + rimR * Math.sin(a + off), outer];
      seg(hub, rim, out.cyan);
    }
  }
}

function append(dst: number[], src: readonly number[]) {
  for (let i = 0; i < src.length; i++) dst.push(src[i]);
}

/**
 * The whole car: body lines (e46-body), plate recess and twin tailpipes, four 18-inch
 * wheels (wheel-geometry), the inner chassis and the body shell. Deterministic.
 * `base`/`cyan`/`amber` stay inside the car's bounding box and `base` stays mirror-symmetric.
 */
export function e46Wireframe(): Wireframe {
  const body = bodyWireframe();
  const out: Wireframe = { base: body.base, cyan: body.cyan, amber: body.amber };

  // Rear plate recess and the twin tailpipes on the left (driver's) side.
  polyline(roundedRect([-2.23, 0.86, 0], 0.58, 0.15, "x", 0.25), out.base, true);
  for (const z of [-0.5, -0.39]) {
    const front = circle([-2.1, 0.24, z], 0.038, "x", 10);
    const back = circle([-2.29, 0.24, z], 0.038, "x", 10);
    polyline(back, out.amber, true);
    polyline(circle([-2.29, 0.24, z], 0.026, "x", 10), out.amber, true);
    for (let i = 0; i < back.length; i += 5) seg(front[i], back[i], out.amber);
  }

  for (const cx of [CAR.frontAxle, CAR.rearAxle]) {
    for (const side of [1, -1] as const) {
      const w = wheelGeometry({ cx, cy: CAR.wheelRadius, zc: side * CAR.track, side });
      append(out.base, w.tyre);
      append(out.cyan, w.rim);
      append(out.cyan, w.brake);
    }
  }
  out.inner = chassisWireframe();
  out.shell = bodyShell();
  return out;
}

/** Faint ground reference under the car: concentric rings and radial spokes. */
export function groundGrid(rings = 4, spokes = 16): number[] {
  const out: number[] = [];
  for (let r = 1; r <= rings; r++) polyline(circle([0, 0, 0], r * 0.85, "z", 48).map(([x, y]) => [x, 0, y] as V3), out, true);
  const R = rings * 0.85;
  for (let k = 0; k < spokes; k++) {
    const a = (k / spokes) * Math.PI * 2;
    out.push(0.85 * Math.cos(a), 0, 0.85 * Math.sin(a), R * Math.cos(a), 0, R * Math.sin(a));
  }
  return out;
}

/** Radius of the holographic pedestal the car stands on. */
export const PEDESTAL_R = 2.75;

export interface PedestalLines {
  /** Square tech grid on y = 0, clipped to the pedestal disc. */
  grid: number[];
  /** Rim (double ring), inner rings, the outer halo ring and the disc's lower edge with its struts. */
  rings: number[];
  /** Radial ticks round the rim: short every 3°, long every 15°. */
  ticks: number[];
}

/** The isometric pedestal under the car. Deterministic; everything on or just under y = 0. */
export function pedestal(R = PEDESTAL_R, cell = 0.25): PedestalLines {
  const grid: number[] = [];
  const steps = Math.floor(R / cell);
  for (let k = -steps; k <= steps; k++) {
    const u = k * cell;
    const h = Math.sqrt(Math.max(0, R * R - u * u));
    if (h <= 0) continue;
    grid.push(u, 0, -h, u, 0, h);
    grid.push(-h, 0, u, h, 0, u);
  }
  const rings: number[] = [];
  const flat = (r: number, y: number, n: number) => circle([0, 0, 0], r, "z", n).map(([x, z]) => [x, y, z] as V3);
  for (const r of [R, R + 0.06, R * 0.62, R * 0.36, R + 0.42]) polyline(flat(r, 0, 96), rings, true);
  const lower = flat(R + 0.06, -0.08, 96);
  polyline(lower, rings, true);
  const upper = flat(R + 0.06, 0, 96);
  for (let i = 0; i < upper.length; i += 4) seg(upper[i], lower[i], rings);
  const ticks: number[] = [];
  for (let d = 0; d < 360; d += 3) {
    const a = (d * Math.PI) / 180;
    const r1 = R + (d % 15 === 0 ? 0.26 : 0.16);
    ticks.push((R + 0.1) * Math.cos(a), 0, (R + 0.1) * Math.sin(a), r1 * Math.cos(a), 0, r1 * Math.sin(a));
  }
  return { grid, rings, ticks };
}

export interface SweepFan {
  positions: number[];
  /** Per-vertex RGB intensity (0–1, grey): 1 on the leading edge, fading to 0 on the trailing one. */
  colors: number[];
  index: number[];
}

/**
 * The radar sweep over the pedestal: an annular sector from `r0` to `r1` spanning `arc`
 * radians behind angle 0, bright on its leading edge and fading out behind it.
 */
export function sweepFan(r0 = 0.4, r1 = PEDESTAL_R, arc = 0.75, n = 24): SweepFan {
  const positions: number[] = [];
  const colors: number[] = [];
  const index: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = -arc * (1 - t);
    const v = t * t;
    for (const r of [r0, r1]) {
      positions.push(r * Math.cos(a), 0, r * Math.sin(a));
      colors.push(v, v, v);
    }
  }
  for (let i = 0; i < n; i++) {
    const a = 2 * i;
    index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  return { positions, colors, index };
}

// ── Zones ────────────────────────────────────────────────────────────────────

export interface ZoneVolume {
  zone: TraceZone;
  label: string;
  /** Box centre and size (the invisible hit volume). */
  center: V3;
  size: V3;
  /** Where pulses and callout leader lines attach. */
  anchor: V3;
}

/** Hood = engine (local inference), firewall = ECU (rules, skills, routines), cabin = cockpit
 * (I/O & voice), hatch = cargo (memory), tailpipe = exhaust (external MCP). Non-overlapping.
 * Every anchor but the exhaust's sits inside the lofted body (e46-body.test.ts checks it):
 * the engine anchor is under the hood skin, the ECU's in the cowl box below the windshield. */
export const ZONE_VOLUMES: readonly ZoneVolume[] = [
  { zone: "engine", label: "Engine bay", center: [1.69, 0.68, 0], size: [1.1, 0.6, 1.62], anchor: [1.7, 0.84, 0] },
  { zone: "ecu", label: "ECU & wiring harness", center: [0.98, 0.98, 0], size: [0.26, 0.34, 1.5], anchor: [0.98, 0.96, 0] },
  { zone: "cockpit", label: "Dashboard & console", center: [0, 1.14, 0], size: [1.6, 0.62, 1.5], anchor: [0.15, 1.2, 0] },
  { zone: "cargo", label: "Cargo trunk", center: [-1.5, 1.1, 0], size: [1.36, 0.7, 1.5], anchor: [-1.5, 1.22, 0] },
  { zone: "exhaust", label: "Exhaust", center: [-2.2, 0.24, -0.445], size: [0.3, 0.2, 0.36], anchor: [-2.3, 0.24, -0.445] },
];

export function zoneVolume(zone: TraceZone): ZoneVolume {
  return ZONE_VOLUMES.find((z) => z.zone === zone) ?? ZONE_VOLUMES[0];
}

export const zoneAnchor = (zone: TraceZone): V3 => zoneVolume(zone).anchor;

/** Do two axis-aligned boxes overlap (strictly)? Used by the tests to keep hit volumes apart. */
export function boxesOverlap(a: ZoneVolume, b: ZoneVolume): boolean {
  for (let k = 0; k < 3; k++) {
    if (Math.abs(a.center[k] - b.center[k]) >= (a.size[k] + b.size[k]) / 2) return false;
  }
  return true;
}

// ── Pulses ───────────────────────────────────────────────────────────────────

/** A pulse runs this long along its path, then fades. */
export const PULSE_MS = 900;

/** How long a zone glows after its pulse arrives. */
export const ZONE_FLASH_MS = 700;

/**
 * A zone flash at `age` ms after its pulse's arrival: "pending" while the pulse is still
 * travelling (keep the entry), the glow's opacity while it decays, "done" once it is over
 * (prune the entry so nothing touches the material per frame any more).
 */
export function zoneFlash(age: number, ms = ZONE_FLASH_MS): "pending" | "done" | number {
  if (age < 0) return "pending";
  if (age >= ms) return "done";
  return 0.16 * (1 - age / ms);
}

export interface Pulse {
  key: string;
  from: TraceZone;
  to: TraceZone;
  ok: boolean;
}

const stepKey = (s: TraceStep) => `${s.traceId}#${s.seq}#${s.hop}#${s.at}`;

/**
 * The steps that arrived since `prevLast` (the previous ring's newest step), at most `max`.
 * `useTrace` appends and trims from the front, so the new ones are the tail after it.
 * A cleared ring yields nothing; a ring that rotated past `prevLast` yields its last `max`.
 */
export function freshSteps(steps: readonly TraceStep[], prevLast: TraceStep | null | undefined, max = 8): TraceStep[] {
  if (!steps.length) return [];
  if (prevLast === steps[steps.length - 1]) return [];
  const idx = prevLast ? steps.lastIndexOf(prevLast) : -1;
  const fresh = idx >= 0 ? steps.slice(idx + 1) : steps;
  return fresh.slice(-max);
}

/**
 * One pulse per fresh step: from the zone of the previous step of the same trace (in
 * arrival order) to the step's zone. A trace's first step — or a hop that stays in its
 * zone — is a pulse with from === to (drawn as a flash at the anchor, no travel).
 */
export function pulsesFor(all: readonly TraceStep[], fresh: readonly TraceStep[]): Pulse[] {
  return fresh.map((s) => {
    const at = all.lastIndexOf(s);
    let from: TraceZone = s.zone;
    for (let i = (at < 0 ? all.length : at) - 1; i >= 0; i--) {
      if (all[i].traceId === s.traceId) {
        from = all[i].zone;
        break;
      }
    }
    return { key: stepKey(s), from, to: s.zone, ok: s.ok };
  });
}

/**
 * The spline a pulse travels: a quadratic arc from one anchor to the other, lifted above
 * the body so it reads as a harness line. `n + 1` points; empty when from === to.
 */
export function pulseCurve(from: TraceZone, to: TraceZone, n = 24): V3[] {
  if (from === to) return [];
  const a = zoneAnchor(from);
  const b = zoneAnchor(to);
  const dist = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const c: V3 = [(a[0] + b[0]) / 2, Math.max(a[1], b[1]) + 0.3 + 0.12 * dist, (a[2] + b[2]) / 2];
  const out: V3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1], u * u * a[2] + 2 * u * t * c[2] + t * t * b[2]]);
  }
  return out;
}

/** Point at `t` (0–1, clamped) along a sampled curve, linearly interpolated. */
export function pointAt(curve: readonly V3[], t: number): V3 | null {
  if (!curve.length) return null;
  if (curve.length === 1) return curve[0];
  const f = Math.max(0, Math.min(1, t)) * (curve.length - 1);
  const i = Math.min(curve.length - 2, Math.floor(f));
  const k = f - i;
  const a = curve[i];
  const b = curve[i + 1];
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

// ── Callout leader lines ─────────────────────────────────────────────────────

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where a leader line leaves a callout card: the point on the card's edge nearest the
 * target. `null` when the target is inside the card (no line to draw). */
export function leaderStart(r: Rect, p: V2): V2 | null {
  const [px, py] = p;
  const inside = px > r.x && px < r.x + r.w && py > r.y && py < r.y + r.h;
  if (inside) return null;
  return [Math.max(r.x, Math.min(r.x + r.w, px)), Math.max(r.y, Math.min(r.y + r.h, py))];
}

/** NDC (−1…1, y up) → pixels in a `w`×`h` box (y down). */
export function ndcToPx(x: number, y: number, w: number, h: number): V2 {
  return [((x + 1) / 2) * w, ((1 - y) / 2) * h];
}

// ── Camera fit ───────────────────────────────────────────────────────────────

/** Initial camera position (3/4 from the rear: behind and to the right). */
export const HOLO_CAMERA: V3 = [-5.6, 2.5, 4.4];
/** The orbit centre the camera looks at. Low, so the car and its pedestal sit mid-frame. */
export const HOLO_TARGET: V3 = [0, 0.3, 0];
/** Vertical field of view, degrees. */
export const HOLO_FOV = 30;

/** Plan radius bounding every car vertex at any yaw (the bumper corners). */
export const CAR_PLAN_R = 2.36;
/** Height bounding every car vertex. */
export const CAR_TOP = 1.5;

/**
 * Rings `[plan radius, height]` that must stay in frame at any yaw: the car's footprint at the
 * ground and at roof height (conservative cylinder), the pedestal's outer halo and the disc's
 * lower edge. The pedestal is rotationally symmetric and the car spins, so rings are exact.
 */
export const FIT_RINGS: readonly (readonly [number, number])[] = [
  [CAR_PLAN_R, 0],
  [CAR_PLAN_R, CAR_TOP],
  [PEDESTAL_R + 0.42, 0],
  [PEDESTAL_R + 0.06, -0.08],
];

export interface FitOpts {
  /** Camera position the fit's view direction comes from (its distance is ignored). */
  camera?: V3;
  /** Orbit centre the camera looks at. */
  target?: V3;
  /** Largest |NDC| any fitted point may reach (both axes). */
  fill?: number;
  /** Never closer than this. */
  min?: number;
  rings?: readonly (readonly [number, number])[];
}

/**
 * Camera distance (from `target`, along the `camera → target` ray) that keeps every point of
 * `rings` within `fill` of the viewport's edges at any yaw, for a perspective camera with
 * vertical `fovDeg` and `aspect` (w/h). Elevation-aware: points nearer the camera project
 * lower and larger, which a flat bounding-card fit misses.
 *
 * Per point (horizontal offset `h` toward the camera, lateral `l`, height `dy` over the
 * target): depth = d − a with a = h·cos e + dy·sin e; screen-up = −h·sin e + dy·cos e. The
 * constraints |up| ≤ fill·tan(v/2)·depth and |l| ≤ fill·tan(h/2)·depth are linear in d.
 */
export function fitDistance(fovDeg: number, aspect: number, opts: FitOpts = {}): number {
  const { camera = HOLO_CAMERA, target = HOLO_TARGET, fill = 0.9, min = 4, rings = FIT_RINGS } = opts;
  const tv = Math.tan((fovDeg * Math.PI) / 360);
  const th = tv * Math.max(0.1, aspect);
  const e = Math.atan2(camera[1] - target[1], Math.hypot(camera[0] - target[0], camera[2] - target[2]));
  const ce = Math.cos(e);
  const se = Math.sin(e);
  const N = 180;
  let d = min;
  for (const [r, y] of rings) {
    const dy = y - target[1];
    for (let k = 0; k < N; k++) {
      const phi = (k / N) * Math.PI * 2;
      const h = r * Math.cos(phi);
      const l = r * Math.sin(phi);
      const a = h * ce + dy * se;
      const up = -h * se + dy * ce;
      d = Math.max(d, a + Math.abs(up) / (fill * tv), a + Math.abs(l) / (fill * th));
    }
  }
  return d;
}
