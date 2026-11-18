import { describe, expect, it } from "vitest";
import { commandText, hasOnVerb, isOsControlPhrase, parseOsIntent, playTarget, resolveModel, type OsIntent } from "./os-intent-parse";

const parse = (t: string, cueActive = true) => parseOsIntent(t, { osName: "Tony", cueActive, cuePlaying: cueActive });

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

  it.each(["turn off", "stop it", "stop", "hold on, stop", "Hold on. Stop.", "wait wait stop", "no no stop", "dude stop", "stop stop", "make it stop", "turn of", "mute it"])(
    "bare \"%s\" is gabagool-off (non-explicit) only while a cue is active",
    (text) => {
      expect(parse(text, true)).toEqual({ kind: "gabagool-off", explicit: false });
      expect(parse(text, false)).toBeNull();
    },
  );

  it.each(["kill the music", "stop the music", "pause the song", "turn the music off"])(
    "\"%s\" stops an active cue, otherwise pauses Spotify",
    (text) => {
      expect(parse(text, true)).toEqual({ kind: "gabagool-off", explicit: false });
      expect(parse(text, false)).toEqual({ kind: "media", action: "pause" });
    },
  );

  it.each(["turn the gabagool theme off", "turn of gabagool", "mute gabagool", "pause gabagool", "silence the gabagool", "get rid of gabagool", "drop gabagool mode", "switch gabagool mode off"])(
    "%s → explicit gabagool-off, even with no cue active",
    (text) => {
      expect(parse(text, false)).toEqual({ kind: "gabagool-off", explicit: true });
    },
  );

  it("a bare 'turn off' with no cue active and no other match is null", () => {
    expect(parse("turn off", false)).toBeNull();
  });

  it("'turn gabagool off, shut it down' stays a stop, not a volume change", () => {
    expect(parse("turn gabagool off, shut it down", false)).toEqual({ kind: "gabagool-off", explicit: true });
  });
});

describe("parseOsIntent — cue volume", () => {
  const opts = (cuePlaying: boolean) => ({ osName: "Tony", cueActive: cuePlaying, cuePlaying });

  it.each<[string, number]>([
    ["make the gabagool music louder", 1],
    ["Can you make the Gaba Goo music louder?", 1],
    ["turn the gabagool theme up", 1],
    ["crank the gabagool", 2],
    ["make the theme a lot louder", 2],
    ["turn the gabagool down", -1],
    ["gabagool quieter", -1],
    ["lower the theme", -1],
  ])("%s → explicit cue-volume %i, whether or not a cue plays", (text, steps) => {
    expect(parseOsIntent(text, opts(false))).toEqual({ kind: "cue-volume", steps, explicit: true });
    expect(parseOsIntent(text, opts(true))).toEqual({ kind: "cue-volume", steps, explicit: true });
  });

  it("a long ramble naming the theme still counts (checked before the 12-word cap)", () => {
    expect(parseOsIntent("I don't know, can you make- I want to hear the Gaba Gu music a little louder", opts(false))).toEqual({
      kind: "cue-volume",
      steps: 1,
      explicit: true,
    });
  });

  it.each<[string, number]>([
    ["louder", 1],
    ["turn it up", 1],
    ["crank it", 2],
    ["make the music a little louder", 1],
    ["volume up", 1],
    ["quieter", -1],
    ["turn it down a notch", -1],
    ["bring it down", -1],
    ["softer please", -1],
  ])("bare %s → the playing cue's theme, else Spotify ±15 per step", (text, steps) => {
    expect(parseOsIntent(text, opts(true))).toEqual({ kind: "cue-volume", steps, explicit: false });
    expect(parseOsIntent(text, opts(false))).toEqual({ kind: "media", action: "volume", delta: 15 * steps });
  });

  it.each(["lower the price", "increase my budget", "turn the lights down", "raise a ticket"])("%s is not a volume command", (text) => {
    expect(parseOsIntent(text, opts(true))).toBeNull();
    expect(parseOsIntent(text, opts(false))).toBeNull();
  });

  it("naming Spotify wins over a playing cue", () => {
    expect(parseOsIntent("turn spotify up", opts(true))).toEqual({ kind: "media", action: "volume", delta: 15 });
  });
});

