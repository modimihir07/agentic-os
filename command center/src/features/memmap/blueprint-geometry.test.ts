import { describe, expect, it } from "vitest";
import type { SnapSummary, TraceStep } from "@/lib/platform";
import {
  BLUEPRINT_YAW,
  BLUEPRINT_YAW_SWING,
  blueprintFit,
  blueprintModules,
  crankSpeed,
  CYLINDERS,
  cylinderX,
  explodeAt,
  explodePoint,
  I6_PHASE_DEG,
  pistonLift,
  project,
  ROD,
  rng,
  telemetryRows,
  THROW,
} from "./blueprint-geometry";

const summary = (o: Partial<SnapSummary> = {}): SnapSummary => ({
  uptimeSecs: 10,
  cpuPct: 34.4,
  memUsedMb: 1000,
  memTotalMb: 4000,
  gpuUtilPct: 12,
  vramUsedMb: 3000,
  vramTotalMb: 12000,
  servicesUp: 1,
  servicesTotal: 2,
  skills: 0,
  storesOk: 1,
  storesTotal: 1,
  ...o,
});
const model = (ms: number, tps?: number): TraceStep => ({ traceId: "t", seq: 0, hop: "model", zone: "engine", label: "lmstudio · qwen", ok: true, ms, at: 1, ...(tps != null ? { tps } : {}) });

describe("blueprint basics", () => {
  it("rng is deterministic per seed and in [0, 1)", () => {
    const a = rng(7);
    const b = rng(7);
    const xs = Array.from({ length: 50 }, () => a());
    expect(Array.from({ length: 50 }, () => b())).toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(rng(8)()).not.toBe(xs[0]);
  });

  it("project: centre maps to (cx, cy); up is up on screen; yaw rotates x", () => {
    expect(project([0, 0, 0], 0.4, 1, 10, 50, 40)).toEqual([50, 40]);
    expect(project([0, 1, 0], 0, 0, 10, 50, 40)[1]).toBeLessThan(40);
    expect(project([1, 0, 0], 0, 0, 10, 50, 40)[0]).toBe(60);
    expect(project([1, 0, 0], Math.PI, 0, 10, 50, 40)[0]).toBeCloseTo(40);
  });
});

describe("engine kinematics", () => {
  it("pistonLift peaks at TDC, bottoms at BDC and spans the stroke", () => {
    expect(pistonLift(0)).toBeCloseTo(THROW + ROD, 12);
    expect(pistonLift(Math.PI)).toBeCloseTo(ROD - THROW, 12);
    for (let a = 0; a < Math.PI * 2; a += 0.1) {
      expect(pistonLift(a)).toBeLessThanOrEqual(THROW + ROD + 1e-12);
      expect(pistonLift(a)).toBeGreaterThanOrEqual(ROD - THROW - 1e-12);
    }
  });

  it("I6 crank phases pair the cylinders 1/6, 2/5, 3/4 at 120° apart", () => {
    expect(I6_PHASE_DEG).toHaveLength(CYLINDERS);
    for (let i = 0; i < 3; i++) expect(I6_PHASE_DEG[i]).toBe(I6_PHASE_DEG[CYLINDERS - 1 - i]);
    expect(new Set(I6_PHASE_DEG).size).toBe(3);
    expect(cylinderX(0)).toBeCloseTo(-cylinderX(CYLINDERS - 1), 12);
  });

  it("crankSpeed idles without a CPU reading and speeds up with load", () => {
    expect(crankSpeed(null)).toBeCloseTo(crankSpeed(0), 12);
    expect(crankSpeed(100)).toBeGreaterThan(crankSpeed(20));
    expect(crankSpeed(500)).toBe(crankSpeed(100));
  });
});

