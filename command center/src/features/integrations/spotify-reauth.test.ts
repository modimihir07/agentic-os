import { describe, expect, it, vi } from "vitest";
import type { SpotifyReauthEvent } from "@/lib/platform";

const h = vi.hoisted(() => ({
  handlers: new Map<string, (p: unknown) => void>(),
  subscribe: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/lib/platform", () => ({
  cmd: vi.fn(),
  onNativeEvent: (ev: string, fn: (p: unknown) => void) => {
    h.subscribe(ev);
    h.handlers.set(ev, fn);
    return Promise.resolve(() => undefined);
  },
}));
vi.mock("@/features/reminders/notify", () => ({ useToasts: { getState: () => ({ push: h.toast }) } }));
vi.mock("./mcp-enable", () => ({ setMcpEnabled: vi.fn() }));
vi.mock("./changed", () => ({ notifyIntegrationsChanged: vi.fn() }));

import { SPOTIFY_REFRESH_EVENTS, installSpotifyReauthNotice, reauthToast } from "./spotify-connect";

const URL = "https://accounts.spotify.com/authorize?client_id=abc&state=xyz";
const ev = (reason: SpotifyReauthEvent["reason"], silent: boolean): SpotifyReauthEvent => ({ reason, url: URL, silent });

describe("installSpotifyReauthNotice", () => {
  it("one toast per spotify-reauth event, worded per reason / silent, never the URL; idempotent", () => {
    installSpotifyReauthNotice();
    installSpotifyReauthNotice(); // no-op
    expect(h.subscribe.mock.calls.filter((c) => c[0] === "spotify-reauth")).toHaveLength(1);
    const fire = h.handlers.get("spotify-reauth")!;

    fire(ev("renew", true));
    fire(ev("scopes", false));
    fire(ev("refused", false));
    fire(ev("expired", false));
    expect(h.toast).toHaveBeenCalledTimes(4);
    const toasts = h.toast.mock.calls.map((c) => c[0] as { title: string; body: string });
    expect(toasts[0]).toMatchObject({ title: "Renewing Spotify sign-in", body: "A Spotify tab opened to renew access — it should close on its own." });
    expect(toasts[1]).toMatchObject({ title: "Spotify needs your OK", body: "Spotify needs new permissions — approve the tab I opened." });
    expect(toasts[2].body).toBe("Spotify needs new permissions — approve the tab I opened.");
    expect(toasts[3]).toMatchObject({ title: "Spotify needs your OK", body: "Your Spotify sign-in expired — approve the tab I opened to renew it." });
    for (const t of toasts) {
      expect(JSON.stringify(t)).not.toContain("http");
      expect(JSON.stringify(t)).not.toContain("client_id");
    }
  });

  it("a silent expired renewal reads as a renewal", () => {
    expect(reauthToast({ reason: "expired", silent: true }).title).toBe("Renewing Spotify sign-in");
  });

  it("views re-read their status on spotify-reauth too", () => {
    expect(SPOTIFY_REFRESH_EVENTS).toContain("spotify-reauth");
  });
});
