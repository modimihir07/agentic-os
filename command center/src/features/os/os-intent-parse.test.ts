import { describe, expect, it } from "vitest";
import { commandText, hasOnVerb, isOsControlPhrase, parseDevTask, parseOsIntent, resolveModel, type OsIntent } from "./os-intent-parse";

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
    "\"%s\" stops an active cue, otherwise is left to Spotify's Rust grammar",
    (text) => {
      expect(parse(text, true)).toEqual({ kind: "gabagool-off", explicit: false });
      expect(parse(text, false)).toBeNull();
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
  ])("bare %s → the playing cue's theme, else null (Spotify's, parsed in Rust)", (text, steps) => {
    expect(parseOsIntent(text, opts(true))).toEqual({ kind: "cue-volume", steps, explicit: false });
    expect(parseOsIntent(text, opts(false))).toBeNull();
  });

  it.each(["lower the price", "increase my budget", "turn the lights down", "raise a ticket"])("%s is not a volume command", (text) => {
    expect(parseOsIntent(text, opts(true))).toBeNull();
    expect(parseOsIntent(text, opts(false))).toBeNull();
  });

  it("naming Spotify wins over a playing cue (left to Rust, never cue-volume)", () => {
    expect(parseOsIntent("turn spotify up", opts(true))).toBeNull();
  });
});

