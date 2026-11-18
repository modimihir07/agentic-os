/**
 * The E46 Touring body (2004 325i, "GABAGOUL") as pure geometry: no three.js, no DOM, so it
 * unit-tests in node. Metres; x runs rear (−) to front (+), y is up from the ground, z is
 * the car's width (+z = right side).
 *
 * How the body is built:
 *  1. Side profile: a centripetal Catmull-Rom spline through UPPER_PROFILE (the sparse,
 *     hand-placed control points), arc-length resampled to PROFILE_POINTS and clamped.
 *  2. Plan view: a monotone (PCHIP) half-width spline `planHW(x)`, narrow at the nose and
 *     the tail, full at the doors.
 *  3. Sections: at each station a closed, mirror-symmetric loop — a superellipse crown over
 *     the roof / hood / glass, the greenhouse tumblehome, the belt step, the shoulder
 *     crease, the door bulge, the rocker tuck-under and a flat floor.
 *  4. Lines: rings every RING_EVERY stations, longitudinal feature lines at fixed section
 *     indices, wheel arches cut out of both, plus the details that make it an E46: the
 *     greenhouse with its Hofmeister kink and separate quarter glass, tilted kidneys with
 *     surround and slats, twin angel-eye rings, power-dome hood lines, roof rails, the
 *     L-shaped tail lamps that wrap onto the flank.
 *  5. A closed indexed shell (depth only, for occlusion and the Fresnel rim).
 *  6. An inner chassis / drivetrain group (engine, gearbox, shaft, diff, exhaust run,
 *     subframes, seats) drawn as an x-ray layer.
 *
 * Everything is deterministic: the 3D wireframe test compares two builds with toEqual.
 */

export type V2 = readonly [number, number];
export type V3 = readonly [number, number, number];
export type Side = 1 | -1;
export type End = "front" | "rear";

export const CAR = {
  length: 4.48,
  halfLength: 2.24,
  /** Body half-width at the shoulder. */
  halfWidth: 0.87,
  /** Roof half-width (tumblehome). */
  roofHalfWidth: 0.7,
  /** Beltline (bottom of the side glass). */
  belt: 0.98,
  /** Roof crown: ~1.415 m stock, ~1.40 m on coilovers. */
  roof: 1.4,
  frontAxle: 1.44,
  rearAxle: -1.285,
  /** Wheel-centre height: the tyre's radius (WHEEL.tyreR), so the tyres stand on the ground. */
  wheelRadius: 0.316,
  /** Wheel centre |z| (track/2). */
  track: 0.74,
} as const;

/**
 * Centre-line side silhouette, rear bumper bottom → up the forward-leaning tailgate panel and
 * the raked hatch glass → over the spoiler lip and the long wagon roof (drooping ~2.5 cm to
 * the rear) → down the raked windshield and the hood → front bumper bottom. The third value
 * is the old plan-view width factor (kept for compatibility; `planHW` is the real plan shape).
 */
export const UPPER_PROFILE: readonly (readonly [number, number, number])[] = [
  [-2.15, 0.24, 0.9],
  [-2.22, 0.32, 0.92],
  [-2.245, 0.45, 0.95],
  [-2.24, 0.6, 0.96],
  [-2.225, 0.75, 0.96],
  [-2.2, 0.88, 0.96],
  [-2.17, 0.98, 0.96],
  [-2.11, 1.1, 0.95],
  [-2.04, 1.21, 0.95],
  [-1.96, 1.3, 0.96],
  [-1.9, 1.355, 0.97],
  [-1.82, 1.375, 0.98],
  [-1.4, 1.388, 0.99],
  [-0.8, 1.397, 1],
  [-0.2, 1.4, 1],
  [0.12, 1.395, 1],
  [0.3, 1.375, 1],
  [0.6, 1.21, 1],
  [1.04, 0.985, 1],
  [1.4, 0.905, 0.99],
  [1.8, 0.84, 0.97],
  [2.08, 0.765, 0.94],
  [2.18, 0.715, 0.91],
  [2.235, 0.645, 0.9],
  [2.26, 0.54, 0.9],
  [2.25, 0.4, 0.89],
  [2.2, 0.24, 0.88],
];

export const PROFILE_POINTS = 90;
export const CLAMP_X = 2.27;
export const CLAMP_Y = CAR.roof;
/** Wheel-arch radius: ~44 mm between tyre and arch, a coilover stance. */
export const ARCH_R = 0.36;
export const BELT = CAR.belt;
/** Bottom edge of the side glass. */
export const GLASS_Y = BELT + 0.02;
/** Height of the roof drip line, where the tumblehome ends. */
const ROOF_EDGE_Y = CAR.roof - 0.05;
/** Superellipse exponent of the crown (roof, hood, glass). */
const CROWN_N = 2.6;
/** Crown arc sample positions, as a fraction of the edge half-width (centre → edge). */
const CROWN_Z = [0, 0.3, 0.55, 0.75, 0.88, 0.96, 1] as const;
/** Lines that sit on a surface are lifted this far off it (the shell is polygon-offset back too). */
export const LIFT = 0.004;

/** First and last loft stations: the tail and nose "caps". */
export const X_TAIL = -2.17;
export const X_NOSE = 2.15;
export const STATION_STEPS = 48;
export const RING_EVERY = 4;

/** Named indices into a section's right half (crown at 0 → floor centre at 20). */
export const SEC = { CROWN: 0, ARC_MID: 2, EDGE: 6, GLASS: 10, BELT: 11, SHOULDER: 13, BULGE: 15, ROCKER: 17, SILL: 18, FLOOR_EDGE: 19, FLOOR: 20 } as const;
export const SECTION_HALF = 21;
export const SECTION_LOOP = 2 * SECTION_HALF - 2;

const SIDES: readonly Side[] = [1, -1];

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

// ── Splines ──────────────────────────────────────────────────────────────────

/**
 * Centripetal Catmull-Rom (alpha 0.5, Barry–Goldman) through `pts`, `samples` points per
 * span; the ends are extended with mirrored phantom points. Passes through every control
 * point and, unlike the uniform variant, never loops or cusps on uneven spacing.
 */
export function catmullRom(pts: readonly V2[], samples = 12, alpha = 0.5): V2[] {
  const n = pts.length;
  if (n < 2) return pts.map(([x, y]) => [x, y] as V2);
  const P = (i: number): V2 => {
    if (i < 0) return [2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1]];
    if (i >= n) return [2 * pts[n - 1][0] - pts[n - 2][0], 2 * pts[n - 1][1] - pts[n - 2][1]];
    return pts[i];
  };
  const knot = (a: V2, b: V2) => Math.max(1e-6, Math.hypot(b[0] - a[0], b[1] - a[1]) ** alpha);
  const out: V2[] = [[pts[0][0], pts[0][1]]];
  for (let i = 0; i + 1 < n; i++) {
    const p0 = P(i - 1);
    const p1 = P(i);
    const p2 = P(i + 1);
    const p3 = P(i + 2);
    const t0 = 0;
    const t1 = t0 + knot(p0, p1);
    const t2 = t1 + knot(p1, p2);
    const t3 = t2 + knot(p2, p3);
    for (let k = 1; k <= samples; k++) {
      const t = t1 + ((t2 - t1) * k) / samples;
      const mix = (a: V2, b: V2, ta: number, tb: number): V2 => {
        const u = (t - ta) / (tb - ta);
        return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
      };
      const a1 = mix(p0, p1, t0, t1);
      const a2 = mix(p1, p2, t1, t2);
      const a3 = mix(p2, p3, t2, t3);
      const b1 = mix(a1, a2, t0, t2);
      const b2 = mix(a2, a3, t1, t3);
      out.push(k === samples ? [p2[0], p2[1]] : mix(b1, b2, t1, t2));
    }
  }
  return out;
}

