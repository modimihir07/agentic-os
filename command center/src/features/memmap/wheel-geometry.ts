/**
 * One 18-inch E46 wheel as pure line geometry (no three.js): a 225/40R18 tyre (or the
 * staggered rear 255/35R18, same diameter, wider section) with a real cross-section (bead, sidewall bulge, shoulder, tread and grooves), a multi-spoke alloy
 * (lip, barrel, inner flange, five twin-spoke pairs dished toward the hub, centre cap and
 * five lug bolts), and the brake behind the spokes (vented rotor with its hat, and a
 * caliper at the trailing edge). Metres, same axes as holo-geometry: the wheel spins
 * about z. Deterministic.
 */

export type WV3 = readonly [number, number, number];

export const WHEEL = {
  size: "225/40",
  /** 225/40R18: 457 mm rim + 2 × 90 mm sidewall → 0.637 m diameter. */
  tyreR: 0.316,
  /** 18-inch rim lip. */
  rimR: 0.2286,
  rotorR: 0.15,
  hubR: 0.075,
  /** Half the tyre's section width (its outer face sits at zc + this, plus the bulge). */
  halfWidth: 0.104,
  spokePairs: 5,
  /** Circle resolution. */
  n: 36,
} as const;

/** The staggered rear tyre, 255/35R18: 457 mm + 2 × 89 mm → 0.636 m, so the same radius, ~13% wider. */
export const REAR_TYRE = {
  size: "255/35",
  tyreR: WHEEL.tyreR,
  halfWidth: 0.1175,
} as const;

/** Tyre cross-section for the 225 section (radius, offset from the wheel's centre plane, + = outboard); scaled for wider tyres. */
const TYRE_SECTION: readonly (readonly [number, number])[] = [
  [0.232, 0.104],
  [0.27, 0.117],
  [0.302, 0.11],
  [WHEEL.tyreR, 0.082],
  [WHEEL.tyreR, 0.028],
  [WHEEL.tyreR, -0.028],
  [WHEEL.tyreR, -0.082],
  [0.302, -0.11],
  [0.27, -0.117],
  [0.232, -0.104],
];

export interface WheelSpec {
  /** Axle x, wheel-centre height, centre-plane z. */
  cx: number;
  cy: number;
  zc: number;
  /** Which side of the car: the outer face points this way in z. */
  side: 1 | -1;
  /** Where the caliper sits, in degrees about z (180 = trailing edge for a car facing +x). */
  caliperDeg?: number;
  /** Half the tyre's section width (default WHEEL.halfWidth); the rim face moves out with it. */
  halfWidth?: number;
  /** Twin-spoke pairs (default WHEEL.spokePairs). */
  spokePairs?: number;
}

export interface WheelLines {
  tyre: number[];
  rim: number[];
  brake: number[];
}

function seg(a: WV3, b: WV3, out: number[]) {
  out.push(a[0], a[1], a[2], b[0], b[1], b[2]);
}

function loop(pts: readonly WV3[], out: number[]) {
  for (let i = 0; i < pts.length; i++) seg(pts[i], pts[(i + 1) % pts.length], out);
}

