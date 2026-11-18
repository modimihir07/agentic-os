import { describe, expect, it } from "vitest";
import { VOLUME_HOLD_MS, fmtTime, needsReconnect, progressAt, progressFraction, shownVolume } from "./spotify-ui";

describe("spotify widget helpers", () => {
  it("formats track times", () => {
    expect(fmtTime(0)).toBe("0:00");
    expect(fmtTime(187_400)).toBe("3:07");
    expect(fmtTime(3_729_000)).toBe("1:02:09");
    expect(fmtTime(-5)).toBe("0:00");
    expect(fmtTime(NaN)).toBe("0:00");
  });

  it("advances position only while playing, clamped to the length", () => {
    const np = { isPlaying: true, progressMs: 10_000, durationMs: 12_000 };
    expect(progressAt(np, 1000, 2500)).toBe(11_500);
    expect(progressAt(np, 1000, 9000)).toBe(12_000);
    expect(progressAt({ ...np, isPlaying: false }, 1000, 9000)).toBe(10_000);
    expect(progressAt({ ...np, durationMs: 0 }, 1000, 9000)).toBe(18_000);
    expect(progressFraction(6, 12)).toBe(0.5);
    expect(progressFraction(20, 12)).toBe(1);
    expect(progressFraction(5, 0)).toBe(0);
  });

  it("a recent slider edit wins over the polled volume", () => {
    expect(shownVolume(40, null, 0)).toBe(40);
    expect(shownVolume(40, { value: 70, at: 1000 }, 1000 + VOLUME_HOLD_MS - 1)).toBe(70);
    expect(shownVolume(40, { value: 70, at: 1000 }, 1000 + VOLUME_HOLD_MS)).toBe(40);
    expect(shownVolume(null, null, 0)).toBe(null);
  });

  it("knows when to show Connect again", () => {
    expect(needsReconnect("Spotify isn't connected — connect it in Settings → Integrations.")).toBe(true);
    expect(needsReconnect("Open Spotify on this PC or your phone first.")).toBe(false);
    expect(needsReconnect("Spotify session expired — connect it again in Settings → Integrations")).toBe(true);
    expect(needsReconnect("Spotify is blocking this app: the Spotify account that owns it in the Developer Dashboard needs an active Premium subscription")).toBe(true);
    expect(needsReconnect("Spotify playback control needs Premium")).toBe(false);
  });
});
