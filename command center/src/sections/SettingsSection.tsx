import { useState } from "react";
import { useSettings } from "@/stores/settings";
import { Waveform } from "@/features/voice/Waveform";
import { VoiceOrb } from "@/features/voice/VoiceOrb";
import { isTauri } from "@/lib/platform";
import { Card, Field, Input, Select, SubTabs } from "@/components/ui";
import { GatewayStatusCard, OrchestratorCard, VerifierCard } from "./settings/ServicesSettings";
import { AgentVoiceRoster, SttCard, TtsCard } from "./settings/VoiceSettings";
import { GoogleCard, LocalLlmCard, N8nCard } from "./settings/IntegrationSettings";
import { BridgeCard, PipelinesCard } from "./settings/PipelineSettings";
import { ComputeCard, DropletCard, MarketDataCard, OsIdentityCard, OsPermissionsCard, OverseerCard, PrivacyShieldCard, WorkspacesCard } from "./settings/OsSettings";
import { McpRegistryCard, SkillsLibraryCard } from "./settings/LibrarySettings";
import { MemoryLifecycleCard } from "./settings/MemorySettings";
import { AiProvidersCard, CliHubCard, ComputeRouterCard, ModelLabCard, ModelLibraryCard } from "./settings/HubSettings";
import { CueStudio } from "./settings/CueStudio";
import { VoiceDetectionCard } from "./settings/VadSettings";
import { RoutingSettings } from "./settings/RoutingSettings";
import { GlassOpacitySlider } from "@/features/os/OsControls";

type Tab = "services" | "voice" | "integrations" | "business" | "appearance";
const TABS: { id: Tab; label: string }[] = [
  { id: "services", label: "Services" },
  { id: "voice", label: "Voice & Triggers" },
  { id: "integrations", label: "Integrations" },
  { id: "business", label: "Business" },
  { id: "appearance", label: "Appearance" },
];

export function SettingsSection() {
  const [tab, setTab] = useState<Tab>(() => (sessionStorageGet("cc.settings.tab") as Tab) || "services");
  const go = (t: Tab) => {
    setTab(t);
    try {
      sessionStorage.setItem("cc.settings.tab", t);
    } catch {
      /* private mode */
    }
  };
  const desktop = isTauri();
  return (
    <div className="mx-auto h-full w-full max-w-4xl space-y-4 overflow-y-auto px-4 pb-32 md:px-6 md:pb-8">
      <SubTabs tabs={TABS} value={tab} onChange={go} />
      {tab === "services" && (
        <>
          <GatewayCard />
          {desktop ? (
            <>
              <ModelLabCard />
              <ComputeRouterCard />
              <ComputeCard />
              <DropletCard />
              <OrchestratorCard />
              <VerifierCard />
              <WorkspacesCard />
              <MemoryLifecycleCard />
            </>
          ) : (
            <DesktopOnly what="Backend, model and verifier switching" />
          )}
          <ConfirmGateCard />
        </>
      )}
      {tab === "voice" && (
        <>
          <VoiceDetectionCard />
          {desktop ? (
            <>
              <SttCard />
              <TtsCard />
              <AgentVoiceRoster />
              <RoutingSettings />
            </>
          ) : (
            <DesktopOnly what="Whisper / Kokoro / XTTS selection (the phone uses the browser's voice for now)" />
          )}
          <CueStudio />
        </>
      )}
      {tab === "integrations" && (
        <>
          {desktop && (
            <>
              <OsIdentityCard />
              <OsPermissionsCard />
              <PrivacyShieldCard />
              <ModelLibraryCard />
              <CliHubCard />
              <AiProvidersCard />
              <SkillsLibraryCard />
              <McpRegistryCard />
              <OverseerCard />
              <MarketDataCard />
            </>
          )}
          <LocalLlmCard />
          {desktop ? (
            <>
              <PipelinesCard />
              <BridgeCard />
              <N8nCard />
              <GoogleCard />
            </>
          ) : (
            <DesktopOnly what="n8n and Google credentials" />
          )}
        </>
      )}
      {tab === "business" && <BusinessCard />}
      {tab === "appearance" && (
        <>
          <Card title="Ultra glass" hint="Opacity of every widget in Ultra-glass mode. 0–5 % is a crystal-clear floating HUD over the wallpaper.">
            <GlassOpacitySlider />
          </Card>
          <WaveCard />
          <LocationCard />
          <IdentityCard />
        </>
      )}
    </div>
  );
}

const sessionStorageGet = (k: string) => {
  try {
    return sessionStorage.getItem(k);
  } catch {
    return null;
  }
};

function DesktopOnly({ what }: { what: string }) {
  return (
    <Card title="Desktop app">
      <p className="text-sm text-ink-2">{what} lives in the desktop app, where the keychain and local services are. Changes there apply to this phone automatically through the gateway.</p>
    </Card>
  );
}

function GatewayCard() {
  const s = useSettings();
  return (
    <Card title="Gateway" hint="The Agentic OS server (server.py): sync hub for phone ↔ desktop, OCR, vault and backups. The desktop app starts it automatically. On your phone, open http(s)://<desktop NetBird IP>:8080/cc/ and Add to Home screen.">
      <Input className="font-mono" value={s.gatewayUrl} onChange={(e) => s.set({ gatewayUrl: e.target.value })} spellCheck={false} aria-label="Gateway URL" />
      {!isTauri() && (
        <Field label="Gateway token (network lock)" className="mt-2">
          <Input type="password" value={s.gatewayToken} onChange={(e) => s.set({ gatewayToken: e.target.value })} placeholder="From desktop → Settings → Integrations → New phone token" className="font-mono" autoComplete="off" />
          <p className="mt-1 text-xs text-ink-3">Not saved to this device — re-enter it each session so it never sits in plaintext storage.</p>
        </Field>
      )}
      <GatewayStatusCard />
    </Card>
  );
}

