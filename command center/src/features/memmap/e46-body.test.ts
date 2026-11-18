import { describe, expect, it } from "vitest";
import {
  angelEyes,
  BELT,
  bodyShell,
  bodyWireframe,
  CAR,
  catmullRom,
  chassisWireframe,
  CLAMP_X,
  CLAMP_Y,
  crownY,
  doorCuts,
  faceProfileX,
  faceX,
  frameAt,
  GLASS_Y,
  inArch,
  insideBody,
  pchip,
  planHW,
  resample,
  roundedPoly,
  SEC,
  SECTION_HALF,
  SECTION_LOOP,
  sectionLoop,
  sideGlass,
  sideHW,
  sideOutline,
  sideProfile,
  stationFrames,
  tailLamp,
  topY,
  UPPER_PROFILE,
  X_NOSE,
  X_TAIL,
} from "./e46-body";
import { e46Wireframe, ZONE_VOLUMES } from "./holo-geometry";

const pts3 = (a: readonly number[]) => Array.from({ length: a.length / 3 }, (_, i) => [a[3 * i], a[3 * i + 1], a[3 * i + 2]] as const);

describe("splines", () => {
  it("catmullRom passes through every control point and stays finite", () => {
    const ctrl = [
      [0, 0],
      [1, 2],
      [1.1, 2.05],
      [4, 0],
    ] as const;
    const c = catmullRom(ctrl, 8);
    expect(c).toHaveLength(1 + 3 * 8);
    for (let i = 0; i < ctrl.length; i++) {
      expect(c[i * 8][0]).toBeCloseTo(ctrl[i][0], 9);
      expect(c[i * 8][1]).toBeCloseTo(ctrl[i][1], 9);
    }
    expect(c.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);
  });

  it("resample spaces points evenly by arc length and keeps both ends", () => {
    const r = resample(
      [
        [0, 0],
        [1, 0],
        [1, 3],
      ],
      5,
    );
    expect(r).toHaveLength(5);
    expect(r[0]).toEqual([0, 0]);
    expect(r[4]).toEqual([1, 3]);
    for (let i = 1; i < r.length; i++) expect(Math.hypot(r[i][0] - r[i - 1][0], r[i][1] - r[i - 1][1])).toBeCloseTo(1, 9);
  });

  it("pchip interpolates its knots and never overshoots them", () => {
    const t = [
      [0, 0],
      [1, 1],
      [2, 1],
      [3, 0],
    ] as const;
    for (const [x, y] of t) expect(pchip(t, x)).toBeCloseTo(y, 12);
    for (let x = 0; x <= 3; x += 0.01) {
      expect(pchip(t, x)).toBeLessThanOrEqual(1 + 1e-12);
      expect(pchip(t, x)).toBeGreaterThanOrEqual(-1e-12);
    }
  });
});

describe("E46 side profile", () => {
  const p = sideProfile();

  it("is the UPPER_PROFILE spline, resampled, and never overshoots the clamp", () => {
    expect(p.length).toBe(90);
    for (const [x, y] of p) {
      expect(Math.abs(x)).toBeLessThanOrEqual(CLAMP_X);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(CLAMP_Y);
    }
    expect(p[0]).toEqual([UPPER_PROFILE[0][0], UPPER_PROFILE[0][1]]);
    const last = UPPER_PROFILE[UPPER_PROFILE.length - 1];
    expect(p[p.length - 1][0]).toBeCloseTo(last[0], 9);
    expect(p[p.length - 1][1]).toBeCloseTo(last[1], 9);
  });

  it("follows the control points (every control point lies within 2 cm of the drawn line)", () => {
    for (const [cx, cy] of UPPER_PROFILE) {
      let best = Infinity;
      for (let i = 0; i + 1 < p.length; i++) {
        const [ax, ay] = p[i];
        const [bx, by] = p[i + 1];
        const dx = bx - ax;
        const dy = by - ay;
        const t = Math.max(0, Math.min(1, ((cx - ax) * dx + (cy - ay) * dy) / (dx * dx + dy * dy || 1)));
        best = Math.min(best, Math.hypot(ax + dx * t - cx, ay + dy * t - cy));
      }
      expect(best).toBeLessThan(0.02);
    }
  });

  it("has a long wagon roof, a raked windshield and a hood lower than the belt", () => {
    expect(crownY(-1.9)).toBeGreaterThan(1.4);
    expect(crownY(0)).toBeGreaterThan(1.42);
    expect(crownY(0.7)).toBeLessThan(crownY(0.35));
    expect(crownY(1.6)).toBeLessThan(BELT);
  });

  it("closes the side silhouette: the sill and arches return to the profile's first point", () => {
    const o = sideOutline();
    expect(o[0]).toEqual(o[o.length - 1]);
    expect(o[0]).toEqual(p[0]);
    // The lower edge runs front → rear and dips under both axles' arches.
    for (const ax of [CAR.frontAxle, CAR.rearAxle]) {
      const over = o.filter(([x, y]) => Math.abs(x - ax) < 0.05 && y > 0.5);
      expect(over.length).toBeGreaterThan(0);
    }
  });

  it("puts the bumpers and the plate where the plate mesh expects them", () => {
    expect(faceProfileX("rear", 0.5)).toBeLessThan(-2.2);
    expect(faceProfileX("front", 0.55)).toBeGreaterThan(2.2);
    // The plate mesh sits at x = -2.238: the tail surface around it must stay in front of it.
    for (const z of [-0.26, 0, 0.26]) for (const y of [0.81, 0.86, 0.91]) expect(faceX("rear", y, z)).toBeGreaterThanOrEqual(-2.235);
  });
});

