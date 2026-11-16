import { useState, type ReactNode } from "react";
import { KeyRound, ShieldCheck, Trash2 } from "lucide-react";
import { useSettings } from "@/stores/settings";
import { Waveform } from "@/features/voice/Waveform";
import { cmd, isTauri, type ProviderInfo } from "@/lib/platform";
import { usePoll } from "@/lib/use-poll";

export function SettingsSection() {
  const s = useSettings();
  return (
    <div className="mx-auto h-full w-full max-w-3xl space-y-4 overflow-y-auto px-4 pb-28 md:px-6 md:pb-8">
      <Card title="Gateway" hint="Agentic OS backend (server.py). On your phone, use the desktop's NetBird IP, e.g. http://100.x.y.z:8080.">
        <input className="field font-mono" value={s.gatewayUrl} onChange={(e) => s.set({ gatewayUrl: e.target.value })} spellCheck={false} aria-label="Gateway URL" />
      </Card>

      <Card title="Voice waveform" hint="Colour ramp left → right and stroke weight.">
        <div className="well mb-3 rounded-[14px] px-3">
          <Waveform state="speaking" height={72} />
        </div>
        <div className="flex flex-wrap items-center gap-4">
          {s.waveColors.map((c, i) => (
            <label key={i} className="flex items-center gap-2 font-mono text-xs text-ink-2">
              <input
                type="color"
                value={c}
                onChange={(e) => {
                  const next = [...s.waveColors] as [string, string, string];
                  next[i] = e.target.value;
                  s.set({ waveColors: next });
                }}
                className="size-8 cursor-pointer rounded-full border border-white/10 bg-transparent"
                aria-label={`Waveform colour ${i + 1}`}
              />
              {c.toUpperCase()}
            </label>
          ))}
          <label className="flex items-center gap-2 text-sm text-ink-2">
            Weight
            <input type="range" min={1.5} max={6} step={0.5} value={s.waveThickness} onChange={(e) => s.set({ waveThickness: Number(e.target.value) })} className="accent-amber" />
          </label>
          <button className="pill-glass !h-8 text-xs" onClick={() => s.set({ waveColors: ["#00F0FF", "#A855F7", "#FF6B4A"], waveThickness: 3 })}>
            Stitch default
          </button>
          <button className="pill-glass !h-8 text-xs" onClick={() => s.set({ waveColors: ["#75FFE0", "#00E5C3", "#FF7A2F"] })}>
            Teal / amber
          </button>
        </div>
      </Card>

      <Card title="Confirmation gate" hint="Anything that changes, sends, books, pays or deletes is read back and waits for your “yes” or a tap. If you don't answer in time, it cancels itself. This can't be turned off.">
        <label className="flex items-center gap-3 text-sm text-ink-2">
          Auto-cancel after
          <input type="range" min={10} max={120} step={5} value={s.confirmTimeoutSec} onChange={(e) => s.set({ confirmTimeoutSec: Number(e.target.value) })} className="accent-amber" />
          <span className="w-12 font-mono text-ink tabular">{s.confirmTimeoutSec}s</span>
        </label>
      </Card>

      <Card title="Weather location" hint="Leave empty to use this device's location.">
        <LocationForm />
      </Card>

      <Card title="Identity & mantra">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Callsign">
            <input className="field font-mono" value={s.identity.callsign} onChange={(e) => s.set({ identity: { ...s.identity, callsign: e.target.value } })} />
          </Field>
          <Field label="Status line">
            <input className="field font-mono" value={s.identity.subtitle} onChange={(e) => s.set({ identity: { ...s.identity, subtitle: e.target.value } })} />
          </Field>
          {s.mantra.lines.map((line, i) => (
            <Field key={i} label={`Mantra ${i + 1}`}>
              <input
                className="field"
                value={line}
                onChange={(e) => {
                  const lines = [...s.mantra.lines] as [string, string, string];
                  lines[i] = e.target.value;
                  s.set({ mantra: { ...s.mantra, lines } });
                }}
              />
            </Field>
          ))}
        </div>
      </Card>

      {isTauri() ? (
        <Card title="LLM providers & keys" hint="Keys go straight into the OS keychain via Rust and are never readable from the UI again. A key is bound to its provider's host — changing the URL invalidates it.">
          <Providers />
        </Card>
      ) : (
        <Card title="LLM providers">
          <p className="text-sm text-ink-2">
            On mobile, all model calls run through the gateway — no API keys are stored in this browser. Manage providers in the desktop app.
          </p>
        </Card>
      )}
    </div>
  );
}

