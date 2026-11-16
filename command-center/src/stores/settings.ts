import { create } from "zustand";
import { persist } from "zustand/middleware";

export type WeatherMode = "auto" | "clear" | "rain" | "snow" | "autumn" | "midnight" | "fog";

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
  set: (patch: Partial<Omit<SettingsState, "set">>) => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      gatewayUrl: "http://127.0.0.1:8080",
      waveColors: ["#00F0FF", "#A855F7", "#FF6B4A"],
      waveThickness: 3,
      wallpaperIntervalSec: 45,
      wallpaperShuffle: false,
      wallpaperSync: true,
      confirmTimeoutSec: 30,
      weatherMode: "auto",
      weatherLocation: null,
      identity: { callsign: "E46 // GABAGOUL", subtitle: "JARVIS ACTIVE" },
      mantra: {
        lines: ["FOCUS", "DISCIPLINE", "CONSISTENCY"],
        quote: ["Be patient.", "Progress takes time,", "but it changes everything."],
      },
      set: (patch) => set(patch),
    }),
    {
      name: "cc.settings",
      version: 2,
      // v1 → v2: new fields fall back to defaults via the shallow merge below.
      migrate: (persisted) => persisted as SettingsState,
    },
  ),
);