/** `n` points evenly spaced by arc length along a polyline (both ends included). */
export function resample(poly: readonly V2[], n: number): V2[] {
  if (poly.length < 2 || n < 2) return poly.slice(0, Math.max(0, n)).map(([x, y]) => [x, y] as V2);
  const cum = [0];
  for (let i = 1; i < poly.length; i++) cum.push(cum[i - 1] + Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]));
  const total = cum[cum.length - 1];
  const out: V2[] = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const d = (total * k) / (n - 1);
    while (j < poly.length - 2 && cum[j + 1] < d) j++;
    const span = cum[j + 1] - cum[j];
    const u = span > 0 ? clamp((d - cum[j]) / span, 0, 1) : 0;
    out.push([lerp(poly[j][0], poly[j + 1][0], u), lerp(poly[j][1], poly[j + 1][1], u)]);
  }
  return out;
}

/** Monotone cubic (PCHIP) interpolation of a table sorted by x; clamped at both ends. Never overshoots its knots. */
export function pchip(table: readonly V2[], x: number): number {
  const n = table.length;
  if (x <= table[0][0]) return table[0][1];
  if (x >= table[n - 1][0]) return table[n - 1][1];
  let i = 0;
  while (x > table[i + 1][0]) i++;
  const h = (k: number) => table[k + 1][0] - table[k][0];
  const d = (k: number) => (table[k + 1][1] - table[k][1]) / h(k);
  const m = (k: number) => {
    if (k === 0) return d(0);
    if (k === n - 1) return d(n - 2);
    const a = d(k - 1);
    const b = d(k);
    if (a * b <= 0) return 0;
    const w1 = 2 * h(k) + h(k - 1);
    const w2 = h(k) + 2 * h(k - 1);
    return (w1 + w2) / (w1 / a + w2 / b);
  };
  const hh = h(i);
  const t = (x - table[i][0]) / hh;
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * table[i][1] + (t3 - 2 * t2 + t) * hh * m(i) + (-2 * t3 + 3 * t2) * table[i + 1][1] + (t3 - t2) * hh * m(i + 1);
}

// ── Side profile ─────────────────────────────────────────────────────────────

let profileCache: V2[] | null = null;

/** The drawn centre-line silhouette: UPPER_PROFILE splined, resampled and clamped. Cached. */
export function sideProfile(): readonly V2[] {
  if (!profileCache) {
    const ctrl = UPPER_PROFILE.map(([x, y]) => [x, y] as V2);
    profileCache = resample(catmullRom(ctrl, 16), PROFILE_POINTS).map(([x, y]) => [clamp(x, -CLAMP_X, CLAMP_X), clamp(y, 0, CLAMP_Y)] as V2);
  }
  return profileCache;
}

/** Height of the top of the body (roof, glass or hood centre) at `x`: the highest crossing of the profile. */
export function crownY(x: number): number {
  const p = sideProfile();
  let best = -Infinity;
  for (let i = 0; i + 1 < p.length; i++) {
    const [x0, y0] = p[i];
    const [x1, y1] = p[i + 1];
    if ((x - x0) * (x - x1) > 0) continue;
    const y = x1 === x0 ? Math.max(y0, y1) : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    if (y > best) best = y;
  }
  if (best > -Infinity) return best;
  return x < 0 ? p[0][1] : p[p.length - 1][1];
}

/** x of the centre-line end face (tailgate / bumper, or nose) at height `y`. */
export function faceProfileX(end: End, y: number): number {
  const p = sideProfile();
  const n = p.length;
  const at = (k: number) => (end === "rear" ? p[k] : p[n - 1 - k]);
  if (y <= at(0)[1]) return at(0)[0];
  for (let k = 0; k + 1 < n; k++) {
    const a = at(k);
    const b = at(k + 1);
    if (y >= Math.min(a[1], b[1]) && y <= Math.max(a[1], b[1])) return b[1] === a[1] ? b[0] : a[0] + ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]);
  }
  return at(0)[0];
}

// ── Plan and section shape ───────────────────────────────────────────────────

/** Plan-view half-width control points: a rounded tail, full width at the doors, a tapered nose. */
export const PLAN: readonly V2[] = [
  [-2.26, 0.56],
  [-2.22, 0.72],
  [-2.15, 0.8],
  [-2.0, 0.84],
  [-1.6, 0.865],
  [-1.0, 0.87],
  [0.9, 0.87],
  [1.5, 0.866],
  [1.85, 0.85],
  [2.05, 0.82],
  [2.15, 0.79],
  [2.22, 0.73],
  [2.27, 0.58],
];

/** Body half-width at the door bulge for station `x`. */
export const planHW = (x: number) => pchip(PLAN, x);

/** Sill / floor height: low between the axles (coilover stance), rising into the bumpers. */
export const floorY = (x: number) => 0.2 + 0.04 * smoothstep(1.8, 2.2, Math.abs(x));

/** Greenhouse taper in plan: the roof-edge half-width factor, narrowing over the D-pillars to the tail. */
export const ROOF_TAPER: readonly V2[] = [
  [-2.0, 0.88],
  [-1.4, 1],
];

export const roofTaper = (x: number) => pchip(ROOF_TAPER, x);

/** Lower-body half-width as a fraction of planHW, by height: tuck-under, bulge, shoulder crease, belt. */
function lowerFrac(y: number, yFloor: number): number {
  const t: V2[] = [
    [yFloor, 0.9],
    [yFloor + 0.06, 0.965],
    [0.42, 0.995],
    [0.58, 1],
    [0.72, 0.996],
    [0.84, 0.99],
    [0.87, 0.976],
    [BELT, 0.95],
  ];
  if (y <= t[0][0]) return t[0][1];
  for (let i = 0; i + 1 < t.length; i++) if (y <= t[i + 1][0]) return lerp(t[i][1], t[i + 1][1], (y - t[i][0]) / (t[i + 1][0] - t[i][0]));
  return t[t.length - 1][1];
}

/** Half-width at height `y` for a station with plan half-width `s` and roof taper `k`: lower body, then the greenhouse tumblehome. */
function sideHWs(s: number, yFloor: number, y: number, k = 1): number {
  if (y <= BELT) return s * lowerFrac(y, yFloor);
  const g0 = s * 0.95 - 0.035; // the belt step: glass sits inboard of the shoulder
  const g1 = ((0.66 * s) / CAR.halfWidth) * k;
  return lerp(g0, g1, clamp((y - BELT) / (ROOF_EDGE_Y - BELT), 0, 1));
}

/** Half-width of the body side at (x, y) (below the crown's edge). */
export const sideHW = (x: number, y: number) => sideHWs(planHW(x), floorY(x), y, roofTaper(x));

/** Everything a section at `x` needs. */
export interface Frame {
  x: number;
  /** Crown (centre-line top). */
  yTop: number;
  /** Where the crown arc meets the side (roof drip, A-pillar, hood shut line). */
  yEdge: number;
  /** Half-width at the edge (crown arc semi-axis). */
  a: number;
  /** Crown arc height (yTop − yEdge). */
  b: number;
  /** planHW(x). */
  s: number;
  yFloor: number;
  /** roofTaper(x). */
  k: number;
}

export function frameAt(x: number): Frame {
  const yTop = crownY(x);
  const s = planHW(x);
  const yFloor = floorY(x);
  const k = roofTaper(x);
  const b = 0.035 + 0.015 * clamp((yTop - 0.95) / 0.25, 0, 1);
  const yEdge = yTop - b;
  return { x, yTop, yEdge, a: sideHWs(s, yFloor, yEdge, k), b, s, yFloor, k };
}

