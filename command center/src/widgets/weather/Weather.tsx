import { CloudFog, CloudRain, Leaf, Moon, Snowflake, Sun, Wand2 } from "lucide-react";
import { Empty, WidgetHeader } from "@/components/WidgetHeader";
import { useAtmosphere, useWeather } from "@/features/weather/weather-store";
import { useSettings, type WeatherMode } from "@/stores/settings";

export const ATMOSPHERES: { mode: WeatherMode; label: string; icon: typeof Sun }[] = [
  { mode: "auto", label: "Live", icon: Wand2 },
  { mode: "clear", label: "Sunrise", icon: Sun },
  { mode: "autumn", label: "Autumn", icon: Leaf },
  { mode: "rain", label: "Rain", icon: CloudRain },
  { mode: "snow", label: "Snow", icon: Snowflake },
  { mode: "fog", label: "Fog", icon: CloudFog },
  { mode: "midnight", label: "Midnight", icon: Moon },
];

export default function Weather() {
  const { now, error } = useWeather();
  const mode = useSettings((s) => s.weatherMode);
  const atmosphere = useAtmosphere();

  return (
    <div className="flex h-full flex-col">
      <WidgetHeader title={now?.place ?? "Weather"} status={<span className="label-caps text-ink-3">{atmosphere}</span>} />
      {now ? (
        <div className="flex items-end gap-3">
          <span className="font-mono text-4xl font-semibold text-ink tabular">{Math.round(now.tempC)}°</span>
          <div className="pb-1">
            <p className="text-sm text-ink">{now.label}</p>
            <p className="font-mono text-[11px] text-ink-3 tabular">wind {Math.round(now.windKph)} km/h</p>
          </div>
        </div>
      ) : (
        <Empty>{error ?? "Fetching conditions…"}</Empty>
      )}
      {/* The top bar carries the switch on large screens. */}
      <AtmosphereSwitch mode={mode} className="mt-auto lg:hidden" />
    </div>
  );
}

export function AtmosphereSwitch({ mode, className = "" }: { mode: WeatherMode; className?: string }) {
  const set = useSettings((s) => s.set);
  return (
    <div role="radiogroup" aria-label="Atmosphere" className={`well flex w-fit flex-wrap gap-0.5 rounded-full p-1 ${className}`}>
      {ATMOSPHERES.map(({ mode: m, label, icon: Icon }) => (
        <button
          key={m}
          role="radio"
          aria-checked={mode === m}
          aria-label={label}
          title={label}
          onClick={() => set({ weatherMode: m })}
          className={`grid size-7 place-items-center rounded-full transition-colors ${
            mode === m ? "bg-gradient-to-tr from-amber to-amber-light text-canvas shadow-[0_0_12px_rgba(255,122,47,0.6)]" : "text-ink-2 hover:bg-white/10 hover:text-ink"
          }`}
        >
          <Icon size={14} />
        </button>
      ))}
    </div>
  );
}
