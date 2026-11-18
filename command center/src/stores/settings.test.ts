import { describe, expect, it } from "vitest";
import { deepMergeDefaults, useSettings } from "./settings";

describe("deepMergeDefaults", () => {
  const defaults = {
    brainstorm: { autoOrganizeEvery: 6, listenProfile: "relaxed" as const },
    vad: { sensitivity: 60, endSilenceMs: 700, maxUtteranceMs: 15000 },
    wakeWords: ["hey tony"],
    weatherLocation: null as { lat: number; lon: number; label: string } | null,
    osName: "Tony",
  };

  it("backfills a missing nested key without touching sibling keys the persisted object already has", () => {
    // Simulates a pre-v5 persisted `brainstorm` object that predates `listenProfile`.
    const persisted = { brainstorm: { autoOrganizeEvery: 9 } };
    const merged = deepMergeDefaults(persisted, defaults);
    expect(merged.brainstorm).toEqual({ autoOrganizeEvery: 9, listenProfile: "relaxed" });
  });

  it("leaves a persisted value in place when it differs from the default", () => {
    const persisted = { vad: { sensitivity: 80, endSilenceMs: 700, maxUtteranceMs: 15000 } };
    const merged = deepMergeDefaults(persisted, defaults);
    expect(merged.vad.sensitivity).toBe(80);
  });

  it("takes an array from the persisted side as-is (arrays replace wholesale, not element-merge)", () => {
    const persisted = { wakeWords: ["yo"] };
    const merged = deepMergeDefaults(persisted, defaults);
    expect(merged.wakeWords).toEqual(["yo"]);
  });

  it("keeps an explicit null from the persisted side rather than overwriting it with the default", () => {
    const persisted = { weatherLocation: null };
    const merged = deepMergeDefaults(persisted, defaults);
    expect(merged.weatherLocation).toBeNull();
  });

  it("fills in an entire missing top-level object", () => {
    const persisted = { osName: "Tony" };
    const merged = deepMergeDefaults(persisted, defaults);
    expect(merged.brainstorm).toEqual(defaults.brainstorm);
  });

  it("returns the defaults untouched when nothing was persisted", () => {
    expect(deepMergeDefaults(null, defaults)).toEqual(defaults);
    expect(deepMergeDefaults(undefined, defaults)).toEqual(defaults);
  });

  it("is idempotent — merging the already-merged result again changes nothing", () => {
    const once = deepMergeDefaults({ brainstorm: { autoOrganizeEvery: 9 } }, defaults);
    const twice = deepMergeDefaults(once, defaults);
    expect(twice).toEqual(once);
  });
});

describe("useSettings defaults (v5)", () => {
  it("defaults the new brainstorm.listenProfile to relaxed", () => {
    expect(useSettings.getState().brainstorm.listenProfile).toBe("relaxed");
  });
});
