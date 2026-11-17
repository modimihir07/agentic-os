import { useEffect, useState } from "react";
import { Container, Loader2, Plus, Radar, ShieldCheck, Trash2 } from "lucide-react";
import { Card, Field, Input, Select } from "@/components/ui";
import { cmd, isTauri, type N8nDiscovery, type WorkflowInfo } from "@/lib/platform";
import { cc, type CcConfig } from "@/lib/cc-api";
import { syncCalendar } from "@/features/reminders/scheduler";
import { useProviders } from "./use-providers";

/** n8n bound to the local Docker container; workflow map with read-only vs mutating tiers. */
export function N8nCard() {
  const { view, patch, load } = useProviders();
  const [disc, setDisc] = useState<N8nDiscovery | null>(null);
  const [busy, setBusy] = useState(false);
  const [wfs, setWfs] = useState<WorkflowInfo[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const n8n = view?.providers.find((p) => p.id === "n8n");

  const discover = async (adopt = true) => {
    setBusy(true);
    try {
      const d = await cmd("n8n_discover", { adopt });
      setDisc(d);
      if (d.adopted) await load();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void discover(false);
    void cmd("n8n_workflows").then(setWfs);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (next: WorkflowInfo[]) => {
    try {
      setWfs(await cmd("n8n_workflows_set", { workflows: next.filter((w) => w.name.trim() && w.path.trim()) }));
      setMsg("Workflows saved.");
    } catch (e) {
      setMsg(String(e));
    }
  };

  if (!n8n) return null;
  return (
    <Card
      title="n8n · Docker"
      hint="Bound to your local n8n container automatically. Read-only workflows (e.g. calendar-upcoming, gmail-digest) feed widgets directly. Mutating ones only run after you approve on the confirmation card — the app can only call workflows listed here."
      action={busy ? <Loader2 size={14} className="animate-spin text-ink-3" /> : null}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-[12px] border border-white/[0.07] px-3 py-2 text-sm">
        <Container size={15} className={disc?.healthy ? "text-teal" : "text-ink-3"} />
        {disc?.found ? (
          <span className="text-ink-2">
            <b className="text-ink">{disc.container}</b> · {disc.status} · <span className="font-mono">{disc.url}</span> {disc.healthy ? <span className="text-teal">· healthy</span> : <span className="text-alert">· not answering</span>}
          </span>
        ) : (
          <span className="text-ink-3">{disc ? "No n8n container running in Docker." : "Looking for the n8n container…"}</span>
        )}
        <button onClick={() => void discover(true)} className="pill-glass ml-auto !h-8 text-xs">
          <Radar size={13} /> Detect & bind
        </button>
      </div>
      <Field label="n8n URL (override)">
        <Input defaultValue={n8n.baseUrl} key={n8n.baseUrl} onBlur={(e) => e.target.value !== n8n.baseUrl && void patch({ id: "n8n", baseUrl: e.target.value })} className="font-mono !text-[12px]" spellCheck={false} />
      </Field>

      <div className="mt-3 space-y-1.5">
        <div className="hidden grid-cols-[1fr_1.3fr_90px_32px] gap-2 px-1 sm:grid">
          {["Name", "Webhook path", "Changes things?", ""].map((h) => (
            <span key={h} className="label-caps text-ink-3">
              {h}
            </span>
          ))}
        </div>
        {wfs.map((w, i) => (
          <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_1.3fr_90px_32px]">
            <Input value={w.name} onChange={(e) => setWfs(wfs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} className="!h-9 !py-1 font-mono !text-[12px]" placeholder="calendar-create" aria-label="Workflow name" />
            <Input value={w.path} onChange={(e) => setWfs(wfs.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)))} className="!h-9 !py-1 font-mono !text-[12px]" placeholder="webhook/calendar-create" aria-label="Webhook path" />
            <label className="flex items-center gap-2 text-xs text-ink-2">
              <input type="checkbox" checked={w.mutating} onChange={(e) => setWfs(wfs.map((x, j) => (j === i ? { ...x, mutating: e.target.checked } : x)))} className="accent-amber" />
              {w.mutating ? "asks first" : "read-only"}
            </label>
            <button aria-label="Remove workflow" onClick={() => void save(wfs.filter((_, j) => j !== i))} className="grid size-9 place-items-center rounded-full text-ink-3 hover:text-alert">
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <button onClick={() => setWfs([...wfs, { name: "", path: "webhook/", mutating: true }])} className="pill-glass !h-8 text-xs">
          <Plus size={13} /> Workflow
        </button>
        <button onClick={() => void save(wfs)} className="pill-primary !h-8 text-xs">
          Save workflows
        </button>
      </div>
      {msg && <p className="mt-2 text-xs text-ink-2">{msg}</p>}
    </Card>
  );
}

const GOOGLE_PRESETS: WorkflowInfo[] = [
  { name: "calendar-upcoming", path: "webhook/calendar-upcoming", mutating: false, description: "list upcoming Google Calendar events" },
  { name: "calendar-create", path: "webhook/calendar-create", mutating: true, description: "create a Google Calendar event" },
  { name: "calendar-cancel", path: "webhook/calendar-cancel", mutating: true, description: "cancel a Google Calendar event" },
  { name: "gmail-digest", path: "webhook/gmail-digest", mutating: false, description: "unread Gmail summary" },
  { name: "gmail-send", path: "webhook/gmail-send", mutating: true, description: "send an email from Gmail" },
];

/**
 * Gmail + Google Calendar. Recommended path: n8n's Google nodes hold the OAuth
 * tokens; this app calls named webhooks. Optional: store your own OAuth client
 * in the OS keychain for the direct connector.
 */
export function GoogleCard() {
  const { view, load } = useProviders();
  const [wfs, setWfs] = useState<WorkflowInfo[]>([]);
  const [client, setClient] = useState({ id: "", secret: "" });
  const [msg, setMsg] = useState<string | null>(null);
  const google = view?.providers.find((p) => p.id === "google");
  useEffect(() => void cmd("n8n_workflows").then(setWfs), []);
  const have = new Set(wfs.map((w) => w.name));

  const addPresets = async () => {
    const next = [...wfs, ...GOOGLE_PRESETS.filter((p) => !have.has(p.name))];
    setWfs(await cmd("n8n_workflows_set", { workflows: next }));
    setMsg("Added the Google webhooks to n8n workflows. Create matching Webhook-trigger workflows in n8n using its Gmail / Google Calendar nodes.");
  };

  return (
    <Card title="Gmail & Google Calendar" hint="Route 1 (works today): n8n’s Gmail and Google Calendar nodes hold your Google sign-in; Jarvis calls their webhooks. Reads sync every 10 minutes; creating, cancelling or sending always asks first.">
      <div className="space-y-1.5">
        {GOOGLE_PRESETS.map((p) => (
          <div key={p.name} className="flex items-center gap-2 text-[13px]">
            <span className={`size-1.5 rounded-full ${have.has(p.name) ? "bg-teal" : "bg-ink-3"}`} />
            <span className="font-mono text-ink">{p.name}</span>
            <span className="truncate text-ink-3">— {p.description}</span>
            <span className={`label-caps ml-auto shrink-0 ${p.mutating ? "text-amber-soft" : "text-teal"}`}>{p.mutating ? "asks first" : "read-only"}</span>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button onClick={() => void addPresets()} className="pill-primary !h-9 text-xs" disabled={GOOGLE_PRESETS.every((p) => have.has(p.name))}>
          <Plus size={13} /> Add Google webhooks to n8n map
        </button>
        <button
          onClick={async () => {
            try {
              setMsg(`Calendar sync: ${await syncCalendar()} events updated.`);
            } catch (e) {
              setMsg(`Calendar sync failed: ${String(e)}`);
            }
          }}
          className="pill-glass !h-9 text-xs"
        >
          Sync calendar now
        </button>
      </div>

      <div className="mt-4 border-t border-white/5 pt-4">
        <p className="label-caps mb-1 text-ink-3">Route 2 · your own Google OAuth client (optional)</p>
        <p className="mb-2 text-xs text-ink-3">
          Saved to the OS keychain, never readable from the UI. For a direct Google connector without n8n — the connector itself is on the backlog, so Route 1 is what syncs today.
        </p>
        <form
          className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!client.id || !client.secret) return;
            await cmd("secret_set", { provider: "google", value: JSON.stringify({ clientId: client.id.trim(), clientSecret: client.secret.trim() }) });
            setClient({ id: "", secret: "" });
            await load();
            setMsg("Google OAuth client stored in the keychain.");
          }}
        >
          <Input value={client.id} onChange={(e) => setClient({ ...client, id: e.target.value })} placeholder="Client ID (…apps.googleusercontent.com)" className="font-mono !text-[12px]" autoComplete="off" aria-label="Google OAuth client ID" />
          <Input type="password" value={client.secret} onChange={(e) => setClient({ ...client, secret: e.target.value })} placeholder="Client secret" className="font-mono !text-[12px]" autoComplete="off" aria-label="Google OAuth client secret" />
          <button className="pill-glass !h-10 text-xs" disabled={!client.id || !client.secret}>
            Save
          </button>
        </form>
        {google?.hasKey && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-teal">
            <ShieldCheck size={13} /> OAuth client stored
            <button className="ml-2 text-ink-3 underline hover:text-alert" onClick={async () => (await cmd("secret_delete", { provider: "google" }), load())}>
              remove
            </button>
          </p>
        )}
      </div>
      {msg && <p className="mt-2 text-xs text-ink-2">{msg}</p>}
    </Card>
  );
}

/** The gateway's local LLM: OCR (vision), organizing, widget generation, vault embeddings. */
export function LocalLlmCard() {
  const [cfg, setCfg] = useState<CcConfig | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const load = async () => {
    try {
      setCfg(await cc.config());
      const h = await cc.health();
      setModels(h.llm.models ?? []);
      setMsg(h.llm.ok ? null : `Local LLM not reachable: ${h.llm.error}`);
    } catch (e) {
      setMsg(`Gateway: ${String(e)}`);
    }
  };
  useEffect(() => void load(), []);
  if (!cfg) return <Card title="Local AI (gateway)">{msg ?? "Loading…"}</Card>;
  const save = async (llm: Partial<CcConfig["llm"]>) => {
    try {
      setCfg(await cc.setConfig({ llm }));
      setMsg("Saved.");
      void load();
    } catch (e) {
      setMsg(String(e));
    }
  };
  const pick = (label: string, key: "model" | "visionModel" | "embeddingModel", filter: (m: string) => boolean, hint: string) => (
    <Field label={label}>
      <Select value={cfg.llm[key]} onChange={(e) => void save({ [key]: e.target.value })}>
        <option value="">{hint}</option>
        {[...new Set([cfg.llm[key], ...models.filter(filter)])].filter(Boolean).map((m) => (
          <option key={m}>{m}</option>
        ))}
      </Select>
    </Field>
  );
  return (
    <Card title="Local AI (gateway)" hint="Used by the phone and desktop alike for receipt OCR, brainstorm organizing, widget generation and the vector vault. Runs on your LM Studio — zero token cost, nothing leaves the machine.">
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Endpoint (OpenAI-compatible)">
          <Input defaultValue={cfg.llm.baseUrl} onBlur={(e) => e.target.value !== cfg.llm.baseUrl && void save({ baseUrl: e.target.value })} className="font-mono !text-[12px]" spellCheck={false} />
        </Field>
        {pick("Text model", "model", (m) => !/embed/i.test(m), "First loaded model")}
        {pick("Vision model (OCR)", "visionModel", (m) => /vl|vision|llava|gemma-3|qwen2\.5-vl|pixtral|minicpm/i.test(m), "Same as text model")}
        {pick("Embedding model (vault)", "embeddingModel", (m) => /embed/i.test(m), "First embedding model")}
      </div>
      {msg && <p className={`mt-2 text-xs ${/not reach|Gateway|fail/i.test(msg) ? "text-alert" : "text-teal"}`}>{msg}</p>}
      {!isTauri() && <p className="mt-2 text-xs text-ink-3">These settings live on the gateway, so they apply to every device.</p>}
    </Card>
  );
}
