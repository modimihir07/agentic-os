import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  cmd: vi.fn(),
  tauri: true,
  duckResult: true as boolean,
  cfg: { enabled: true, level: 15, restoreMs: 2500, onWakeListen: true },
}));

vi.mock("@/lib/platform", () => ({ cmd: h.cmd, isTauri: () => h.tauri }));
vi.mock("@/stores/settings", () => ({ useSettings: { getState: () => ({ conversation: { spotifyDuck: h.cfg }, vad: { maxUtteranceMs: 15_000 } }) } }));

type Duck = typeof import("./spotify-duck");
let d: Duck;

const calls = (name: string) => h.cmd.mock.calls.filter((c) => c[0] === name).length;
const ducks = () => calls("spotify_duck");
const unducks = () => calls("spotify_unduck");
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
/** A promise and its resolver (a pause / turn still in flight). */
function later() {
  let done!: () => void;
  const p = new Promise<void>((r) => (done = r));
  return { p, done };
}

beforeEach(async () => {
  vi.useFakeTimers();
  h.cmd.mockReset().mockImplementation((name: string) => Promise.resolve(name === "spotify_duck" ? h.duckResult : undefined));
  h.tauri = true;
  h.duckResult = true;
  h.cfg = { enabled: true, level: 15, restoreMs: 2500, onWakeListen: true };
  vi.resetModules(); // fresh module state per test
  d = await import("./spotify-duck");
});

afterEach(() => vi.useRealTimers());

describe("spotify-duck — onset", () => {
  it("ducks once per utterance at the configured level", async () => {
    d.duckOnSpeech();
    d.duckOnSpeech();
    await tick(0);
    expect(h.cmd).toHaveBeenCalledWith("spotify_duck", { level: 15 });
    expect(ducks()).toBe(1);
    expect(d.musicPlayingHere()).toBe(true);
  });

  it("does nothing when off, off the desktop app, or on a passive listen without onWakeListen", async () => {
    h.cfg.enabled = false;
    d.duckOnSpeech();
    h.cfg.enabled = true;
    h.tauri = false;
    d.duckOnSpeech();
    h.tauri = true;
    h.cfg.onWakeListen = false;
    d.duckOnSpeech(true);
    await tick(60_000);
    expect(h.cmd).not.toHaveBeenCalled();
    d.duckOnSpeech(false); // a real (non-passive) listen still ducks
    expect(ducks()).toBe(1);
  });

  it("a refused duck means music isn't known to play here", async () => {
    h.duckResult = false;
    d.duckOnSpeech();
    await tick(0);
    expect(d.musicPlayingHere()).toBe(false);
  });
});

describe("spotify-duck — restore timing", () => {
  it("the restore timer starts at utterance end, not onset", async () => {
    d.duckOnSpeech();
    await tick(10_000); // a long utterance: still ducked
    expect(unducks()).toBe(0);
    d.scheduleRestore(); // 'transcribing'
    await tick(2499);
    expect(unducks()).toBe(0);
    await tick(1);
    expect(unducks()).toBe(1);
  });

  it("follows the restore delay setting", async () => {
    h.cfg.restoreMs = 1500;
    d.duckOnSpeech();
    d.scheduleRestore();
    await tick(1500);
    expect(unducks()).toBe(1);
  });

  it("talking again before the restore keeps it ducked (no second duck call)", async () => {
    d.duckOnSpeech();
    d.scheduleRestore();
    await tick(2000);
    d.duckOnSpeech();
    await tick(5000);
    expect(unducks()).toBe(0);
    expect(ducks()).toBe(1);
    d.scheduleRestore();
    await tick(2500);
    expect(unducks()).toBe(1);
  });

  it("hard ceiling: an aborted listen (no callbacks) can't leave the music ducked", async () => {
    d.duckOnSpeech();
    await tick(15_000 + d.CEILING_PAD_MS - 1);
    expect(unducks()).toBe(0);
    await tick(1);
    expect(unducks()).toBe(1);
  });

  it("restoreDuck (abort / error / hard stop) restores at once, and only once", async () => {
    d.duckOnSpeech();
    d.restoreDuck();
    d.restoreDuck();
    await tick(0);
    expect(unducks()).toBe(1);
    await tick(60_000);
    expect(unducks()).toBe(1);
  });

  it("nothing ducked: no restore calls at all", async () => {
    d.restoreDuck();
    d.scheduleRestore();
    d.settleNoise();
    d.settleCommand(Promise.resolve());
    d.restoreAfterPause(Promise.resolve());
    await tick(60_000);
    expect(h.cmd).not.toHaveBeenCalled();
  });

  it("still asks Rust to unduck after a duck that reported false (it may have timed out mid-PUT)", async () => {
    h.duckResult = false;
    d.duckOnSpeech();
    d.restoreDuck();
    await tick(0);
    expect(unducks()).toBe(1);
  });
});

