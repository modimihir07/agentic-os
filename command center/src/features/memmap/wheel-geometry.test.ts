import { describe, expect, it } from "vitest";
import { REAR_TYRE, WHEEL, wheelGeometry } from "./wheel-geometry";

const spec = { cx: 1.44, cy: 0.32, zc: 0.74, side: 1 as const };
const pts = (a: readonly number[]) => Array.from({ length: a.length / 3 }, (_, i) => [a[3 * i], a[3 * i + 1], a[3 * i + 2]] as const);
const radius = (p: readonly number[]) => Math.hypot(p[0] - spec.cx, p[1] - spec.cy);

describe("wheelGeometry", () => {
  const w = wheelGeometry(spec);

  it("emits whole, finite segments in every group", () => {
    for (const g of [w.tyre, w.rim, w.brake]) {
      expect(g.length).toBeGreaterThan(0);
      expect(g.length % 6).toBe(0);
      expect(g.every(Number.isFinite)).toBe(true);
    }
  });

  it("nests rotor < rim < tyre", () => {
    expect(WHEEL.rotorR).toBeLessThan(WHEEL.rimR);
    expect(WHEEL.rimR).toBeLessThan(WHEEL.tyreR);
    const maxR = (g: number[]) => Math.max(...pts(g).map(radius));
    expect(maxR(w.brake)).toBeLessThan(WHEEL.rimR);
    expect(maxR(w.rim)).toBeLessThan(WHEEL.tyreR);
    expect(maxR(w.tyre)).toBeCloseTo(WHEEL.tyreR, 9);
    // The rotor ring itself is at rotorR.
    expect(pts(w.brake).some((p) => Math.abs(radius(p) - WHEEL.rotorR) < 1e-9)).toBe(true);
  });

  it("puts the brake inboard of the spokes and stays inside |z| < 0.9", () => {
    const spokeFace = spec.zc + WHEEL.halfWidth - 0.035;
    for (const [, , z] of pts(w.brake)) expect(z).toBeLessThan(spokeFace);
    for (const g of [w.tyre, w.rim, w.brake]) for (const [, y, z] of pts(g)) {
      expect(Math.abs(z)).toBeLessThan(0.9);
      expect(y).toBeGreaterThanOrEqual(0);
    }
  });

  it("mirrors to the other side of the car", () => {
    const l = wheelGeometry({ ...spec, zc: -spec.zc, side: -1 });
    expect(l.tyre.length).toBe(w.tyre.length);
    const r = pts(w.rim);
    pts(l.rim).forEach(([x, y, z], i) => {
      expect(x).toBeCloseTo(r[i][0], 12);
      expect(y).toBeCloseTo(r[i][1], 12);
      expect(z).toBeCloseTo(-r[i][2], 12);
    });
  });

  it("is deterministic", () => {
    expect(wheelGeometry(spec)).toEqual(w);
  });

  it("staggers the rear: a wider 255 section of the same diameter, still inside |z| < 0.9", () => {
    const rear = wheelGeometry({ ...spec, halfWidth: REAR_TYRE.halfWidth });
    const zMax = (g: number[]) => Math.max(...pts(g).map(([, , z]) => z));
    expect(zMax(rear.tyre)).toBeGreaterThan(zMax(w.tyre) + 0.01);
    expect(zMax(rear.tyre)).toBeLessThan(0.9);
    expect(Math.max(...pts(rear.tyre).map(radius))).toBeCloseTo(REAR_TYRE.tyreR, 9);
    expect(Math.abs(REAR_TYRE.tyreR - WHEEL.tyreR)).toBeLessThan(0.002);
    // The default is the front 225 wheel.
    expect(wheelGeometry({ ...spec, halfWidth: WHEEL.halfWidth })).toEqual(w);
  });
});
