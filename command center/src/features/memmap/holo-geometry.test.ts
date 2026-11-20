import { describe, expect, it } from "vitest";
import type { TraceStep, TraceZone } from "@/lib/platform";
import {
  boxesOverlap,
  CAR,
  CAR_PLAN_R,
  CAR_TOP,
  circle,
  HOLO_CAMERA,
  HOLO_FOV,
  HOLO_TARGET,
  leaderElbow,
  leaderPath,
  pedestal,
  e46Wireframe,
  fitDistance,
  freshSteps,
  groundGrid,
  halfWidthAt,
  leaderStart,
  lowerProfile,
  ndcToPx,
  pointAt,
  pulseCurve,
  pulsesFor,
  roundedRect,
  TELEMETRY_NODES,
  UPPER_PROFILE,
  WHEELS_LABEL,
  ZONE_VOLUMES,
  zoneAnchor,
  zoneFlash,
  zoneVolume,
} from "./holo-geometry";
import { faceProfileX } from "./e46-body";
import { zoneOf } from "./trace-store";

const step = (traceId: string, seq: number, hop: TraceStep["hop"], ok = true, at = 1000 + seq): TraceStep => ({ traceId, seq, hop, zone: zoneOf(hop), label: hop, ok, ms: 5, at });

const inBox = (p: readonly number[], v: { center: readonly number[]; size: readonly number[] }) => p.every((c, k) => Math.abs(c - v.center[k]) <= v.size[k] / 2 + 1e-9);

describe("E46 Touring profile", () => {
  it("spans the real car's length and stays under its roof", () => {
    const xs = UPPER_PROFILE.map((p) => p[0]);
    expect(Math.min(...xs)).toBeCloseTo(-CAR.halfLength, 1);
    expect(Math.max(...xs)).toBeCloseTo(CAR.halfLength, 1);
    for (const [, y, f] of UPPER_PROFILE) {
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThanOrEqual(CAR.roof);
      expect(f).toBeGreaterThan(0.8);
      expect(f).toBeLessThanOrEqual(1);
    }
  });

  it("has a wagon roofline: the roof runs almost to the tail, then a raked (not fastback) hatch drops to the belt", () => {
    const roof = UPPER_PROFILE.filter(([, y]) => y >= CAR.roof - 0.05);
    const rearmost = Math.min(...roof.map(([x]) => x));
    // A saloon's roof ends near the C-pillar (~-1.0 m); the Touring's reaches the D-pillar.
    expect(rearmost).toBeLessThan(-1.75);
    // The hatch rakes: from the roof's rear edge to the beltline in 0.2-0.38 m of length.
    const hatchTop = UPPER_PROFILE.find(([x, y]) => y >= CAR.roof - 0.05 && x === rearmost)!;
    const hatchBottom = UPPER_PROFILE.find(([, y]) => Math.abs(y - CAR.belt) < 0.01)!;
    const dx = Math.abs(hatchTop[0] - hatchBottom[0]);
    expect(dx).toBeGreaterThan(0.2);
    expect(dx).toBeLessThan(0.38);
    // Below the belt the tailgate panel leans forward too.
    expect(faceProfileX("rear", 0.98)).toBeGreaterThan(faceProfileX("rear", 0.6));
  });

  it("cuts both wheel arches over the axles into the lower edge", () => {
    const lower = lowerProfile();
    for (const axle of [CAR.frontAxle, CAR.rearAxle]) {
      const over = lower.filter(([x]) => Math.abs(x - axle) < 0.05);
      expect(Math.max(...over.map(([, y]) => y))).toBeGreaterThan(CAR.wheelRadius + 0.3);
    }
    expect(lower[0][0]).toBeGreaterThan(lower[lower.length - 1][0]);
  });

  it("tucks the body in above the beltline (tumblehome)", () => {
    expect(halfWidthAt(0.5)).toBe(CAR.halfWidth);
    expect(halfWidthAt(CAR.roof)).toBeCloseTo(CAR.roofHalfWidth);
    expect(halfWidthAt(1.2)).toBeLessThan(CAR.halfWidth);
    expect(halfWidthAt(1.2)).toBeGreaterThan(CAR.roofHalfWidth);
    expect(halfWidthAt(5)).toBeCloseTo(CAR.roofHalfWidth);
  });
});