function LocationForm() {
  const { weatherLocation, set } = useSettings();
  const [lat, setLat] = useState(weatherLocation?.lat?.toString() ?? "");
  const [lon, setLon] = useState(weatherLocation?.lon?.toString() ?? "");
  const [label, setLabel] = useState(weatherLocation?.label ?? "");
  return (
    <form
      className="grid gap-3 sm:grid-cols-[1fr_1fr_1.4fr_auto]"
      onSubmit={(e) => {
        e.preventDefault();
        const la = Number(lat), lo = Number(lon);
        set({ weatherLocation: lat && lon && Number.isFinite(la) && Number.isFinite(lo) ? { lat: la, lon: lo, label: label || "Saved location" } : null });
      }}
    >
      <input className="field font-mono" placeholder="Lat 43.65" value={lat} onChange={(e) => setLat(e.target.value)} aria-label="Latitude" inputMode="decimal" />
      <input className="field font-mono" placeholder="Lon -79.38" value={lon} onChange={(e) => setLon(e.target.value)} aria-label="Longitude" inputMode="decimal" />
      <input className="field" placeholder="Label (Toronto)" value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Location label" />
      <button className="pill-glass" type="submit">
        Save
      </button>
    </form>
  );
}

function Providers() {
  const { data, error, refresh } = usePoll(() => cmd("providers_list"), 60_000);
  if (error) return <p className="text-sm text-alert">{error}</p>;
  return (
    <ul className="space-y-2">
      {(data ?? []).map((p) => (
        <ProviderRow key={p.id} p={p} onChange={refresh} />
      ))}
    </ul>
  );
}

function ProviderRow({ p, onChange }: { p: ProviderInfo; onChange: () => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <li className="rounded-[14px] border border-white/[0.06] bg-white/[0.02] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-ink">{p.label}</span>
        <span className="label-caps text-amber-soft">{p.kind}</span>
        <span className="font-mono text-[11px] text-ink-3">{p.model}</span>
        <span className="ml-auto truncate font-mono text-[11px] text-ink-3">{p.baseUrl}</span>
      </div>
      {p.needsKey && (
        <form
          className="mt-2 flex items-center gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!key) return;
            setBusy(true);
            try {
              await cmd("secret_set", { provider: p.id, value: key });
              setKey("");
              onChange();
            } finally {
              setBusy(false);
            }
          }}
        >
          {p.hasKey ? (
            <span className="flex items-center gap-1.5 text-xs text-teal">
              <ShieldCheck size={14} /> Key stored in keychain
            </span>
          ) : (
            <KeyRound size={14} className="text-amber" />
          )}
          <input
            type="password"
            autoComplete="off"
            className="field !h-9 !py-1 font-mono"
            placeholder={p.hasKey ? "Replace key…" : "Paste API key"}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            aria-label={`${p.label} API key`}
          />
          <button className="pill-glass !h-9 shrink-0 text-xs" disabled={busy || !key}>
            Save
          </button>
          {p.hasKey && (
            <button
              type="button"
              aria-label={`Delete ${p.label} key`}
              className="grid size-9 shrink-0 place-items-center rounded-full text-ink-2 hover:text-alert"
              onClick={async () => {
                await cmd("secret_delete", { provider: p.id });
                onChange();
              }}
            >
              <Trash2 size={14} />
            </button>
          )}
        </form>
      )}
    </li>
  );
}

function Card({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="glass rounded-[20px] p-5">
      <h2 className="label-caps text-amber-soft">{title}</h2>
      {hint && <p className="mb-3 mt-1 text-xs text-ink-3">{hint}</p>}
      <div className={hint ? "" : "mt-3"}>{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="label-caps text-ink-3">{label}</span>
      {children}
    </label>
  );
}