describe("exploded modules", () => {
  const mods = blueprintModules(0.3);

  it("has the cylinder bank, intake, exhaust and drivetrain, all finite", () => {
    expect(mods.map((m) => m.id)).toEqual(["pistons", "intake", "exhaust", "drivetrain"]);
    for (const m of mods) {
      expect(m.lines.length).toBeGreaterThan(0);
      for (const l of m.lines) for (const p of l) expect(p.every(Number.isFinite)).toBe(true);
    }
  });

  it("the block stays put; the other modules fly out", () => {
    expect(mods[0].explode).toEqual([0, 0, 0]);
    for (const m of mods.slice(1)) expect(Math.hypot(...m.explode)).toBeGreaterThan(0.3);
    const m = mods[1];
    expect(explodePoint([1, 2, 3], m, 0)).toEqual([1, 2, 3]);
    expect(explodePoint([0, 0, 0], m, 1)).toEqual(m.explode);
  });

  it("pistons move with the crank angle, the rest is static", () => {
    const a = blueprintModules(0);
    const b = blueprintModules(1);
    expect(a[0].lines).not.toEqual(b[0].lines);
    expect(a.slice(1)).toEqual(b.slice(1));
    expect(blueprintModules(0)).toEqual(a);
  });

  it("the static modules are built once and shared between frames", () => {
    const a = blueprintModules(0);
    const b = blueprintModules(2);
    for (let k = 1; k < 4; k++) expect(a[k].lines).toBe(b[k].lines);
  });

  it("blueprintFit is one fixed fit that keeps every animated frame inside the box", () => {
    const w = 200;
    const h = 100;
    const fit = blueprintFit(w, h, 0.42);
    expect(fit.scale).toBeGreaterThan(0);
    // Sample the real animation loop: yaw and explode from t, the crank turning.
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (let t = 0; t < 30; t += 0.37) {
      const e = explodeAt(t);
      const yaw = BLUEPRINT_YAW + BLUEPRINT_YAW_SWING * Math.sin(t * 0.22);
      for (const m of blueprintModules(t * 3.1))
        for (const l of m.lines)
          for (const p of l) {
            const [x, y] = project(explodePoint(p, m, e), yaw, 0.42, fit.scale, fit.cx, fit.cy);
            x0 = Math.min(x0, x);
            x1 = Math.max(x1, x);
            y0 = Math.min(y0, y);
            y1 = Math.max(y1, y);
          }
    }
    expect(x0).toBeGreaterThanOrEqual(10 - 1e-6);
    expect(x1).toBeLessThanOrEqual(w - 10 + 1e-6);
    expect(y0).toBeGreaterThanOrEqual(0);
    expect(y1).toBeLessThanOrEqual(h);
    // Deterministic per box size: nothing to recompute per frame.
    expect(blueprintFit(w, h, 0.42)).toEqual(fit);
    expect(blueprintFit(w, h, 0.42, true).scale).toBeGreaterThanOrEqual(fit.scale);
  });

  it("explodeAt breathes between 0.72 and 1", () => {
    for (let t = 0; t < 14; t += 0.25) {
      expect(explodeAt(t)).toBeGreaterThanOrEqual(0.72 - 1e-12);
      expect(explodeAt(t)).toBeLessThanOrEqual(1 + 1e-12);
    }
  });
});

describe("telemetryRows", () => {
  it("shows live CPU, GPU, VRAM and tokens/s", () => {
    const r = telemetryRows(summary(), [model(800, 42.3)]);
    expect(r.map((x) => [x.key, x.module, x.value])).toEqual([
      ["cpu", "pistons", "34%"],
      ["gpu", "intake", "12%"],
      ["vram", "exhaust", "25%"],
      ["tps", "drivetrain", "42"],
    ]);
    expect(r[0].pct).toBeCloseTo(34.4);
    expect(r[3].label).toBe("TOK/S");
    expect(telemetryRows(summary(), [model(800, 7.25)])[3].value).toBe("7.3");
  });

  it("falls back to the last model hop's latency when tokens/s wasn't measured", () => {
    const r = telemetryRows(summary(), [model(840)]);
    expect(r[3].label).toBe("LAT");
    expect(r[3].value).toBe("840 ms");
  });

  it("reports the newest model hop, never an older hop's tokens/s as current", () => {
    const r = telemetryRows(summary(), [model(900, 42), model(1200)]);
    expect(r[3].label).toBe("LAT");
    expect(r[3].value).toBe("1.2 s");
    expect(r[3].value).not.toBe("42");
    const later = telemetryRows(summary(), [model(1200), model(900, 42)]);
    expect(later[3].value).toBe("42");
    const untimed = telemetryRows(summary(), [model(900, 42), model(Number.NaN)]);
    expect(untimed[3].value).toBe("—");
  });

  it("never fakes a number: every missing source is a dash with a reason", () => {
    for (const r of telemetryRows(null, [])) {
      expect(r.value).toBe("—");
      expect(r.pct).toBeNull();
      expect(r.why.length).toBeGreaterThan(0);
    }
    const partial = telemetryRows(summary({ cpuPct: null, gpuUtilPct: null, vramUsedMb: null }), []);
    expect(partial.map((x) => x.value)).toEqual(["—", "—", "—", "—"]);
    expect(partial[1].why).toMatch(/GPU/);
  });
});
