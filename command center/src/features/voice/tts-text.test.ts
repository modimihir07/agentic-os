import { describe, expect, it } from "vitest";
import { looksLikeList, nextStreamChunk, sentences, stripForSpeech } from "./tts-text";

describe("stripForSpeech", () => {
  it("strips fenced code blocks and inline code", () => {
    expect(stripForSpeech("before ```const x = 1;``` after")).toBe("before after");
    expect(stripForSpeech("run `npm test` now")).toBe("run npm test now");
  });

  it("strips images and unwraps links to their text", () => {
    expect(stripForSpeech("see ![alt](pic.png) here")).toBe("see here");
    expect(stripForSpeech("read [the docs](https://example.com) first")).toBe("read the docs first");
  });

  it("strips headings and list markers", () => {
    expect(stripForSpeech("# Title\nSome text")).toBe("Title\nSome text");
    expect(stripForSpeech("- one\n- two\n1. three\n2) four")).toBe("one\ntwo\nthree\nfour");
  });

  it("unwraps bold, italic and strikethrough", () => {
    expect(stripForSpeech("this is **bold** and __also bold__")).toBe("this is bold and also bold");
    expect(stripForSpeech("this is *italic* and _also italic_")).toBe("this is italic and also italic");
    expect(stripForSpeech("~~gone~~")).toBe("gone");
  });

  it("removes emoji without touching ordinary punctuation", () => {
    expect(stripForSpeech("done! 🎉🔥 great job")).toBe("done! great job");
    expect(stripForSpeech("cost: $5.00 (a bargain)")).toBe("cost: $5.00 (a bargain)");
  });

  it("collapses runs of spaces/tabs but leaves newlines from list stripping alone", () => {
    expect(stripForSpeech("a   b\t\tc")).toBe("a b c");
  });
});

