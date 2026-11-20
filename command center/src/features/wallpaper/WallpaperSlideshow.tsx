import { useEffect, useMemo, useState } from "react";
import { matchingWallpapers, useWallpapers } from "./wallpaper-store";
import { useAtmosphere, useTimePhase } from "@/features/weather/weather-store";
import { useSettings } from "@/stores/settings";
import { usePrefersReducedMotion } from "@/lib/use-media-query";

/**
 * Full-bleed background. Two stacked layers: when the current wallpaper
 * changes, the new one fades in over the old (decoded first so there is never
 * a flash of black). A slow "living drift" pan keeps stills feeling alive.
 * The vignette keeps foreground text legible on any user upload.
 */
export function WallpaperSlideshow() {
  const { items, currentId, playing, hydrated, hydrate, next } = useWallpapers();
  const { wallpaperIntervalSec, wallpaperShuffle, wallpaperSync } = useSettings();
  const reduced = usePrefersReducedMotion();
  const [layers, setLayers] = useState<{ key: string; src: string }[]>([]);
  const atmosphere = useAtmosphere();
  const phase = useTimePhase();

  // Weather + time-of-day sync: rotate only through scenes tagged for now.
  const allowed = useMemo(
    () => (wallpaperSync ? matchingWallpapers(items, atmosphere, phase).map((w) => w.id) : undefined),
    [wallpaperSync, items, atmosphere, phase],
  );
  const allowedKey = allowed?.join(",");

  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  // When conditions change (snow starts, sun sets), move into the matching set right away.
  useEffect(() => {
    if (hydrated && allowed && !allowed.includes(useWallpapers.getState().currentId)) next(1, wallpaperShuffle, allowed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, allowedKey]);

  // Auto-advance (paused when hidden or when the user pauses the reel).
  useEffect(() => {
    if (!playing || !hydrated) return;
    const t = setInterval(() => {
      if (!document.hidden) next(1, wallpaperShuffle, allowed);
    }, Math.max(5, wallpaperIntervalSec) * 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, hydrated, wallpaperIntervalSec, wallpaperShuffle, next, allowedKey]);

  // Preload + decode the next image before swapping it in.
  const src = items.find((i) => i.id === currentId)?.src;
  useEffect(() => {
    if (!src) return;
    let cancelled = false;
    const img = new Image();
    img.src = src;
    img
      .decode()
      .catch(() => undefined)
      .then(() => {
        if (cancelled) return;
        setLayers((prev) => [...prev.slice(-1), { key: `${currentId}-${Date.now()}`, src }]);
      });
    return () => {
      cancelled = true;
    };
  }, [src, currentId]);

  return (
    <div aria-hidden className="fixed inset-0 -z-10 overflow-hidden bg-canvas">
      {layers.map((layer, i) => (
        <div
          key={layer.key}
          className="absolute inset-0 transition-opacity duration-[1600ms] ease-out starting:opacity-0"
          style={{ opacity: i === layers.length - 1 ? 1 : 0 }}
        >
          <img
            src={layer.src}
            alt=""
            draggable={false}
            className={`size-full object-cover ${reduced ? "" : "animate-living-drift"}`}
          />
        </div>
      ))}
      {/* Legibility: top + bottom scrims, edge vignette, dual-tone aura from the design system. */}
      <div className="absolute inset-0 bg-[linear-gradient(to_bottom,rgba(11,13,17,0.65)_0%,transparent_22%,transparent_62%,rgba(11,13,17,0.85)_100%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_45%,rgba(0,0,0,0.55)_100%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,122,47,0.10)_0%,transparent_55%),radial-gradient(circle_at_bottom_left,rgba(0,229,195,0.07)_0%,transparent_50%)]" />
    </div>
  );
}
