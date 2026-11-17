import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, CheckCircle2, KeyRound, Loader2, Plus, RefreshCw, ShieldCheck, Trash2, X, Zap } from "lucide-react";
import { Card, Field, Input, Select } from "@/components/ui";
import { cmd, CHAT_KINDS, type ProviderInfo } from "@/lib/platform";
import { useServicesHealth } from "@/features/services/use-health";
import { modelsFor, useProviders } from "./use-providers";
import { useOs } from "@/features/os/os-store";

/** Custom model ids the user added per provider (kept across restarts). */
const CUSTOM_KEY = "cc.models.custom";
function customIds(id: string): string[] {
  try {
    return (JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? "{}") as Record<string, string[]>)[id] ?? [];
  } catch {
    return [];
  }
}
function addCustomId(id: string, model: string) {
  try {
    const all = JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? "{}") as Record<string, string[]>;
    all[id] = [...new Set([...(all[id] ?? []), model])];
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(all));
  } catch {
    /* private mode: the id still applies, it just isn't remembered */
  }
}

/**
 * Model dropdown fed by the provider's own /models. It is ALWAYS a <select>:
 * a failed fetch or a picked custom id no longer swaps it for a text box (that
 * was the "disappearing dropdown"). "+ Custom ID" adds an id to the list.
 */