describe("parseOsIntent — Spotify media", () => {
  const media = (text: string, cuePlaying = false) => parseOsIntent(text, { osName: "Tony", cueActive: cuePlaying, cuePlaying });

  it.each<[string, OsIntent]>([
    ["play bohemian rhapsody on spotify", { kind: "media", action: "play", query: "bohemian rhapsody", searchKind: "track" }],
    ["play bohemian rhapsody by queen", { kind: "media", action: "play", query: "bohemian rhapsody queen", searchKind: "track" }],
    ["can you play some jazz", { kind: "media", action: "play", query: "jazz", searchKind: "playlist" }],
    ["play songs by Radiohead", { kind: "media", action: "play", query: "radiohead", searchKind: "artist" }],
    ["play the album OK Computer", { kind: "media", action: "play", query: "ok computer", searchKind: "album" }],
    ["play my chill playlist", { kind: "media", action: "play", query: "chill", searchKind: "playlist" }],
    ["play music", { kind: "media", action: "resume" }],
    ["pause the music", { kind: "media", action: "pause" }],
    ["pause spotify", { kind: "media", action: "pause" }],
    ["pause", { kind: "media", action: "pause" }],
    ["resume", { kind: "media", action: "resume" }],
    ["resume the music", { kind: "media", action: "resume" }],
    ["skip this song", { kind: "media", action: "next" }],
    ["next track", { kind: "media", action: "next" }],
    ["play the next song", { kind: "media", action: "next" }],
    ["previous track", { kind: "media", action: "previous" }],
    ["go back a song", { kind: "media", action: "previous" }],
    ["what's playing", { kind: "media", action: "now" }],
    ["what song is this", { kind: "media", action: "now" }],
    ["spotify volume 40", { kind: "media", action: "volume", value: 40 }],
    ["set spotify to 30%", { kind: "media", action: "volume", value: 30 }],
    ["set the volume to fifty", { kind: "media", action: "volume", value: 50 }],
    ["turn the volume up to 70", { kind: "media", action: "volume", value: 70 }],
  ])("%s", (text, expected) => {
    expect(media(text)).toEqual(expected);
  });

  it.each(["play devil's advocate", "play a game with me", "play it again", "play the latest video on youtube", "play along with this idea for a second", "next", "what's on", "continue"])(
    "%s is not a Spotify command",
    (text) => {
      expect(media(text)).toBeNull();
    },
  );

  it("a bare 'play …' over 8 words is left to the planner; 'on spotify' isn't", () => {
    expect(media("play the song that was on the radio this morning in the car")).toBeNull();
    expect(media("play the song that goes la la la on spotify")).toMatchObject({ kind: "media", action: "play" });
  });

  it("precedence: a playing cue owns bare 'volume 30' and stops; Spotify keeps explicit commands", () => {
    expect(media("set the volume to 30", true)).toBeNull();
    expect(media("spotify volume 30", true)).toEqual({ kind: "media", action: "volume", value: 30 });
    expect(media("pause", true)).toEqual({ kind: "gabagool-off", explicit: false });
    expect(media("pause spotify", true)).toEqual({ kind: "media", action: "pause" });
  });

  it("a line naming Gabagool never becomes a Spotify search", () => {
    expect(media("play gabagool")).toEqual({ kind: "gabagool-on" });
    expect(media("play the gabagool theme on spotify")).toEqual({ kind: "gabagool-on" });
  });
});

describe("hasOnVerb", () => {
  it("only true for an ON verb", () => {
    expect(hasOnVerb("enter gabagool mode")).toBe(true);
    expect(hasOnVerb("play gabagool")).toBe(true);
    expect(hasOnVerb("make the gabagool music louder")).toBe(false);
    expect(hasOnVerb("gabagool is great")).toBe(false);
  });
});

