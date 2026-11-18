import { afterEach, describe, expect, it, vi } from "vitest";
import { heuristicPlan } from "./plan";

const desktop = () => vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
afterEach(() => vi.unstubAllGlobals());

describe("heuristicPlan — Gmail draft binding", () => {
  it("a draft with an address is a mutating gmail.create_draft tool plan", () => {
    desktop();
    const p = heuristicPlan("Hey Tony, draft an email to sam@acme.ca about lunch saying I'm running late", "general");
    expect(p.mutating).toBe(true);
    expect(p.target).toEqual({ kind: "tool", tool: "gmail.create_draft", args: { to: "sam@acme.ca", subject: "Lunch", body: "I'm running late" } });
    expect(p.payload).toEqual({ to: "sam@acme.ca", subject: "Lunch", body: "I'm running late" });
    expect(p.readBack).toMatch(/Gmail draft to sam@acme\.ca.*won't be sent.*Proceed\?$/);
    expect(p.run).toBeUndefined();
  });

  it("no address → a read-only reply asking for it, never a gateway agent", async () => {
    desktop();
    const p = heuristicPlan("draft a reply to my last email", "booking");
    expect(p.mutating).toBe(false);
    expect((await p.run!()).text).toMatch(/Who should the draft go to\?/);
  });

  it("an address-less draft routed to the Booking Desk stays the Booking Desk's", () => {
    desktop();
    const p = heuristicPlan("draft an email to my agent about the self-tape", "booking");
    expect(p.run).toBeUndefined();
    expect(p.target?.kind).not.toBe("tool");
    expect(heuristicPlan("draft an email to my agent about the self-tape", "general").run).toBeDefined();
  });

  it("on the phone a draft is a polite read-only reply", async () => {
    const p = heuristicPlan("draft an email to sam@acme.ca saying hi", "general");
    expect(p.mutating).toBe(false);
    expect((await p.run!()).text).toMatch(/desktop app/);
  });
});

describe("heuristicPlan — music controls are never gateway actions", () => {
  it.each(["set the volume to 30", "pause music", "pause the music", "play some jazz on spotify", "skip this song", "turn it down", "set spotify to 40%", "spotify volume 20", "resume spotify", "change the song", "start my workout playlist", "restart the track"])("%s", (s) => {
    const p = heuristicPlan(s, "general");
    expect(p.mutating).toBe(false);
    expect(p.target.kind).toBe("agent");
  });

  it("still treats real actions as mutating", () => {
    expect(heuristicPlan("cancel my dinner with Sam", "booking").mutating).toBe(true);
    expect(heuristicPlan("set a meeting with Jo on Friday", "booking").mutating).toBe(true);
    expect(heuristicPlan("add this song to my road trip playlist", "general").mutating).toBe(true);
  });
});

describe("heuristicPlan — trailing addressed name", () => {
  it("', Tony.' at the end never lands in the draft", () => {
    desktop();
    const p = heuristicPlan("Draft an email to sam@gmail.com saying I'm running late, Tony.", "general");
    expect(p.target).toMatchObject({ kind: "tool", tool: "gmail.create_draft" });
    expect(JSON.stringify(p.target)).not.toMatch(/tony/i);
  });
});
