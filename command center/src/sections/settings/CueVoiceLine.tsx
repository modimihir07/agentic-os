import { useEffect, useRef, useState } from "react";
import { Loader2, Mic2, Play, RefreshCw, Square } from "lucide-react";
import { Field, Select } from "@/components/ui";
import { cmd, isTauri, nativeRaw, type VoicesView } from "@/lib/platform";
import { audio } from "@/features/cues/player";
import type { CueWidget } from "@/features/cues/types";

/** One fetch of the TTS engine's voices, shared by every cue card. */
let voicesP: Promise<VoicesView> | null = null;
const loadVoices = (fresh = false) => {
  if (fresh || !voicesP) {
    voicesP = cmd("tts_voices", {});
    voicesP.catch(() => (voicesP = null));
  }
  return voicesP;
};

const CATEGORY = { cloned: "Cloned voices", professional: "Professional clones", generated: "Designed voices", premade: "Premade voices" } as Record<string, string>;

/**
 * Text-to-speech for a cue: type what to say, pick the voice it's said in (any voice on
 * the TTS engine — e.g. your cloned ElevenLabs voices), preview it, or clone a new voice
 * from an audio sample right here.
 */
export function CueVoiceLine({ cue, onChange }: { cue: CueWidget; onChange: (p: Partial<CueWidget>) => void }) {
  const [view, setView] = useState<VoicesView | null>(null);
  const [text, setText] = useState(cue.intro.text);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const [playing, setPlaying] = useState<AudioBufferSourceNode | null>(null);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => setText(cue.intro.text), [cue.intro.text]);
  useEffect(() => {
    if (isTauri()) void loadVoices().then(setView).catch((e) => setNote({ text: String(e), tone: "err" }));
  }, []);

  const voices = view?.voices ?? [];
  const eleven = view?.engine === "elevenlabs";
  const voice = cue.intro.voice ?? "";
  const missing = voice && view && !voices.some((v) => v.id === voice);
  const groups = eleven
    ? Object.entries(voices.reduce<Record<string, typeof voices>>((g, v) => ((g[CATEGORY[v.category ?? ""] ?? "Other"] ??= []).push(v), g), {}))
    : [["Voices", voices] as const];
  const label = (v: (typeof voices)[number]) => v.label ?? v.id;
  const pick = (id: string) => {
    const v = voices.find((x) => x.id === id);
    onChange({ intro: { ...cue.intro, voice: id || undefined, voiceLabel: v ? label(v) : undefined } });
  };
  const commit = () => text !== cue.intro.text && onChange({ intro: { ...cue.intro, text } });

  const preview = async () => {
    if (playing) {
      playing.stop();
      setPlaying(null);
      return;
    }
    const line = (cue.intro.mode === "static" ? text : "").trim() || `This is ${cue.intro.voiceLabel ?? "Tony"} on your ${cue.name} cue.`;
    setBusy("Synthesizing…");
    setNote(null);
    try {
      const bytes = await cmd("tts_synthesize", voice ? { text: line.slice(0, 2000), voice } : { text: line.slice(0, 2000) });
      const a = audio();
      const src = a.createBufferSource();
      src.buffer = await a.decodeAudioData(bytes);
      src.connect(a.destination);
      src.onended = () => setPlaying(null);
      src.start();
      setPlaying(src);
    } catch (e) {
      setNote({ text: String(e), tone: "err" });
    } finally {
      setBusy(null);
    }
  };

  const clone = async (f: File) => {
    const name = prompt(eleven ? "Name for the new voice (it's added to your ElevenLabs account):" : "Name for the voice file:", f.name.replace(/\.[^.]+$/, ""));
    if (name === null) return;
    setBusy(eleven ? `Cloning “${name}” on ElevenLabs…` : `Uploading ${f.name}…`);
    setNote(null);
    try {
      const id = await nativeRaw<string>("tts_voice_upload", new Uint8Array(await f.arrayBuffer()), { "x-filename": f.name, "x-voice-name": name });
      const fresh = await loadVoices(true);
      setView(fresh);
      const v = fresh.voices.find((x) => x.id === id);
      onChange({ intro: { ...cue.intro, text, voice: id, voiceLabel: v ? label(v) : name } });
      setNote({ text: `“${name}” loaded and set as this cue's voice.`, tone: "ok" });
    } catch (e) {
      setNote({ text: String(e), tone: "err" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-3 rounded-[12px] border border-white/[0.06] p-3">
      <div className="grid gap-3 lg:grid-cols-[180px_1fr]">
        <Field label="Spoken line (text-to-speech)">
          <Select value={cue.intro.mode} onChange={(e) => onChange({ intro: { ...cue.intro, mode: e.target.value as "static" | "llm" } })}>
            <option value="static">Say exactly what I type</option>
            <option value="llm">Generate from prompt</option>
          </Select>
        </Field>
        <Field label="Voice">
          <div className="flex flex-wrap gap-1.5">
            <Select value={voice} onChange={(e) => pick(e.target.value)} className="!min-w-[220px] flex-1" aria-label="Voice for this cue">
              <option value="">Tony's voice (Settings → Voice)</option>
              {missing && <option value={voice}>{cue.intro.voiceLabel ?? voice} — not on {view?.engine}</option>}
              {groups.map(([g, list]) => (
                <optgroup key={g} label={g}>
                  {list.map((v) => (
                    <option key={v.id} value={v.id}>
                      {label(v)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
            <button onClick={() => void loadVoices(true).then(setView)} aria-label="Refresh voices" title="Refresh voices" className="pill-glass !h-10 !w-10 !p-0">
              <RefreshCw size={13} />
            </button>
            <input ref={file} type="file" accept="audio/*" hidden onChange={(e) => (e.target.files?.[0] && void clone(e.target.files[0]), (e.target.value = ""))} />
            <button onClick={() => file.current?.click()} disabled={!!busy || !isTauri()} className="pill-glass !h-10 text-xs" title={eleven ? "Upload 30 s – 2 min of clean speech; ElevenLabs clones it instantly" : "Save a reference voice file into the voices folder"}>
              <Mic2 size={13} /> {eleven ? "Clone a voice from audio" : "Load custom voice"}
            </button>
          </div>
        </Field>
      </div>
      <Field label={cue.intro.mode === "static" ? "What the voice says" : "Prompt (Tony writes a fresh line each time, spoken in the voice above)"} className="mt-3">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          rows={cue.intro.mode === "static" ? 3 : 2}
          maxLength={2000}
          placeholder={cue.intro.mode === "static" ? "Entering Gabagool mode. Somebody get me a plate of capicola." : "Hype me up for lunch, mention the time"}
          className="field w-full resize-y !py-2 text-sm"
        />
      </Field>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <button onClick={() => void preview()} disabled={(!!busy && !playing) || !isTauri()} className="pill-glass !h-8 text-xs">
          {busy && !playing ? <Loader2 size={12} className="animate-spin" /> : playing ? <Square size={12} /> : <Play size={12} />}
          {playing ? "Stop" : cue.intro.mode === "static" ? "Speak it" : "Preview voice"}
        </button>
        <span className="text-ink-3">{busy ?? (cue.intro.mode === "static" ? `${text.length}/2000` : "")}</span>
        {note && <span className={note.tone === "ok" ? "text-teal" : "text-alert"}>{note.text}</span>}
      </div>
    </div>
  );
}
