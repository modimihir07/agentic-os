import { describe, expect, it } from "vitest";
import { introLine } from "./handoff";

describe("introLine", () => {
  it("introduces one agent", () => {
    expect(introLine(["booking"])).toBe("Here's Booking Desk.");
  });
  it("chains several in order", () => {
    expect(introLine(["booking", "librarian"])).toBe("Here's Booking Desk, then Librarian.");
  });
});