describe("plan and sections", () => {
  it("tapers in plan: nose and tail narrower than the doors", () => {
    expect(planHW(2.15)).toBeLessThan(planHW(0));
    expect(planHW(-2.17)).toBeLessThan(planHW(0));
    expect(planHW(0)).toBeCloseTo(CAR.halfWidth, 6);
  });

  it("every station section is closed (40 points, no gaps) and mirror-symmetric", () => {
    for (const f of stationFrames()) {
      const loop = sectionLoop(f.x);
      expect(loop).toHaveLength(SECTION_LOOP);
      for (let k = 0; k < SECTION_LOOP; k++) {
        const m = loop[(SECTION_LOOP - k) % SECTION_LOOP];
        expect(m[0]).toBe(loop[k][0]);
        expect(m[1]).toBeCloseTo(loop[k][1], 12);
        expect(m[2]).toBeCloseTo(-loop[k][2], 12);
      }
      // The crown and the floor centre sit on the centre line, the side never pokes out past planHW.
      expect(loop[SEC.CROWN][2]).toBe(0);
      expect(loop[SEC.FLOOR][2]).toBe(0);
      for (const [, y, z] of loop) {
        expect(Math.abs(z)).toBeLessThanOrEqual(f.s + 1e-9);
        expect(y).toBeGreaterThanOrEqual(f.yFloor - 1e-9);
        expect(y).toBeLessThanOrEqual(f.yTop + 1e-9);
      }
    }
    expect(SECTION_LOOP).toBe(2 * SECTION_HALF - 2);
  });

  it("tucks the greenhouse in above the belt (tumblehome) with a step at the belt", () => {
    expect(sideHW(0, 1.3)).toBeLessThan(sideHW(0, 1.0));
    expect(sideHW(0, BELT + 0.001)).toBeLessThan(sideHW(0, BELT) - 0.02);
    expect(sideHW(0, 0.58)).toBeCloseTo(planHW(0), 9);
  });

  it("crowns the roof: highest on the centre line, lower at the drip rail", () => {
    const f = frameAt(-0.5);
    expect(topY(-0.5, 0)).toBeCloseTo(f.yTop, 9);
    expect(topY(-0.5, 0.58)).toBeLessThan(f.yTop);
    expect(topY(-0.5, f.a)).toBeCloseTo(f.yEdge, 9);
  });

  it("anchors every non-exhaust zone inside the lofted body", () => {
    for (const v of ZONE_VOLUMES.filter((z) => z.zone !== "exhaust")) expect(insideBody(v.anchor), v.zone).toBe(true);
    expect(insideBody([0, 2, 0])).toBe(false);
    expect(insideBody([0, 0.8, 1.2])).toBe(false);
  });
});

describe("arches", () => {
  it("cuts the arch opening over each axle", () => {
    expect(inArch(CAR.frontAxle, 0.6)).toBe(true);
    expect(inArch(CAR.rearAxle, 0.1)).toBe(true);
    expect(inArch(CAR.rearAxle, 0.75)).toBe(false);
    expect(inArch(0, 0.3)).toBe(false);
  });

  it("no body line runs through an arch opening", () => {
    const { base } = bodyWireframe();
    for (const [x, y, z] of pts3(base)) {
      // Only side lines (outboard of the wheel's tyre face) could cross the opening.
      if (Math.abs(z) > 0.7) expect(inArch(x, y, 0.4 - 1e-3)).toBe(false);
    }
  });
});