export function ModelSelect({ provider, onChange, label = "Model" }: { provider: ProviderInfo; onChange: (m: string) => void; label?: string }) {
  const [models, setModels] = useState<string[]>([]);
  const [err, setErr] = useState<string | undefined>();
  const [adding, setAdding] = useState(false);
  const [custom, setCustom] = useState(() => customIds(provider.id));
  const load = (force = false) => void modelsFor(provider.id, force).then((r) => (setModels(r.models), setErr(r.error)));
  useEffect(() => load(), [provider.id, provider.baseUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  const options = [...new Set([...(provider.model ? [provider.model] : []), ...models, ...custom])];
  const commit = (v: string) => {
    const id = v.trim();
    setAdding(false);
    if (!id) return;
    addCustomId(provider.id, id);
    setCustom(customIds(provider.id));
    if (id !== provider.model) onChange(id);
  };
  return (
    <Field label={label}>
      <div className="flex gap-1.5">
        {adding ? (
          <Input
            autoFocus
            placeholder="custom model id"
            className="font-mono !text-[13px]"
            onKeyDown={(e) => {
              if (e.key === "Enter") commit((e.target as HTMLInputElement).value);
              if (e.key === "Escape") setAdding(false);
            }}
            onBlur={(e) => commit(e.target.value)}
          />
        ) : (
          <Select value={provider.model} onChange={(e) => e.target.value !== provider.model && onChange(e.target.value)} className="font-mono !text-[13px]">
            {!options.length && <option value="">(no models — start it, or add a custom ID)</option>}
            {options.map((m) => (
              <option key={m} value={m}>
                {m}
                {!models.includes(m) && m !== provider.model ? " (custom)" : ""}
              </option>
            ))}
          </Select>
        )}
        <button type="button" aria-label="Add a custom model ID" title="+ Custom ID" onClick={() => setAdding(true)} className="grid size-10 shrink-0 place-items-center rounded-[12px] border border-white/10 text-ink-2 hover:text-ink">
          <Plus size={14} />
        </button>
        <button type="button" aria-label="Reload models" title={err ?? "Reload models"} onClick={() => load(true)} className={`grid size-10 shrink-0 place-items-center rounded-[12px] border border-white/10 ${err ? "text-alert" : "text-ink-2"} hover:text-ink`}>
          <RefreshCw size={14} />
        </button>
      </div>
      {err && <span className="block truncate text-[11px] text-alert/80">{err} — showing saved ids</span>}
    </Field>
  );
}

function HealthDot({ id }: { id: string }) {
  const s = useServicesHealth().services.find((x) => x.id === id);
  if (!s) return <span className="size-2 rounded-full bg-ink-3" />;
  return <span title={s.up ? `up · ${s.latencyMs}ms` : s.detail} className={`size-2 shrink-0 rounded-full ${s.up ? "bg-teal shadow-[0_0_6px_#00e5c3]" : s.manual ? "bg-ink-3" : "bg-alert"}`} />;
}

/**
 * Orchestrator switcher: which backends answer, in what order, with which
 * model. The first one that responds wins; the rest are automatic fallbacks.
 */
export function OrchestratorCard() {
  const { view, load, patch, policy, apply, error, saving } = useProviders();
  const [testing, setTesting] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  useEffect(() => void load(), [load]);
  if (!view) return <Card title="Orchestrator & models">{error ?? "Loading providers…"}</Card>;

  const chat = view.providers.filter((p) => CHAT_KINDS.includes(p.kind) && p.id !== "verifier");
  const chain = view.policy.chain.map((id) => chat.find((p) => p.id === id)).filter(Boolean) as ProviderInfo[];
  const spare = chat.filter((p) => !view.policy.chain.includes(p.id));
  const move = (i: number, d: -1 | 1) => {
    const next = [...view.policy.chain];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    void policy({ chain: next });
  };

  const test = async (p: ProviderInfo) => {
    setTesting((t) => ({ ...t, [p.id]: "…" }));
    const t0 = performance.now();
    try {
      const r = await cmd("dispatch_chat", { req: { messages: [{ role: "user", content: "Reply with exactly: OK" }], priority: "interactive", provider: p.id, maxSecs: 20 } });
      setTesting((t) => ({ ...t, [p.id]: `✓ ${Math.round(performance.now() - t0)}ms · “${r.content.slice(0, 24)}”` }));
    } catch (e) {
      setTesting((t) => ({ ...t, [p.id]: `✗ ${String(e).slice(0, 80)}` }));
    }
  };

  return (
    <Card
      title="Orchestrator & models"
      hint="Requests go to the first backend that answers; the rest are automatic fallbacks. Switch models live — no restart. Keys stay bound to each host, so changing a URL can never send a key elsewhere."
      action={saving ? <Loader2 size={14} className="animate-spin text-ink-3" /> : null}
    >
      <ol className="space-y-2">
        {chain.map((p, i) => (
          <li key={p.id} className="rounded-[14px] border border-white/[0.07] bg-white/[0.02] p-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="grid size-6 place-items-center rounded-full bg-amber/15 font-mono text-[11px] text-amber-light">{i + 1}</span>
              <HealthDot id={p.id} />
              <span className="font-medium text-ink">{p.label}</span>
              <span className="label-caps text-ink-3">{p.kind}</span>
              <div className="ml-auto flex items-center gap-0.5">
                <IconBtn label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                  <ArrowUp size={13} />
                </IconBtn>
                <IconBtn label="Move down" disabled={i === chain.length - 1} onClick={() => move(i, 1)}>
                  <ArrowDown size={13} />
                </IconBtn>
                <IconBtn label="Remove from chain" disabled={chain.length === 1} onClick={() => void policy({ chain: view.policy.chain.filter((c) => c !== p.id) })}>
                  <X size={13} />
                </IconBtn>
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-[1.3fr_1fr_auto]">
              <ModelSelect provider={p} onChange={(model) => void patch({ id: p.id, model })} label={p.kind === "agentic-os" ? "Agent" : "Model"} />
              <Field label="Endpoint">
                <Input defaultValue={p.baseUrl} onBlur={(e) => e.target.value !== p.baseUrl && void patch({ id: p.id, baseUrl: e.target.value })} className="font-mono !text-[12px]" spellCheck={false} />
              </Field>
              <div className="flex items-end">
                <button onClick={() => void test(p)} className="pill-glass !h-10 w-full text-xs">
                  <Zap size={13} /> Test
                </button>
              </div>
            </div>
            {testing[p.id] && <p className={`mt-1.5 font-mono text-[11px] ${testing[p.id].startsWith("✓") ? "text-teal" : "text-ink-2"}`}>{testing[p.id]}</p>}
            {p.needsKey && <KeyRow p={p} onChange={load} />}
          </li>
        ))}
      </ol>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {spare.length > 0 && (
          <Select value="" onChange={(e) => e.target.value && void policy({ chain: [...view.policy.chain, e.target.value] })} className="!h-9 !w-auto !py-1 text-[13px]" aria-label="Add to chain">
            <option value="">+ Add backend to chain…</option>
            {spare.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </Select>
        )}
        <button onClick={() => setAdding((a) => !a)} className="pill-glass !h-9 text-[13px]">
          <Plus size={13} /> Custom endpoint
        </button>
        {spare.filter((p) => p.custom).map((p) => (
          <button key={p.id} onClick={() => void apply(cmd("provider_remove", { id: p.id }))} className="pill-glass !h-9 text-[13px] hover:!border-alert/50">
            <Trash2 size={12} /> {p.label}
          </button>
        ))}
      </div>
      {adding && <AddEndpoint onDone={() => setAdding(false)} />}
      {error && <p className="mt-2 text-xs text-alert">{error}</p>}
    </Card>
  );
}

function AddEndpoint({ onDone }: { onDone: () => void }) {
  const apply = useProviders((s) => s.apply);
  const [d, setD] = useState({ label: "", baseUrl: "http://127.0.0.1:11434/v1", model: "", kind: "local" as "local" | "cloud" | "agentic-os", needsKey: false });
  const [err, setErr] = useState<string | null>(null);
  return (
    <form
      className="mt-3 grid gap-2 rounded-[14px] border border-white/[0.07] p-3 sm:grid-cols-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const id = d.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "custom";
        try {
          await apply(cmd("provider_add", { provider: { id, label: d.label || id, kind: d.kind, baseUrl: d.baseUrl, model: d.model || "local-model", needsKey: d.needsKey } }));
          onDone();
        } catch (e2) {
          setErr(String(e2));
        }
      }}
    >
      <Field label="Name">
        <Input value={d.label} onChange={(e) => setD({ ...d, label: e.target.value })} placeholder="Ollama on the desktop" required />
      </Field>
      <Field label="Type">
        <Select value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value as typeof d.kind })}>
          <option value="local">Local / LAN (OpenAI-compatible)</option>
          <option value="cloud">Remote (OpenAI-compatible)</option>
          <option value="agentic-os">Agentic OS gateway</option>
        </Select>
      </Field>
      <Field label="Base URL">
        <Input value={d.baseUrl} onChange={(e) => setD({ ...d, baseUrl: e.target.value })} className="font-mono" spellCheck={false} required />
      </Field>
      <Field label="Model">
        <Input value={d.model} onChange={(e) => setD({ ...d, model: e.target.value })} placeholder="pick after adding" className="font-mono" />
      </Field>
      <label className="flex items-center gap-2 text-sm text-ink-2">
        <input type="checkbox" checked={d.needsKey} onChange={(e) => setD({ ...d, needsKey: e.target.checked })} className="accent-amber" /> Needs an API key
      </label>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onDone} className="pill-glass !h-9 text-[13px]">
          Cancel
        </button>
        <button className="pill-primary !h-9 text-[13px]">Add endpoint</button>
      </div>
      {err && <p className="text-xs text-alert sm:col-span-2">{err}</p>}
    </form>
  );
}

