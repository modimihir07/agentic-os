import { describe, expect, it, vi } from "vitest";
import { FallbackTts } from "./tts-fallback";
import type { SpeakOpts, TtsEngine } from "./tts-types";

/** A fake engine whose `speak` can be scripted to fail N times before succeeding
 * (or fail forever), so the fallback/retry behaviour can be observed directly. */
function fakeEngine(name: string, opts: { supported?: boolean; failTimes?: number } = {}): TtsEngine & { calls: (string | undefined)[][] } {
  let failuresLeft = opts.failTimes ?? 0;
  const calls: (string | undefined)[][] = [];
  return {
    name,
    supported: opts.supported ?? true,
    calls,
    async speak(text: string, o?: SpeakOpts) {
      calls.push([text, o?.voice, o?.agent]);
      if (failuresLeft > 0) {
        failuresLeft--;
        throw new Error(`${name} down`);
      }
    },
    prefetch: vi.fn(),
    cancel: vi.fn(),
  };
}

describe("FallbackTts", () => {
  it("speaks with the primary when it succeeds", async () => {
    const primary = fakeEngine("primary");
    const backup = fakeEngine("backup");
    const tts = new FallbackTts(primary, backup);
    await tts.speak("hello", { agent: "general" });
    expect(primary.calls).toEqual([["hello", undefined, "general"]]);
    expect(backup.calls).toHaveLength(0);
    expect(tts.name).toBe("primary");
  });

  it("falls back to the backup for one failed call without switching permanently", async () => {
    const primary = fakeEngine("primary", { failTimes: 1 });
    const backup = fakeEngine("backup");
    const tts = new FallbackTts(primary, backup);

    await tts.speak("first"); // primary fails once → backup speaks this one
    expect(backup.calls).toHaveLength(1);
    expect(tts.name).toBe("primary"); // never permanently switched

    await tts.speak("second"); // primary is back up — no more scripted failures
    expect(primary.calls.map((c) => c[0])).toEqual(["first", "second"]);
    expect(backup.calls).toHaveLength(1); // backup wasn't touched again
  });

  it("retries the primary without an explicit voice before falling back", async () => {
    const primary: TtsEngine & { calls: (string | undefined)[][] } = fakeEngine("primary");
    let first = true;
    primary.speak = vi.fn(async (text: string, o?: SpeakOpts) => {
      primary.calls.push([text, o?.voice, o?.agent]);
      if (first && o?.voice) {
        first = false;
        throw new Error("voice unavailable on this engine");
      }
    });
    const backup = fakeEngine("backup");
    const tts = new FallbackTts(primary, backup);
    await tts.speak("hi", { voice: "some-cue-voice" });
    // Tried once with the voice (failed), retried on the primary without it (succeeded).
    expect(primary.calls).toEqual([
      ["hi", "some-cue-voice", undefined],
      ["hi", undefined, undefined],
    ]);
    expect(backup.calls).toHaveLength(0);
  });

  it("uses the backup directly when the primary is unsupported", async () => {
    const primary = fakeEngine("primary", { supported: false });
    const backup = fakeEngine("backup");
    const tts = new FallbackTts(primary, backup);
    expect(tts.name).toBe("backup");
    await tts.speak("hello");
    expect(primary.calls).toHaveLength(0);
    expect(backup.calls).toHaveLength(1);
  });

  it("prefetch is a no-op once the primary is unsupported, and forwards opts otherwise", () => {
    const primary = fakeEngine("primary");
    const backup = fakeEngine("backup");
    const tts = new FallbackTts(primary, backup);
    tts.prefetch("x", { agent: "booking" });
    expect(primary.prefetch).toHaveBeenCalledWith("x", { agent: "booking" });

    const offline = fakeEngine("primary", { supported: false });
    const tts2 = new FallbackTts(offline, backup);
    tts2.prefetch("x");
    expect(offline.prefetch).not.toHaveBeenCalled();
  });

  it("cancel always cancels both engines", () => {
    const primary = fakeEngine("primary");
    const backup = fakeEngine("backup");
    const tts = new FallbackTts(primary, backup);
    tts.cancel();
    expect(primary.cancel).toHaveBeenCalledTimes(1);
    expect(backup.cancel).toHaveBeenCalledTimes(1);
  });
});