/** Half-width of the section at height `y` (0 above the crown or below the floor). */
export function widthAt(f: Frame, y: number): number {
  if (y < f.yFloor || y > f.yTop) return 0;
  if (y <= f.yEdge) return sideHWs(f.s, f.yFloor, y, f.k);
  const v = clamp((y - f.yEdge) / f.b, 0, 1);
  return f.a * Math.pow(1 - Math.pow(v, CROWN_N), 1 / CROWN_N);
}

/** Height of the top surface (crown arc) at (x, z); the edge height outside the arc. */
export function topY(x: number, z: number, f: Frame = frameAt(x)): number {
  const u = clamp(Math.abs(z) / Math.max(1e-6, f.a), 0, 1);
  return f.yEdge + f.b * Math.pow(1 - Math.pow(u, CROWN_N), 1 / CROWN_N);
}

/** Right half of a section, (z, y) from the crown (z = 0) to the floor centre (z = 0): SECTION_HALF points. */
export function sectionHalf(f: Frame): V2[] {
  const out: V2[] = [];
  for (const u of CROWN_Z) {
    const z = f.a * u;
    out.push([z, u === 0 ? f.yTop : u === 1 ? f.yEdge : topY(f.x, z, f)]);
  }
  const w = (y: number) => sideHWs(f.s, f.yFloor, y, f.k);
  const gb = GLASS_Y - 0.015;
  const above = f.yEdge > gb;
  for (let j = 1; j <= 3; j++) {
    const y = above ? f.yEdge - ((f.yEdge - gb) * j) / 4 : f.yEdge;
    out.push([w(y), y]);
  }
  {
    const y = Math.min(gb, f.yEdge);
    out.push([w(y), y]);
  }
  {
    const y = Math.min(BELT, f.yEdge);
    out.push([f.s * lowerFrac(y, f.yFloor), y]);
  }
  for (const level of [0.92, 0.855, 0.72, 0.58, 0.45]) {
    const y = Math.min(level, f.yEdge);
    out.push([w(y), y]);
  }
  const rocker = Math.min(f.yFloor + 0.06, f.yEdge);
  out.push([w(rocker), rocker]);
  out.push([w(f.yFloor), f.yFloor]);
  out.push([f.s * 0.7, f.yFloor]);
  out.push([0, f.yFloor]);
  return out;
}

/** A section's closed loop in 3D: the right half, then its mirror back up the left. Point k mirrors (SECTION_LOOP − k) % SECTION_LOOP. */
export function loopAt(f: Frame, xOf: (z: number, y: number) => number = () => f.x): V3[] {
  const h = sectionHalf(f);
  const out: V3[] = h.map(([z, y]) => [xOf(z, y), y, z]);
  for (let k = h.length - 2; k >= 1; k--) out.push([xOf(-h[k][0], h[k][1]), h[k][1], -h[k][0]]);
  return out;
}

export const sectionLoop = (x: number) => loopAt(frameAt(x));

let framesCache: Frame[] | null = null;

/** The loft stations, X_TAIL → X_NOSE (STATION_STEPS + 1 frames). Cached. */
export function stationFrames(): readonly Frame[] {
  if (!framesCache) framesCache = Array.from({ length: STATION_STEPS + 1 }, (_, i) => frameAt(lerp(X_TAIL, X_NOSE, i / STATION_STEPS)));
  return framesCache;
}

const capFrame = (end: End) => {
  const f = stationFrames();
  return end === "front" ? f[f.length - 1] : f[0];
};

/**
 * x on an end face at (y, z): the cap station at the corners, bulging out to the centre-line
 * profile (bumper, tailgate, nose) in the middle. The tail is a little squarer than the nose.
 */
export function faceX(end: End, y: number, z: number): number {
  const f = capFrame(end);
  const w = widthAt(f, y);
  const r = w > 1e-6 ? clamp(Math.abs(z) / w, 0, 1) : 1;
  const px = faceProfileX(end, y);
  const bulge = end === "front" ? Math.max(0, px - f.x) : Math.min(0, px - f.x);
  return f.x + bulge * (1 - r ** (end === "front" ? 2.2 : 2.6));
}

// ── Surface points ───────────────────────────────────────────────────────────

/** A point on the body side at (x, y), lifted `out` off it. */
export const onSide = (x: number, y: number, side: Side, out = LIFT): V3 => [x, y, side * (sideHW(x, y) + out)];
/** A point on the top surface (roof, hood, glass) at (x, z), lifted `up` off it. */
export const onTop = (x: number, z: number, up = LIFT): V3 => [x, topY(x, z) + up, z];
/** A point on an end face at (z, y), lifted `out` off it. */
export const onFace = (end: End, z: number, y: number, out = LIFT): V3 => [faceX(end, y, z) + (end === "front" ? out : -out), y, z];

/** Inside a wheel arch opening (side view): the r = ARCH_R half-disc over each axle, open down to the ground. */
export function inArch(x: number, y: number, r = ARCH_R): boolean {
  for (const ax of [CAR.frontAxle, CAR.rearAxle]) {
    const dx = x - ax;
    if (Math.abs(dx) >= r) continue;
    if (y <= CAR.wheelRadius || Math.hypot(dx, y - CAR.wheelRadius) < r) return true;
  }
  return false;
}

/** Is (x, y, z) inside the body's section at x? (Zone anchors must be.) */
export function insideBody(p: V3): boolean {
  const [x, y, z] = p;
  if (x <= X_TAIL || x >= X_NOSE) return false;
  const f = frameAt(x);
  return y > f.yFloor && y < f.yTop && Math.abs(z) < widthAt(f, y);
}

// ── Segment helpers ──────────────────────────────────────────────────────────

function seg(a: V3, b: V3, out: number[]) {
  if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) return;
  out.push(a[0], a[1], a[2], b[0], b[1], b[2]);
}

function polyline(pts: readonly V3[], out: number[], closed = false) {
  for (let i = 0; i + 1 < pts.length; i++) seg(pts[i], pts[i + 1], out);
  if (closed && pts.length > 2) seg(pts[pts.length - 1], pts[0], out);
}

const mixV = (a: V3, b: V3, t: number): V3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/** A segment with any part inside a wheel arch removed (the boundary found by bisection). */
function clipSeg(a: V3, b: V3, out: number[], depth = 0) {
  const ia = inArch(a[0], a[1]);
  const ib = inArch(b[0], b[1]);
  if (!ia && !ib) {
    const m = mixV(a, b, 0.5);
    if (depth > 3 || !inArch(m[0], m[1])) return seg(a, b, out);
    clipSeg(a, m, out, depth + 1);
    clipSeg(m, b, out, depth + 1);
    return;
  }
  if (ia && ib) return;
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 24; k++) {
    const t = (lo + hi) / 2;
    const p = mixV(a, b, t);
    if (inArch(p[0], p[1]) === ia) lo = t;
    else hi = t;
  }
  if (ia) seg(mixV(a, b, hi), b, out);
  else seg(a, mixV(a, b, lo), out);
}

function polylineClipped(pts: readonly V3[], out: number[], closed = false) {
  for (let i = 0; i + 1 < pts.length; i++) clipSeg(pts[i], pts[i + 1], out);
  if (closed && pts.length > 2) clipSeg(pts[pts.length - 1], pts[0], out);
}

