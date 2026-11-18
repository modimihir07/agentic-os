import { describe, expect, it } from "vitest";
import { bargeSensitivityOffset, classifyOutputLabel, effectiveRoute } from "./audio-route";

describe("classifyOutputLabel", () => {
  for (const label of [
    "Default - Headphones (Realtek(R) Audio)",
    "Headset Earphone (HyperX Cloud II)",
    "Headphones (WH-1000XM4 Stereo)",
    "AirPods Pro",
    "Default - Air Pods (Bluetooth)",
    "Galaxy Buds2 Pro",
    "Pixel Buds A-Series",
    "Earbuds (Jabra Elite)",
    "Headset (Bose QC35 II Hands-Free AG Audio)",
    "Hands-Free (WF-1000XM5)",
    "Bluetooth Headset",
    "EarPods",
  ]) {
    it(`"${label}" → headset`, () => expect(classifyOutputLabel(label)).toBe("headset"));
  }
  for (const label of ["Default - Speakers (Realtek(R) Audio)", "Speakers (USB Audio Device)", "LG HDR 4K (NVIDIA High Definition Audio)", "JBL Flip 5 (Bluetooth)", "Digital Output (S/PDIF)", "Communications - Speakers", "Budget Monitor"]) {
    it(`"${label}" → speakers`, () => expect(classifyOutputLabel(label)).toBe("speakers"));
  }
  it("no label (no mic permission yet) → speakers, the safe default", () => {
    expect(classifyOutputLabel("")).toBe("speakers");
    expect(classifyOutputLabel(undefined)).toBe("speakers");
    expect(classifyOutputLabel(null)).toBe("speakers");
  });
});

describe("effectiveRoute / barge offset", () => {
  it("auto follows the device; a forced setting wins", () => {
    expect(effectiveRoute("auto", "headset")).toBe("headset");
    expect(effectiveRoute("auto", "speakers")).toBe("speakers");
    expect(effectiveRoute("speakers", "headset")).toBe("speakers");
    expect(effectiveRoute("headset", "speakers")).toBe("headset");
  });
  it("speakers barge-in is stricter", () => {
    expect(bargeSensitivityOffset("speakers")).toBe(-35);
    expect(bargeSensitivityOffset("headset")).toBe(-25);
  });
});