describe("e46Wireframe", () => {
  const w = e46Wireframe();

  it("emits whole segments (6 numbers each) in every colour group", () => {
    for (const g of [w.base, w.cyan, w.amber, w.halo ?? []]) {
      expect(g.length).toBeGreaterThan(0);
      expect(g.length % 6).toBe(0);
      expect(g.every(Number.isFinite)).toBe(true);
    }
  });

  it("is deterministic and symmetric in width (left/right mirror)", () => {
    expect(e46Wireframe()).toEqual(w);
    const zs = w.base.filter((_, i) => i % 3 === 2);
    expect(Math.max(...zs)).toBeCloseTo(-Math.min(...zs), 5);
  });

  it("fits the car's bounding box", () => {
    const pts = [...w.base, ...w.cyan, ...w.amber, ...(w.halo ?? [])];
    for (let i = 0; i < pts.length; i += 3) {
      expect(Math.abs(pts[i])).toBeLessThan(CAR.halfLength + 0.1);
      expect(pts[i + 1]).toBeGreaterThanOrEqual(-1e-9);
      expect(pts[i + 1]).toBeLessThan(CAR.roof + 0.1);
      expect(Math.abs(pts[i + 2])).toBeLessThan(1.0);
    }
  });

  it("puts the amber tail lamps and exhaust at the rear", () => {
    for (let i = 0; i < w.amber.length; i += 3) expect(w.amber[i]).toBeLessThan(-2);
  });
});

describe("shape helpers", () => {
  it("circle has n points at radius r in the right plane", () => {
    const c = circle([1, 2, 3], 0.5, "z", 12);
    expect(c).toHaveLength(12);
    for (const [x, y, z] of c) {
      expect(Math.hypot(x - 1, y - 2)).toBeCloseTo(0.5);
      expect(z).toBe(3);
    }
    for (const [x, y, z] of circle([1, 2, 3], 0.5, "x", 8)) {
      expect(x).toBe(1);
      expect(Math.hypot(y - 2, z - 3)).toBeCloseTo(0.5);
    }
  });

  it("roundedRect stays inside its box", () => {
    for (const [x, y, z] of roundedRect([2, 0.6, 0.1], 0.2, 0.1, "x")) {
      expect(x).toBe(2);
      expect(Math.abs(y - 0.6)).toBeLessThanOrEqual(0.05 + 1e-9);
      expect(Math.abs(z - 0.1)).toBeLessThanOrEqual(0.1 + 1e-9);
    }
  });

  it("groundGrid is flat on y = 0", () => {
    const g = groundGrid(2, 4);
    expect(g.length % 6).toBe(0);
    for (let i = 1; i < g.length; i += 3) expect(g[i]).toBe(0);
  });
});

describe("telemetry nodes", () => {
  it("pins the four wheel hubs on their outer faces, without becoming trace zones", () => {
    expect(TELEMETRY_NODES.map((n) => n.id)).toEqual(["wheel-fl", "wheel-fr", "wheel-rl", "wheel-rr"]);
    const zones: string[] = ZONE_VOLUMES.map((z) => z.zone);
    for (const n of TELEMETRY_NODES) {
      expect(zones).not.toContain(n.id);
      expect(n.anchor[1]).toBe(CAR.wheelRadius);
      expect([CAR.frontAxle, CAR.rearAxle]).toContain(n.anchor[0]);
      expect(Math.abs(n.anchor[2])).toBeGreaterThan(CAR.track);
      expect(Math.abs(n.anchor[2])).toBeLessThan(0.9);
      expect(Math.sign(n.anchor[2])).toBe(n.id.endsWith("l") ? -1 : 1);
    }
    expect(WHEELS_LABEL).toBe('WHEELS // 18" · 225/40 · 255/35');
  });
});