describe("greenhouse", () => {
  const g = sideGlass();

  it("has three side windows behind each other: front door, rear door, quarter glass", () => {
    const span = (l: readonly (readonly [number, number])[]) => [Math.min(...l.map((p) => p[0])), Math.max(...l.map((p) => p[0]))];
    const [, frontMax] = span(g.front);
    const [frontMin] = span(g.front);
    const [rearMin, rearMax] = span(g.rear);
    const [, quarterMax] = span(g.quarter);
    expect(frontMax).toBeGreaterThan(0.6);
    expect(rearMax).toBeLessThan(frontMin);
    expect(quarterMax).toBeLessThan(rearMin);
    for (const l of [g.front, g.rear, g.quarter]) for (const [, y] of l) expect(y).toBeGreaterThanOrEqual(GLASS_Y - 1e-9);
  });

  it("has the Hofmeister kink: the quarter glass's rearmost point is above the belt, its lower corner swept forward", () => {
    const q = g.quarter;
    const rearmost = q.reduce((m, p) => (p[0] < m[0] ? p : m));
    expect(rearmost[1]).toBeGreaterThan(GLASS_Y + 0.05);
    const lowRear = q.filter(([x, y]) => x < -1.7 && y < GLASS_Y + 0.01);
    expect(lowRear.length).toBeGreaterThan(0);
    for (const [x] of lowRear) expect(x).toBeGreaterThan(rearmost[0] + 0.05);
  });

  it("door cuts run from the belt down to the sill", () => {
    for (const cut of doorCuts()) {
      expect(cut[0][1]).toBe(BELT);
      expect(cut[cut.length - 1][1]).toBeLessThan(0.32);
    }
  });
});

describe("front and rear details", () => {
  it("angel eyes sit on the nose (x > 2.1), two rings and two lenses per side", () => {
    const rings = angelEyes();
    expect(rings).toHaveLength(8);
    for (const r of rings) for (const [x] of r) expect(x).toBeGreaterThan(2.1);
    const zs = rings.map((r) => r.reduce((s, p) => s + p[2], 0) / r.length);
    expect(zs.filter((z) => z > 0)).toHaveLength(4);
  });

  it("the L tail lamp wraps onto the flank on the body surface and its tailgate leg reaches inboard", () => {
    for (const s of [1, -1] as const) {
      const lamp = tailLamp(s);
      for (const [x, y, z] of lamp.flank) {
        expect(Math.abs(Math.abs(z) - sideHW(x, y))).toBeLessThan(0.01);
        expect(x).toBeLessThan(-2);
      }
      expect(Math.min(...lamp.face.map(([, , z]) => Math.abs(z)))).toBeLessThan(0.6);
      for (const [x, , z] of lamp.loop) {
        expect(x).toBeLessThan(-2);
        expect(Math.sign(z)).toBe(s);
      }
    }
  });

  it("faceX bulges the end faces out to the profile in the middle and meets the cap at the corners", () => {
    expect(faceX("front", 0.55, 0)).toBeCloseTo(faceProfileX("front", 0.55), 9);
    expect(faceX("front", 0.55, 2)).toBeCloseTo(X_NOSE, 9);
    expect(faceX("rear", 0.5, -2)).toBeCloseTo(X_TAIL, 9);
  });

  it("roundedPoly keeps its points inside the corners' bounding box", () => {
    const r = roundedPoly(
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
      0.2,
    );
    expect(r).toHaveLength(4 * 5);
    for (const [x, y] of r) {
      expect(x).toBeGreaterThanOrEqual(-1e-12);
      expect(x).toBeLessThanOrEqual(1 + 1e-12);
      expect(y).toBeGreaterThanOrEqual(-1e-12);
      expect(y).toBeLessThanOrEqual(1 + 1e-12);
    }
  });
});

describe("shell and chassis", () => {
  it("the shell's indices stay in range and form whole triangles", () => {
    const { positions, index } = bodyShell();
    expect(positions.length % 3).toBe(0);
    expect(index.length % 3).toBe(0);
    expect(index.length).toBeGreaterThan(0);
    const n = positions.length / 3;
    expect(index.every((i) => Number.isInteger(i) && i >= 0 && i < n)).toBe(true);
    expect(positions.every(Number.isFinite)).toBe(true);
  });

  it("the shell leaves the arch openings empty", () => {
    const { positions, index } = bodyShell();
    for (let t = 0; t < index.length; t += 3) {
      const cx = (positions[index[t] * 3] + positions[index[t + 1] * 3] + positions[index[t + 2] * 3]) / 3;
      const cy = (positions[index[t] * 3 + 1] + positions[index[t + 1] * 3 + 1] + positions[index[t + 2] * 3 + 1]) / 3;
      expect(inArch(cx, cy)).toBe(false);
    }
  });

  it("the inner chassis is whole segments inside the body's bounding box", () => {
    const c = chassisWireframe();
    expect(c.length % 6).toBe(0);
    expect(c.length).toBeGreaterThan(0);
    for (const [x, y, z] of pts3(c)) {
      expect(Math.abs(x)).toBeLessThan(CAR.halfLength);
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThan(CAR.roof);
      expect(Math.abs(z)).toBeLessThan(CAR.halfWidth);
    }
  });

  it("the facade carries the inner and shell groups, deterministically", () => {
    const w = e46Wireframe();
    expect(w.inner?.length).toBeGreaterThan(0);
    expect(w.shell?.index.length).toBeGreaterThan(0);
    expect(e46Wireframe().shell).toEqual(w.shell);
  });
});
