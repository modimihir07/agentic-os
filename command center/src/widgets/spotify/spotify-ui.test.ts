import { describe, expect, it } from "vitest";
import type { SpotifyStatus } from "@/lib/platform";
import { ALLOWLIST_FIX_TEXT, VOLUME_HOLD_MS, cardButton, expiryHint, fmtTime, missingScopesLine, needsReconnect, progressAt, progressFraction, shownVolume, spotifyFix, spotifyFixText } from "./spotify-ui";

describe("spotify widget helpers", () => {
  it("formats track times", () => {
    expect(fmtTime(0)).toBe("0:00");
    expect(fmtTime(187_400)).toBe("3:07");
    expect(fmtTime(3_729_000)).toBe("1:02:09");
    expect(fmtTime(-5)).toBe("0:00");
    expect(fmtTime(NaN)).toBe("0:00");
  });

  it("advances position only while playing, clamped to the length", () => {
    const np = { isPlaying: true, progressMs: 10_000, durationMs: 12_000 };
    expect(progressAt(np, 1000, 2500)).toBe(11_500);
    expect(progressAt(np, 1000, 9000)).toBe(12_000);
    expect(progressAt({ ...np, isPlaying: false }, 1000, 9000)).toBe(10_000);
    expect(progressAt({ ...np, durationMs: 0 }, 1000, 9000)).toBe(18_000);
    expect(progressFraction(6, 12)).toBe(0.5);
    expect(progressFraction(20, 12)).toBe(1);
    expect(progressFraction(5, 0)).toBe(0);
  });

  it("a recent slider edit wins over the polled volume", () => {
    expect(shownVolume(40, null, 0)).toBe(40);
    expect(shownVolume(40, { value: 70, at: 1000 }, 1000 + VOLUME_HOLD_MS - 1)).toBe(70);
    expect(shownVolume(40, { value: 70, at: 1000 }, 1000 + VOLUME_HOLD_MS)).toBe(40);
    expect(shownVolume(null, null, 0)).toBe(null);
  });

  it("needsReconnect(status) follows problemKind / reauthPending, never the text", () => {
    expect(needsReconnect({ problemKind: "reauth", reauthPending: false })).toBe(true);
    expect(needsReconnect({ problemKind: null, reauthPending: true })).toBe(true);
    expect(needsReconnect({ problemKind: "transient", reauthPending: false })).toBe(false);
    expect(needsReconnect({ problemKind: "allowlist", reauthPending: false })).toBe(false);
    expect(needsReconnect({ problemKind: null, reauthPending: false })).toBe(false);
  });

  it("an error reply that may mean a dead sign-in makes the widget re-read its status", () => {
    expect(needsReconnect("Spotify isn't connected — connect it in Settings → Integrations.")).toBe(true);
    expect(needsReconnect("Open Spotify on this PC or your phone first.")).toBe(false);
    // A 401 the refresh couldn't fix is not a dead sign-in (Rust no longer says "connect it again").
    expect(needsReconnect("Spotify refused the request (HTTP 401): Permissions missing")).toBe(false);
    expect(needsReconnect("Spotify access was revoked or expired — connect it again in Settings → Integrations")).toBe(true);
    expect(needsReconnect("Spotify needs new permissions for this app — reconnect it in Settings → Integrations")).toBe(true);
    expect(needsReconnect("Spotify is blocking this app: the Spotify account that owns it in the Developer Dashboard needs an active Premium subscription")).toBe(true);
    expect(needsReconnect("Spotify playback control needs Premium")).toBe(false);
    expect(needsReconnect("Spotify needs one more permission for that — I opened the Spotify sign-in page. Approve it, then ask again.")).toBe(true);
    expect(needsReconnect("This Spotify account isn't on the app's user list — add it under Users Management")).toBe(true);
  });

  it("allowlist: a fix text and a re-check, never a Connect / Re-authenticate button", () => {
    const s = { connected: true, problem: "This Spotify account isn't on the app's user list", problemKind: "allowlist" as const };
    expect(spotifyFix(s)).toBe("allowlist");
    expect(spotifyFixText("allowlist")).toBe(ALLOWLIST_FIX_TEXT);
    expect(ALLOWLIST_FIX_TEXT).toBe("Add this Spotify account under Users Management in the Spotify Developer Dashboard (development mode, 5 users max).");
    expect(spotifyFixText("reauth")).toBeNull();
    expect(cardButton(s)).toEqual({ label: "Check again", recheck: true });
  });

  it("a pending re-consent is a re-auth even without a problem text", () => {
    expect(spotifyFix({ connected: true, problem: null, problemKind: null, reauthPending: true })).toBe("reauth");
    expect(missingScopesLine({ reauthPending: true, missingScopes: ["user-library-modify", "user-top-read"] })).toBe("Spotify needs 2 new permissions");
    expect(missingScopesLine({ reauthPending: true, missingScopes: ["user-top-read"] })).toBe("Spotify needs 1 new permission");
    expect(missingScopesLine({ reauthPending: false, missingScopes: ["user-top-read"] })).toBeNull();
    expect(missingScopesLine({ reauthPending: true, missingScopes: [] })).toBeNull();
  });

  it("an allowlist / owner-Premium block outranks a pending re-consent (a sign-in can't fix it)", () => {
    const allow = { connected: true, problem: "This Spotify account isn't on the app's user list", problemKind: "allowlist" as const, reauthPending: true };
    expect(spotifyFix(allow)).toBe("allowlist");
    expect(cardButton(allow)).toEqual({ label: "Check again", recheck: true });
    const owner = { connected: true, problem: "Spotify is blocking this app", problemKind: "owner_premium" as const, reauthPending: true };
    expect(spotifyFix(owner)).toBe("recheck");
    expect(cardButton(owner)).toEqual({ label: "Check again", recheck: true });
    // Other problems keep the re-consent first.
    expect(spotifyFix({ connected: true, problem: "Spotify had a server problem", problemKind: "transient", reauthPending: true })).toBe("reauth");
  });

  it("expiry hint only within 7 days", () => {
    expect(expiryHint({ expiresInDays: null })).toBeNull();
    expect(expiryHint({ expiresInDays: 8 })).toBeNull();
    expect(expiryHint({ expiresInDays: 7 })).toBe("Spotify sign-in expires in 7 days — Reconnect to renew it.");
    expect(expiryHint({ expiresInDays: 1 })).toBe("Spotify sign-in expires in 1 day — Reconnect to renew it.");
    expect(expiryHint({ expiresInDays: 0 })).toBe("Spotify sign-in expires in 0 days — Reconnect to renew it.");
  });

  it("switches on problemKind, not the problem text", () => {
    const st = (connected: boolean, problemKind: SpotifyStatus["problemKind"], problem: string | null = problemKind ? "x" : null) => ({ connected, problem, problemKind });
    expect(spotifyFix(st(false, null))).toBe("connect");
    expect(spotifyFix(st(true, null))).toBeNull();
    expect(spotifyFix(st(true, "reauth"))).toBe("reauth");
    expect(spotifyFix(st(true, "owner_premium"))).toBe("recheck");
    expect(spotifyFix(st(true, "premium"))).toBeNull();
    expect(spotifyFix(st(true, "transient"))).toBeNull();
    // Text that merely sounds like re-auth doesn't trigger it.
    expect(spotifyFix(st(true, "transient", "Spotify session expired — connect it again"))).toBeNull();
    expect(cardButton(st(false, null))).toEqual({ label: "Connect", recheck: false });
    expect(cardButton(st(true, "reauth"))).toEqual({ label: "Re-authenticate", recheck: false });
    expect(cardButton(st(true, "owner_premium"))).toEqual({ label: "Check again", recheck: true });
    expect(cardButton(st(true, "transient"))).toEqual({ label: "Reconnect", recheck: false });
    expect(cardButton(st(true, null))).toEqual({ label: "Reconnect", recheck: false });
  });
});
