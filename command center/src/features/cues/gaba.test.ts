import { describe, expect, it } from "vitest";
import { editDistance, isGabaLike, norm } from "./gaba";

describe("norm — Whisper mangles of \"gabagool\"", () => {
  const MATCHES: [string, string][] = [
    ["Gaba Gool", "gabagool"],
    ["Gaba-Gool", "gabagool"],
    ["Gabagul", "gabagool"],
    ["Gabba Goule", "gabagool"],
    ["gaba goom", "gabagool"],
    ["gobba gool", "gabagool"],
    ["gaba ghoul", "gabagool"],
    ["gobble", "gabagool"],
    ["cabbage cool", "gabagool"],
    ["turn off gabagool mode", "turn off gabagool mode"],
    ["enter gaba goom mode", "enter gabagool mode"],
  ];
  for (const [input, expected] of MATCHES) {
    it(`"${input}" → "${expected}"`, () => {
      expect(norm(input)).toBe(expected);
    });
  }

  const NON_MATCHES = ["garbage", "cabbage", "gabby", "good", "a good book", "gab"];
  for (const input of NON_MATCHES) {
    it(`does not rewrite ordinary word "${input}"`, () => {
      expect(norm(input)).toBe(input);
    });
  }

  it("is idempotent", () => {
    expect(norm(norm("gaba goom"))).toBe(norm("gaba goom"));
  });

  it("collapses punctuation and whitespace", () => {
    expect(norm("  Gaba-Gool,   Mode! ")).toBe("gabagool mode");
  });
});

describe("isGabaLike", () => {
  it("accepts known mangles", () => {
    for (const w of ["gabagool", "gobble", "gabagul", "gabbagool"]) expect(isGabaLike(w)).toBe(true);
  });
  it("rejects ordinary words", () => {
    for (const w of ["garbage", "cabbage", "gabby", "hello", "book"]) expect(isGabaLike(w)).toBe(false);
  });
  it("rejects words far outside the length window", () => {
    expect(isGabaLike("g")).toBe(false);
    expect(isGabaLike("a".repeat(20))).toBe(false);
  });
});

describe("editDistance", () => {
  it("is 0 for identical strings", () => expect(editDistance("gabagool", "gabagool")).toBe(0));
  it("counts substitutions", () => expect(editDistance("gabagool", "gabagoom")).toBe(1));
  it("counts insertions/deletions", () => expect(editDistance("gabagol", "gabagool")).toBe(1));
});

describe("norm never swallows a trailing command word", () => {
  it.each([
    ["gabagool up", "gabagool up"],
    ["turn gabagool on", "turn gabagool on"],
    ["turn the gabagool down", "turn the gabagool down"],
    ["gaba gool mode", "gabagool mode"],
    ["ga ba gool", "gabagool"],
  ])("%s → %s", (input, out) => expect(norm(input)).toBe(out));
});
