import { useEffect, useRef, useState } from "react";
import { Loader2, Music, Play, Plus, Square, Trash2, Upload, Volume2, Zap } from "lucide-react";
import { Card, Field, Input, Select } from "@/components/ui";
import { cc, useCollection } from "@/lib/cc-api";
import { SECTIONS } from "@/stores/nav";
import { THREADS } from "@/features/voice/voice-store";
import { loadBuffer, peaks, playClip, useCueRun, type Playing } from "@/features/cues/player";
import { fireCue } from "@/features/cues/cue-runtime";
import { newClip, type AudioClip, type CueWidget, type ThemeClip } from "@/features/cues/types";
import { CueVoiceLine } from "./CueVoiceLine";

const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const fmt = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}` : `${s.toFixed(1)}s`);

/** Settings → Voice & Triggers: modular cue widgets (Gabagool Mode, Startup Welcome, your own). */
export function CueStudio() {
  const { items, loaded, create, update, remove } = useCollection<CueWidget>("cues");
  const running = useCueRun((s) => s.running);
  const stop = useCueRun((s) => s.stopAll);
  const cues = [...items].sort((a, b) => (a.builtin ? 0 : 1) - (b.builtin ? 0 : 1) || a._created - b._created);
  return (
    <Card
      title="Voice & triggers — cue widgets"
      hint="Each widget fires on a phrase you say or type, at a time of day, or at startup: Tony speaks a line (static or generated), a trimmed soundbite plays, and a trimmed theme track runs underneath — ducked while Tony and the soundbite talk."
      action={
        <>
          {running && (
            <button onClick={stop} className="pill-glass !h-8 text-xs !border-alert/50 text-alert">
              <Square size={12} /> Stop “{running}”
            </button>
          )}
          <button
            onClick={() => void create({ name: "New cue", enabled: true, phrases: [], time: "", days: [], startup: false, intro: { mode: "static", text: "" }, soundbite: null, theme: null, action: { kind: "none", value: "" } })}
            className="pill-primary !h-8 text-xs"
          >
            <Plus size={13} /> Add event / cue widget
          </button>
        </>
      }
    >
      {!loaded && <Loader2 size={14} className="animate-spin text-ink-3" />}
      <div className="space-y-3">
        {cues.map((c) => (
          <CueCard key={c.id} cue={c} onChange={(p) => void update(c.id, p)} onDelete={() => void remove(c.id)} />
        ))}
      </div>
    </Card>
  );
}

function CueCard({ cue, onChange, onDelete }: { cue: CueWidget & { id: string }; onChange: (p: Partial<CueWidget>) => void; onDelete: () => void }) {
  const [phrases, setPhrases] = useState(cue.phrases.join(", "));
  useEffect(() => setPhrases(cue.phrases.join(", ")), [cue.phrases]);
  return (
    <section className={`rounded-[16px] border p-4 ${cue.enabled ? "border-white/10 bg-white/[0.02]" : "border-white/5 opacity-60"}`}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button role="switch" aria-checked={cue.enabled} aria-label={`Enable ${cue.name}`} onClick={() => onChange({ enabled: !cue.enabled })} className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${cue.enabled ? "bg-teal/80" : "bg-white/15"}`}>
          <span className={`absolute top-0.5 size-4 rounded-full bg-white shadow transition-[left] duration-200 ${cue.enabled ? "left-[18px]" : "left-0.5"}`} />
        </button>
        <input key={cue.name} defaultValue={cue.name} onBlur={(e) => e.target.value.trim() && e.target.value !== cue.name && onChange({ name: e.target.value.trim() })} className="field !h-8 !w-56 !py-1 text-sm font-medium" aria-label="Widget name" />
        {cue.builtin === "gabagool" && <span className="text-sm">🍝</span>}
        <button onClick={() => fireCue(cue)} className="pill-primary ml-auto !h-8 text-xs">
          <Play size={12} /> Test full sequence
        </button>
        {!cue.builtin && (
          <button onClick={() => confirm(`Delete “${cue.name}”?`) && onDelete()} aria-label="Delete widget" className="pill-glass !h-8 !w-8 !p-0 hover:!border-alert/50">
            <Trash2 size={12} />
          </button>
        )}
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <Field label="Voice / text cue phrases (comma-separated)">
          <Input value={phrases} onChange={(e) => setPhrases(e.target.value)} onBlur={() => onChange({ phrases: phrases.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean) })} placeholder="enter gabagool mode, lock in" />
        </Field>
        <Field label="Time of day (optional)">
          <div className="flex gap-1.5">
            <Input type="time" value={cue.time} onChange={(e) => onChange({ time: e.target.value })} className="!w-32 font-mono" />
            <div className="flex flex-wrap gap-0.5">
              {DAYS.map((d, i) => {
                const on = cue.days.includes(i);
                return (
                  <button key={d} onClick={() => onChange({ days: on ? cue.days.filter((x) => x !== i) : [...cue.days, i].sort() })} className={`h-7 w-7 rounded-full text-[10px] ${on ? "bg-amber/25 text-amber-light" : "text-ink-3 hover:text-ink"}`} title={cue.days.length ? "" : "No days selected = every day"}>
                    {d}
                  </button>
                );
              })}
            </div>
          </div>
        </Field>
        <Field label="Startup">
          <label className="flex h-10 items-center gap-2 text-sm text-ink-2">
            <input type="checkbox" checked={cue.startup} onChange={(e) => onChange({ startup: e.target.checked })} className="accent-teal" /> Fire when the Command Center launches
          </label>
        </Field>
      </div>

      <CueVoiceLine cue={cue} onChange={onChange} />

      <div className="mt-3 space-y-3">
        <ClipRow label="Soundbite / voice clip" icon={<Volume2 size={13} />} clip={cue.soundbite} onChange={(c) => onChange({ soundbite: c })} />
        <ClipRow
          label="Theme music"
          icon={<Music size={13} />}
          clip={cue.theme}
          theme
          onChange={(c) => onChange({ theme: c ? ({ duck: true, duckLevel: 22, ...(cue.theme ?? {}), ...c } as ThemeClip) : null })}
        />
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-[180px_1fr]">
        <Field label="OS action after the cue">
          <Select value={cue.action.kind} onChange={(e) => onChange({ action: { kind: e.target.value as CueWidget["action"]["kind"], value: "" } })}>
            <option value="none">None</option>
            <option value="tab">Open a tab</option>
            <option value="thread">Switch agent thread</option>
            <option value="prompt">Send Tony a prompt</option>
          </Select>
        </Field>
        {cue.action.kind === "tab" && (
          <Field label="Tab">
            <Select value={cue.action.value} onChange={(e) => onChange({ action: { ...cue.action, value: e.target.value } })}>
              <option value="">Pick…</option>
              {SECTIONS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {cue.action.kind === "thread" && (
          <Field label="Thread">
            <Select value={cue.action.value} onChange={(e) => onChange({ action: { ...cue.action, value: e.target.value } })}>
              <option value="">Pick…</option>
              {THREADS.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </Select>
          </Field>
        )}
        {cue.action.kind === "prompt" && (
          <Field label="Prompt">
            <Input key={cue.action.value} defaultValue={cue.action.value} onBlur={(e) => onChange({ action: { ...cue.action, value: e.target.value } })} placeholder="Give me my top 3 tasks for today" />
          </Field>
        )}
      </div>
    </section>
  );
}

/** Loader + non-destructive dual-handle trimmer with a mini waveform. */
function ClipRow({ label, icon, clip, theme, onChange }: { label: string; icon: React.ReactNode; clip: AudioClip | ThemeClip | null; theme?: boolean; onChange: (c: AudioClip | null) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [wave, setWave] = useState<number[] | null>(null);
  const [preview, setPreview] = useState<Playing | null>(null);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setWave(null);
    if (clip) void loadBuffer(clip.fileId).then((b) => setWave(peaks(b))).catch((e) => setErr(String(e)));
  }, [clip?.fileId]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = async (f: File) => {
    setBusy(true);
    setErr(null);
    try {
      const up = await cc.upload(f, f.name);
      const buf = await loadBuffer(up.id);
      onChange({ ...newClip(up.id, f.name, buf.duration), ...(theme ? { loop: false } : {}) });
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };
  const set = (p: Partial<AudioClip & ThemeClip>) => clip && onChange({ ...clip, ...p });
  const dur = clip?.duration ?? 0;
  const pct = (t: number) => (dur ? (t / dur) * 100 : 0);
  const togglePreview = async () => {
    if (preview) {
      preview.stop(150);
      setPreview(null);
      return;
    }
    if (!clip) return;
    const p = await playClip({ ...clip, loop: false });
    setPreview(p);
    void p.done.then(() => setPreview(null));
  };

  return (
    <div className="rounded-[12px] border border-white/[0.06] p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="flex items-center gap-1.5 text-ink">
          {icon} {label}
        </span>
        {clip && <span className="truncate font-mono text-[11px] text-ink-3">{clip.name} · {fmt(dur)}</span>}
        <input ref={file} type="file" accept="audio/*" hidden onChange={(e) => e.target.files?.[0] && void load(e.target.files[0])} />
        <button onClick={() => file.current?.click()} className="pill-glass ml-auto !h-8 text-xs" disabled={busy}>
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />} {clip ? "Replace" : "Load audio"}
        </button>
        {clip && (
          <button onClick={() => onChange(null)} aria-label={`Remove ${label}`} className="pill-glass !h-8 !w-8 !p-0">
            <Trash2 size={12} />
          </button>
        )}
      </div>
      {err && <p className="mt-1 text-xs text-alert">{err}</p>}
      {clip && (
        <>
          <div className="relative mt-2 h-14 overflow-hidden rounded-[8px] bg-white/[0.03]">
            <div className="absolute inset-0 flex items-center gap-px px-px">
              {(wave ?? []).map((v, i) => {
                const t = (i / (wave?.length ?? 1)) * dur;
                const inside = t >= clip.inPoint && t <= clip.outPoint;
                return <span key={i} className={`flex-1 rounded-full ${inside ? "bg-teal/80" : "bg-white/15"}`} style={{ height: `${Math.max(4, v * 100)}%` }} />;
              })}
            </div>
            <div className="pointer-events-none absolute inset-y-0 border-l-2 border-amber" style={{ left: `${pct(clip.inPoint)}%` }} />
            <div className="pointer-events-none absolute inset-y-0 border-l-2 border-amber" style={{ left: `${pct(clip.outPoint)}%` }} />
            {/* Two overlaid range inputs = dual-handle trimmer (only the thumbs take pointer events). */}
            <input type="range" min={0} max={dur} step={0.1} value={clip.inPoint} aria-label="Start time" onChange={(e) => set({ inPoint: Math.min(Number(e.target.value), clip.outPoint - 0.1) })} className="trim-range absolute inset-0 w-full" />
            <input type="range" min={0} max={dur} step={0.1} value={clip.outPoint} aria-label="End time" onChange={(e) => set({ outPoint: Math.max(Number(e.target.value), clip.inPoint + 0.1) })} className="trim-range absolute inset-0 w-full" />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-ink-2">
            <label className="flex items-center gap-1">
              Start
              <input type="number" min={0} max={dur} step={0.1} value={clip.inPoint} onChange={(e) => set({ inPoint: Math.max(0, Math.min(Number(e.target.value), clip.outPoint - 0.1)) })} className="field !h-7 !w-20 !py-0 font-mono !text-[12px]" />s
            </label>
            <label className="flex items-center gap-1">
              End
              <input type="number" min={0} max={dur} step={0.1} value={clip.outPoint} onChange={(e) => set({ outPoint: Math.min(dur, Math.max(Number(e.target.value), clip.inPoint + 0.1)) })} className="field !h-7 !w-20 !py-0 font-mono !text-[12px]" />s
            </label>
            <span className="font-mono text-amber-light">Clip {fmt(clip.outPoint - clip.inPoint)}</span>
            <label className="flex items-center gap-1">
              Vol
              <input type="range" min={0} max={100} value={clip.volume} onChange={(e) => set({ volume: Number(e.target.value) })} className="w-20 accent-teal" />
              <span className="w-8 font-mono">{clip.volume}%</span>
            </label>
            <label className="flex items-center gap-1">
              Fade in
              <input type="number" min={0} max={5000} step={50} value={clip.fadeInMs} onChange={(e) => set({ fadeInMs: Number(e.target.value) })} className="field !h-7 !w-20 !py-0 font-mono !text-[12px]" />ms
            </label>
            <label className="flex items-center gap-1">
              out
              <input type="number" min={0} max={5000} step={50} value={clip.fadeOutMs} onChange={(e) => set({ fadeOutMs: Number(e.target.value) })} className="field !h-7 !w-20 !py-0 font-mono !text-[12px]" />ms
            </label>
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={clip.loop} onChange={(e) => set({ loop: e.target.checked })} className="accent-teal" /> Loop
            </label>
            {theme && "duck" in clip && (
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={clip.duck} onChange={(e) => set({ duck: e.target.checked })} className="accent-amber" /> Duck to
                <input type="number" min={5} max={60} value={clip.duckLevel} onChange={(e) => set({ duckLevel: Number(e.target.value) })} className="field !h-7 !w-14 !py-0 font-mono !text-[12px]" />%
              </label>
            )}
            <button onClick={() => void togglePreview()} className="pill-glass ml-auto !h-7 text-[11px]">
              {preview ? <Square size={11} /> : <Zap size={11} />} {preview ? "Stop" : "Preview trimmed selection"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
