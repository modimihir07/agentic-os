import { useEffect, useRef } from "react";
import { useSettings } from "@/stores/settings";
import { useOsName } from "@/features/os/os-store";
import { vadMeter } from "./engines";
import { setWakeMode } from "./voice-controller";
import { useVoice } from "./voice-store";

/** RMS → 0–100 % on a log scale (same as the Settings meter). */
const bar = (rms: number) => Math.max(0, Math.min(100, ((Math.log10(Math.max(rms, 1e-4)) + 4) / 3.3) * 100));

/**
 * Pop-up voice controls: hands-free Listening on/off, "needs Hey Tony", and the
 * sensitivity slider with a live meter (your voice vs the trigger line).
 */
export function ListenControls() {
  const name = useOsName();
  const wakeMode = useSettings((s) => s.wakeMode);
  const wakeRequire = useSettings((s) => s.wakeRequire);
  const vad = useSettings((s) => s.vad);
  const set = useSettings((s) => s.set);
  const state = useVoice((s) => s.state);
  const level = useRef<HTMLDivElement>(null);
  const on = useRef<HTMLDivElement>(null);
  const floor = useRef<HTMLDivElement>(null);
  const live = state === "listening" || state === "transcribing";

  useEffect(() => {
    if (!live) return;
    let raf = 0;
    const draw = () => {
      // Neural VAD: show speech probability vs its trigger line; else loudness vs the energy line.
      const n = vadMeter.neural;
      if (level.current) level.current.style.width = `${n ? vadMeter.prob * 100 : bar(vadMeter.level)}%`;
      if (on.current) on.current.style.left = `${n ? vadMeter.probOn * 100 : bar(vadMeter.on)}%`;
      if (floor.current) floor.current.style.opacity = n ? "0" : "1";
      if (floor.current && !n) floor.current.style.left = `${bar(vadMeter.floor)}%`;
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [live]);

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 pb-2">
      <button
        role="switch"
        aria-checked={wakeMode}
        onClick={() => setWakeMode(!wakeMode)}
        title={wakeMode ? "Hands-free: the mic stays open" : "Off: the mic only opens when you tap it or press Ctrl+Shift+Space"}
        className="flex items-center gap-2 text-xs"
      >
        <span className={`relative h-5 w-9 rounded-full transition-colors ${wakeMode ? "bg-teal/80" : "bg-white/15"}`}>
          <span className={`absolute top-0.5 size-4 rounded-full bg-white shadow transition-[left] duration-200 ${wakeMode ? "left-[18px]" : "left-0.5"}`} />
        </span>
        <span className={wakeMode ? "text-teal" : "text-ink-2"}>Listening {wakeMode ? "on" : "off"}</span>
      </button>
      {wakeMode && (
        <button
          onClick={() => set({ wakeRequire: !wakeRequire })}
          aria-pressed={wakeRequire}
          className={`rounded-full border px-2.5 py-0.5 text-[11px] ${wakeRequire ? "border-amber/50 bg-amber/10 text-amber-light" : "border-white/10 text-ink-3"}`}
          title={wakeRequire ? `Only acts on lines that start with “Hey ${name}”` : "Acts on everything it hears"}
        >
          {wakeRequire ? `Needs “Hey ${name}”` : "Any speech"}
        </button>
      )}
      <label className="flex min-w-[220px] flex-1 items-center gap-2 text-[11px] text-ink-3">
        Sensitivity
        <span className="relative flex-1">
          <input type="range" min={0} max={100} step={5} value={vad.sensitivity} onChange={(e) => set({ vad: { ...vad, sensitivity: Number(e.target.value) } })} className="w-full accent-teal" aria-label="Voice sensitivity" />
          {live && (
            <span className="pointer-events-none absolute inset-x-0 -bottom-1.5 h-1 overflow-hidden rounded-full bg-white/10">
              <span ref={level} className="block h-full bg-gradient-to-r from-teal to-amber" style={{ width: "0%" }} />
              <span ref={floor} className="absolute inset-y-0 w-px bg-white/50" />
              <span ref={on} className="absolute inset-y-0 w-0.5 bg-teal" />
            </span>
          )}
        </span>
        <span className="w-7 text-right font-mono text-ink-2">{vad.sensitivity}</span>
      </label>
    </div>
  );
}
