import { describe, expect, it } from "vitest";
import { parseDraftEmail } from "./draft-email";

describe("parseDraftEmail", () => {
  it("topic → subject, and the topic is the body when nothing else was said", () => {
    expect(parseDraftEmail("draft an email to sam@acme.ca about the quarterly budget")).toEqual({ kind: "draft", to: "sam@acme.ca", subject: "The quarterly budget", body: "The quarterly budget" });
  });

  it("topic plus saying → subject and body", () => {
    expect(parseDraftEmail("Draft an email to Sam@Acme.ca about lunch saying I'll be ten minutes late.")).toEqual({ kind: "draft", to: "sam@acme.ca", subject: "Lunch", body: "I'll be ten minutes late" });
  });

  it("saying / that / telling him → body, subject from its first words", () => {
    expect(parseDraftEmail("draft email to jo@x.io saying the shoot moved to Friday at noon because of rain")).toMatchObject({ subject: "The shoot moved to Friday at noon because…", body: "The shoot moved to Friday at noon because of rain" });
    expect(parseDraftEmail("draft a quick email to jo@x.io that the deck is ready")).toMatchObject({ subject: "The deck is ready", body: "The deck is ready" });
    expect(parseDraftEmail("draft an email to jo@x.io telling him that I'm in")).toMatchObject({ body: "I'm in" });
  });

  it("explicit subject and body", () => {
    expect(parseDraftEmail("draft an email to a@b.co with the subject Contract renewal, body please sign by Monday")).toMatchObject({ subject: "Contract renewal", body: "Please sign by Monday" });
    expect(parseDraftEmail("draft an email to a@b.co subject: Hello")).toEqual({ kind: "ask", reply: expect.stringContaining("What should the email to a@b.co say") });
  });

  it("several recipients and spoken addresses", () => {
    expect(parseDraftEmail("draft an email to sam at acme dot co dot uk and jo@x.io about rates")).toMatchObject({ to: "sam@acme.co.uk, jo@x.io" });
    expect(parseDraftEmail("draft an email to a@b.co, c@d.org about rates")).toMatchObject({ to: "a@b.co, c@d.org" });
  });

  it("asks for the address when there isn't one", () => {
    expect(parseDraftEmail("draft an email to Sam about lunch")).toEqual({ kind: "ask", reply: expect.stringContaining("What's Sam's email address?") });
    expect(parseDraftEmail("please draft a reply to my last email")).toEqual({ kind: "ask", reply: expect.stringContaining("Who should the draft go to?") });
    expect(parseDraftEmail("create a draft for my accountant about taxes in my email")).toMatchObject({ kind: "ask" });
  });

  it("write / compose only bind with an address; other drafts are left alone", () => {
    expect(parseDraftEmail("write an email to my landlord about the leak")).toBeNull();
    expect(parseDraftEmail("compose an email to lee@studio.ca about the edit")).toMatchObject({ kind: "draft", to: "lee@studio.ca" });
    expect(parseDraftEmail("draft a reply to Maria")).toBeNull();
    expect(parseDraftEmail("draft a blog post about agents")).toBeNull();
    expect(parseDraftEmail("read my last email")).toBeNull();
    expect(parseDraftEmail("email sam@acme.ca saying hi")).toBeNull();
  });
});

describe("half-spoken addresses", () => {
  it("'sam at gmail.com' (Whisper keeps the spoken 'at') still drafts", () => {
    expect(parseDraftEmail("draft an email to sam at gmail.com saying hi")).toMatchObject({ kind: "draft", to: "sam@gmail.com", body: "Hi" });
  });
});