/** A rounded polygon: each corner replaced by a quadratic fillet of radius ~`r` (`n` + 1 points). */
export function roundedPoly(corners: readonly V2[], r: number, n = 4): V2[] {
  const out: V2[] = [];
  const m = corners.length;
  for (let i = 0; i < m; i++) {
    const c = corners[i];
    const p = corners[(i + m - 1) % m];
    const q = corners[(i + 1) % m];
    const lp = Math.hypot(p[0] - c[0], p[1] - c[1]);
    const lq = Math.hypot(q[0] - c[0], q[1] - c[1]);
    const tp = Math.min(0.45, r / Math.max(1e-9, lp));
    const tq = Math.min(0.45, r / Math.max(1e-9, lq));
    const a: V2 = [lerp(c[0], p[0], tp), lerp(c[1], p[1], tp)];
    const b: V2 = [lerp(c[0], q[0], tq), lerp(c[1], q[1], tq)];
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const u = 1 - t;
      out.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]]);
    }
  }
  return out;
}

/** Circle points (u, v) around a centre in a 2D plane. */
function ring2(c: V2, r: number, n: number): V2[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)] as V2;
  });
}

// ── 2D outlines shared by the 3D body and the static SVG chassis ─────────────

/** The DLO (glass) top at station x: just under the roof drip / A-pillar edge. */
const dloTop = (x: number) => frameAt(x).yEdge - 0.035;

function topEdge(x0: number, x1: number, step = 0.04): V2[] {
  const n = Math.max(1, Math.round(Math.abs(x1 - x0) / step));
  return Array.from({ length: n + 1 }, (_, k) => {
    const x = lerp(x0, x1, k / n);
    return [x, dloTop(x)] as V2;
  });
}

/** Front x of the side glass: where the A-pillar edge comes down to the glass line. */
function aPillarBase(): number {
  let xA = 0.6;
  for (let x = 0.6; x <= 1.06; x += 0.005) if (dloTop(x) >= GLASS_Y + 0.004) xA = x;
  return Math.round(xA * 1000) / 1000;
}

export interface SideGlass {
  front: V2[];
  rear: V2[];
  /** The Touring's separate quarter glass behind the C-pillar, with the Hofmeister kink at its lower rear corner. */
  quarter: V2[];
}

/** Side-view width of the D-pillar between the quarter glass and the hatch. */
const D_PILLAR = 0.12;
/** x of the quarter glass's rear edge at height `y`: parallel to the raked hatch, a D-pillar ahead of it. */
const dPillarX = (y: number) => faceProfileX("rear", y) + D_PILLAR;

/** Side glass outlines in the side view (x, y), each closed. */
export function sideGlass(): SideGlass {
  const xA = aPillarBase();
  const front: V2[] = [[-0.02, GLASS_Y], [xA, GLASS_Y], ...topEdge(xA, -0.02)];
  const rear: V2[] = [[-0.1, GLASS_Y], ...topEdge(-0.1, -0.98), [-1.0, GLASS_Y]];
  // Where the DLO top meets the D-pillar line (a fixed-point iteration; converges in a few steps).
  let xe = -1.84;
  for (let i = 0; i < 4; i++) xe = dPillarX(dloTop(xe));
  const xr = dPillarX(1.09);
  const quarter: V2[] = [
    [-1.07, GLASS_Y],
    ...topEdge(-1.06, xe),
    // D-pillar: down along the hatch rake, then the kink sweeps the lower corner forward.
    [dPillarX(1.13), 1.13],
    [xr, 1.09],
    [xr + 0.025, 1.045],
    [xr + 0.08, GLASS_Y + 0.003],
  ];
  return { front, rear, quarter };
}

/** Door shut lines in the side view: front door leading edge, B-pillar, rear door trailing edge round the arch. */
export function doorCuts(): V2[][] {
  const r = ARCH_R + 0.06;
  const ax = CAR.rearAxle;
  const th0 = Math.acos((-1.0 - ax) / r);
  const arc: V2[] = Array.from({ length: 9 }, (_, k) => {
    const t = th0 * (1 - k / 8);
    return [ax + r * Math.cos(t), CAR.wheelRadius + r * Math.sin(t)] as V2;
  });
  return [
    [
      [1.0, BELT],
      [0.995, 0.6],
      [0.985, 0.27],
    ],
    [
      [-0.04, BELT],
      [-0.05, 0.27],
    ],
    [[-1.0, BELT], ...arc, [ax + r, 0.27]],
  ];
}

/** Closed side silhouette (x, y): the profile, then the sill and both arches back to the start. */
export function sideOutline(): V2[] {
  const p = sideProfile();
  const lower: V2[] = [];
  for (const ax of [CAR.frontAxle, CAR.rearAxle]) {
    lower.push([ax + ARCH_R, floorY(ax + ARCH_R)]);
    for (let k = 0; k <= 18; k++) {
      const a = (Math.PI * k) / 18;
      lower.push([ax + ARCH_R * Math.cos(a), CAR.wheelRadius + ARCH_R * Math.sin(a)]);
    }
    lower.push([ax - ARCH_R, floorY(ax - ARCH_R)]);
  }
  return [...p, ...lower, p[0]];
}

// ── Front and rear details ───────────────────────────────────────────────────

/**
 * Facelift headlight outline on the nose (z, y), right side, clockwise from the outer top:
 * the top edge steps down near the inner end (the facelift notch toward the kidney), and the
 * outer end is the indicator chamber that wraps onto the wing.
 */
export const HEADLIGHT: readonly V2[] = [
  [0.745, 0.704],
  [0.42, 0.718],
  [0.38, 0.69],
  [0.29, 0.68],
  [0.31, 0.6],
  [0.762, 0.604],
];
/** Inner edge of the indicator chamber (|z|), inside the headlight's outer end. */
export const INDICATOR_Z = 0.69;

/** Angel-eye halo rings (two per side) and their projector lenses, on the nose. */
export function angelEyes(): V3[][] {
  const rings: V3[][] = [];
  for (const s of SIDES) {
    for (const zc of [0.455, 0.625]) {
      for (const r of [0.044, 0.023]) rings.push(ring2([zc, 0.655], r, r > 0.03 ? 24 : 14).map(([z, y]) => onFace("front", s * z, y, LIFT + 0.004)));
    }
  }
  return rings;
}

/** Facelift kidney (z, y), right side: taller than the pre-facelift's, with a curved lower edge. */
export function kidneyOutline(grow = 0): V2[] {
  const z0 = 0.035 - grow;
  const z1 = 0.224 + grow;
  const bottom = (t: number) => 0.552 - 0.016 * (1 - t * t) - grow;
  const out: V2[] = [
    [z0, 0.692 + grow],
    [0.2 + grow, 0.68 + grow],
    [z1, 0.57],
  ];
  for (let k = 0; k <= 6; k++) {
    const t = 1 - k / 6;
    out.push([lerp(z0, z1, t), bottom(t)]);
  }
  return out;
}

/** M-Tech bumper side intake (z, y), right side: a trapezoid with the fog lamp inside it. */
export const SIDE_INTAKE: readonly V2[] = [
  [0.49, 0.4],
  [0.68, 0.4],
  [0.7, 0.28],
  [0.52, 0.27],
];
/** Fog lamp centre (z, y), right side: inside the side intake. */
export const FOG: V2 = [0.595, 0.335];

/** Tail lamp heights on the rear face: top, the inner leg's bottom, the outer leg's bottom. */
const LAMP_TOP = 0.935;
const LAMP_INNER = 0.865;
const LAMP_LOW = 0.775;

export interface TailLamp {
  /** The closed L outline: tailgate leg and corner on the rear face, wrapped onto the flank. */
  loop: V3[];
  /** Rear-face points (the horizontal "tailgate" leg reaches inboard to |z| ≈ 0.51). */
  face: V3[];
  /** Points on the flank (the side of the car). */
  flank: V3[];
  /** The LED / halogen bars inside the lamp, each a polyline on the rear face. */
  bars: V3[][];
}