/** The wheel's segment lists, grouped for colouring (tyre, rim, brake). */
export function wheelGeometry({ cx, cy, zc, side, caliperDeg = 180, halfWidth = WHEEL.halfWidth, spokePairs = WHEEL.spokePairs }: WheelSpec): WheelLines {
  const out: WheelLines = { tyre: [], rim: [], brake: [] };
  const n: number = WHEEL.n;
  const at = (r: number, a: number, dz: number): WV3 => [cx + r * Math.cos(a), cy + r * Math.sin(a), zc + side * dz];
  const circle = (r: number, dz: number, m: number = n) => Array.from({ length: m }, (_, i) => at(r, (i / m) * Math.PI * 2, dz));
  const wz = halfWidth / WHEEL.halfWidth;
  const section = TYRE_SECTION.map(([r, dz]) => [r, dz * wz] as const);

  // Tyre: a circle per cross-section point, meridians through the section, tread blocks.
  for (const [r, dz] of section) loop(circle(r, dz), out.tyre);
  for (let i = 0; i < n; i += n / 9) {
    const a = (i / n) * Math.PI * 2;
    for (let k = 0; k + 1 < section.length; k++) seg(at(section[k][0], a, section[k][1]), at(section[k + 1][0], a, section[k + 1][1]), out.tyre);
  }
  for (let i = 0; i < n; i += 2) {
    const a = ((i + 0.5) / n) * Math.PI * 2;
    seg(at(WHEEL.tyreR, a, 0.082 * wz), at(WHEEL.tyreR, a + 0.05, 0.028 * wz), out.tyre);
    seg(at(WHEEL.tyreR, a, -0.082 * wz), at(WHEEL.tyreR, a + 0.05, -0.028 * wz), out.tyre);
  }

  // Rim: lip, inner lip step, barrel and inner flange.
  const face = halfWidth;
  loop(circle(WHEEL.rimR, face + 0.002), out.rim);
  loop(circle(0.215, face - 0.008), out.rim);
  loop(circle(0.205, face - 0.06), out.rim);
  loop(circle(WHEEL.rimR, -face), out.rim);
  // Twin-spoke pairs, dished: hub end 35 mm inboard of the lip.
  for (let k = 0; k < spokePairs; k++) {
    const ak = Math.PI / 2 + (k / spokePairs) * Math.PI * 2;
    for (const sgn of [-1, 1]) {
      const h = at(WHEEL.hubR, ak + sgn * 0.13, face - 0.035);
      const r = at(0.212, ak + sgn * 0.21, face - 0.008);
      const dx = r[0] - h[0];
      const dy = r[1] - h[1];
      const len = Math.hypot(dx, dy) || 1;
      const px = -dy / len;
      const py = dx / len;
      const edge = (p: WV3, w: number, lift = 0): WV3 => [p[0] + px * w, p[1] + py * w, p[2] + side * lift];
      seg(edge(h, 0.011), edge(r, 0.01), out.rim);
      seg(edge(h, -0.011), edge(r, -0.01), out.rim);
      seg(edge(h, 0, 0.006), edge(r, 0, 0.006), out.rim);
    }
  }
  // Hub ring, centre cap and five lug bolts (5 × 120).
  loop(circle(WHEEL.hubR, face - 0.035, 24), out.rim);
  loop(circle(0.032, face - 0.03, 16), out.rim);
  for (let k = 0; k < 5; k++) {
    const a = Math.PI / 2 + (k / 5) * Math.PI * 2 + Math.PI / 5;
    const c = at(0.052, a, face - 0.033);
    loop(
      Array.from({ length: 6 }, (_, i) => {
        const b = (i / 6) * Math.PI * 2;
        return [c[0] + 0.008 * Math.cos(b), c[1] + 0.008 * Math.sin(b), c[2]] as WV3;
      }),
      out.rim,
    );
  }

  // Brake, inboard of the spokes: vented rotor (friction ring + hat) and the caliper.
  loop(circle(WHEEL.rotorR, face - 0.075), out.brake);
  loop(circle(0.095, face - 0.075), out.brake);
  loop(circle(0.07, face - 0.06, 20), out.brake);
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    seg(at(0.1, a, face - 0.075), at(0.145, a + 0.08, face - 0.075), out.brake);
  }
  const c0 = ((caliperDeg - 28) * Math.PI) / 180;
  const c1 = ((caliperDeg + 28) * Math.PI) / 180;
  for (const dz of [face - 0.065, face - 0.095]) {
    const pts: WV3[] = [];
    for (let i = 0; i <= 8; i++) pts.push(at(0.168, c0 + ((c1 - c0) * i) / 8, dz));
    for (let i = 8; i >= 0; i--) pts.push(at(0.112, c0 + ((c1 - c0) * i) / 8, dz));
    loop(pts, out.brake);
  }
  for (const [r, a] of [
    [0.168, c0],
    [0.168, c1],
    [0.112, c0],
    [0.112, c1],
  ] as const)
    seg(at(r, a, face - 0.065), at(r, a, face - 0.095), out.brake);
  return out;
}
