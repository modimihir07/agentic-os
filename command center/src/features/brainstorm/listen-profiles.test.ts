import { describe, expect, it } from "vitest";
import { LISTEN_PROFILES } from "./listen-profiles";
import { utteranceShouldEnd } from "@/features/voice/vad-rules";

describe("LISTEN_PROFILES", () => {
  it("snappy ends on a short pause and caps at 30s", () => {
    expect(LISTEN_PROFILES.snappy).toEqual({ endSilenceMs: 1000, maxUtteranceMs: 30_000, maxSilenceStartMs: 30_000 });
  });

  it("relaxed tolerates a long pause (2.8–3.5s per spec) and caps at 90–120s", () => {
    expect(LISTEN_PROFILES.relaxed.endSilenceMs).toBeGreaterThanOrEqual(2800);
    expect(LISTEN_PROFILES.relaxed.endSilenceMs).toBeLessThanOrEqual(3500);
    expect(LISTEN_PROFILES.relaxed.maxUtteranceMs).toBeGreaterThanOrEqual(90_000);
    expect(LISTEN_PROFILES.relaxed.maxUtteranceMs).toBeLessThanOrEqual(120_000);
  });

  it("continuous never ends on silence, the no-speech timeout, or a time cap", () => {
    expect(LISTEN_PROFILES.continuous).toEqual({ endSilenceMs: Infinity, maxUtteranceMs: Infinity, maxSilenceStartMs: Infinity });
  });

  it("every field is a positive number (finite or Infinity, never NaN or <= 0)", () => {
    for (const profile of Object.values(LISTEN_PROFILES)) {
      for (const v of Object.values(profile)) {
        expect(Number.isNaN(v)).toBe(false);
        expect(v).toBeGreaterThan(0);
      }
    }
  });

  it("feeds utteranceShouldEnd correctly for every profile (end-to-end sanity, not just the table shape)", () => {
    // snappy: a 1.5s pause ends the thought.
    expect(utteranceShouldEnd(1500, LISTEN_PROFILES.snappy.endSilenceMs, 2000, LISTEN_PROFILES.snappy.maxUtteranceMs)).toBe(true);
    // relaxed: a 1.5s pause mid-thought does NOT end it (needs ~3s).
    expect(utteranceShouldEnd(1500, LISTEN_PROFILES.relaxed.endSilenceMs, 10_000, LISTEN_PROFILES.relaxed.maxUtteranceMs)).toBe(false);
    // continuous: even a very long pause never ends it on silence alone.
    expect(utteranceShouldEnd(10 * 60_000, LISTEN_PROFILES.continuous.endSilenceMs, 10 * 60_000, LISTEN_PROFILES.continuous.maxUtteranceMs)).toBe(false);
  });
});
