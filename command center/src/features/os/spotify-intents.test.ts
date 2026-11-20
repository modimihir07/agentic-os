import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingSpotifyCall, SpotifyIntent } from "@/lib/platform";

const h = vi.hoisted(() => ({
  cmd: vi.fn(),
  tauri: true,
  pending: null as unknown,
  gated: vi.fn(),
  connect: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/lib/platform", () => ({ cmd: h.cmd, isTauri: () => h.tauri }));
vi.mock("@/stores/settings", () => ({ useSettings: { getState: () => ({ osName: "Tony" }) } }));
vi.mock("@/features/voice/voice-store", () => ({ useVoice: { getState: () => ({ pending: h.pending }) } }));
vi.mock("@/features/reminders/notify", () => ({ useToasts: { getState: () => ({ push: h.toast }) } }));
vi.mock("@/features/bridge/gate", () => ({ gated: h.gated }));
vi.mock("@/features/integrations/spotify-connect", () => ({ connectSpotify: h.connect }));

import { ASK_REPLY, CARD_OPEN_REPLY, RECONNECT_REPLY, cueOwnsVolume, parseSpotifyLine, runPendingSpotify, runSpotifyIntent } from "./spotify-intents";

const intent = (p: Partial<SpotifyIntent>): SpotifyIntent => ({ tool: "spotify.now_playing", args: {}, summary: "x", mutating: false, explicit: false, ...p });
type GateOpts = { action: string; summary: string; required?: string; channel?: string };
type Call = (approved: boolean) => Promise<string>;

beforeEach(() => {
  h.cmd.mockReset();
  h.gated.mockReset().mockResolvedValue(null);
  h.connect.mockReset().mockResolvedValue({ ok: true, account: "me" });
  h.toast.mockReset();
  h.tauri = true;
  h.pending = null;
});

describe("parseSpotifyLine", () => {
  it("asks Rust's grammar with the OS name", async () => {
    const sp = intent({ tool: "spotify.play", args: { query: "Bilmuri" }, mutating: true });
    h.cmd.mockResolvedValueOnce(sp);
    expect(await parseSpotifyLine("play bilmuri")).toEqual(sp);
    expect(h.cmd).toHaveBeenCalledWith("spotify_parse", { text: "play bilmuri", osName: "Tony" });
  });

  it("is null off the desktop app (no IPC) and on any error", async () => {
    h.tauri = false;
    expect(await parseSpotifyLine("play bilmuri")).toBeNull();
    expect(h.cmd).not.toHaveBeenCalled();
    h.tauri = true;
    h.cmd.mockRejectedValueOnce(new Error("unknown command spotify_parse"));
    expect(await parseSpotifyLine("play bilmuri")).toBeNull();
  });
});

describe("runSpotifyIntent", () => {
  it("a read calls spotify_tool with approved false and returns its reply", async () => {
    h.cmd.mockResolvedValueOnce("Now playing Tell Me by Groove Theory.");
    const r = await runSpotifyIntent(intent({ tool: "spotify.now_playing" }));
    expect(r.reply).toBe("Now playing Tell Me by Groove Theory.");
    expect(h.cmd).toHaveBeenCalledTimes(1);
    expect(h.cmd).toHaveBeenCalledWith("spotify_tool", { name: "spotify.now_playing", args: {}, approved: false });
    expect(h.gated).not.toHaveBeenCalled();
  });

  it("a write that runs returns Rust's reply, no card", async () => {
    h.cmd.mockResolvedValueOnce("Paused Spotify.");
    const r = await runSpotifyIntent(intent({ tool: "spotify.pause", mutating: true, summary: "Pause Spotify" }));
    expect(r).toEqual({ reply: "Paused Spotify." });
    expect(h.gated).not.toHaveBeenCalled();
  });

  it("a write on Ask raises the card once, with `required` set (no second call(false))", async () => {
    h.cmd.mockRejectedValueOnce("PERMISSION_REQUIRED:mcp");
    const sp = intent({ tool: "spotify.play", args: { query: "Bilmuri" }, mutating: true, summary: "Play Bilmuri on Spotify" });
    const r = await runSpotifyIntent(sp, "voice");
    expect(r).toEqual({ reply: ASK_REPLY, card: true });
    expect(h.cmd).toHaveBeenCalledTimes(1);
    expect(h.gated).toHaveBeenCalledTimes(1);
    const [opts, call] = h.gated.mock.calls[0] as [GateOpts, Call];
    expect(opts).toMatchObject({ action: "spotify", summary: "Play Bilmuri on Spotify", required: "PERMISSION_REQUIRED:mcp", channel: "voice" });
    // Approve runs the same tool with approved: true.
    h.cmd.mockResolvedValueOnce("Playing Bilmuri on Spotify.");
    expect(await call(true)).toBe("Playing Bilmuri on Spotify.");
    expect(h.cmd).toHaveBeenLastCalledWith("spotify_tool", { name: "spotify.play", args: { query: "Bilmuri" }, approved: true });
  });

  it("passes the destructive gate error through as `required`", async () => {
    h.cmd.mockRejectedValueOnce(new Error("PERMISSION_REQUIRED:destructive"));
    await runSpotifyIntent(intent({ tool: "spotify.unlike_track", args: { track_query: "current" }, mutating: true, summary: "Remove this song from your Liked Songs" }));
    expect((h.gated.mock.calls[0][0] as GateOpts).required).toBe("PERMISSION_REQUIRED:destructive");
    expect((h.gated.mock.calls[0][0] as GateOpts).channel).toBe("text");
  });

  it("with a card already open it asks to answer that one first", async () => {
    h.pending = { plan: { id: "p" } };
    h.cmd.mockRejectedValueOnce("PERMISSION_REQUIRED:mcp");
    const r = await runSpotifyIntent(intent({ tool: "spotify.next", mutating: true, summary: "Skip to the next track" }));
    expect(r.reply).toBe(CARD_OPEN_REPLY);
    expect(h.gated).not.toHaveBeenCalled();
  });

  it("Deny reads as the Permissions wording", async () => {
    h.cmd.mockRejectedValueOnce("PERMISSION_DENIED:mcp");
    const r = await runSpotifyIntent(intent({ tool: "spotify.pause", mutating: true }));
    expect(r.reply).toBe("Spotify control is blocked: the MCP permission is set to Deny in Settings → Permissions.");
    expect(h.gated).not.toHaveBeenCalled();
  });

  it("other errors are tidied into a sentence", async () => {
    h.cmd.mockRejectedValueOnce("Nothing is playing on Spotify");
    expect((await runSpotifyIntent(intent({ tool: "spotify.get_queue" }))).reply).toBe("Nothing is playing on Spotify.");
  });

  it("reconnect starts connectSpotify and never calls spotify_tool", async () => {
    const r = await runSpotifyIntent(intent({ tool: "spotify.reconnect" }));
    expect(r.reply).toBe(RECONNECT_REPLY);
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(h.cmd).not.toHaveBeenCalled();
  });

  it("off the desktop app it says so", async () => {
    h.tauri = false;
    expect((await runSpotifyIntent(intent({}))).reply).toMatch(/desktop app/);
    expect(h.cmd).not.toHaveBeenCalled();
  });
});

describe("runPendingSpotify (D14)", () => {
  const p: PendingSpotifyCall = {
    name: "spotify.remove_from_playlist",
    args: { playlist_name: "Late Night", track_query: "Tell Me" },
    summary: "Remove Tell Me from your Late Night playlist",
    required: "PERMISSION_REQUIRED:destructive",
  };

  it("raises the card once with the payload's `required`; approve calls spotify_tool, never os_turn", async () => {
    const r = await runPendingSpotify(p, "voice");
    expect(r).toEqual({ reply: ASK_REPLY, card: true });
    expect(h.cmd).not.toHaveBeenCalled(); // no first call(false)
    expect(h.gated).toHaveBeenCalledTimes(1);
    const [opts, call] = h.gated.mock.calls[0] as [GateOpts, Call];
    expect(opts).toMatchObject({ summary: p.summary, required: p.required, channel: "voice" });
    h.cmd.mockResolvedValueOnce("Removed Tell Me from your Late Night playlist.");
    await call(true);
    expect(h.cmd).toHaveBeenCalledTimes(1);
    expect(h.cmd).toHaveBeenCalledWith("spotify_tool", { name: p.name, args: p.args, approved: true });
    expect(h.cmd.mock.calls.some((c) => c[0] === "os_turn")).toBe(false);
  });

  it("with a card already open it asks to answer that one first", async () => {
    h.pending = { plan: { id: "p" } };
    expect((await runPendingSpotify(p)).reply).toBe(CARD_OPEN_REPLY);
    expect(h.gated).not.toHaveBeenCalled();
  });
});

describe("cueOwnsVolume", () => {
  const vol = (explicit: boolean) => intent({ tool: "spotify.volume", args: { percent: 30 }, mutating: true, explicit });
  it("a bare volume during a playing cue is the cue's / Tony's", () => {
    expect(cueOwnsVolume(vol(false), true, "volume 30")).toBe(true);
  });
  it("naming Spotify or the music keeps it Spotify's", () => {
    expect(cueOwnsVolume(vol(true), true, "spotify volume 30")).toBe(false);
    expect(cueOwnsVolume(vol(false), true, "music volume 30")).toBe(false);
  });
  it("no cue playing ⇒ Spotify's; other tools are never claimed", () => {
    expect(cueOwnsVolume(vol(false), false, "volume 30")).toBe(false);
    expect(cueOwnsVolume(intent({ tool: "spotify.pause", mutating: true }), true, "pause")).toBe(false);
  });
});
