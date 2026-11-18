import { create } from "zustand";
import { persist } from "zustand/middleware";

export type WeatherMode = "auto" | "clear" | "rain" | "snow" | "autumn" | "midnight" | "fog";

/** Brainstorm Listen Mode dictation profile — how long a pause ends a thought, and the hard cap per utterance. */
export type ListenProfile = "snappy" | "relaxed" | "continuous";

export interface SettingsState {
  /** Agentic OS FastAPI backend. On mobile, use the desktop's NetBird IP. */
  gatewayUrl: string;
  /** Voice waveform colour ramp (left → right). Defaults follow the Stitch spectrum. */
  waveColors: [string, string, string];
  waveThickness: number;
  wallpaperIntervalSec: number;
  wallpaperShuffle: boolean;
  /** Rotate only through wallpapers tagged for the current weather + time of day. */
  wallpaperSync: boolean;
  /** Seconds a mutating action waits for yes/no before cancelling itself. */
  confirmTimeoutSec: number;
  weatherMode: WeatherMode;
  /** Null = ask the browser for geolocation. */
  weatherLocation: { lat: number; lon: number; label: string } | null;
  identity: { callsign: string; subtitle: string };
  mantra: { lines: [string, string, string]; quote: [string, string, string] };
  /** Microphone deviceId (empty = system default). */
  micDeviceId: string;
  /** Printed on invoices. Stays on this device + the local gateway. */
  business: { name: string; address: string; email: string; phone: string; hstNumber: string; province: string; hstRate: number; currency: string };
  trading: { symbol: string; tvSymbol: string; interval: string; range: string; showPoc: boolean; showZones: boolean; showValueArea: boolean };
  /** `listenProfile` picks how patient Brainstorm Listen Mode is before it ends a thought (see capture.ts LISTEN_PROFILES). */
  brainstorm: { autoOrganizeEvery: number; listenProfile: ListenProfile };
  /** The OS's name ("Tony"). Mirrored from Rust os.json; drives headers, badges, wake words. */
  osName: string;
  wakeWords: string[];
  /** Hands-free: keep listening and act only on lines that start with a wake word. */
  wakeMode: boolean;
  /** Hands-free: only act on lines that start with a wake word (off = act on any speech). */
  wakeRequire: boolean;
  /** Ultra-glass panel opacity, 0–100 %. 0–5 % = crystal-clear floating HUD. */
  glassOpacity: number;
  /**
   * Phone only: bearer token for the gateway when the desktop's network lock is on.
   * Deliberately excluded from persistence (see `partialize` below) — a secret has no
   * business sitting in plaintext `localStorage`. Re-enter it each session.
   */
  gatewayToken: string;
  /** Voice detection: 0–100 sensitivity, pause that ends an utterance, hard cap. */
  vad: { sensitivity: number; endSilenceMs: number; maxUtteranceMs: number };
  /** Conversation: reopen the mic after Tony answers; let you talk over him. */
  conversation: { followUp: boolean; followUpSecs: number; bargeIn: boolean };
  set: (patch: Partial<Omit<SettingsState, "set">>) => void;
}

/**
 * When the PWA is served by the gateway itself (phone → http(s)://<desktop>:8080/cc/),
 * the gateway is simply this origin. In Tauri / Vite dev it's the local server.
 */
const defaultGateway = (): string => {
  if (typeof location !== "undefined" && location.pathname.startsWith("/cc")) return location.origin;
  return "http://127.0.0.1:8080";
};

/** The full default state (everything but the `set` action) — also the fallback side of `deepMergeDefaults`. */
const defaults: Omit<SettingsState, "set"> = {
  gatewayUrl: defaultGateway(),
  micDeviceId: "",
  business: { name: "", address: "", email: "", phone: "", hstNumber: "", province: "ON", hstRate: 13, currency: "CAD" },
  trading: { symbol: "SPY", tvSymbol: "AMEX:SPY", interval: "5m", range: "5d", showPoc: true, showZones: true, showValueArea: true },
  brainstorm: { autoOrganizeEvery: 6, listenProfile: "relaxed" },
  osName: "Tony",
  wakeWords: ["hey tony", "yo tony", "tony"],
  wakeMode: false,
  wakeRequire: true,
  glassOpacity: 8,
  gatewayToken: "",
  vad: { sensitivity: 60, endSilenceMs: 700, maxUtteranceMs: 15000 },
  conversation: { followUp: true, followUpSecs: 6, bargeIn: true },
  waveColors: ["#00F0FF", "#A855F7", "#FF6B4A"],
  waveThickness: 3,
  wallpaperIntervalSec: 45,
  wallpaperShuffle: false,
  wallpaperSync: true,
  confirmTimeoutSec: 30,
  weatherMode: "auto",
  weatherLocation: null,
  identity: { callsign: "E46 // GABAGOUL", subtitle: "TONY ACTIVE" },
  mantra: {
    lines: ["FOCUS", "DISCIPLINE", "CONSISTENCY"],
    quote: ["Be patient.", "Progress takes time,", "but it changes everything."],
  },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Every object key optional, recursively (arrays and primitives are left as-is — a persisted value for one of those either is there or isn't). */
export type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

/**
 * Recursively fills any key missing from `partial` (at any depth) with the matching value from
 * `full`, instead of zustand persist's default shallow merge — which replaces a whole nested
 * object (e.g. `brainstorm`, `vad`) wholesale and drops fields a prior app version never saved.
 * Arrays and primitives in `partial` win as-is when present; `full`'s shape always wins for keys
 * `partial` doesn't have. Exported so other config additions (new nested `SettingsState` fields
 * from later work) get the same backfill without each one re-implementing it.
 */
export function deepMergeDefaults<T>(partial: DeepPartial<T> | null | undefined, full: T): T {
  if (!isPlainObject(partial) || !isPlainObject(full)) return partial == null ? full : (partial as T);
  const out: Record<string, unknown> = { ...full, ...partial };
  for (const key of Object.keys(full)) {
    const f = (full as Record<string, unknown>)[key];
    const p = (partial as Record<string, unknown>)[key];
    if (isPlainObject(f)) out[key] = deepMergeDefaults(p as DeepPartial<typeof f> | null | undefined, f);
    else if (p === undefined) out[key] = f;
  }
  return out as T;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      ...defaults,
      set: (patch) => set(patch),
    }),
    {
      name: "cc.settings",
      version: 5,
      migrate: (persisted, from) => {
        const s = (persisted ?? {}) as Partial<SettingsState>;
        // v4: the OS is called Tony now — retire the old default subtitle.
        if (from < 4 && s?.identity?.subtitle === "JARVIS ACTIVE") s.identity = { ...s.identity, subtitle: "TONY ACTIVE" };
        // `merge` (below) backfills any still-missing fields right after this runs.
        return s as unknown as SettingsState;
      },
      // Deep-merge (not zustand's default shallow merge) so a persisted nested object missing a
      // newer field (e.g. an old `brainstorm` without `listenProfile`) is backfilled from defaults
      // instead of leaving that field `undefined`. Runs on every load, not just on a version bump.
      merge: (persisted, current) => deepMergeDefaults(persisted as DeepPartial<SettingsState> | null | undefined, current),
      // Never write the bearer token to disk. `deepMergeDefaults` backfills it from `defaults`
      // (empty string) on every load, same as any other field a persisted snapshot doesn't have.
      partialize: ({ gatewayToken: _gatewayToken, ...rest }) => rest,
    },
  ),
);
