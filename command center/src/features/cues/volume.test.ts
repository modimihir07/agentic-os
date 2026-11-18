import { describe, expect, it } from "vitest";
import { clampVolume, nudgeVolume, softClipCurve, updateDuckSources, volumeGain, type DuckSource } from "./volume";

describe("cue volume math", () => {
  it("clamps to 0–300 %", () => {
    expect(clampVolume(-5)).toBe(0);
    expect(clampVolume(150)).toBe(150);
    expect(clampVolume(420)).toBe(300);
    expect(clampVolume(Number.NaN)).toBe(0);
  });

  it("maps % to linear gain up to 3", () => {
    expect(volumeGain(100)).toBe(1);
    expect(volumeGain(300)).toBe(3);
    expect(volumeGain(1000)).toBe(3);
    expect(volumeGain(-1)).toBe(0);
  });

  it("nudges and clamps to whole percents", () => {
    expect(nudgeVolume(100, 25)).toBe(125);
    expect(nudgeVolume(100, -25)).toBe(75);
    expect(nudgeVolume(290, 50)).toBe(300);
    expect(nudgeVolume(10, -25)).toBe(0);
    expect(nudgeVolume(22.4, 25)).toBe(47);
  });
});

describe("duck sources", () => {
  it("stays ducked until every source releases", () => {
    const s = new Set<DuckSource>();
    expect(updateDuckSources(s, "tts", true)).toBe(true);
    expect(updateDuckSources(s, "user", true)).toBe(true);
    expect(updateDuckSources(s, "user", false)).toBe(true);
    expect(updateDuckSources(s, "tts", false)).toBe(false);
  });

  it("is idempotent", () => {
    const s = new Set<DuckSource>();
    updateDuckSources(s, "user", true);
    updateDuckSources(s, "user", true);
    expect(updateDuckSources(s, "user", false)).toBe(false);
    expect(updateDuckSources(s, "tts", false)).toBe(false);
  });
});

describe("softClipCurve", () => {
  const c = softClipCurve(2049, 0.8);
  const at = (x: number) => c[Math.round(((x + 1) / 2) * (c.length - 1))];

  it("is the identity below the knee", () => {
    expect(at(0)).toBeCloseTo(0, 6);
    expect(at(0.5)).toBeCloseTo(0.5, 3);
    expect(at(-0.8)).toBeCloseTo(-0.8, 3);
  });

  it("is monotonic, odd and stays inside ±1", () => {
    for (let i = 1; i < c.length; i++) expect(c[i]).toBeGreaterThanOrEqual(c[i - 1]);
    expect(at(1)).toBeLessThan(1);
    expect(at(1)).toBeGreaterThan(0.9);
    expect(at(-1)).toBeCloseTo(-at(1), 6);
  });
});