describe("zones", () => {
  it("has exactly one hit volume per trace zone", () => {
    const zones: TraceZone[] = ["cockpit", "engine", "ecu", "cargo", "exhaust"];
    expect(ZONE_VOLUMES.map((z) => z.zone).sort()).toEqual([...zones].sort());
    for (const z of zones) expect(zoneVolume(z).zone).toBe(z);
  });

  it("maps zones to the right part of the car", () => {
    expect(zoneAnchor("engine")[0]).toBeGreaterThan(1); // hood, front
    expect(zoneAnchor("cargo")[0]).toBeLessThan(-1); // hatch, rear
    expect(zoneAnchor("exhaust")[0]).toBeLessThan(-2); // tailpipe
    expect(zoneAnchor("exhaust")[1]).toBeLessThan(0.5);
    expect(zoneAnchor("exhaust")[2]).toBeLessThan(0); // left (driver's) side
    const ecu = zoneAnchor("ecu")[0];
    expect(ecu).toBeLessThan(zoneAnchor("engine")[0]); // firewall between hood …
    expect(ecu).toBeGreaterThan(zoneAnchor("cockpit")[0]); // … and cabin
  });

  it("keeps the hit volumes apart so a hover picks one zone", () => {
    for (let i = 0; i < ZONE_VOLUMES.length; i++) for (let j = i + 1; j < ZONE_VOLUMES.length; j++) expect(boxesOverlap(ZONE_VOLUMES[i], ZONE_VOLUMES[j])).toBe(false);
  });

  it("boxesOverlap detects an overlap", () => {
    const a = { ...ZONE_VOLUMES[0] };
    expect(boxesOverlap(a, { ...a, center: [a.center[0] + 0.1, a.center[1], a.center[2]] })).toBe(true);
  });

  it("anchors the engine, ECU, cockpit and cargo inside their volumes (exhaust sits at the pipe tip)", () => {
    for (const v of ZONE_VOLUMES.filter((z) => z.zone !== "exhaust")) expect(inBox(v.anchor, v)).toBe(true);
  });
});

describe("pulse path selection", () => {
  it("freshSteps returns the tail after the previous newest step", () => {
    const a = step("t1", 0, "input");
    const b = step("t1", 1, "router");
    const c = step("t1", 2, "model");
    expect(freshSteps([a, b, c], a)).toEqual([b, c]);
    expect(freshSteps([a, b, c], c)).toEqual([]);
    expect(freshSteps([a], undefined)).toEqual([a]);
    expect(freshSteps([], c)).toEqual([]);
  });

  it("freshSteps caps a big jump (ring rotated past the last seen step)", () => {
    const ring = Array.from({ length: 20 }, (_, i) => step("t", i, "tool"));
    const gone = step("old", 0, "input");
    expect(freshSteps(ring, gone, 5)).toEqual(ring.slice(-5));
  });

  it("pulses travel from the previous step's zone in the same trace", () => {
    const steps = [step("t1", 0, "input"), step("t2", 0, "router"), step("t1", 1, "router"), step("t1", 2, "memory"), step("t1", 3, "tool", false)];
    const p = pulsesFor(steps, steps.slice(2));
    expect(p.map((x) => [x.from, x.to])).toEqual([
      ["cockpit", "engine"],
      ["engine", "cargo"],
      ["cargo", "exhaust"],
    ]);
    expect(p[2].ok).toBe(false);
  });

  it("a trace's first step is a flash in place (from === to)", () => {
    const s = step("solo", 0, "rules");
    const [p] = pulsesFor([s], [s]);
    expect(p.from).toBe("ecu");
    expect(p.to).toBe("ecu");
    expect(pulseCurve(p.from, p.to)).toEqual([]);
  });

  it("pulse keys are unique per step", () => {
    const steps = [step("t", 0, "input"), step("t", 1, "router")];
    const keys = pulsesFor(steps, steps).map((p) => p.key);
    expect(new Set(keys).size).toBe(2);
  });

  it("pulseCurve runs anchor to anchor and arcs above both", () => {
    const c = pulseCurve("cockpit", "exhaust", 10);
    expect(c).toHaveLength(11);
    expect(c[0]).toEqual(zoneAnchor("cockpit"));
    c[10].forEach((v, k) => expect(v).toBeCloseTo(zoneAnchor("exhaust")[k]));
    const peak = Math.max(...c.map((p) => p[1]));
    expect(peak).toBeGreaterThan(Math.max(zoneAnchor("cockpit")[1], zoneAnchor("exhaust")[1]));
  });

  it("pointAt interpolates and clamps", () => {
    const c = pulseCurve("engine", "cargo", 4);
    expect(pointAt(c, 0)).toEqual(c[0]);
    expect(pointAt(c, 1)).toEqual(c[4]);
    expect(pointAt(c, -3)).toEqual(c[0]);
    expect(pointAt(c, 9)).toEqual(c[4]);
    const mid = pointAt(c, 0.125)!;
    mid.forEach((v, k) => expect(v).toBeCloseTo((c[0][k] + c[1][k]) / 2));
    expect(pointAt([], 0.5)).toBeNull();
  });
});

