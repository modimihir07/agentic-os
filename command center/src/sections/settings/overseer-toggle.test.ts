import { describe, expect, it } from "vitest";
import { OVERSEER_OFF, overseerFamilyOn, toggleOverseer } from "./overseer-toggle";

describe("overseer toggles", () => {
  it("turn off back to the local model", () => {
    expect(toggleOverseer("claude-cli", "claude", false)).toBe(OVERSEER_OFF);
    expect(toggleOverseer("claude-api", "claude", false)).toBe("local");
    expect(toggleOverseer("gemini-api", "gemini", false)).toBe("local");
  });

  it("never flip API mode to CLI when already on", () => {
    expect(toggleOverseer("claude-api", "claude", true)).toBe("claude-api");
    expect(toggleOverseer("gemini-api", "gemini", true)).toBe("gemini-api");
    expect(toggleOverseer("claude-cli", "claude", true)).toBe("claude-cli");
  });

  it("switching families starts in CLI mode; turning off another family changes nothing", () => {
    expect(toggleOverseer("gemini-api", "claude", true)).toBe("claude-cli");
    expect(toggleOverseer("local", "gemini", true)).toBe("gemini-cli");
    expect(toggleOverseer("droplet", "claude", false)).toBe("droplet");
    expect(toggleOverseer("gemini-cli", "claude", false)).toBe("gemini-cli");
  });

  it("reports which family is on", () => {
    expect(overseerFamilyOn("claude-api", "claude")).toBe(true);
    expect(overseerFamilyOn("claude-api", "gemini")).toBe(false);
    expect(overseerFamilyOn("local", "claude")).toBe(false);
  });
});
