import { describe, expect, it } from "vitest";
import { parseReflex } from "./reflex-parse";

const BUSY = { busy: true, holding: false };
const IDLE = { busy: false, holding: false };
const HOLDING = { busy: false, holding: true };

describe("parseReflex — required fixtures (said in a row, live)", () => {
  for (const said of ["Take it ease.", "Take it easy", "take it eas", "eh", "aye", "whoa", "oh", "madone", "aspetta", "Aspet", "aspett"]) {
    it(`"${said}" is a hold while busy`, () => {
      expect(parseReflex(said, BUSY)).toEqual({ kind: "hold", rest: "" });
    });
  }
});

describe("parseReflex — negatives", () => {
  it('"oh and add milk" (busy) is a normal command', () => expect(parseReflex("oh and add milk", BUSY)).toBeNull());
  it('"oh" (idle) is nothing', () => expect(parseReflex("oh", IDLE)).toBeNull());
  it('"go ahead and email Sam" (not holding) is a normal command', () => expect(parseReflex("go ahead and email Sam", BUSY)).toBeNull());
  it('"take it easy on the bass" (busy) holds with the rest as the first segment', () => {
    expect(parseReflex("take it easy on the bass", BUSY)).toEqual({ kind: "hold", rest: "on the bass" });
  });
  it("idle questions starting with oh stay commands", () => expect(parseReflex("oh what's the weather", IDLE)).toBeNull());
  it("ordinary lines are not reflexes", () => {
    for (const s of ["what's the weather", "play Bilmuri on Spotify", "continue the music", "keep going", "send it to Sam"]) expect(parseReflex(s, IDLE)).toBeNull();
  });
  it("hey kitties is never a prefix", () => expect(parseReflex("hey kitties are cute", BUSY)).toBeNull());
});

describe("parseReflex — cut", () => {
  for (const s of ["Cut it.", "cut it out", "Cut that!", "cutit", "Yo Tony, cut it.", "Tony cut it", "stop talking", "stop, stop", "hey tony cut it", "okay cut it now"]) {
    it(`"${s}" cuts in every state`, () => {
      for (const ctx of [IDLE, BUSY, HOLDING, { busy: true, holding: false, ttsAudible: true }]) expect(parseReflex(s, ctx)?.kind).toBe("cut");
    });
  }
  it("a long line that starts with a cut phrase still cuts", () => {
    expect(parseReflex("cut it, I want to ask something else entirely", BUSY)).toEqual({ kind: "cut", rest: "I want to ask something else entirely" });
  });
  it("a long line with cut it in the middle is a command", () => {
    expect(parseReflex("tell the coder to cut it down to three paragraphs", BUSY)).toBeNull();
  });
});

describe("parseReflex — bare hard stops (whole utterance only)", () => {
  for (const s of ["Stop.", "stop it", "Shut it off!", "shut it down", "Tony, stop please", "hey Tony stop", "stop it now", "okay shut it off then"]) {
    it(`"${s}" cuts in every state, flagged as needing the wake word in a room listen`, () => {
      for (const ctx of [IDLE, BUSY, HOLDING, { busy: true, holding: false, ttsAudible: true, musicAudible: true }]) {
        expect(parseReflex(s, ctx)).toEqual({ kind: "cut", rest: "", needsAddress: true });
      }
    });
  }
  for (const s of ["don't stop the music", "stop at the store", "stop playing Bilmuri", "shut it off at 11", "stop the timer", "shut it down after this song", "stop it from raining"]) {
    it(`"${s}" is not a cut (falls through to the normal grammars)`, () => {
      for (const ctx of [IDLE, BUSY]) expect(parseReflex(s, ctx)).toBeNull();
    });
  }
  it("the classic cut phrases carry no wake-word requirement", () => {
    expect(parseReflex("cut it", IDLE)).toEqual({ kind: "cut", rest: "" });
    expect(parseReflex("stop talking", IDLE)?.needsAddress).toBeUndefined();
  });
  it("hey kitties stays a hold", () => expect(parseReflex("hey kitties", BUSY)).toEqual({ kind: "hold", rest: "" }));
});

