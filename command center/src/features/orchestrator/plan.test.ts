import { afterEach, describe, expect, it, vi } from "vitest";
import { heuristicPlan, stripWake } from "./plan";

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
    expect(heuristicPlan("add a todo to Linear", "general").mutating).toBe(true);
    expect(heuristicPlan("send this song to Sam", "general").mutating).toBe(true);
  });

  // Spotify library edits are Tony's: the Rust tool path gates them and raises the card (askCards).
  it.each(["add this song to my late night playlist", "create a playlist called Road Trip", "like this song on spotify", "queue up some jazz on spotify", "shuffle my liked songs"])(
    "%s is a Spotify line, not a gateway action",
    (s) => {
      const p = heuristicPlan(s, "general");
      expect(p.mutating).toBe(false);
      expect(p.target.kind).toBe("agent");
    },
  );
});

describe("stripWake — interjections before the name", () => {
  it.each([
    ["aye tony can you play some bilmuri", "can you play some bilmuri"],
    ["Ayy, Tony, pause the music", "pause the music"],
    ["ayo jarvis what's playing", "what's playing"],
    ["hi tony, skip this", "skip this"],
    ["Hey Tony: check my email", "check my email"],
  ])("%s → %s", (input, out) => {
    expect(stripWake(input)).toBe(out);
  });

  it("keeps the name when it isn't an address, and whole words only", () => {
    expect(stripWake("play tony bennett")).toBe("play tony bennett");
    expect(stripWake("ayesha called")).toBe("ayesha called");
  });

  it("'aye tony, play …' is a music control, never a gateway action", () => {
    const p = heuristicPlan("aye tony can you play some bilmuri", "general");
    expect(p.mutating).toBe(false);
    expect(p.target.kind).toBe("agent");
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

describe("heuristicPlan — 'update' questions are read-only", () => {
  it.each(["give me an update on whatsapp", "any whatsapp updates?", "update me on the self-tape", "what's the latest update from the coder", "any updates from finance"])("%s", (s) => {
    expect(heuristicPlan(s, "general").mutating).toBe(false);
  });

  it("'ask the coder for an update' is read-only and stays Named to the coder", () => {
    const p = heuristicPlan("ask the coder for an update");
    expect(p.mutating).toBe(false);
    expect(p.role).toBe("coder");
  });

  it("real updates and settings stay mutating", () => {
    expect(heuristicPlan("update the invoice", "ops").mutating).toBe(true);
    expect(heuristicPlan("set the meeting for Friday", "booking").mutating).toBe(true);
    expect(heuristicPlan("update my status update template", "general").mutating).toBe(true);
    expect(heuristicPlan("reply to Sam on WhatsApp", "general").mutating).toBe(true);
  });
});
