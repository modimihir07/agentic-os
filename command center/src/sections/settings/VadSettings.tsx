import { useEffect, useRef, useState } from "react";
import { Mic, Square } from "lucide-react";
import { Card } from "@/components/ui";
import { MicCapture, encodeWav16k, vadMeter } from "@/features/voice/engines";
import { isTauri, nativeRaw } from "@/lib/platform";
import { useSettings } from "@/stores/settings";

/** Map an RMS level onto a 0–100 % bar (log scale so quiet rooms are visible). */
const bar = (rms: number) => Math.max(0, Math.min(100, ((Math.log10(Math.max(rms, 1e-4)) + 4) / 3.3) * 100));

export function VoiceDetectionCard() {
  const vad = useSettings((s) => s.vad);
  const set = useSettings((s) => s.set);
  const up = (p: Partial<typeof vad>) => set({ vad: { ...vad, ...p } });
  const [testing, setTesting] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const mic = useRef<MicCapture | null>(null);
  const level = useRef<HTMLDivElement>(null);
  const floor = useRef<HTMLDivElement>(null);
  const on = useRef<HTMLDivElement>(null);
  const off = useRef<HTMLDivElement>(null);
  const dot = useRef<HTMLSpanElement>(null);
  const prob = useRef<HTMLDivElement>(null);
  const probOn = useRef<HTMLDivElement>(null);
  const probOff = useRef<HTMLDivElement>(null);
  const engine = useRef<HTMLSpanElement>(null);

  // Meter: rAF is fine here (only while this card is on screen).
  useEffect(() => {
    if (!testing) return;
    let raf = 0;
    const draw = () => {
      if (prob.current) prob.current.style.width = `${vadMeter.neural ? vadMeter.prob * 100 : 0}%`;
      if (probOn.current) probOn.current.style.left = `${vadMeter.probOn * 100}%`;
      if (probOff.current) probOff.current.style.left = `${vadMeter.probOff * 100}%`;
      if (engine.current) engine.current.textContent = vadMeter.neural ? "Silero neural VAD" : "energy detector (Silero loading or unavailable)";
      if (level.current) level.current.style.width = `${bar(vadMeter.level)}%`;
      if (floor.current) floor.current.style.left = `${bar(vadMeter.floor)}%`;
      if (on.current) on.current.style.left = `${bar(vadMeter.on)}%`;
      if (off.current) off.current.style.left = `${bar(vadMeter.off)}%`;
      if (dot.current) dot.current.style.opacity = vadMeter.speaking ? "1" : "0.15";
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [testing]);

  const listen = () => {
    const m = (mic.current ??= new MicCapture());
    const t0 = performance.now();
    let speechAt = 0;
    void m
      .start({
        record: true,
        maxSilenceStartMs: 60_000,
        onSpeechStart: () => (speechAt = performance.now()),
        onUtteranceEnd: async (pcm, rate) => {
          const ended = performance.now();
          const secs = (pcm.length / rate).toFixed(1);
          let line = `heard ${secs}s · detected ${Math.round(speechAt - t0)}ms after start · endpoint ${Math.round(ended - speechAt)}ms`;
          if (isTauri()) {
            try {
              const w0 = performance.now();
              const text = await nativeRaw<string>("stt_transcribe", encodeWav16k(pcm, rate));
              line += ` · Whisper ${Math.round(performance.now() - w0)}ms → “${text.trim()}”`;
            } catch (e) {
              line += ` · Whisper failed: ${String(e).slice(0, 80)}`;
            }
          }
          setLog((l) => [line, ...l].slice(0, 6));
          if (mic.current === m) listen(); // keep testing
        },
      })
      .catch((e) => setLog((l) => [`mic error: ${e}`, ...l]));
  };

  const toggle = () => {
    if (testing) {
      mic.current?.stop();
      mic.current = null;
      setTesting(false);
    } else {
      setLog([]);
      setTesting(true);
      listen();
    }
  };
  useEffect(() => () => mic.current?.stop(), []);

  return (
    <Card
      title="Voice detection"
      hint="A local neural model (Silero) scores every 32 ms of audio for speech, so typing, fans and music don't trigger it; Tony sends to Whisper as soon as you pause. If the model can't load, it falls back to measuring loudness above your room's noise. Raise sensitivity if quiet speech is missed; lower it if noise keeps triggering it."
      action={
        <button onClick={toggle} className={testing ? "pill-glass !h-8 text-xs !border-alert/50 text-alert" : "pill-primary !h-8 text-xs"}>
          {testing ? <Square size={12} /> : <Mic size={12} />} {testing ? "Stop test" : "Test my mic"}
        </button>
      }
    >
      <div className="space-y-4">
        <label className="block text-sm text-ink-2">
          Sensitivity
          <div className="mt-1 flex items-center gap-3">
            <span className="w-20 text-[11px] text-ink-3">ignores noise</span>
            <input type="range" min={0} max={100} step={5} value={vad.sensitivity} onChange={(e) => up({ sensitivity: Number(e.target.value) })} className="flex-1 accent-teal" aria-label="Voice detection sensitivity" />
            <span className="w-24 text-right text-[11px] text-ink-3">hears whispers</span>
            <span className="w-10 text-right font-mono text-ink">{vad.sensitivity}</span>
          </div>
        </label>
        <label className="block text-sm text-ink-2">
          End-of-speech pause
          <div className="mt-1 flex items-center gap-3">
            <span className="w-20 text-[11px] text-ink-3">snappy</span>
            <input type="range" min={350} max={1600} step={50} value={vad.endSilenceMs} onChange={(e) => up({ endSilenceMs: Number(e.target.value) })} className="flex-1 accent-amber" aria-label="End-of-speech pause" />
            <span className="w-24 text-right text-[11px] text-ink-3">lets you think</span>
            <span className="w-16 text-right font-mono text-ink">{vad.endSilenceMs}ms</span>
          </div>
        </label>
        <label className="flex items-center gap-3 text-sm text-ink-2">
          Max utterance
          <input type="range" min={5000} max={30000} step={1000} value={vad.maxUtteranceMs} onChange={(e) => up({ maxUtteranceMs: Number(e.target.value) })} className="flex-1 accent-amber" aria-label="Max utterance" />
          <span className="w-12 text-right font-mono text-ink">{vad.maxUtteranceMs / 1000}s</span>
        </label>

        {testing && (
          <div>
            <div className="relative h-6 overflow-hidden rounded-full bg-white/[0.05]">
              <div ref={level} className="h-full rounded-full bg-gradient-to-r from-teal to-amber transition-[width] duration-75" style={{ width: "0%" }} />
              <div ref={floor} className="absolute inset-y-0 w-0.5 bg-white/40" title="noise floor" />
              <div ref={off} className="absolute inset-y-0 w-0.5 bg-amber/60" title="stop threshold" />
              <div ref={on} className="absolute inset-y-0 w-0.5 bg-teal" title="speech threshold" />
            </div>
            <div className="mt-1 flex items-center gap-3 text-[11px] text-ink-3">
              <span className="flex items-center gap-1">
                <span ref={dot} className="size-2 rounded-full bg-teal" /> speech
              </span>
              <span>white = room noise · amber = pause line · teal = trigger line</span>
            </div>
            <div className="relative mt-2 h-3 overflow-hidden rounded-full bg-white/[0.05]" title="speech probability">
              <div ref={prob} className="h-full rounded-full bg-teal/70 transition-[width] duration-75" style={{ width: "0%" }} />
              <div ref={probOff} className="absolute inset-y-0 w-0.5 bg-amber/60" title="pause line" />
              <div ref={probOn} className="absolute inset-y-0 w-0.5 bg-teal" title="trigger line" />
            </div>
            <div className="mt-1 text-[11px] text-ink-3">
              speech probability · deciding: <span ref={engine} className="text-ink-2" />
            </div>
            <ul className="mt-2 space-y-1 font-mono text-[11px] text-ink-2">
              {log.length === 0 && <li className="text-ink-3">Say something…</li>}
              {log.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}
