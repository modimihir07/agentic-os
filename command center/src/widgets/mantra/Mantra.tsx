import { useEffect, useState } from "react";
import type { WidgetProps } from "@/core/widgets/types";
import { useSettings } from "@/stores/settings";
import { useAtmosphere, useWeather } from "@/features/weather/weather-store";

export default function Mantra({ config }: WidgetProps<{ showQuote: boolean }>) {
  const { lines, quote } = useSettings((s) => s.mantra);
  const now = useWeather((s) => s.now);
  const atmosphere = useAtmosphere();
  const clock = useClock();

  return (
    <div className="flex h-full flex-col items-center justify-center text-center [text-shadow:0_2px_18px_rgba(0,0,0,0.7)]">
      <span aria-hidden className="mb-3 h-8 w-px bg-gradient-to-b from-transparent to-white/60" />
      <span aria-hidden className="mb-4 size-1.5 rounded-full bg-white shadow-[0_0_8px_#fff]" />
      <h1 className="font-light tracking-[0.55em] text-amber-light [font-size:clamp(1.6rem,3.2vw,3rem)]">{lines[0]}</h1>
      <p className="mt-2 tracking-[0.6em] text-ink/90 [font-size:clamp(0.75rem,1vw,1rem)]">{lines[1]}</p>
      <p className="mt-2 tracking-[0.6em] text-ink/70 [font-size:clamp(0.7rem,0.9vw,0.95rem)]">{lines[2]}</p>
      <div aria-hidden className="mt-4 flex items-center gap-3">
        <span className="h-px w-10 bg-white/30" />
        <span className="size-1.5 rounded-full bg-amber shadow-[0_0_8px_#ff7a2f]" />
        <span className="h-px w-10 bg-white/30" />
      </div>
      <p className="label-caps mt-4 text-ink/80 tabular">
        {clock} · {now ? `${now.label} · ${Math.round(now.tempC)}°C` : atmosphere}
      </p>
      {config.showQuote && (
        <p className="mt-3 hidden text-xs uppercase tracking-[0.2em] text-ink/70 lg:block">
          {quote[0]} {quote[1]} <span className="text-amber-light">{quote[2]}</span>
        </p>
      )}
    </div>
  );
}

function useClock() {
  const fmt = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const [t, setT] = useState(fmt);
  useEffect(() => {
    const id = setInterval(() => setT(fmt()), 10_000);
    return () => clearInterval(id);
  }, []);
  return t;
}
