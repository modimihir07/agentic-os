import { useRef, useState } from "react";
import { Eye, EyeOff, Tags, Trash2, Upload } from "lucide-react";
import { matchingWallpapers, useWallpapers, type WallpaperTags } from "@/features/wallpaper/wallpaper-store";
import { PHASES, useAtmosphere, useTimePhase, type Atmosphere } from "@/features/weather/weather-store";
import { useSettings } from "@/stores/settings";

export function WallpapersSection() {
  const { items, currentId, select, toggleEnabled, upload, remove } = useWallpapers();
  const { wallpaperIntervalSec, wallpaperShuffle, wallpaperSync, set } = useSettings();
  const atmosphere = useAtmosphere();
  const phase = useTimePhase();
  const fitsNow = new Set(matchingWallpapers(items, atmosphere, phase).map((w) => w.id));
  const [tagging, setTagging] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const handle = async (files: FileList | null) => {
    if (!files?.length) return;
    const r = await upload(files);
    setMsg([r.added ? `Added ${r.added} wallpaper${r.added > 1 ? "s" : ""}.` : "", ...r.rejected].filter(Boolean).join(" "));
  };

  return (
    <div className="mx-auto h-full w-full max-w-6xl overflow-y-auto px-4 pb-28 md:px-6 md:pb-8">
      <div className="glass mb-4 flex flex-wrap items-center gap-4 rounded-[20px] p-4">
        <button className="pill-primary" onClick={() => input.current?.click()}>
          <Upload size={15} /> Upload wallpapers
        </button>
        <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => void handle(e.target.files)} />
        <label className="flex items-center gap-3 text-sm text-ink-2">
          Rotate every
          <input
            type="range"
            min={10}
            max={300}
            step={5}
            value={wallpaperIntervalSec}
            onChange={(e) => set({ wallpaperIntervalSec: Number(e.target.value) })}
            className="accent-amber"
          />
          <span className="w-12 font-mono text-ink tabular">{wallpaperIntervalSec}s</span>
        </label>
        <label className="flex items-center gap-2 text-sm text-ink-2">
          <input type="checkbox" checked={wallpaperShuffle} onChange={(e) => set({ wallpaperShuffle: e.target.checked })} className="accent-amber" />
          Shuffle
        </label>
        <label className="flex items-center gap-2 text-sm text-ink-2">
          <input type="checkbox" checked={wallpaperSync} onChange={(e) => set({ wallpaperSync: e.target.checked })} className="accent-amber" />
          Sync to weather &amp; time
        </label>
        <span className="label-caps ml-auto text-ink-3">
          Now: <span className="text-teal">{atmosphere}</span> · <span className="text-amber-soft">{phase}</span>
        </span>
        {msg && <p className="w-full text-xs text-ink-2">{msg}</p>}
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void handle(e.dataTransfer.files);
        }}
        className={`grid grid-cols-2 gap-3 rounded-[20px] transition-shadow sm:grid-cols-3 lg:grid-cols-4 ${dragOver ? "ring-2 ring-teal" : ""}`}
      >
        {items.map((w) => (
          <figure key={w.id} className={`group relative overflow-hidden rounded-[14px] border ${w.id === currentId ? "border-amber/70 glow-amber" : "border-white/10"}`}>
            <button onClick={() => select(w.id)} className="block w-full" aria-label={`Show ${w.name}`}>
              {w.src ? (
                <img src={w.src} alt="" loading="lazy" className={`aspect-video w-full object-cover transition-opacity ${w.enabled ? "" : "opacity-35"}`} />
              ) : (
                <div className="aspect-video w-full animate-pulse bg-white/5" />
              )}
            </button>
            {wallpaperSync && fitsNow.has(w.id) && w.enabled && (
              <span className="label-caps absolute left-2 top-2 rounded-full bg-teal/90 px-2 py-0.5 text-canvas">Fits now</span>
            )}
            {tagging === w.id && <TagEditor id={w.id} tags={w.tags} />}
            <figcaption className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-gradient-to-t from-black/85 to-transparent px-3 pb-2 pt-6">
              <span className="truncate text-[13px] text-ink">{w.name}</span>
              <button
                onClick={() => setTagging(tagging === w.id ? null : w.id)}
                aria-label={`Edit conditions for ${w.name}`}
                aria-expanded={tagging === w.id}
                title="Weather & time tags"
                className={`ml-auto grid size-7 place-items-center rounded-full hover:bg-white/10 ${tagging === w.id ? "text-amber" : "text-ink-2 hover:text-ink"}`}
              >
                <Tags size={14} />
              </button>
              <button
                onClick={() => toggleEnabled(w.id)}
                aria-label={w.enabled ? `Exclude ${w.name} from rotation` : `Include ${w.name} in rotation`}
                title={w.enabled ? "In rotation" : "Excluded"}
                className="grid size-7 place-items-center rounded-full text-ink-2 hover:bg-white/10 hover:text-ink"
              >
                {w.enabled ? <Eye size={14} /> : <EyeOff size={14} />}
              </button>
              {!w.builtin && (
                <button onClick={() => void remove(w.id)} aria-label={`Delete ${w.name}`} className="grid size-7 place-items-center rounded-full text-ink-2 hover:bg-white/10 hover:text-alert">
                  <Trash2 size={14} />
                </button>
              )}
            </figcaption>
          </figure>
        ))}
      </div>
      <p className="mt-3 text-xs text-ink-3">
        Drop images anywhere on the grid. Uploads stay on this device (IndexedDB) and work offline. Tag each scene with the weather and time it
        suits — with sync on, a snowy December evening rotates through your snow + night scenes.
      </p>
    </div>
  );
}

const ATMOS: Atmosphere[] = ["clear", "autumn", "rain", "snow", "fog", "midnight"];

function TagEditor({ id, tags }: { id: string; tags: WallpaperTags }) {
  const setTags = useWallpapers((s) => s.setTags);
  const toggle = <T extends string>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const chip = (on: boolean) =>
    `rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider transition-colors ${
      on ? "border-amber bg-amber/25 text-ink" : "border-white/15 bg-black/40 text-ink-2 hover:text-ink"
    }`;
  return (
    <div className="absolute inset-x-0 top-0 space-y-1.5 bg-black/80 p-2 backdrop-blur-sm">
      <div className="flex flex-wrap gap-1" role="group" aria-label="Weather">
        {ATMOS.map((a) => (
          <button key={a} aria-pressed={tags.atmospheres.includes(a)} className={chip(tags.atmospheres.includes(a))} onClick={() => setTags(id, { ...tags, atmospheres: toggle(tags.atmospheres, a) })}>
            {a}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1" role="group" aria-label="Time of day">
        {PHASES.map((p) => (
          <button key={p} aria-pressed={tags.phases.includes(p)} className={chip(tags.phases.includes(p))} onClick={() => setTags(id, { ...tags, phases: toggle(tags.phases, p) })}>
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}
