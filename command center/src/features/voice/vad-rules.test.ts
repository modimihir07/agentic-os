import { describe, expect, it } from "vitest";
import { utteranceShouldEnd } from "./vad-rules";

describe("utteranceShouldEnd", () => {
  it("ends on a long enough pause", () => {
    expect(utteranceShouldEnd(1000, 1000, 500, 30_000)).toBe(true);
    expect(utteranceShouldEnd(999, 1000, 500, 30_000)).toBe(false);
  });

  it("ends once the hard cap is exceeded, pause or not", () => {
    expect(utteranceShouldEnd(0, 3000, 120_001, 120_000)).toBe(true);
    expect(utteranceShouldEnd(0, 3000, 120_000, 120_000)).toBe(false); // exactly at the cap: not yet over
  });

  it("continuous profile (Infinity thresholds) never ends on silence or time", () => {
    expect(utteranceShouldEnd(10_000_000, Infinity, 10_000_000, Infinity)).toBe(false);
    expect(utteranceShouldEnd(0, Infinity, 0, Infinity)).toBe(false);
  });

  it("a finite pause threshold still ends an utterance even with an Infinity cap", () => {
    expect(utteranceShouldEnd(3000, 3000, 5000, Infinity)).toBe(true);
  });

  it("an Infinity pause threshold with a finite cap only ends via the cap", () => {
    expect(utteranceShouldEnd(10_000_000, Infinity, 30_001, 30_000)).toBe(true);
    expect(utteranceShouldEnd(10_000_000, Infinity, 29_999, 30_000)).toBe(false);
  });
});