/** The E46 Touring's body-mounted L-shaped tail lamp on side `s`, wrapping round the corner. */
export function tailLamp(s: Side): TailLamp {
  const capW = (y: number) => widthAt(capFrame("rear"), y);
  const face = (z: number, y: number, out = LIFT) => onFace("rear", s * z, y, out);
  const flank = (x: number, y: number) => onSide(x, y, s);
  const top: V3[] = [];
  for (let k = 0; k <= 6; k++) top.push(face(lerp(0.51, capW(LAMP_TOP), k / 6), LAMP_TOP));
  const flankPts: V3[] = [
    flank(X_TAIL + 0.04, LAMP_TOP - 0.003),
    flank(-2.08, LAMP_TOP - 0.007),
    flank(-2.035, LAMP_TOP - 0.01),
    flank(-2.06, LAMP_LOW),
    flank(-2.1, LAMP_LOW),
    flank(X_TAIL + 0.04, LAMP_LOW),
  ];
  const bottom: V3[] = [];
  for (let k = 0; k <= 4; k++) bottom.push(face(lerp(capW(LAMP_LOW), 0.66, k / 4), LAMP_LOW));
  const inner: V3[] = [face(0.66, LAMP_INNER), face(0.51, LAMP_INNER)];
  const bar = (z0: number, y: number) => Array.from({ length: 5 }, (_, k) => face(lerp(z0, capW(y) - 0.03, k / 4), y, LIFT + 0.002));
  const bars = [bar(0.535, 0.9), bar(0.685, 0.835), bar(0.685, 0.805)];
  return { loop: [...top, ...flankPts, ...bottom, ...inner], face: [...top, ...bottom, ...inner], flank: flankPts, bars };
}

/** Twin tailpipes on the left (driver's) side: centre height, |z| of each, inner and outer x, radius. */
export const EXHAUST_TIPS = { y: 0.215, z: [-0.5, -0.39], x0: -2.1, x1: -2.29, r: 0.038 } as const;

// ── Rear hatch and roof rails ────────────────────────────────────────────────

/** Bottom and top of the hatch glass (heights on the hatch), and the tailgate's top edge (its x). */
const HATCH_Y0 = GLASS_Y + 0.03;
const HATCH_Y1 = CAR.roof - 0.11;
const gateTopX = () => faceProfileX("rear", CAR.roof - 0.035);
/** Tailgate half-width at its foot, between the tail lamps. */
const GATE_FOOT = 0.495;

/** Tailgate half-width on the hatch at station x: between the lamps at the foot, out toward the D-pillars at the top. */
export function gateHW(x: number): number {
  const xt = gateTopX();
  const top = frameAt(xt).a - 0.03;
  return Math.min(frameAt(x).a - 0.03, lerp(GATE_FOOT, top, clamp((x - X_TAIL) / (xt - X_TAIL), 0, 1)));
}

export interface Hatch {
  /** The hatch glass, closed, on the raked hatch surface. */
  glass: V3[];
  /** The tailgate shut line, closed: across the bumper top, up beside the lamps, along the hatch, across the roof's rear edge. */
  gate: V3[];
  /** The roof spoiler lip over the glass, closed. */
  spoiler: V3[];
}

/** The tailgate, derived from the side profile so it follows any change to the hatch rake. */
export function hatch(): Hatch {
  const x0 = faceProfileX("rear", HATCH_Y0);
  const x1 = faceProfileX("rear", HATCH_Y1);
  const xt = gateTopX();
  const across = (x: number, w: number, up: number, n = 8) => Array.from({ length: n + 1 }, (_, k) => onTop(x, lerp(w, -w, k / n), up));
  const sideRun = (xa: number, xb: number, z: (x: number) => number, up = LIFT, n = 8) => Array.from({ length: n + 1 }, (_, k) => {
    const x = lerp(xa, xb, k / n);
    return onTop(x, z(x), up);
  });
  const gw = (x: number) => gateHW(x) - 0.045;
  const glass: V3[] = [...sideRun(x0, x1, gw), ...across(x1, gw(x1), LIFT).slice(1, -1), ...sideRun(x1, x0, (x) => -gw(x)), ...across(x0, -gw(x0), LIFT).slice(1, -1)];

  const cap = capFrame("rear");
  const yFoot = 0.63;
  const yUp = cap.yEdge - 0.01;
  const up = (s: Side) => [0.8, yUp].map((y) => onFace("rear", s * GATE_FOOT, y));
  const gate: V3[] = [
    ...Array.from({ length: 9 }, (_, k) => onFace("rear", lerp(-GATE_FOOT, GATE_FOOT, k / 8), yFoot)),
    ...up(1),
    ...sideRun(X_TAIL, xt, gateHW, LIFT, 10),
    ...across(xt, gateHW(xt), LIFT).slice(1, -1),
    ...sideRun(xt, X_TAIL, (x) => -gateHW(x), LIFT, 10),
    ...up(-1).reverse(),
  ];

  const xs = x1 + 0.012;
  const sw = (x: number) => gateHW(x) - 0.012;
  const spoiler: V3[] = [...across(xs, sw(xs), 0.016), ...across(xt - 0.004, -sw(xt - 0.004), 0.006)];
  return { glass, gate, spoiler };
}

/** Roof rail ends and lift off the roof (top and lower bar). */
const RAIL_X0 = 0.1;
const RAIL_X1 = -1.75;
/** Roof rail on side `s`: following the roof crown and its taper, inboard of the drip line. */
export function roofRail(s: Side): { top: V3[]; low: V3[]; feet: V3[][] } {
  const rz = (x: number) => s * Math.min(0.58, frameAt(x).a - 0.07);
  const top: V3[] = [onTop(RAIL_X0 + 0.07, rz(RAIL_X0 + 0.07), 0.008)];
  const low: V3[] = [];
  for (let k = 0; k <= 24; k++) {
    const x = lerp(RAIL_X0, RAIL_X1, k / 24);
    const end = k === 0 || k === 24 ? 0.012 : 0;
    top.push(onTop(x, rz(x), 0.035 - end));
    low.push(onTop(x, rz(x), 0.02 - end * 0.5));
  }
  top.push(onTop(RAIL_X1 - 0.07, rz(RAIL_X1 - 0.07), 0.008));
  const feet = [0.06, -0.6, -1.2, -1.7].map((x) => [onTop(x, rz(x), 0), onTop(x, rz(x), 0.02)]);
  return { top, low, feet };
}

// ── The body wireframe ───────────────────────────────────────────────────────

export interface BodyLines {
  base: number[];
  cyan: number[];
  amber: number[];
  /** The angel-eye rings, drawn brighter with a glow pass. */
  halo: number[];
}

function faceLine(end: End, y: number, out: number[], frac = 1) {
  const w = widthAt(capFrame(end), y) * frac;
  polyline(
    Array.from({ length: 17 }, (_, k) => onFace(end, lerp(-w, w, k / 16), y)),
    out,
  );
}

const faceLoop = (end: End, pts: readonly V2[], out: number[], lift = LIFT) =>
  polyline(
    pts.map(([z, y]) => onFace(end, z, y, lift)),
    out,
    true,
  );