describe("spotify-duck — anti-pumping cooldown", () => {
  it("no re-duck within the cooldown after a no-command restore", async () => {
    d.duckOnSpeech();
    d.settleNoise();
    await tick(2500);
    expect(unducks()).toBe(1);
    d.duckOnSpeech(true);
    expect(ducks()).toBe(1);
    await tick(d.COOLDOWN_MS);
    d.duckOnSpeech(true);
    expect(ducks()).toBe(2);
  });

  it("a command restore starts no cooldown", async () => {
    d.duckOnSpeech();
    d.settleCommand(Promise.resolve());
    await tick(0);
    expect(unducks()).toBe(1);
    d.duckOnSpeech();
    expect(ducks()).toBe(2);
  });

  it("inCooldown is a plain time window", () => {
    expect(d.inCooldown(1000, 0)).toBe(true);
    expect(d.inCooldown(d.COOLDOWN_MS, 0)).toBe(false);
    expect(d.inCooldown(5, -Infinity)).toBe(false);
  });
});

describe("spotify-duck — cut / hold / command", () => {
  it("cut and hold: restore only after the pause lands; plain restores wait for it", async () => {
    d.duckOnSpeech();
    const pause = later();
    d.restoreAfterPause(pause.p);
    expect(d.musicPlayingHere()).toBe(false);
    d.restoreDuck(); // hardStopMic right after the cut
    await tick(d.PAUSE_WAIT_CAP_MS - 1); // nothing, not even the ceiling, restores before the pause
    expect(unducks()).toBe(0);
    pause.done();
    await tick(0);
    expect(unducks()).toBe(1);
  });

  it("a pause that never settles still restores after the cap", async () => {
    d.duckOnSpeech();
    d.restoreAfterPause(new Promise(() => undefined));
    await tick(d.PAUSE_WAIT_CAP_MS - 1);
    expect(unducks()).toBe(0);
    await tick(1);
    expect(unducks()).toBe(1);
  });

  it("a failed pause still restores", async () => {
    d.duckOnSpeech();
    d.restoreAfterPause(Promise.reject(new Error("offline")));
    await tick(0);
    expect(unducks()).toBe(1);
  });

  it("a command restores once its turn settles, or after the cap", async () => {
    d.duckOnSpeech();
    const turn = later();
    d.settleCommand(turn.p);
    await tick(d.COMMAND_RESTORE_CAP_MS - 1);
    expect(unducks()).toBe(0);
    await tick(1);
    expect(unducks()).toBe(1);
    turn.done();
    await tick(0);
    expect(unducks()).toBe(1);
  });

  it("talking again during a deferred command restore keeps the music ducked", async () => {
    d.duckOnSpeech();
    const turn = later();
    d.settleCommand(turn.p);
    d.duckOnSpeech(); // barge-in over Tony's reply
    turn.done();
    await tick(d.COMMAND_RESTORE_CAP_MS);
    expect(unducks()).toBe(0);
    d.scheduleRestore();
    await tick(2500);
    expect(unducks()).toBe(1);
    expect(ducks()).toBe(1);
  });
});