function ConfirmGateCard() {
  const s = useSettings();
  return (
    <Card title="Confirmation gate" hint="Anything that changes, sends, books, pays or deletes is read back and waits for your “yes” or a tap. If you don't answer in time it cancels itself. This can't be turned off.">
      <label className="flex items-center gap-3 text-sm text-ink-2">
        Auto-cancel after
        <input type="range" min={10} max={120} step={5} value={s.confirmTimeoutSec} onChange={(e) => s.set({ confirmTimeoutSec: Number(e.target.value) })} className="accent-amber" />
        <span className="w-12 font-mono text-ink tabular">{s.confirmTimeoutSec}s</span>
      </label>
    </Card>
  );
}

const PROVINCES: [string, string, number][] = [
  ["ON", "Ontario — HST", 13], ["NS", "Nova Scotia — HST", 14], ["NB", "New Brunswick — HST", 15], ["NL", "Newfoundland — HST", 15], ["PE", "PEI — HST", 15],
  ["BC", "British Columbia — GST", 5], ["AB", "Alberta — GST", 5], ["SK", "Saskatchewan — GST", 5], ["MB", "Manitoba — GST", 5], ["QC", "Québec — GST", 5],
  ["YT", "Yukon — GST", 5], ["NT", "NWT — GST", 5], ["NU", "Nunavut — GST", 5],
];

function BusinessCard() {
  const { business, set } = useSettings();
  const up = (patch: Partial<typeof business>) => set({ business: { ...business, ...patch } });
  return (
    <Card title="Business details" hint="Printed on invoices and used for the HST/GST summary. Stored on this device and in your local gateway only.">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Business / your name">
          <Input value={business.name} onChange={(e) => up({ name: e.target.value })} />
        </Field>
        <Field label="HST/GST registration #">
          <Input value={business.hstNumber} onChange={(e) => up({ hstNumber: e.target.value })} placeholder="123456789 RT0001" className="font-mono" />
        </Field>
        <Field label="Address">
          <Input value={business.address} onChange={(e) => up({ address: e.target.value })} />
        </Field>
        <Field label="Email">
          <Input type="email" value={business.email} onChange={(e) => up({ email: e.target.value })} />
        </Field>
        <Field label="Phone">
          <Input value={business.phone} onChange={(e) => up({ phone: e.target.value })} />
        </Field>
        <Field label="Province (sets the default tax rate)">
          <Select
            value={business.province}
            onChange={(e) => {
              const p = PROVINCES.find((x) => x[0] === e.target.value)!;
              up({ province: p[0], hstRate: p[2] });
            }}
          >
            {PROVINCES.map(([code, name, rate]) => (
              <option key={code} value={code}>
                {name} {rate}%
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Invoice tax rate %">
          <Input type="number" step="0.5" min={0} max={20} value={business.hstRate} onChange={(e) => up({ hstRate: Number(e.target.value) })} className="font-mono" />
        </Field>
        <Field label="Currency">
          <Select value={business.currency} onChange={(e) => up({ currency: e.target.value })}>
            <option>CAD</option>
            <option>USD</option>
          </Select>
        </Field>
      </div>
    </Card>
  );
}

function WaveCard() {
  const s = useSettings();
  return (
    <Card title="Voice waveform & orb" hint="Colour ramp and stroke weight for the waveform and the floating orb.">
      <div className="mb-3 flex items-center gap-4">
        <div className="well flex-1 rounded-[14px] px-3">
          <Waveform state="speaking" height={72} />
        </div>
        <div className="grid size-24 shrink-0 place-items-center">
          <VoiceOrb state="speaking" size={64} />
        </div>
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
  );
}

function LocationCard() {
  const { weatherLocation, set } = useSettings();
  const [lat, setLat] = useState(weatherLocation?.lat?.toString() ?? "");
  const [lon, setLon] = useState(weatherLocation?.lon?.toString() ?? "");
  const [label, setLabel] = useState(weatherLocation?.label ?? "");
  return (
    <Card title="Weather location" hint="Leave empty to use this device's location.">
      <form
        className="grid gap-3 sm:grid-cols-[1fr_1fr_1.4fr_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          const la = Number(lat), lo = Number(lon);
          set({ weatherLocation: lat && lon && Number.isFinite(la) && Number.isFinite(lo) ? { lat: la, lon: lo, label: label || "Saved location" } : null });
        }}
      >
        <Input className="font-mono" placeholder="Lat 43.65" value={lat} onChange={(e) => setLat(e.target.value)} aria-label="Latitude" inputMode="decimal" />
        <Input className="font-mono" placeholder="Lon -79.38" value={lon} onChange={(e) => setLon(e.target.value)} aria-label="Longitude" inputMode="decimal" />
        <Input placeholder="Label (Toronto)" value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Location label" />
        <button className="pill-glass" type="submit">
          Save
        </button>
      </form>
    </Card>
  );
}

function IdentityCard() {
  const s = useSettings();
  return (
    <Card title="Identity & mantra">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Callsign">
          <Input className="font-mono" value={s.identity.callsign} onChange={(e) => s.set({ identity: { ...s.identity, callsign: e.target.value } })} />
        </Field>
        <Field label="Status line">
          <Input className="font-mono" value={s.identity.subtitle} onChange={(e) => s.set({ identity: { ...s.identity, subtitle: e.target.value } })} />
        </Field>
        {s.mantra.lines.map((line, i) => (
          <Field key={i} label={`Mantra ${i + 1}`}>
            <Input
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
  );
}
