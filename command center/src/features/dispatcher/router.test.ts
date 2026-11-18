import { describe, expect, it } from "vitest";
import { DEFAULT_ROUTING_CONFIG, normalize, resolve } from "./router";
import fixtures from "./router.fixtures.json";

interface Fixture {
  desc: string;
  text: string;
  role: string | null;
  kind: string;
  taskContains?: string;
}

describe("resolve (shared fixtures)", () => {
  const list = fixtures as Fixture[];
  it("has a decent fixture set", () => {
    expect(list.length).toBeGreaterThanOrEqual(10);
  });
  for (const f of list) {
    it(`${f.desc} — ${JSON.stringify(f.text)}`, () => {
      const r = resolve(f.text, DEFAULT_ROUTING_CONFIG);
      expect(r.role).toBe(f.role);
      expect(r.kind).toBe(f.kind);
      if (f.taskContains) expect(r.task).toContain(f.taskContains);
    });
  }
});

describe("normalize", () => {
  it("fixes the three Whisper mangles", () => {
    expect(normalize("what's up")).toBe("whatsapp");
    expect(normalize("whats app")).toBe("whatsapp");
    expect(normalize("what sapp")).toBe("whatsapp");
  });
  it("spells out number words", () => {
    expect(normalize("last five messages")).toBe("last 5 messages");
  });
  it("lowercases and strips punctuation except &", () => {
    expect(normalize("B&Co")).toBe("b&co");
    expect(normalize("Hello, world!")).toBe("hello world");
  });
});

describe("whole-word boundaries", () => {
  it("does not match 'book' as a substring of 'booking'", () => {
    expect(resolve("please book a table for two", DEFAULT_ROUTING_CONFIG).kind).toBe("Default");
  });
  it("does not match 'ui' inside 'quick'", () => {
    expect(resolve("give me a quick summary", DEFAULT_ROUTING_CONFIG).kind).toBe("Default");
  });
});

describe("domain tie-break", () => {
  it("prefers booking over ops on an equal score", () => {
    const r = resolve("schedule a reminder about my messages", DEFAULT_ROUTING_CONFIG);
    expect(r.role).toBe("booking");
    expect(r.kind).toBe("Domain");
  });
});