/** The body as coloured line segments (no wheels, no chassis). Deterministic. */
export function bodyWireframe(): BodyLines {
  const L: BodyLines = { base: [], cyan: [], amber: [], halo: [] };
  const frames = stationFrames();
  const loops = frames.map((f) => loopAt(f));

  // Section rings (arches cut out) and the longitudinal feature lines.
  for (let i = 0; i < loops.length; i += RING_EVERY) polylineClipped(loops[i], L.base, true);
  const along = (k: number, s: Side) => loops.map((l) => l[s === 1 ? k : (SECTION_LOOP - k) % SECTION_LOOP]);
  for (const s of SIDES) {
    for (const k of [SEC.ARC_MID, SEC.EDGE, SEC.SHOULDER, SEC.BULGE, SEC.ROCKER, SEC.SILL]) polylineClipped(along(k, s), L.base);
    const belt = along(SEC.BELT, s);
    for (let i = 0; i + 1 < belt.length; i++) if (frames[i].yEdge > GLASS_Y && frames[i + 1].yEdge > GLASS_Y) seg(belt[i], belt[i + 1], L.cyan);
  }

  // Centre line over the whole profile, closed into the cap floors.
  const prof = sideProfile().map(([x, y]) => [x, y, 0] as V3);
  polyline(prof, L.base);
  seg(prof[0], loops[0][SEC.FLOOR], L.base);
  seg(prof[prof.length - 1], loops[loops.length - 1][SEC.FLOOR], L.base);

  for (const s of SIDES) {
    // Wheel arches: the cut edge and a flared lip just outboard of it.
    for (const ax of [CAR.frontAxle, CAR.rearAxle]) {
      const lip: V3[] = [onSide(ax + ARCH_R, floorY(ax + ARCH_R), s)];
      const flare: V3[] = [];
      for (let k = 0; k <= 18; k++) {
        const a = (Math.PI * k) / 18;
        lip.push(onSide(ax + ARCH_R * Math.cos(a), CAR.wheelRadius + ARCH_R * Math.sin(a), s));
        const fa = 0.14 + (Math.PI - 0.28) * (k / 18);
        flare.push(onSide(ax + (ARCH_R + 0.03) * Math.cos(fa), CAR.wheelRadius + (ARCH_R + 0.03) * Math.sin(fa), s, LIFT + 0.01));
      }
      lip.push(onSide(ax - ARCH_R, floorY(ax - ARCH_R), s));
      polyline(lip, L.base);
      polyline(flare, L.base);
    }
    // Door shut lines and handles.
    for (const cut of doorCuts()) polyline(cut.map(([x, y]) => onSide(x, y, s)), L.base);
    for (const [x0, x1] of [
      [0.08, 0.22],
      [-0.86, -0.72],
    ]) {
      const handle = roundedPoly(
        [
          [x0, 0.872],
          [x1, 0.872],
          [x1, 0.852],
          [x0, 0.852],
        ],
        0.008,
        2,
      );
      polyline(
        handle.map(([x, y]) => onSide(x, y, s, LIFT + 0.006)),
        L.base,
        true,
      );
    }
    // Side glass: front door, rear door, quarter glass with the Hofmeister kink.
    const g = sideGlass();
    for (const loop of [g.front, g.rear, g.quarter]) polyline(loop.map(([x, y]) => onSide(x, y, s)), L.cyan, true);
    // Door mirror: housing (base) and glass (cyan).
    const mz = (z: number): number => s * z;
    polyline(
      [
        [0.93, 1.0, mz(0.85)],
        [0.88, 1.1, mz(0.945)],
        [0.76, 1.115, mz(0.968)],
        [0.7, 1.05, mz(0.965)],
        [0.74, 0.99, mz(0.93)],
        [0.86, 0.985, mz(0.86)],
      ] as V3[],
      L.base,
      true,
    );
    polyline(
      [
        [0.725, 1.095, mz(0.955)],
        [0.705, 1.05, mz(0.955)],
        [0.735, 1.005, mz(0.93)],
        [0.75, 1.06, mz(0.93)],
      ] as V3[],
      L.cyan,
      true,
    );
    // Roof rails following the roof and its taper, on four feet.
    const rail = roofRail(s);
    polyline(rail.top, L.cyan);
    polyline(rail.low, L.cyan);
    for (const [p, q] of rail.feet) seg(p, q, L.base);
    // Hood power-dome ridges, converging on the kidneys.
    polyline(
      Array.from({ length: 13 }, (_, k) => onTop(lerp(2.06, 1.08, k / 12), s * lerp(0.17, 0.4, k / 12), 0.008)),
      L.base,
    );
  }

  // Windshield (cyan) and cowl (base).
  const aGlass = (x: number) => {
    const f = frameAt(x);
    return sideHWs(f.s, f.yFloor, Math.max(f.yEdge, GLASS_Y), f.k) - 0.05;
  };
  const xsW = 0.36;
  const xeW = 1.0;
  const ws: V3[] = [];
  for (let k = 0; k <= 10; k++) {
    const x = lerp(xsW, xeW, k / 10);
    ws.push(onTop(x, aGlass(x)));
  }
  for (let k = 1; k < 8; k++) ws.push(onTop(xeW, lerp(aGlass(xeW), -aGlass(xeW), k / 8)));
  for (let k = 10; k >= 0; k--) {
    const x = lerp(xsW, xeW, k / 10);
    ws.push(onTop(x, -aGlass(x)));
  }
  for (let k = 1; k < 8; k++) ws.push(onTop(xsW, lerp(-aGlass(xsW), aGlass(xsW), k / 8)));
  polyline(ws, L.cyan, true);
  const cowl = frameAt(1.04);
  polyline(
    Array.from({ length: 13 }, (_, k) => onTop(1.04, lerp(-cowl.a, cowl.a, k / 12) * 0.95)),
    L.base,
  );

  // Rear: hatch glass (cyan) inside the tailgate shut line, under the spoiler lip (base).
  const h = hatch();
  polyline(h.glass, L.cyan, true);
  polyline(h.gate, L.base, true);
  polyline(h.spoiler, L.base, true);

  // Rear bumper lines and valance, reflectors (amber) and the L tail lamps with their bars (amber).
  faceLine("rear", 0.62, L.base);
  faceLine("rear", 0.36, L.base, 0.92);
  faceLine("rear", 0.29, L.base, 0.88);
  for (const s of SIDES) {
    faceLoop(
      "rear",
      roundedPoly(
        [
          [s * 0.56, 0.485],
          [s * 0.7, 0.485],
          [s * 0.7, 0.46],
          [s * 0.56, 0.46],
        ],
        0.01,
        2,
      ),
      L.amber,
    );
    const lamp = tailLamp(s);
    polyline(lamp.loop, L.amber, true);
    for (const bar of lamp.bars) polyline(bar, L.amber);
    seg(onSide(X_TAIL + 0.04, 0.855, s), onSide(-2.05, 0.855, s), L.amber);
  }

  // Nose: M-Tech bumper (trapezoid centre intake, side intakes with fogs, splitter), plate,
  // facelift kidneys (cyan) with surround and slats (base), notched headlights, angel eyes (halo).
  faceLine("front", 0.525, L.base);
  faceLine("front", 0.25, L.base, 0.9);
  faceLoop(
    "front",
    roundedPoly(
      [
        [-0.4, 0.4],
        [0.4, 0.4],
        [0.36, 0.27],
        [-0.36, 0.27],
      ],
      0.03,
    ),
    L.base,
  );
  for (let k = 1; k <= 3; k++) faceLine("front", lerp(0.27, 0.4, k / 4), L.base, 0.36 / widthAt(capFrame("front"), lerp(0.27, 0.4, k / 4)));
  faceLoop(
    "front",
    [
      [-0.26, 0.505],
      [0.26, 0.505],
      [0.26, 0.415],
      [-0.26, 0.415],
    ],
    L.base,
  );
  for (const s of SIDES) {
    const mirror = (pts: readonly V2[]) => pts.map(([z, y]) => [s * z, y] as V2);
    faceLoop("front", mirror(roundedPoly(kidneyOutline(), 0.03)), L.cyan, LIFT + 0.006);
    faceLoop("front", mirror(roundedPoly(kidneyOutline(0.013), 0.04)), L.base, LIFT + 0.008);
    const kid = kidneyOutline();
    for (let k = 1; k <= 6; k++) {
      const t = k / 7;
      const z = lerp(0.035, 0.205, t);
      const yTop = lerp(kid[0][1], kid[1][1], t) - 0.012;
      const yBot = 0.552 - 0.016 * (1 - ((z - 0.035) / (0.224 - 0.035)) ** 2) + 0.012;
      seg(onFace("front", s * z, yTop, LIFT + 0.002), onFace("front", s * z, yBot, LIFT + 0.002), L.base);
    }
    faceLoop("front", mirror(roundedPoly(HEADLIGHT, 0.022)), L.cyan);
    seg(onFace("front", s * INDICATOR_Z, 0.61), onFace("front", s * INDICATOR_Z, 0.7), L.cyan);
    faceLoop("front", mirror(roundedPoly(SIDE_INTAKE, 0.025)), L.base);
    for (const [r, n, group] of [
      [0.04, 18, L.cyan],
      [0.052, 20, L.base],
    ] as const)
      faceLoop("front", ring2([s * FOG[0], FOG[1]], r, n), group);
  }
  for (const ring of angelEyes()) polyline(ring, L.halo, true);

  return L;
}

