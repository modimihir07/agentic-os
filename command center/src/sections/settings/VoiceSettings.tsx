import { useEffect, useRef, useState } from "react";
import { Loader2, Play, RefreshCw, Upload } from "lucide-react";
import { Card, Field, Input, Select } from "@/components/ui";
import { cmd, nativeRaw, type VoicesView } from "@/lib/platform";
import { useSettings } from "@/stores/settings";
import { audioContext } from "@/features/voice/engines";
import { modelsFor, useProviders } from "./use-providers";
import { ModelSelect } from "./ServicesSettings";

const LANGS: [string, string][] = [
  ["auto", "Auto-detect"], ["en", "English"], ["fr", "French"], ["es", "Spanish"], ["it", "Italian"], ["pt", "Portuguese"],
  ["de", "German"], ["nl", "Dutch"], ["pl", "Polish"], ["ru", "Russian"], ["uk", "Ukrainian"], ["zh", "Chinese"],
  ["ja", "Japanese"], ["ko", "Korean"], ["hi", "Hindi"], ["pa", "Punjabi"], ["ar", "Arabic"], ["tl", "Tagalog"],
];

/** Whisper STT: model variant, language and input device. */
export function SttCard() {
  const { view, patch } = useProviders();
  const micDeviceId = useSettings((s) => s.micDeviceId);
  const set = useSettings((s) => s.set);
  const [variants, setVariants] = useState<string[]>([]);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stt = view?.providers.find((p) => p.id === view.policy.stt);

  useEffect(() => {
    if (stt) void modelsFor(stt.id, true).then((r) => setVariants(r.models));
  }, [stt?.id, stt?.engine, stt?.modelsDir]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMics = async () => {
    try {
      // Labels are only exposed after mic permission has been granted once.
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
      probe?.getTracks().forEach((t) => t.stop());
      setMics((await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput"));
    } catch {
      setMics([]);
    }
  };
  useEffect(() => void loadMics(), []);

  if (!stt) return null;
  const configure = async (model?: string, language?: string) => {
    setBusy(true);
    setNote(null);
    try {
      setNote(await cmd("stt_configure", { model, language }));
      await useProviders.getState().load();
    } catch (e) {
      setNote(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Speech-to-text · Whisper" hint="Bigger models are more accurate but slower. turbo ≈ large-v3 quality at a fraction of the cost. *.en variants are English-only and faster." action={busy ? <Loader2 size={14} className="animate-spin text-ink-3" /> : null}>
      <div className="grid gap-2 sm:grid-cols-3">
        <Field label="Model">
          <Select value={stt.model} onChange={(e) => void configure(e.target.value)}>
            {[...new Set([stt.model, ...variants])].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </Select>
        </Field>
        <Field label="Language">
          <Select value={stt.language ?? "auto"} onChange={(e) => void configure(undefined, e.target.value)}>
            {LANGS.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Microphone">
          <div className="flex gap-1.5">
            <Select value={micDeviceId} onChange={(e) => set({ micDeviceId: e.target.value })}>
              <option value="">System default</option>
              {mics.map((m) => (
                <option key={m.deviceId} value={m.deviceId}>
                  {m.label || `Mic ${m.deviceId.slice(0, 6)}`}
                </option>
              ))}
            </Select>
            <button type="button" aria-label="Refresh microphones" onClick={() => void loadMics()} className="grid size-10 shrink-0 place-items-center rounded-[12px] border border-white/10 text-ink-2 hover:text-ink">
              <RefreshCw size={14} />
            </button>
          </div>
        </Field>
        <Field label="Engine">
          <Select value={stt.engine ?? "whispercpp"} onChange={(e) => void patch({ id: stt.id, engine: e.target.value })}>
            <option value="whispercpp">whisper.cpp server (hot-swap models)</option>
            <option value="openai">OpenAI-compatible (speaches / faster-whisper)</option>
          </Select>
        </Field>
        <Field label="Endpoint">
          <Input defaultValue={stt.baseUrl} onBlur={(e) => e.target.value !== stt.baseUrl && void patch({ id: stt.id, baseUrl: e.target.value })} className="font-mono !text-[12px]" spellCheck={false} />
        </Field>
        <Field label="Models folder (ggml-*.bin)">
          <Input defaultValue={stt.modelsDir ?? ""} placeholder="C:\\whisper\\models" onBlur={(e) => e.target.value !== (stt.modelsDir ?? "") && void patch({ id: stt.id, modelsDir: e.target.value })} className="font-mono !text-[12px]" spellCheck={false} />
        </Field>
      </div>
      {note && <p className={`mt-2 text-xs ${/not found|fail|error|unreach/i.test(note) ? "text-alert" : "text-teal"}`}>{note}</p>}
    </Card>
  );
}

/** TTS voice manager: dropdown of every installed voice, preview, and custom-voice upload. */
export function TtsCard() {
  const { view, patch, policy } = useProviders();
  const [voices, setVoices] = useState<VoicesView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const tts = view?.providers.find((p) => p.id === view.policy.tts);

  const load = async () => {
    try {
      setVoices(await cmd("tts_voices"));
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  };
  useEffect(() => void load(), [tts?.baseUrl, tts?.engine, tts?.voicesDir]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!tts) return null;

  const preview = async (voice: string) => {
    setBusy(`Previewing ${voice}…`);
    try {
      const bytes = await cmd("tts_synthesize", { text: `Hi, I'm ${useSettings.getState().osName || "Tony"}. This is how I'll sound on your command center.`, voice });
      const ac = await audioContext();
      const buf = await ac.decodeAudioData(bytes);
      const src = ac.createBufferSource();
      src.buffer = buf;
      src.connect(ac.destination);
      src.start();
      setBusy(null);
    } catch (e) {
      setBusy(`Preview failed: ${String(e)}`);
    }
  };

  const upload = async (f: File) => {
    setBusy(`Uploading ${f.name}…`);
    try {
      const id = await nativeRaw<string>("tts_voice_upload", new Uint8Array(await f.arrayBuffer()), { "x-filename": f.name });
      await load();
      if (/\.(wav|mp3|flac|ogg)$/i.test(f.name) && tts.engine !== "xtts") {
        setBusy(`Saved “${id}”. Reference audio clones a voice with XTTS — switch the engine to Coqui XTTS to use it.`);
      } else {
        await patch({ id: tts.id, voice: id });
        setBusy(`Added and selected “${id}”.`);
      }
    } catch (e) {
      setBusy(`Upload failed: ${String(e)}`);
    }
  };

  const current = tts.voice ?? voices?.current ?? "";
  const list = voices?.voices ?? [];
  const eleven = tts.engine === "elevenlabs";
  const ttsProviders = view?.providers.filter((x) => x.kind === "tts") ?? [];
  const label = (id: string) => list.find((v) => v.id === id)?.label ?? id;
  // ElevenLabs groups by category (cloned first); local engines by server vs custom file.
  const groups: [string, typeof list][] = eleven
    ? (["cloned", "professional", "generated", "premade"] as const)
        .map((c) => [CATEGORY_LABEL[c], list.filter((v) => (v.category ?? "premade") === c)] as [string, typeof list])
        .concat([["Other", list.filter((v) => !["cloned", "professional", "generated", "premade"].includes(v.category ?? "premade"))]])
        .filter(([, vs]) => vs.length > 0)
    : [
        ["Server voices", list.filter((v) => v.source === "server")],
        ["Custom voices", list.filter((v) => v.source === "custom")],
      ];
  const cloned = list.filter((v) => v.category === "cloned").length;

  return (
    <Card
      title="Text-to-speech · voices"
      hint={
        eleven
          ? "Your ElevenLabs account's voices, fetched live — cloned voices first. Tony speaks with exactly the voice ID you pick. If ElevenLabs is offline or out of quota, live replies fall back to local Kokoro."
          : "Kokoro ships dozens of voices; Coqui XTTS clones a voice from a few seconds of reference audio. Custom files are saved to the voices folder — mount it into the TTS container so it can load them."
      }
    >
      <div className="grid gap-2 sm:grid-cols-[1.4fr_auto]">
        <Field label="Speaking engine">
          <Select value={view?.policy.tts ?? tts.id} onChange={(e) => void policy({ tts: e.target.value })}>
            {ttsProviders.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
                {x.engine === "elevenlabs" ? " (cloud)" : " (local)"}
              </option>
            ))}
          </Select>
        </Field>
        {eleven ? <ModelSelect provider={tts} onChange={(model) => void patch({ id: tts.id, model })} /> : <span />}

        <Field label={eleven ? `Voice${list.length ? ` (${list.length} on your account${cloned ? `, ${cloned} cloned` : ""})` : ""}` : `Voice${list.length ? ` (${list.length} installed)` : ""}`}>
          <Select value={current} onChange={(e) => void patch({ id: tts.id, voice: e.target.value })}>
            {!list.some((v) => v.id === current) && current && <option value={current}>{eleven ? `${current} (not on this account)` : current}</option>}
            {groups.map(([name, vs]) => (
              <optgroup key={name} label={name}>
                {vs.map((v) => (
                  <option key={v.id} value={v.id}>
                    {eleven ? `${v.label ?? v.id} · ${v.id}` : v.file ? `${v.id} (${v.file})` : v.id}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </Field>
        <div className="flex items-end gap-2">
          <button className="pill-glass !h-10 text-xs" onClick={() => void preview(current)} disabled={!current} title={eleven ? "Uses ElevenLabs characters" : undefined}>
            <Play size={13} /> Preview
          </button>
          {eleven ? (
            <button className="pill-glass !h-10 text-xs" onClick={() => void load()} title="Re-fetch voices from ElevenLabs">
              <RefreshCw size={13} /> Refresh voices
            </button>
          ) : (
            <>
              <button className="pill-primary !h-10 text-xs" onClick={() => file.current?.click()}>
                <Upload size={13} /> Add / load custom voice
              </button>
              <input
                ref={file}
                type="file"
                hidden
                accept=".wav,.mp3,.flac,.ogg,.pt,.pth,.onnx,.json"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void upload(f);
                  e.target.value = "";
                }}
              />
            </>
          )}
        </div>

        {eleven ? (
          <p className="text-xs text-ink-3 sm:col-span-2">
            Selected: <span className="text-ink">{label(current)}</span> <span className="font-mono">({current || "none"})</span> · API key:{" "}
            <span className={voices?.keySource === "missing" ? "text-alert" : "text-teal"}>{KEY_SOURCE[voices?.keySource ?? "missing"]}</span>
          </p>
        ) : (
          <>
            <Field label="Engine">
              <Select value={tts.engine ?? "kokoro"} onChange={(e) => void patch({ id: tts.id, engine: e.target.value })}>
                <option value="kokoro">Kokoro-FastAPI (/v1/audio/speech)</option>
                <option value="xtts">Coqui XTTS api-server (voice cloning)</option>
              </Select>
            </Field>
            <Field label="Endpoint">
              <Input defaultValue={tts.baseUrl} onBlur={(e) => e.target.value !== tts.baseUrl && void patch({ id: tts.id, baseUrl: e.target.value })} className="font-mono !text-[12px]" spellCheck={false} />
            </Field>
            <Field label="Voices folder" className="sm:col-span-2">
              <Input defaultValue={tts.voicesDir ?? voices?.voicesDir ?? ""} onBlur={(e) => e.target.value !== (tts.voicesDir ?? "") && void patch({ id: tts.id, voicesDir: e.target.value })} className="font-mono !text-[12px]" spellCheck={false} />
            </Field>
          </>
        )}
      </div>
      {(err || voices?.serverError) && (
        <p className="mt-2 text-xs text-alert">
          {eleven ? "ElevenLabs" : "TTS server"}: {err ?? voices?.serverError}
          {eleven ? "" : " — custom voices still listed."}
        </p>
      )}
      {busy && <p className={`mt-2 text-xs ${/fail/i.test(busy) ? "text-alert" : "text-teal"}`}>{busy}</p>}
    </Card>
  );
}

const CATEGORY_LABEL = { cloned: "Cloned voices", professional: "Professional clones", generated: "Designed voices", premade: "Premade voices" } as const;

const KEY_SOURCE: Record<NonNullable<VoicesView["keySource"]>, string> = {
  env: "ELEVENLABS_API_KEY environment variable",
  "env-file": "project .env (ELEVENLABS_API_KEY)",
  keychain: "OS keychain",
  missing: "missing — run npx -y @elevenlabs/cli@latest onboard init",
};