/** Zero-cost local verifier: which backend + model double-checks mutating plans. */
const EXT_VERIFIERS: [string, string][] = [
  ["ext:claude-cli", "Claude Code (CLI)"],
  ["ext:claude-api", "Claude (API)"],
  ["ext:gemini-cli", "Gemini (CLI)"],
  ["ext:gemini-api", "Gemini (API)"],
];

export function VerifierCard() {
  const { view, patch, policy } = useProviders();
  const os = useOs((st) => st.cfg);
  const osPatch = useOs((st) => st.patch);
  if (!view) return null;
  const chat = view.providers.filter((p) => CHAT_KINDS.includes(p.kind));
  const current = chat.find((p) => p.id === view.policy.verifier);
  const planner = chat.find((p) => p.id === view.policy.chain[0]);
  const same = current && planner && current.baseUrl === planner.baseUrl && current.model === planner.model;
  const ext = view.policy.verifier.startsWith("ext:");
  return (
    <Card
      title="Verifier"
      hint="Cross-checks every mutating plan against your exact words before the confirmation card appears. Local = zero token cost; Claude / Gemini get a privacy-diffused copy. Your “yes” is still the final gate."
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Backend">
          <Select value={view.policy.verifier} onChange={(e) => void policy({ verifier: e.target.value })}>
            <optgroup label="Local / droplet">
              {chat.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id === "droplet" ? "Remote droplet" : p.id === "verifier" ? "Local secondary model" : p.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="External">
              {EXT_VERIFIERS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </optgroup>
          </Select>
        </Field>
        {current && !ext && <ModelSelect provider={current} onChange={(model) => void patch({ id: current.id, model })} />}
        {ext && <p className="self-end pb-2 text-xs text-ink-3">Keys and models: Settings → Integrations → Overseer.</p>}
      </div>
      {os && (
        <label className="mt-3 flex items-center gap-2 text-sm text-ink-2">
          <input type="checkbox" checked={os.overseer.manualMode} onChange={(e) => void osPatch({ overseer: { manualMode: e.target.checked } })} className="accent-amber" />
          Manual Overseer Mode — every confirmation card also gets an Overseer review
        </label>
      )}
      {same && !ext && (
        <p className="mt-2 rounded-[10px] border border-amber/30 bg-amber/10 px-3 py-2 text-xs text-amber-light">
          The verifier is the same model as your planner, so it’s checking its own work. Load a second, different model in LM Studio (it can serve several) and pick it here for a real second opinion.
        </p>
      )}
    </Card>
  );
}

function KeyRow({ p, onChange }: { p: ProviderInfo; onChange: () => void }) {
  const [key, setKey] = useState("");
  return (
    <form
      className="mt-2 flex items-center gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!key) return;
        await cmd("secret_set", { provider: p.id, value: key });
        setKey("");
        onChange();
      }}
    >
      {p.hasKey ? <ShieldCheck size={14} className="shrink-0 text-teal" /> : <KeyRound size={14} className="shrink-0 text-amber" />}
      <input type="password" autoComplete="off" className="field !h-9 !py-1 font-mono text-[13px]" placeholder={p.hasKey ? "Key stored in keychain — paste to replace" : "Paste API key"} value={key} onChange={(e) => setKey(e.target.value)} aria-label={`${p.label} API key`} />
      <button className="pill-glass !h-9 shrink-0 text-xs" disabled={!key}>
        Save
      </button>
      {p.hasKey && (
        <button type="button" aria-label={`Delete ${p.label} key`} onClick={async () => (await cmd("secret_delete", { provider: p.id }), onChange())} className="grid size-9 shrink-0 place-items-center rounded-full text-ink-2 hover:text-alert">
          <Trash2 size={14} />
        </button>
      )}
    </form>
  );
}

