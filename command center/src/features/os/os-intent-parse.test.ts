import { describe, expect, it } from "vitest";
import { commandText, isOsControlPhrase, parseOsIntent, resolveModel, type OsIntent } from "./os-intent-parse";

const parse = (t: string, cueActive = true) => parseOsIntent(t, { osName: "Tony", cueActive });

describe("parseOsIntent — gabagool", () => {
  it.each<[string, OsIntent]>([
    ["enter gabagool mode", { kind: "gabagool-on" }],
    ["turn on gabagool", { kind: "gabagool-on" }],
    ["activate gabagool mode", { kind: "gabagool-on" }],
    ["start gabagool", { kind: "gabagool-on" }],
  ])("%s → gabagool-on", (text, expected) => {
    expect(parse(text)).toEqual(expected);
  });

  it.each<[string, OsIntent]>([
    ["turn off gabagool mode", { kind: "gabagool-off", explicit: true }],
    ["stop gabagool", { kind: "gabagool-off", explicit: true }],
    ["exit gabagool mode", { kind: "gabagool-off", explicit: true }],
    ["kill gabagool", { kind: "gabagool-off", explicit: true }],
  ])("%s → explicit gabagool-off", (text, expected) => {
    expect(parse(text)).toEqual(expected);
  });

  it.each(["turn off", "stop it", "stop", "kill the music", "stop the music"])(
    "bare \"%s\" is gabagool-off (non-explicit) only while a cue is active",
    (text) => {
      expect(parse(text, true)).toEqual({ kind: "gabagool-off", explicit: false });
      expect(parse(text, false)).toBeNull();
    },
  );

  it("a bare 'turn off' with no cue active and no other match is null", () => {
    expect(parse("turn off", false)).toBeNull();
  });
});

describe("parseOsIntent — workspace switch", () => {
  it.each<[string, string]>([
    ["switch to the booking desk", "booking"],
    ["open the coder tab", "coder"],
    ["go to tony", "general"],
    ["talk to the librarian", "librarian"],
  ])("%s → workspace %s", (text, thread) => {
    expect(parse(text)).toEqual({ kind: "workspace", thread });
  });

  it("plain chit-chat is not a workspace switch", () => {
    expect(parse("what's up")).toBeNull();
  });
});

describe("parseOsIntent — model / compute / kill switch / status", () => {
  it("model swap keeps the spoken query", () => {
    expect(parse("switch model to qwen three eight b")).toEqual({ kind: "model", query: "qwen three eight b" });
    expect(parse("use model llama 3")).toEqual({ kind: "model", query: "llama 3" });
  });

  it.each<["local" | "hybrid" | "cloud", string]>([
    ["local", "go local"],
    ["hybrid", "go hybrid mode"],
    ["cloud", "use cloud mode"],
  ])("compute mode %s from \"%s\"", (mode, text) => {
    expect(parse(text)).toEqual({ kind: "compute", mode });
  });

  it.each<[string, boolean]>([
    ["kill switch on", true],
    ["turn off the kill switch", false],
    ["enable the kill switch", true],
    ["disable kill switch", false],
  ])("%s → kill-switch %s", (text, on) => {
    expect(parse(text)).toEqual({ kind: "kill-switch", on });
  });

  it("system status", () => {
    expect(parse("system status")).toEqual({ kind: "status" });
    expect(parse("status report")).toEqual({ kind: "status" });
  });

  it("an ordinary question parses to null", () => {
    expect(parse("what's up")).toBeNull();
    expect(parse("what's the weather like")).toBeNull();
  });
});

describe("commandText / isOsControlPhrase", () => {
  it("strips wake word and politeness", () => {
    expect(commandText("hey tony, please turn off gabagool mode", "Tony")).toBe("turn off gabagool mode");
  });

  it("isOsControlPhrase matches OS-control phrases and nothing else", () => {
    expect(isOsControlPhrase("turn off gabagool mode", "Tony")).toBe(true);
    expect(isOsControlPhrase("switch to booking desk", "Tony")).toBe(true);
    expect(isOsControlPhrase("what's the weather", "Tony")).toBe(false);
  });
});

describe("resolveModel", () => {
  const models = ["qwen/qwen3-8b", "meta/llama-3.1-8b", "mistralai/mistral-7b"];
  it("matches a spoken model name with number words", () => {
    expect(resolveModel("qwen three eight b", models)).toBe("qwen/qwen3-8b");
  });
  it("matches a dotted version spoken as words", () => {
    expect(resolveModel("llama three one eight b", ["qwen/qwen3-8b", "meta/llama-3.1-8b"])).toBe("meta/llama-3.1-8b");
  });
  it("returns null when nothing is close enough", () => {
    expect(resolveModel("nonsense model xyz", models)).toBeNull();
  });
});
