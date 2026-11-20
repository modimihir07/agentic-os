import { describe, expect, it, vi } from "vitest";
import type { SpotifyIntent } from "@/lib/platform";

const h = vi.hoisted(() => ({ running: null as string | null }));

vi.mock("@/lib/cc-api", () => ({
  collections: {
    snapshot: () => [{ id: "c1", name: "Jazz hour", enabled: true, phrases: ["play some jazz"], action: { kind: "none", value: "" }, days: [] }],
  },
  useCollection: vi.fn(),
}));
vi.mock("./player", () => ({ runCue: vi.fn(), stopAllAudio: vi.fn(), useCueRun: { getState: () => ({ cueId: h.running }) } }));
vi.mock("@/stores/nav", () => ({ useNav: { getState: () => ({ go: vi.fn() }) }, SECTIONS: [] }));
vi.mock("@/features/voice/voice-store", () => ({ useVoice: { getState: () => ({ setActiveThread: vi.fn() }) }, THREADS: [] }));
vi.mock("@/features/reminders/notify", () => ({ useToasts: { getState: () => ({ push: vi.fn() }) } }));

import { cueFor } from "./cue-runtime";

const play = (explicit: boolean): SpotifyIntent => ({ tool: "spotify.play", args: { query: "jazz", prefer_playlist: true }, summary: "Play jazz on Spotify", mutating: true, explicit });

describe("cueFor with a Spotify intent", () => {
  it("a play line that didn't name Spotify can be a cue's phrase", () => {
    expect(cueFor("play some jazz", null, play(false))?.id).toBe("c1");
  });

  it("an explicit Spotify play is never taken by a cue", () => {
    expect(cueFor("play some jazz on spotify", null, play(true))).toBeNull();
  });

  it("any other Spotify intent blocks cues", () => {
    const pause: SpotifyIntent = { tool: "spotify.pause", args: {}, summary: "Pause Spotify", mutating: true, explicit: false };
    expect(cueFor("play some jazz", null, pause)).toBeNull();
  });

  it("with no intents, a phrase match fires; a running cue only restarts on an ON verb", () => {
    expect(cueFor("play some jazz", null)?.id).toBe("c1");
    h.running = "c1";
    expect(cueFor("play some jazz", null)?.id).toBe("c1"); // "play" is an ON verb
    h.running = null;
  });
});
