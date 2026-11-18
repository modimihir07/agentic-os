import { describe, expect, it } from "vitest";
import type { SpotifyNowPlaying } from "@/lib/platform";
import { nowPlayingReply, spotifyErrorReply } from "./media-reply";

describe("spotifyErrorReply", () => {
  it.each<[unknown, string]>([
    ["Spotify isn't connected — connect it in Settings → Integrations", "Spotify isn't connected — connect it in Settings → Integrations."],
    ["kill switch is on — Spotify is a cloud service", "The kill switch is on, and Spotify is a cloud service."],
    ["PERMISSION_DENIED:mcp", "Spotify control is blocked: the MCP permission is set to deny in Settings → Integrations."],
    ["Open Spotify on this PC or your phone first", "Open Spotify on this PC or your phone first."],
    [new Error("spotify playback control needs Premium"), "Spotify playback control needs Premium."],
    ["", "Spotify didn't answer."],
  ])("%s", (raw, expected) => {
    expect(spotifyErrorReply(raw)).toBe(expected);
  });
});

describe("nowPlayingReply", () => {
  const np = (p: Partial<SpotifyNowPlaying>): SpotifyNowPlaying => ({
    isPlaying: true,
    track: null,
    artists: [],
    album: null,
    artUrl: null,
    progressMs: 0,
    durationMs: 0,
    device: null,
    volume: null,
    shuffle: false,
    uri: null,
    ...p,
  });

  it("names the track and artists", () => {
    expect(nowPlayingReply(np({ track: "Creep", artists: ["Radiohead"] }))).toBe("Now playing Creep by Radiohead.");
    expect(nowPlayingReply(np({ track: "Creep", artists: [], isPlaying: false }))).toBe("Paused on Creep.");
  });

  it("says when nothing plays", () => {
    expect(nowPlayingReply(np({}))).toBe("Nothing is playing on Spotify right now.");
  });
});