/** Project world points through a camera built the way HoloViewport builds it: at `target`
 * plus `d` along the normalised `camera − target` ray, looking at `target`. Returns NDC. */
function projector(fov: number, aspect: number, d: number, camera = HOLO_CAMERA, target = HOLO_TARGET) {
  const dir = camera.map((c, k) => c - target[k]);
  const len = Math.hypot(...dir);
  const C = target.map((t, k) => t + (dir[k] / len) * d);
  const f = dir.map((v) => -v / len); // forward
  // right = forward × world-up, up = right × forward
  const rRaw = [f[1] * 0 - f[2] * 1, f[2] * 0 - f[0] * 0, f[0] * 1 - f[1] * 0];
  const rl = Math.hypot(...rRaw);
  const r = rRaw.map((v) => v / rl);
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  const tv = Math.tan((fov * Math.PI) / 360);
  const th = tv * aspect;
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return (p: readonly number[]): [number, number] => {
    const v = [p[0] - C[0], p[1] - C[1], p[2] - C[2]];
    const z = dot(v, f);
    return [dot(v, r) / (z * th), dot(v, u) / (z * tv)];
  };
}

describe("camera fit", () => {
  it("backs off for a narrow stage and never comes closer than the minimum", () => {
    const wide = fitDistance(30, 2.2);
    const narrow = fitDistance(30, 0.9);
    expect(narrow).toBeGreaterThan(wide);
    expect(fitDistance(30, 50)).toBeGreaterThanOrEqual(4);
  });

  it("the fit rings bound every car vertex", () => {
    const w = e46Wireframe();
    for (const layer of [w.base, w.cyan, w.amber, w.halo ?? [], w.inner ?? []]) {
      for (let i = 0; i < layer.length; i += 3) {
        expect(Math.hypot(layer[i], layer[i + 2])).toBeLessThanOrEqual(CAR_PLAN_R);
        expect(layer[i + 1]).toBeLessThanOrEqual(CAR_TOP);
        expect(layer[i + 1]).toBeGreaterThanOrEqual(-0.01);
      }
    }
  });

  it("keeps the car at every yaw and the whole pedestal inside the frame at any aspect (elevation-aware)", () => {
    const w = e46Wireframe();
    const car: number[] = [...w.base, ...w.cyan, ...w.amber, ...(w.halo ?? []), ...(w.inner ?? [])];
    const p = pedestal();
    const ped: number[] = [...p.grid, ...p.rings, ...p.ticks];
    for (const aspect of [1.0, 1.4, 1.78, 2.2, 2.8, 3.0]) {
      const proj = projector(HOLO_FOV, aspect, fitDistance(HOLO_FOV, aspect));
      let maxX = 0;
      let maxY = 0;
      let lo = Infinity;
      let hi = -Infinity;
      for (let k = 0; k < 24; k++) {
        const yaw = (k / 24) * Math.PI * 2;
        const c = Math.cos(yaw);
        const s = Math.sin(yaw);
        for (let i = 0; i < car.length; i += 3) {
          const [x, y] = proj([car[i] * c + car[i + 2] * s, car[i + 1], -car[i] * s + car[i + 2] * c]);
          maxX = Math.max(maxX, Math.abs(x));
          maxY = Math.max(maxY, Math.abs(y));
          lo = Math.min(lo, y);
          hi = Math.max(hi, y);
        }
      }
      for (let i = 0; i < ped.length; i += 3) {
        const [x, y] = proj([ped[i], ped[i + 1], ped[i + 2]]);
        maxX = Math.max(maxX, Math.abs(x));
        maxY = Math.max(maxY, Math.abs(y));
      }
      expect({ aspect, maxX: maxX < 0.95, maxY: maxY < 0.95 }).toEqual({ aspect, maxX: true, maxY: true });
      // The car sits roughly mid-frame, not sunk to the bottom edge.
      expect(Math.abs(hi + lo)).toBeLessThan(0.5);
    }
  });
});