// ── Shell (depth-only occluder and Fresnel rim) ──────────────────────────────

export interface BodyShell {
  positions: number[];
  index: number[];
}

/** The closed body skin: the station tube with the arches cut away, capped by bulging end faces. */
export function bodyShell(): BodyShell {
  const frames = stationFrames();
  const positions: number[] = [];
  const index: number[] = [];
  const add = (p: V3) => {
    positions.push(p[0], p[1], p[2]);
    return positions.length / 3 - 1;
  };
  const tri = (a: number, b: number, c: number) => {
    const cx = (positions[a * 3] + positions[b * 3] + positions[c * 3]) / 3;
    const cy = (positions[a * 3 + 1] + positions[b * 3 + 1] + positions[c * 3 + 1]) / 3;
    if (!inArch(cx, cy)) index.push(a, b, c);
  };
  const grid = (rows: V3[][], closed: boolean) => {
    const ids = rows.map((r) => r.map(add));
    for (let i = 0; i + 1 < ids.length; i++) {
      const n = ids[i].length;
      for (let j = 0; j < (closed ? n : n - 1); j++) {
        const a = ids[i][j];
        const b = ids[i][(j + 1) % n];
        const c = ids[i + 1][j];
        const d = ids[i + 1][(j + 1) % n];
        tri(a, c, b);
        tri(b, c, d);
      }
    }
    return ids;
  };
  grid(
    frames.map((f) => loopAt(f)),
    true,
  );
  // End caps: rings shrinking toward the face centre, each point pushed out onto the face.
  for (const end of ["rear", "front"] as End[]) {
    const f = capFrame(end);
    const yc = (f.yTop + f.yFloor) / 2;
    const half = sectionHalf(f);
    const rings = [1, 0.8, 0.6, 0.4, 0.2].map((lam) =>
      Array.from({ length: SECTION_LOOP }, (_, k) => {
        const h = k < SECTION_HALF ? half[k] : half[SECTION_LOOP - k];
        const z = (k < SECTION_HALF ? 1 : -1) * h[0] * lam;
        const y = yc + (h[1] - yc) * lam;
        return [faceX(end, y, z), y, z] as V3;
      }),
    );
    const ids = grid(rings, true);
    const centre = add([faceX(end, yc, 0), yc, 0]);
    const last = ids[ids.length - 1];
    for (let j = 0; j < last.length; j++) index.push(last[j], last[(j + 1) % last.length], centre);
  }
  return { positions, index };
}

// ── Inner chassis / drivetrain (x-ray layer) ─────────────────────────────────

function box(c: V3, size: V3, out: number[]) {
  const [hx, hy, hz] = [size[0] / 2, size[1] / 2, size[2] / 2];
  const p = (i: number, j: number, k: number): V3 => [c[0] + i * hx, c[1] + j * hy, c[2] + k * hz];
  for (const j of [-1, 1])
    for (const k of [-1, 1]) {
      seg(p(-1, j, k), p(1, j, k), out);
      seg(p(j, -1, k), p(j, 1, k), out);
      seg(p(j, k, -1), p(j, k, 1), out);
    }
}

/** Circle in the plane perpendicular to `axis`. */
function ring(axis: "x" | "y" | "z", c: V3, r: number, n: number, out: number[]) {
  const pts: V3[] = Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    const u = r * Math.cos(a);
    const v = r * Math.sin(a);
    return axis === "x" ? [c[0], c[1] + v, c[2] + u] : axis === "y" ? [c[0] + u, c[1], c[2] + v] : [c[0] + u, c[1] + v, c[2]];
  });
  polyline(pts, out, true);
}

/** A tube along x: `rings` circles from x0 to x1 (radius and centre height interpolated) and `lines` straight strakes. */
function tubeX(x0: number, x1: number, y0: number, y1: number, z: number, r0: number, r1: number, rings: number, lines: number, out: number[]) {
  for (let k = 0; k <= rings; k++) {
    const t = k / rings;
    ring("x", [lerp(x0, x1, t), lerp(y0, y1, t), z], lerp(r0, r1, t), 16, out);
  }
  for (let j = 0; j < lines; j++) {
    const a = (j / lines) * Math.PI * 2;
    seg([x0, y0 + r0 * Math.sin(a), z + r0 * Math.cos(a)], [x1, y1 + r1 * Math.sin(a), z + r1 * Math.cos(a)], out);
  }
}

function helix(x: number, z: number, y0: number, y1: number, r: number, turns: number, out: number[]) {
  const n = Math.round(turns * 14);
  polyline(
    Array.from({ length: n + 1 }, (_, i) => {
      const a = (i / 14) * Math.PI * 2;
      return [x + r * Math.cos(a), lerp(y0, y1, i / n), z + r * Math.sin(a)] as V3;
    }),
    out,
  );
}

/** Side-view seat outline (cushion + backrest) at width z. */
function seat(x: number, z: number, out: number[], bench = false): V3[] {
  const w = bench ? 0.5 : 0.24;
  const pts: V2[] = [
    [x + 0.2, 0.5],
    [x + 0.22, 0.56],
    [x - 0.22, 0.57],
    [x - 0.27, 0.6],
    [x - 0.36, 1.08],
    [x - 0.3, 1.13],
    [x - 0.22, 1.1],
    [x - 0.16, 0.66],
    [x + 0.18, 0.6],
  ];
  const a = pts.map(([px, py]) => [px, py, z - w] as V3);
  const b = pts.map(([px, py]) => [px, py, z + w] as V3);
  polyline(a, out);
  polyline(b, out);
  for (const i of [1, 4, 5, 8]) seg(a[i], b[i], out);
  return a;
}

/**
 * The inner chassis and drivetrain, drawn as a dim x-ray layer: radiator, M54 inline-six
 * (block, head, sump, bores, pulleys, intake plenum and runners, 3-into-1 headers), gearbox,
 * two-piece driveshaft, diff and half shafts, front and rear subframes with struts and
 * springs, steering rack, the twin exhaust run with cats and mufflers, saddle fuel tank,
 * seats and the (left-hand-drive) steering wheel. Deterministic.
 */
