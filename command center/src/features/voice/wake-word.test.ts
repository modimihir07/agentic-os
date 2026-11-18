import { describe, expect, it } from "vitest";
import { wakeCommand } from "./wake-word";

const WORDS = ["hey tony", "yo tony", "tony"];

describe("wakeCommand", () => {
  it.each<[string, string]>([
    ["hey tony what's the time", "what's the time"],
    ["Hey, Tony, turn off gabagool mode.", "turn off gabagool mode."],
    ["Tony, pause the music", "pause the music"],
    ["  ...Yo Tony! louder", "louder"],
    ["hey  tony", ""],
  ])("%s → %s", (text, expected) => {
    expect(wakeCommand(text, WORDS)).toBe(expected);
  });

  it("returns null without a wake word, or for a word that only starts like one", () => {
    expect(wakeCommand("turn it up", WORDS)).toBeNull();
    expect(wakeCommand("Tonya called", WORDS)).toBeNull();
    expect(wakeCommand("hey there tony", ["hey tony"])).toBeNull();
  });

  it("the longest wake word wins", () => {
    expect(wakeCommand("hey tony stop", ["tony", "hey tony"])).toBe("stop");
  });

  it("never treats a gabagool-like word as a wake word", () => {
    expect(wakeCommand("gaba gu mode off", [...WORDS, "gaba gu"])).toBeNull();
    expect(wakeCommand("gabagool louder", ["gabagool"])).toBeNull();
    expect(wakeCommand("Tony, gaba gu mode off", [...WORDS, "gaba gu"])).toBe("gaba gu mode off");
  });
});
