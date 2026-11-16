import { useEffect, useState } from "react";
import { create } from "zustand";
import { useSettings, type WeatherMode } from "@/stores/settings";

export type Atmosphere = Exclude<WeatherMode, "auto">;

export interface WeatherNow {
  tempC: number;
  windKph: number;
  code: number;
  isDay: boolean;
  label: string;
  atmosphere: Atmosphere;
  place: string;
  fetchedAt: number;
  /** Local sunrise/sunset today (epoch ms), used for time-of-day wallpaper sync. */
  sunrise: number | null;
  sunset: number | null;
}

export type TimePhase = "day" | "golden" | "night";
export const PHASES: TimePhase[] = ["day", "golden", "night"];

/** Golden = within 50 min of sunrise/sunset. Without sun data, fall back to the clock. */
export function timePhase(now: number, sunrise: number | null, sunset: number | null): TimePhase {
  const GOLDEN = 50 * 60_000;
  if (sunrise && sunset) {
    if (Math.abs(now - sunrise) < GOLDEN || Math.abs(now - sunset) < GOLDEN) return "golden";
    return now > sunrise && now < sunset ? "day" : "night";
  }
  const h = new Date(now).getHours();
  return h >= 7 && h < 17 ? "day" : h >= 17 && h < 19 ? "golden" : h >= 6 && h < 7 ? "golden" : "night";
}

/** WMO weather code → human label + particle atmosphere. */
export function describeWmo(code: number, isDay: boolean): { label: string; atmosphere: Atmosphere } {
  if (code === 0 || code === 1) return { label: isDay ? "Clear" : "Clear night", atmosphere: isDay ? "clear" : "midnight" };
  if (code === 2 || code === 3) return { label: code === 2 ? "Partly cloudy" : "Overcast", atmosphere: isDay ? "autumn" : "midnight" };
  if (code === 45 || code === 48) return { label: "Fog", atmosphere: "fog" };
  if (code >= 51 && code <= 67) return { label: code >= 61 ? "Rain" : "Drizzle", atmosphere: "rain" };
  if (code >= 71 && code <= 77) return { label: "Snow", atmosphere: "snow" };
  if (code >= 80 && code <= 82) return { label: "Showers", atmosphere: "rain" };
  if (code === 85 || code === 86) return { label: "Snow showers", atmosphere: "snow" };
  if (code >= 95) return { label: "Thunderstorm", atmosphere: "rain" };
  return { label: "—", atmosphere: "clear" };
}

interface WeatherState {
  now: WeatherNow | null;
  error: string | null;
  refresh: () => Promise<void>;
}

async function resolveLocation(): Promise<{ lat: number; lon: number; label: string }> {
  const fixed = useSettings.getState().weatherLocation;
  if (fixed) return fixed;
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) return reject(new Error("Set a location in Settings"));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, label: "Current location" }),
      () => reject(new Error("Location denied — set one in Settings")),
      { timeout: 10_000, maximumAge: 30 * 60_000 },
    );
  });
}

/** Open-Meteo: free, no API key, CORS-enabled — works from both desktop and PWA. */
export const useWeather = create<WeatherState>((set) => ({
  now: null,
  error: null,
  refresh: async () => {
    try {
      const loc = await resolveLocation();
      const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat.toFixed(3)}&longitude=${loc.lon.toFixed(3)}` +
        `&current=temperature_2m,weather_code,wind_speed_10m,is_day&daily=sunrise,sunset&forecast_days=1&timezone=auto&timeformat=unixtime`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Weather ${res.status}`);
      const json = await res.json();
      const c = json.current;
      const isDay = c.is_day === 1;
      const { label, atmosphere } = describeWmo(c.weather_code, isDay);
      const sec = (v: unknown) => (typeof v === "number" ? v * 1000 : null);
      set({
        now: {
          tempC: c.temperature_2m,
          windKph: c.wind_speed_10m,
          code: c.weather_code,
          isDay,
          label,
          atmosphere,
          place: loc.label,
          fetchedAt: Date.now(),
          sunrise: sec(json.daily?.sunrise?.[0]),
          sunset: sec(json.daily?.sunset?.[0]),
        },
        error: null,
      });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "Weather unavailable" });
    }
  },
}));

/** The atmosphere actually rendered: manual override wins, otherwise live weather. */
export function useAtmosphere(): Atmosphere {
  const mode = useSettings((s) => s.weatherMode);
  const live = useWeather((s) => s.now?.atmosphere);
  const phase = useTimePhase();
  // No live weather (offline / location denied): at least follow the clock.
  return mode === "auto" ? (live ?? (phase === "night" ? "midnight" : "clear")) : mode;
}

/** Current day / golden-hour / night, re-evaluated every minute. */
export function useTimePhase(): TimePhase {
  const sunrise = useWeather((s) => s.now?.sunrise ?? null);
  const sunset = useWeather((s) => s.now?.sunset ?? null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return timePhase(now, sunrise, sunset);
}