describe("sentences", () => {
  it("splits on sentence boundaries (each long enough not to merge with its neighbour)", () => {
    const s1 = `Alpha ${"word ".repeat(8)}end1.`; // well over 40 chars
    const s2 = `Bravo ${"word ".repeat(8)}end2.`;
    const s3 = `Charlie ${"word ".repeat(8)}end3.`;
    const out = sentences(`${s1} ${s2} ${s3}`);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(s1);
    expect(out[1]).toBe(s2);
    expect(out[2]).toBe(s3);
  });

  it("cascades short sentences together instead of leaving tiny chunks", () => {
    // Each sentence here is under 40 chars, so — matching the pre-existing merge
    // behaviour this function keeps — they all collapse into one chunk.
    expect(sentences("One. Two! Three?")).toEqual(["One. Two! Three?"]);
  });

  it("merges a short chunk forward with what follows instead of leaving it on its own", () => {
    const out = sentences("Ok. This is what happens next in the plan, in a bit more detail.");
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("Ok.");
    expect(out[0]).toContain("This is what happens next");
  });

  it("caps each chunk at maxChars and does not dump an unbounded tail into the last chunk", () => {
    // Seven sentences, each 300 chars — the old count-based cap (max=6) would have
    // merged everything from the 6th sentence onward into one unbounded chunk.
    const sentence = `${"word ".repeat(59)}end.`; // ~300 chars, one "sentence"
    const text = Array.from({ length: 7 }, () => sentence).join(" ");
    const out = sentences(text, 1800);
    for (const chunk of out) expect(chunk.length).toBeLessThanOrEqual(1800);
    // Nothing was dropped: every chunk's words sum back to the original.
    expect(out.join(" ").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
  });

  it("splits a single clause longer than maxChars on a word boundary", () => {
    const text = `${"word ".repeat(500)}end.`; // ~2500 chars, no sentence breaks until the end
    const out = sentences(text, 1800);
    expect(out.length).toBeGreaterThan(1);
    for (const chunk of out) expect(chunk.length).toBeLessThanOrEqual(1800);
  });

  it("strips markdown before splitting, so chunks never carry markup", () => {
    const out = sentences("**Step one.** Then *step two*.");
    expect(out.join(" ")).not.toMatch(/[*_]/);
  });

  it("keeps a bulleted reply as one chunk instead of one request per bullet", () => {
    // Each bullet ends in a period, which — without list detection — would each become
    // its own sentence chunk (the exact "fires per bullet" bug this guards against).
    const text = "Here's the casting summary:\n- John Smith confirmed for Saturday's callback.\n- Priya Shah still pending wardrobe fitting.\n- Marcus Lee dropped out, backup notified.";
    expect(sentences(text)).toHaveLength(1);
  });

  it("keeps a numbered list as one chunk too", () => {
    const text = "1. Scene one is locked in.\n2. Scene two needs a reshoot.\n3. Scene three is still pending approval.";
    expect(sentences(text)).toHaveLength(1);
  });

  it("does not treat a single incidental dash line as a list", () => {
    // Only one marked line — normal prose, not a list — keeps ordinary sentence splitting.
    const s1 = `Alpha ${"word ".repeat(8)}end1.`;
    const s2 = `- Bravo ${"word ".repeat(8)}end2.`;
    expect(sentences(`${s1}\n${s2}`)).toHaveLength(2);
  });

  it("still caps a very long list at maxChars without dropping content", () => {
    const line = (n: number) => `- Item number ${n} with some extra detail to pad it out.`;
    const text = Array.from({ length: 40 }, (_, i) => line(i)).join("\n");
    const out = sentences(text, 500);
    expect(out.length).toBeGreaterThan(1);
    for (const chunk of out) expect(chunk.length).toBeLessThanOrEqual(500);
    expect(out.join(" ").replace(/\s+/g, " ")).toBe(stripForSpeech(text).replace(/\s+/g, " "));
  });
});

describe("sentences list join", () => {
  it("ends unpunctuated list lines with a period so bullets don't run together", () => {
    expect(sentences("Groceries:\n- eggs\n- milk\n- bread")).toEqual(["Groceries: eggs. milk. bread."]);
  });

  it("leaves list lines that already end in punctuation alone", () => {
    expect(sentences("- Call Sam back?\n- Book the room;\n- **Done.**")).toEqual(["Call Sam back? Book the room; Done."]);
  });
});

describe("looksLikeList", () => {
  it("needs two or more marked lines making up at least half the lines", () => {
    expect(looksLikeList("- a\n- b")).toBe(true);
    expect(looksLikeList("Intro\n- a\n- b\nOutro")).toBe(true);
    expect(looksLikeList("- a\nplain\nplain\nplain")).toBe(false);
  });
});

describe("nextStreamChunk", () => {
  /** Feed `text` one character at a time, collecting chunks the way osRun does. */
  const stream = (text: string) => {
    const chunks: string[] = [];
    let buffered = "";
    let spokenUpTo = 0;
    for (const ch of text) {
      buffered += ch;
      const next = nextStreamChunk(buffered, spokenUpTo);
      if (next) {
        chunks.push(next.chunk);
        spokenUpTo = next.end;
      }
    }
    return { chunks, rest: text.slice(spokenUpTo).trim() };
  };

  const first = "Alright, here's where we stand today.";
  const long1 = "The callback is set for Saturday at noon sharp.";
  const long2 = "Wardrobe still needs Priya for one more fitting.";

  it("waits for a 20+ char clause before the first chunk, then 40+ char sentences", () => {
    expect(nextStreamChunk("Sure, ", 0)).toBeNull();
    expect(nextStreamChunk("Okay, let me look into that for you. ", 0)).toEqual({ chunk: "Okay, let me look into that for you.", end: 36 });
    expect(nextStreamChunk(`${first} Short one. `, first.length)).toBeNull();
  });

  it("does not stall behind a short sentence: it is absorbed into the next long one", () => {
    const { chunks, rest } = stream(`${first} Got it. ${long1} ${long2} Done`);
    expect(chunks).toEqual([first, `Got it. ${long1}`, long2]);
    expect(rest).toBe("Done");
  });

  it("does not count leading whitespace toward a chunk's minimum length", () => {
    const { chunks } = stream(`${first}\n\n${" ".repeat(30)}Got it. ${long1} `);
    expect(chunks).toEqual([first, `Got it. ${long1}`]);
  });

  it("stops chunking once a list line streams in, leaving the list to one end-of-stream call", () => {
    const intro = "Here is the casting summary for this week in order.";
    const list = "\n- John Smith confirmed for Saturday's callback at noon.\n- Priya Shah still pending her wardrobe fitting today.\n- Marcus Lee dropped out, backup notified.";
    const { chunks, rest } = stream(`${intro}${list} Anything else?`);
    expect(chunks).toEqual([intro]);
    expect(sentences(rest)).toHaveLength(1);
  });

  it("never chunks a reply that opens with a list", () => {
    const { chunks } = stream("1. Scene one is locked in, the crew is booked.\n2. Scene two needs a reshoot next week, sadly.\n");
    expect(chunks).toEqual([]);
  });

  it("does not mistake a mid-line number for a list line", () => {
    expect(nextStreamChunk("We moved it to 3. That works for everyone involved, right? ", 0)).not.toBeNull();
  });
});