describe("parseReflex — hold", () => {
  for (const s of ["take it ees", "take it knees", "take at ease", "take it is", "madonna", "ma donna", "my donna", "mad one", "a spetta", "ah spet", "Madone!", "Aspetta, aspetta"]) {
    it(`"${s}" holds even when idle (thought-form lock)`, () => expect(parseReflex(s, IDLE)?.kind).toBe("hold"));
  }
  it("hey kitties (Whisper's take it ease) holds standalone", () => expect(parseReflex("Hey kitties.", BUSY)).toEqual({ kind: "hold", rest: "" }));
  it("thought-form lock keeps the rest as the first segment", () => {
    expect(parseReflex("Take it ease, I'm thinking about the tour dates.", IDLE)).toEqual({ kind: "hold", rest: "I'm thinking about the tour dates." });
  });
  it("address words before a hold are skipped", () => expect(parseReflex("Hey Tony, take it easy", BUSY)).toEqual({ kind: "hold", rest: "" }));
  it("single syllables repeat", () => {
    expect(parseReflex("whoa whoa", BUSY)?.kind).toBe("hold");
    expect(parseReflex("Woah.", BUSY)?.kind).toBe("hold");
    expect(parseReflex("Ay, ay.", BUSY)?.kind).toBe("hold");
  });
  it("single syllables count while holding", () => expect(parseReflex("eh", HOLDING)?.kind).toBe("hold"));
  it("speakers mode: single syllables ignored while TTS is audible", () => {
    expect(parseReflex("oh", { busy: true, holding: false, ttsAudible: true })).toBeNull();
    expect(parseReflex("whoa", { busy: true, holding: false, ttsAudible: true })).toBeNull();
  });
  it("speakers mode: multi-word holds and cuts still count while audible", () => {
    const loud = { busy: true, holding: false, ttsAudible: true };
    expect(parseReflex("take it ease", loud)?.kind).toBe("hold");
    expect(parseReflex("aspetta", loud)?.kind).toBe("hold");
    expect(parseReflex("cut it", loud)?.kind).toBe("cut");
  });
  it("speakers mode: single syllables ignored while Spotify is audible (a lyric's oh)", () => {
    const music = { busy: true, holding: false, musicAudible: true };
    expect(parseReflex("oh", music)).toBeNull();
    expect(parseReflex("eh eh", { busy: false, holding: true, musicAudible: true })).toBeNull();
    expect(parseReflex("take it ease", music)?.kind).toBe("hold");
    expect(parseReflex("cut it", music)?.kind).toBe("cut");
  });
  it("speakers mode: single syllables count while only thinking (not audible)", () => {
    expect(parseReflex("oh", { busy: true, holding: false, ttsAudible: false })?.kind).toBe("hold");
  });
});

describe("parseReflex — resume / submit (holding only)", () => {
  for (const s of ["keep going", "Go on.", "continue", "carry on", "where were you", "you were saying", "okay keep going please"]) {
    it(`"${s}" resumes while holding`, () => {
      expect(parseReflex(s, HOLDING)).toEqual({ kind: "resume", rest: "" });
      expect(parseReflex(s, BUSY)).toBeNull();
    });
  }
  for (const s of ["go ahead", "Run that.", "over to you", "That's it.", "thats it", "send it"]) {
    it(`"${s}" submits while holding`, () => {
      expect(parseReflex(s, HOLDING)).toEqual({ kind: "submit", rest: "" });
      expect(parseReflex(s, IDLE)).toBeNull();
    });
  }
  it("submit with a trailing thought keeps it", () => {
    expect(parseReflex("go ahead and email Sam", HOLDING)).toEqual({ kind: "submit", rest: "email Sam" });
  });
  it("a held segment that merely mentions continuing is not a resume", () => {
    expect(parseReflex("continue with the second verse idea", HOLDING)).toBeNull();
  });
});
