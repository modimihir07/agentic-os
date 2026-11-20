import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { useWallpapers } from "@/features/wallpaper/wallpaper-store";
import { useSettings } from "@/stores/settings";
import { PageSwitcher } from "./PageSwitcher";

/** Bottom wallpaper reel (desktop): "01 Drift Fog · 02 Skyline · 03 Pine Mist (Live)…", dashboard pages at the right end. */
export function ReelDock() {
  const { items, currentId, playing, select, setPlaying, next } = useWallpapers();
  const shuffle = useSettings((s) => s.wallpaperShuffle);
  const enabled = items.filter((i) => i.enabled && i.src);

  return (
    <div className="hidden items-center gap-2 px-6 pb-4 md:flex xl:px-8">
      <span className="label-caps hidden text-amber-soft xl:block">Reel</span>
      <button aria-label="Previous wallpaper" onClick={() => next(-1)} className="glass-thin grid size-9 place-items-center rounded-full text-ink-2 hover:text-ink">
        <ChevronLeft size={16} />
      </button>
      <button
        aria-label={playing ? "Pause slideshow" : "Play slideshow"}
        onClick={() => setPlaying(!playing)}
        className="glass-thin grid size-9 place-items-center rounded-full text-ink-2 hover:text-ink"
      >
        {playing ? <Pause size={14} /> : <Play size={14} />}
      </button>
      <button aria-label="Next wallpaper" onClick={() => next(1, shuffle)} className="glass-thin grid size-9 place-items-center rounded-full text-ink-2 hover:text-ink">
        <ChevronRight size={16} />
      </button>

      <ol className="flex min-w-0 flex-1 gap-2 overflow-x-auto [scrollbar-width:none]">
        {enabled.map((w, i) => {
          const live = w.id === currentId;
          return (
            <li key={w.id} className="shrink-0">
              <button
                onClick={() => select(w.id)}
                aria-current={live}
                className={`flex h-11 items-center gap-2.5 rounded-[14px] border pl-1 pr-4 font-mono text-[12px] transition-all duration-200 ${
                  live ? "border-amber/70 bg-amber/10 text-ink glow-amber" : "border-white/10 bg-[rgba(11,13,17,0.4)] text-ink-2 backdrop-blur-md hover:border-white/25 hover:text-ink"
                }`}
              >
                <img src={w.src} alt="" className="h-9 w-14 rounded-[10px] object-cover" loading="lazy" />
                <span className="tabular">{String(i + 1).padStart(2, "0")}</span>
                <span className="max-w-32 truncate">
                  {w.name}
                  {live && playing ? " · Live" : ""}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <PageSwitcher />
    </div>
  );
}
