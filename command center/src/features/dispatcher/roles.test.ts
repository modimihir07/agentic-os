import { describe, expect, it } from "vitest";
import { ROLE_IDS, SUB_AGENT_IDS, isRoleId, toRoleId, toggleGrant } from "./roles";

describe("toggleGrant", () => {
  const ALL = ["tony", ...SUB_AGENT_IDS] as const;

  it("turns the 'all' entry on and off as a plain toggle", () => {
    expect(toggleGrant([], "all", ALL)).toEqual(["all"]);
    expect(toggleGrant(["all"], "all", ALL)).toEqual([]);
  });

  it("adds/removes a concrete id from an explicit list", () => {
    expect(toggleGrant([], "coder", ALL)).toEqual(["coder"]);
    expect(toggleGrant(["coder"], "coder", ALL)).toEqual([]);
    expect(toggleGrant(["coder"], "ops", ALL)).toEqual(["coder", "ops"]);
  });

  it("narrows 'all' to everyone-but-one when a concrete pill is toggled off", () => {
    const next = toggleGrant(["all"], "coder", ALL);
    expect(next).not.toContain("coder");
    expect(next).not.toContain("all");
    // every other id is still explicitly listed, so access is unchanged for them
    for (const id of ALL) {
      if (id !== "coder") expect(next).toContain(id);
    }
  });

  it("is idempotent re-toggling the same id back on from a narrowed 'all'", () => {
    const narrowed = toggleGrant(["all"], "coder", ALL);
    const restored = toggleGrant(narrowed, "coder", ALL);
    expect(new Set(restored)).toEqual(new Set(ALL));
  });
});

describe("roles", () => {
  it("ROLE_IDS covers all 7 roles with general first", () => {
    expect(ROLE_IDS[0]).toBe("general");
    expect(ROLE_IDS).toHaveLength(7);
  });

  it("SUB_AGENT_IDS excludes general and matches the Part 2 pill order", () => {
    expect(SUB_AGENT_IDS).toEqual(["booking", "coder", "prompter", "designer", "librarian", "ops"]);
  });

  it("toRoleId accepts 'tony' as an alias of 'general'", () => {
    expect(toRoleId("tony")).toBe("general");
    expect(toRoleId("Tony")).toBe("general");
    expect(toRoleId("coder")).toBe("coder");
    expect(toRoleId("nonsense")).toBeNull();
  });

  it("isRoleId rejects unknown ids", () => {
    expect(isRoleId("general")).toBe(true);
    expect(isRoleId("tony")).toBe(false);
    expect(isRoleId("")).toBe(false);
  });
});