describe("zone flash", () => {
  it("keeps a pending flash, decays it, then reports it done so the entry is pruned", () => {
    expect(zoneFlash(-50)).toBe("pending");
    expect(zoneFlash(0)).toBeCloseTo(0.16);
    expect(zoneFlash(350)).toBeCloseTo(0.08);
    expect(zoneFlash(700)).toBe("done");
    expect(zoneFlash(60_000)).toBe("done");
  });
});

describe("callout leader lines", () => {
  const card = { x: 10, y: 10, w: 100, h: 40 };

  it("leaves the card from the edge nearest the target", () => {
    expect(leaderStart(card, [300, 30])).toEqual([110, 30]);
    expect(leaderStart(card, [300, 200])).toEqual([110, 50]);
    expect(leaderStart(card, [50, 0])).toEqual([50, 10]);
  });

  it("draws nothing when the target is under the card", () => {
    expect(leaderStart(card, [50, 30])).toBeNull();
    expect(leaderPath(card, [50, 30])).toBeNull();
  });

  it("leaderPath elbows: square off the card edge, then diagonal to the target", () => {
    // Off the right edge: horizontal first.
    expect(leaderPath(card, [300, 30])).toEqual([
      [110, 30],
      [128, 30],
      [300, 30],
    ]);
    expect(leaderPath(card, [300, 200])).toEqual([
      [110, 50],
      [128, 50],
      [300, 200],
    ]);
    // Above the card: vertical first, never past the target.
    expect(leaderPath(card, [50, 0])).toEqual([
      [50, 10],
      [50, 0],
      [50, 0],
    ]);
    expect(leaderPath(card, [60, -100], 24)).toEqual([
      [60, 10],
      [60, -14],
      [60, -100],
    ]);
    // The path always starts where leaderStart does.
    for (const p of [
      [300, 30],
      [-50, 80],
      [70, 200],
    ] as const)
      expect(leaderPath(card, p)![0]).toEqual(leaderStart(card, p));
  });

  it("leaderElbow writes into a reused buffer (the frame loop's allocation-free path)", () => {
    const buf = new Float64Array(4);
    expect(leaderElbow(card, -50, 30, buf)).toBe(true);
    expect([...buf]).toEqual([10, 30, -8, 30]);
    expect(leaderElbow(card, 50, 30, buf)).toBe(false);
  });

  it("ndcToPx maps clip space to pixels (y down)", () => {
    expect(ndcToPx(-1, 1, 200, 100)).toEqual([0, 0]);
    expect(ndcToPx(1, -1, 200, 100)).toEqual([200, 100]);
    expect(ndcToPx(0, 0, 200, 100)).toEqual([100, 50]);
  });
});