export function chassisWireframe(): number[] {
  const o: number[] = [];
  // Radiator and fan.
  box([2.0, 0.53, 0], [0.05, 0.34, 0.66], o);
  for (let k = 1; k < 6; k++) seg([2.025, 0.36 + (0.34 * k) / 6, -0.33], [2.025, 0.36 + (0.34 * k) / 6, 0.33], o);
  ring("x", [1.94, 0.53, 0], 0.15, 20, o);
  // M54B25 inline-six.
  box([1.6, 0.56, 0.02], [0.66, 0.3, 0.3], o);
  box([1.6, 0.76, 0], [0.62, 0.1, 0.26], o);
  box([1.6, 0.36, 0.02], [0.46, 0.1, 0.24], o);
  const cyl = (i: number) => 1.6 + (i - 2.5) * 0.095;
  for (let i = 0; i < 6; i++) ring("y", [cyl(i), 0.715, 0.02], 0.04, 12, o);
  ring("x", [1.95, 0.45, 0.02], 0.08, 16, o);
  ring("x", [1.95, 0.62, 0.08], 0.045, 12, o);
  ring("x", [1.95, 0.6, -0.1], 0.05, 12, o);
  // Intake plenum (left) and runners into the head.
  tubeX(1.32, 1.88, 0.74, 0.74, -0.25, 0.055, 0.055, 3, 6, o);
  for (let i = 0; i < 6; i++)
    polyline(
      [
        [cyl(i), 0.7, -0.22],
        [cyl(i), 0.66, -0.17],
        [cyl(i), 0.7, -0.13],
      ],
      o,
    );
  // Exhaust headers (right): 6 into two 3-into-1 collectors.
  for (let i = 0; i < 6; i++) {
    const cx = i < 3 ? 1.46 : 1.72;
    polyline(
      [
        [cyl(i), 0.7, 0.14],
        [cyl(i), 0.6, 0.2],
        [cx, 0.42, 0.18],
      ],
      o,
    );
  }
  // Twin exhaust run: downpipes, cats, centre muffler, over the axle on the left, rear muffler.
  polyline(
    [
      [1.72, 0.42, 0.18],
      [1.45, 0.24, 0.14],
      [0.95, 0.22, 0.14],
    ],
    o,
  );
  polyline(
    [
      [1.46, 0.42, 0.18],
      [1.3, 0.24, 0.06],
      [0.95, 0.22, 0.06],
    ],
    o,
  );
  tubeX(0.95, 0.62, 0.22, 0.22, 0.14, 0.038, 0.038, 2, 4, o);
  tubeX(0.95, 0.62, 0.22, 0.22, 0.06, 0.038, 0.038, 2, 4, o);
  for (const z of [0.14, 0.06])
    polyline(
      [
        [0.62, 0.22, z],
        [-0.2, 0.22, 0.1 + (z - 0.1) * 0.5],
      ],
      o,
    );
  tubeX(-0.2, -0.62, 0.22, 0.22, 0.1, 0.07, 0.07, 3, 6, o);
  polyline(
    [
      [-0.62, 0.22, 0.1],
      [-0.95, 0.25, 0.1],
      [-1.05, 0.28, -0.2],
      [-1.6, 0.3, -0.32],
      [-1.74, 0.27, -0.42],
    ],
    o,
  );
  box([-1.9, 0.27, -0.42], [0.32, 0.13, 0.3], o);
  for (const z of EXHAUST_TIPS.z) seg([-2.06, EXHAUST_TIPS.y, z], [EXHAUST_TIPS.x0, EXHAUST_TIPS.y, z], o);
  // Gearbox: bellhousing cone to the tail.
  const gx = [1.27, 1.12, 0.95, 0.7, 0.45];
  const gr = [0.17, 0.15, 0.11, 0.09, 0.06];
  for (let k = 0; k < gx.length; k++) ring("x", [gx[k], lerp(0.5, 0.4, k / 4), 0], gr[k], 18, o);
  for (let j = 0; j < 6; j++) {
    const a = (j / 6) * Math.PI * 2;
    polyline(
      gx.map((x, k) => [x, lerp(0.5, 0.4, k / 4) + gr[k] * Math.sin(a), gr[k] * Math.cos(a)] as V3),
      o,
    );
  }
  // Two-piece driveshaft: guibo, centre bearing, rear joint.
  tubeX(0.45, -1.12, 0.4, 0.34, 0, 0.032, 0.032, 1, 2, o);
  ring("x", [0.45, 0.4, 0], 0.05, 12, o);
  ring("x", [-0.35, 0.37, 0], 0.06, 12, o);
  ring("x", [-1.12, 0.34, 0], 0.05, 12, o);
  // Differential and half shafts.
  const diff: V3 = [CAR.rearAxle, 0.34, 0];
  ring("x", diff, 0.13, 20, o);
  ring("y", diff, 0.13, 20, o);
  ring("z", diff, 0.13, 20, o);
  ring("x", [CAR.rearAxle - 0.11, 0.34, 0], 0.09, 16, o);
  for (const s of SIDES) {
    seg([CAR.rearAxle, 0.34, s * 0.13], [CAR.rearAxle, 0.32, s * 0.6], o);
    for (const z of [0.18, 0.56]) ring("z", [CAR.rearAxle, 0.33, s * z], 0.04, 10, o);
  }
  // Front subframe, control arms, struts with coil springs, steering rack and tie rods.
  box([CAR.frontAxle, 0.27, 0], [0.12, 0.06, 0.9], o);
  seg([1.25, 0.36, -0.42], [1.25, 0.36, 0.42], o);
  for (const s of SIDES) {
    const hub: V3 = [CAR.frontAxle, 0.27, s * 0.6];
    seg([CAR.frontAxle, 0.26, s * 0.33], hub, o);
    seg([1.18, 0.27, s * 0.38], hub, o);
    seg([CAR.frontAxle, 0.32, s * 0.6], [1.4, 0.86, s * 0.53], o);
    helix(1.415, s * 0.555, 0.5, 0.78, 0.07, 4, o);
    ring("z", [1.25, 0.36, s * 0.25], 0.035, 10, o);
    seg([1.25, 0.36, s * 0.42], [1.32, 0.32, s * 0.6], o);
  }
  // Rear subframe, trailing arms, springs and dampers.
  polyline(
    [
      [-1.0, 0.3, -0.48],
      [-1.58, 0.3, -0.48],
      [-1.58, 0.3, 0.48],
      [-1.0, 0.3, 0.48],
    ],
    o,
    true,
  );
  for (const x of [-1.15, -1.45]) seg([x, 0.3, -0.48], [x, 0.3, 0.48], o);
  for (const s of SIDES) {
    seg([-0.92, 0.3, s * 0.62], [CAR.rearAxle, 0.32, s * 0.6], o);
    helix(-1.42, s * 0.5, 0.33, 0.6, 0.06, 3.5, o);
    seg([-1.2, 0.32, s * 0.6], [-1.15, 0.78, s * 0.6], o);
    // Saddle fuel tank, either side of the driveshaft.
    box([-0.75, 0.36, s * 0.27], [0.42, 0.14, 0.26], o);
  }
  // Cabin: front seats, rear bench, steering wheel (left-hand drive: driver on −z) and dash.
  for (const z of [-0.37, 0.37]) seat(-0.15, z, o);
  seat(-0.95, 0, o, true);
  const sw: V3 = [0.4, 1.0, -0.37];
  const tilt = (25 * Math.PI) / 180;
  const wheelPts: V3[] = Array.from({ length: 24 }, (_, i) => {
    const a = (i / 24) * Math.PI * 2;
    const v = 0.19 * Math.sin(a);
    return [sw[0] - v * Math.sin(tilt), sw[1] + v * Math.cos(tilt), sw[2] + 0.19 * Math.cos(a)] as V3;
  });
  polyline(wheelPts, o, true);
  seg(sw, [0.75, 0.8, -0.37], o);
  seg([0.62, 0.98, -0.68], [0.62, 0.98, 0.68], o);
  return o;
}