describe("playTarget", () => {
  it("drops 'by' from track and album queries", () => {
    expect(playTarget("yesterday by the beatles")).toEqual({ query: "yesterday the beatles", searchKind: "track" });
    expect(playTarget("the song called creep")).toEqual({ query: "creep", searchKind: "track" });
    expect(playTarget("abbey road album")).toEqual({ query: "abbey road", searchKind: "album" });
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

  it("Spotify controls are OS-control phrases (never a mutating gateway plan)", () => {
    expect(isOsControlPhrase("set the volume to 30", "Tony")).toBe(true);
    expect(isOsControlPhrase("pause music", "Tony")).toBe(true);
    expect(isOsControlPhrase("turn it up", "Tony")).toBe(true);
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

describe("cue vs Spotify precedence after review", () => {
  const p = (t: string, cueActive: boolean, cuePlaying: boolean) => parseOsIntent(t, { osName: "Tony", cueActive, cuePlaying });

  it("music-naming and pause/mute stops go to Spotify once the theme has stopped", () => {
    for (const t of ["pause the music", "pause music", "pause", "stop the music", "turn off the music"]) {
      expect(p(t, true, false)).toMatchObject({ kind: "media", action: "pause" });
    }
  });

  it("the same stops still end a playing theme", () => {
    for (const t of ["pause the music", "stop the music", "pause", "mute"]) {
      expect(p(t, true, true)).toEqual({ kind: "gabagool-off", explicit: false });
    }
  });

  it("a bare 'stop' in the recent-cue window still ends the cue (intro TTS)", () => {
    expect(p("stop", true, false)).toEqual({ kind: "gabagool-off", explicit: false });
  });

  it("'theme'/'spotify' inside a longer request are not volume commands", () => {
    expect(p("tell the designer to lower the contrast on the dark theme", false, false)).toBeNull();
    expect(p("raise a ticket about the theme switcher", false, false)).toBeNull();
    expect(p("tell the coder to reduce spotify api calls", false, false)).toBeNull();
    expect(p("ask the coder to increase the spotify widget poll interval to ten seconds because it is too chatty", false, false)).toBeNull();
  });

  it("bare targeted volume commands still work", () => {
    expect(p("lower the theme", true, true)).toEqual({ kind: "cue-volume", steps: -1, explicit: true });
    expect(p("turn the spotify volume up please", false, false)).toEqual({ kind: "media", action: "volume", delta: 15 });
    expect(p("I want to hear the gabagool music a little louder right now please Tony ok", true, true)).toMatchObject({ kind: "cue-volume", steps: 1 });
  });
});

describe("gabagool up/on keep their verb", () => {
  const p = (t: string) => parseOsIntent(t, { osName: "Tony", cueActive: true, cuePlaying: true });
  it.each(["turn gabagool up", "Tony, turn the gabagool up a bit", "gabagool up", "pump the gabagool up"])("%s → cue-volume +1", (t) =>
    expect(p(t)).toEqual({ kind: "cue-volume", steps: 1, explicit: true }),
  );
  it("turn gabagool on → gabagool-on", () => expect(parseOsIntent("turn gabagool on", { osName: "Tony" })).toEqual({ kind: "gabagool-on" }));
});

describe("round-3 phrase fixes", () => {
  const p = (t: string, playing = false) => parseOsIntent(t, { osName: "Tony", cueActive: playing, cuePlaying: playing });

  it("anchored gabagool up/down never swallow ON or exit verbs", () => {
    expect(p("start gabagool up")).toEqual({ kind: "gabagool-on" });
    expect(p("shut the gabagool down", true)).toEqual({ kind: "gabagool-off", explicit: true });
    expect(p("power gabagool down", true)).toEqual({ kind: "gabagool-off", explicit: true });
    expect(p("gabagool music down", true)).toEqual({ kind: "cue-volume", steps: -1, explicit: true });
  });

  it("'my' and 'stop playing' music stops pause Spotify (or stop a playing theme)", () => {
    for (const t of ["Pause my music.", "Turn off my music.", "Stop playing music.", "Turn off Spotify."]) {
      expect(p(t)).toMatchObject({ kind: "media", action: "pause" });
    }
    expect(p("Pause my music.", true)).toEqual({ kind: "gabagool-off", explicit: false });
  });

  it("a trailing ', Tony.' doesn't defeat a command", () => {
    expect(p("Turn it up, Tony.", true)).toEqual({ kind: "cue-volume", steps: 1, explicit: false });
    expect(p("Pause the music, Tony.")).toMatchObject({ kind: "media", action: "pause" });
    expect(p("Play Daft Punk on Spotify, Tony.")).toMatchObject({ kind: "media", action: "play", query: "daft punk" });
  });

  it("but 'Tony' as the object of a switch is kept", () => {
    expect(p("switch to Tony")).toMatchObject({ kind: "workspace" });
    expect(p("talk to tony")).toMatchObject({ kind: "workspace" });
  });
});

describe("round-4: the name as an object is never stripped", () => {
  const p = (t: string) => parseOsIntent(t, { osName: "Tony" });
  it.each(["Show Tony.", "Open up Tony.", "open tony", "take me to tony"])("%s switches to Tony's tab", (t) =>
    expect(p(t)).toMatchObject({ kind: "workspace", thread: "general" }),
  );
  it("play something by Tony keeps the credit", () => {
    const r = p("play something by Tony on spotify");
    expect(r).toMatchObject({ kind: "media", action: "play" });
    expect(JSON.stringify(r)).toMatch(/tony/);
  });
});