function IconBtn({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled} className="grid size-7 place-items-center rounded-full text-ink-2 hover:bg-white/10 hover:text-ink disabled:opacity-30">
      {children}
    </button>
  );
}

export function GatewayStatusCard() {
  const { services, refresh } = useServicesHealth();
  const gw = services.find((s) => s.id === "gateway");
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
      {gw?.up ? <CheckCircle2 size={15} className="text-teal" /> : <span className="size-2 rounded-full bg-alert" />}
      <span className={gw?.up ? "text-teal" : "text-ink-2"}>{gw ? (gw.up ? `Gateway up · ${gw.latencyMs}ms` : `Gateway down — ${gw.detail}`) : "Checking…"}</span>
      {gw && !gw.up && (
        <button
          className="pill-primary ml-auto !h-8 text-xs"
          onClick={async () => {
            setBusy("Starting…");
            const r = await cmd("gateway_ensure").catch((e) => ({ up: false, detail: String(e) }));
            setBusy(r.up ? null : r.detail);
            await refresh();
          }}
        >
          {busy === "Starting…" ? <Loader2 size={13} className="animate-spin" /> : null} Start gateway
        </button>
      )}
      {busy && busy !== "Starting…" && <p className="w-full text-xs text-alert">{busy}</p>}
    </div>
  );
}