describe("parseOsIntent — Spotify lines are Rust's", () => {
  const p = (text: string, cueActive = false, cuePlaying = false) => parseOsIntent(text, { osName: "Tony", cueActive, cuePlaying });

  it.each([
    "play bilmuri",
    "play bohemian rhapsody on spotify",
    "can you play some jazz",
    "pause the music",
    "pause spotify",
    "pause",
    "resume",
    "skip this song",
    "next track",
    "go back a song",
    "turn it up",
    "louder",
    "what's playing",
    "what song is this",
    "spotify volume 40",
    "set the volume to fifty",
    "aye tony can you play some bilmuri",
    "Aye, Tony, play Bilmuri on Spotify.",
  ])("returns null for Spotify lines so Rust parses them: %s", (text) => {
    expect(p(text)).toBeNull();
  });

  it("keeps cue precedence for bare music words", () => {
    // A playing cue owns relative volume and stops.
    expect(p("louder", true, true)).toEqual({ kind: "cue-volume", steps: 1, explicit: false });
    expect(p("pause", true, true)).toEqual({ kind: "gabagool-off", explicit: false });
    // A cue fired recently (active) but not playing: a bare "stop" still ends it…
    expect(p("stop", true, false)).toEqual({ kind: "gabagool-off", explicit: false });
    // …but music-naming / pause stops are Spotify's.
    expect(p("pause the music", true, false)).toBeNull();
    // Naming Spotify always leaves the line to Spotify, cue or not.
    expect(p("pause spotify", true, true)).toBeNull();
    expect(p("spotify volume 30", true, true)).toBeNull();
  });

  it("a line naming Gabagool never becomes a Spotify line", () => {
    expect(p("play gabagool")).toEqual({ kind: "gabagool-on" });
    expect(p("play the gabagool theme on spotify")).toEqual({ kind: "gabagool-on" });
  });

  it("strips 'aye' / 'ayy' / 'yo' + the wake name, and keeps credits", () => {
    expect(commandText("oi Tony, yeah, play jazz")).toBe("play jazz");
    expect(commandText("play something by tony")).toBe("play something by tony");
    expect(commandText("ayesha said hi")).toBe("ayesha said hi");
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

  it("Spotify controls are no longer OS-control phrases (plan.ts isPlayback keeps them non-mutating)", () => {
    expect(isOsControlPhrase("set the volume to 30", "Tony")).toBe(false);
    expect(isOsControlPhrase("play bilmuri", "Tony")).toBe(false);
    // Bare stops still are (a cue may own them).
    expect(isOsControlPhrase("stop it", "Tony")).toBe(true);
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

  it("music-naming and pause/mute stops go to Spotify (null here) once the theme has stopped", () => {
    for (const t of ["pause the music", "pause music", "pause", "stop the music", "turn off the music"]) {
      expect(p(t, true, false)).toBeNull();
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
    expect(p("turn the spotify volume up please", false, false)).toBeNull(); // Spotify's: Rust parses it
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

  it("'my' and 'stop playing' music stops are Spotify's (null here) or stop a playing theme", () => {
    for (const t of ["Pause my music.", "Turn off my music.", "Stop playing music.", "Turn off Spotify."]) {
      expect(p(t)).toBeNull();
    }
    expect(p("Pause my music.", true)).toEqual({ kind: "gabagool-off", explicit: false });
  });

  it("a trailing ', Tony.' doesn't defeat a command", () => {
    expect(p("Turn it up, Tony.", true)).toEqual({ kind: "cue-volume", steps: 1, explicit: false });
    expect(p("Pause the music, Tony.", true)).toEqual({ kind: "gabagool-off", explicit: false });
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
  it("play something by Tony keeps the credit (and is Spotify's line, not ours)", () => {
    expect(commandText("play something by Tony on spotify")).toMatch(/by tony on spotify$/);
    expect(p("play something by Tony on spotify")).toBeNull();
  });
});

describe("parseOsIntent — dev task queue (System Map)", () => {
  it.each<[string, OsIntent]>([
    ["log a dev note the router drops Spotify lines", { kind: "dev-task", taskKind: "note", title: "The router drops Spotify lines" }],
    ["Hey Tony, log a dev note: Whisper takes 2s on short lines.", { kind: "dev-task", taskKind: "note", title: "Whisper takes 2s on short lines" }],
    ["Tony add a dev note that the bus card is stale", { kind: "dev-task", taskKind: "note", title: "The bus card is stale" }],
    ["can you make a developer note about the HUD flicker please", { kind: "dev-task", taskKind: "note", title: "The HUD flicker" }],
    ["Dev note: TTS batching splits mid-word", { kind: "dev-task", taskKind: "note", title: "TTS batching splits mid-word" }],
    ["queue a fix for the GitHub 401 on every turn", { kind: "dev-task", taskKind: "fix", title: "The GitHub 401 on every turn" }],
    ["Okay, queue up a fix for Gmail auth", { kind: "dev-task", taskKind: "fix", title: "Gmail auth" }],
    ["add to the dev queue: wire the blueprint toggle", { kind: "dev-task", taskKind: "task", title: "Wire the blueprint toggle" }],
    ["add the Spotify reconnect button to the dev queue", { kind: "dev-task", taskKind: "task", title: "The Spotify reconnect button" }],
    // Whisper's sentence punctuation after a pause.
    ["Log a dev note. The mic stays open after Gabagool.", { kind: "dev-task", taskKind: "note", title: "The mic stays open after Gabagool" }],
    ["Hey, Tony. Log a dev note. Whisper is slow.", { kind: "dev-task", taskKind: "note", title: "Whisper is slow" }],
    ["Queue a fix. The HUD flickers.", { kind: "dev-task", taskKind: "fix", title: "The HUD flickers" }],
    ["Log a dev note; the HUD flickers", { kind: "dev-task", taskKind: "note", title: "The HUD flickers" }],
    ["Log a dev note... the HUD flickers", { kind: "dev-task", taskKind: "note", title: "The HUD flickers" }],
    ["Log a dev-note: the HUD flickers", { kind: "dev-task", taskKind: "note", title: "The HUD flickers" }],
  ])("%s", (text, expected) => {
    expect(parse(text)).toEqual(expected);
  });

  it("keeps the user's casing and a long dictated note (past the 12-word gate)", () => {
    const long = "log a dev note when I say stop during a Spotify track the cue duck stays on and Kokoro sounds muffled for the next three replies";
    const r = parse(long);
    expect(r).toMatchObject({ kind: "dev-task", taskKind: "note" });
    expect(r && r.kind === "dev-task" && r.title).toMatch(/^When I say stop during a Spotify track/);
  });

  it.each([
    "log a dev note",
    "queue a fix",
    "add to the dev queue",
    "tell the coder to queue a fix for the router",
    "what's in the dev queue",
    "how many dev notes do I have",
    "ask the librarian to log a dev note about memory",
    "add milk to the shopping list",
    "queue the next song",
    "log my workout",
    "note that the meeting moved",
    "take a note: buy eggs",
    "log a dev note.",
    // Requests that mention a dev note but ask for something else.
    "write a developer note in the README about the setup",
    "create a dev note template for the coder",
    "add a dev note section to the docs",
    "make a dev note app",
    "record a dev note about this conversation and email it to Sam",
    // A pronoun alone has nothing to log.
    "add this to the dev queue",
    "add that to the dev queue.",
    "add it to the dev queue",
  ])("does not hijack \"%s\"", (text) => {
    expect(parse(text)?.kind === "dev-task").toBe(false);
  });

  it("is an OS-control phrase, so the planner never treats it as a mutating plan", () => {
    expect(isOsControlPhrase("queue a fix for the stale bus card")).toBe(true);
  });

  it("parseDevTask honours a custom OS name", () => {
    expect(parseDevTask("Jeeves, log a dev note: rename me", "Jeeves")).toEqual({ taskKind: "note", title: "Rename me" });
  });

  it("parseDevTask accepts every interjection commandText does", () => {
    expect(parseDevTask("Aye Tony, log a dev note: the HUD flickers")).toEqual({ taskKind: "note", title: "The HUD flickers" });
    expect(parseDevTask("Hi Tony, queue a fix for the mic")?.taskKind).toBe("fix");
    for (const lead of ["Ayo", "Oi", "Ayy", "Ay"]) expect(parseDevTask(`${lead} Tony, log a dev note: the HUD flickers`)?.title).toBe("The HUD flickers");
    expect(parseDevTask("Yeah, log a dev note: the HUD flickers")?.title).toBe("The HUD flickers");
  });
});
