import { useEffect, useState } from "react";
import { KeyRound, Plus, ShieldCheck, Trash2, X } from "lucide-react";
import { Card, Field, Input, Select } from "@/components/ui";
import { cmd, type BridgeScope, type BridgeTier, type BridgeView, type PipelinesConfig, type PipelinesSettings } from "@/lib/platform";
import { gated } from "@/features/bridge/gate";

/** Settings → n8n & Cloud Backup (persisted in providers.json; keys in the OS keychain). */
export function PipelinesCard() {
  const [s, setS] = useState<PipelinesSettings | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [newPath, setNewPath] = useState("");
  const [inst, setInst] = useState({ label: "", url: "" });

  const load = () => void cmd("pipelines_settings").then(setS).catch((e) => setMsg(String(e)));
  useEffect(load, []);

  const save = async (patch: Partial<PipelinesConfig>) => {
    try {
      const next = await gated(
        { action: "settings.pipelines", summary: patch.autoSyncEnabled ? "Turn on automatic Google Drive backups" : "Update n8n & backup settings" },
        (approved) => cmd("pipelines_settings_update", { patch, approved }),
        () => "Saved.",
      );
      if (next) {
        setS(next);
        setMsg("Saved.");
      }
    } catch (e) {
      setMsg(String(e));
    }
  };

  if (!s) return <Card title="n8n & Cloud Backup">{msg ?? "Loading…"}</Card>;
  return (
    <Card
      title="n8n & Cloud Backup"
      hint="Instances are polled through the n8n REST API (needs an API key from n8n → Settings → n8n API). Drive backups POST changed files to an n8n webhook whose workflow writes them to Google Drive. Every request times out after 3 s, so an offline n8n never freezes the app."
    >
      <p className="label-caps mb-2 text-ink-3">N8N_INSTANCES</p>
      <ul className="space-y-2">
        {s.instances.map((i) => (
          <InstanceRow key={i.id} i={i} onChange={load} />
        ))}
      </ul>
      <form
        className="mt-2 grid gap-2 sm:grid-cols-[1fr_1.6fr_auto]"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            setS(await cmd("n8n_instance_add", { label: inst.label || "Remote", baseUrl: inst.url }));
            setInst({ label: "", url: "" });
          } catch (e2) {
            setMsg(String(e2));
          }
        }}
      >
        <Input value={inst.label} onChange={(e) => setInst({ ...inst, label: e.target.value })} placeholder="Label (Remote Droplet)" className="!h-9 !py-1 text-[13px]" aria-label="Instance label" />
        <Input value={inst.url} onChange={(e) => setInst({ ...inst, url: e.target.value })} placeholder="http://100.64.0.10:5678/api/v1" className="!h-9 !py-1 font-mono text-[12px]" aria-label="Instance URL" required />
        <button className="pill-glass !h-9 text-xs">
          <Plus size={13} /> Add instance
        </button>
      </form>

      <div className="mt-5 grid gap-3 sm:grid-cols-[2fr_1fr]">
        <Field label="GDRIVE_SYNC_WEBHOOK_URL">
          <Input
            key={s.gdriveSyncWebhookUrl}
            defaultValue={s.gdriveSyncWebhookUrl}
            onBlur={(e) => e.target.value !== s.gdriveSyncWebhookUrl && void save({ gdriveSyncWebhookUrl: e.target.value })}
            placeholder="http://127.0.0.1:5678/webhook/gdrive-sync"
            className="font-mono !text-[12px]"
            spellCheck={false}
          />
        </Field>
        <Field label="POLL_INTERVAL_SECONDS">
          <Input type="number" min={5} max={3600} key={`p${s.pollIntervalSeconds}`} defaultValue={s.pollIntervalSeconds} onBlur={(e) => Number(e.target.value) !== s.pollIntervalSeconds && void save({ pollIntervalSeconds: Number(e.target.value) })} className="font-mono" />
        </Field>
      </div>

      <p className="label-caps mb-1.5 mt-4 text-ink-3">GDRIVE_TRACKED_PATHS</p>
      <ul className="space-y-1">
        {s.gdriveTrackedPaths.map((p, i) => {
          const resolved = p === "@os-config" ? null : s.resolvedPaths.find((r) => r.path === p);
          return (
            <li key={p} className="flex items-center gap-2 rounded-[10px] border border-white/[0.06] px-3 py-1.5 font-mono text-[12px]">
              <span className={`size-1.5 rounded-full ${p === "@os-config" || resolved?.exists ? "bg-pipe-ok" : "bg-pipe-idle"}`} />
              <span className="min-w-0 flex-1 truncate text-ink">{p === "@os-config" ? "@os-config — providers.json, permissions.json, gateway config (no secrets)" : p}</span>
              {resolved && !resolved.exists && <span className="text-[10px] text-ink-3">missing — skipped</span>}
              <button aria-label={`Stop tracking ${p}`} onClick={() => void save({ gdriveTrackedPaths: s.gdriveTrackedPaths.filter((_, j) => j !== i) })} className="text-ink-3 hover:text-alert">
                <X size={13} />
              </button>
            </li>
          );
        })}
      </ul>
      <form
        className="mt-2 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (newPath.trim()) void save({ gdriveTrackedPaths: [...s.gdriveTrackedPaths, newPath.trim()] }).then(() => setNewPath(""));
        }}
      >
        <Input value={newPath} onChange={(e) => setNewPath(e.target.value)} placeholder="D:\Art Apps\agentic os\brain" className="!h-9 !py-1 font-mono text-[12px]" aria-label="Folder to back up" />
        <button className="pill-glass !h-9 shrink-0 text-xs">
          <Plus size={13} /> Track
        </button>
      </form>

      <div className="mt-4 flex flex-wrap items-center gap-4 text-sm text-ink-2">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={s.autoSyncEnabled} onChange={(e) => void save({ autoSyncEnabled: e.target.checked })} className="accent-teal" />
          AUTO_SYNC_ENABLED — back up every
        </label>
        <Input type="number" min={0.25} max={168} step={0.25} key={`h${s.autoSyncHours}`} defaultValue={s.autoSyncHours} onBlur={(e) => Number(e.target.value) !== s.autoSyncHours && void save({ autoSyncHours: Number(e.target.value) })} className="!h-8 !w-20 !py-1 font-mono text-[12px]" aria-label="Auto-sync interval hours" />
        <span>hours</span>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={s.syncOnExit} onChange={(e) => void save({ syncOnExit: e.target.checked })} className="accent-teal" disabled={!s.autoSyncEnabled} />
          and on clean app exit
        </label>
      </div>
      {msg && <p className="mt-2 text-xs text-ink-2">{msg}</p>}
    </Card>
  );
}

function InstanceRow({ i, onChange }: { i: PipelinesSettings["instances"][number]; onChange: () => void }) {
  const [key, setKey] = useState("");
  return (
    <li className="rounded-[12px] border border-white/[0.07] bg-white/[0.02] p-2.5">
      <div className="flex items-center gap-2 text-sm">
        <span className="font-medium text-ink">{i.label}</span>
        <span className="truncate font-mono text-[11px] text-ink-3">{i.baseUrl}</span>
        {i.custom && (
          <button aria-label={`Remove ${i.label}`} onClick={async () => (await cmd("provider_remove", { id: i.id }), onChange())} className="ml-auto text-ink-3 hover:text-alert">
            <Trash2 size={13} />
          </button>
        )}
      </div>
      <form
        className="mt-1.5 flex items-center gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!key) return;
          await cmd("secret_set", { provider: i.id, value: key, slot: "api" });
          setKey("");
          onChange();
        }}
      >
        {i.hasApiKey ? <ShieldCheck size={14} className="shrink-0 text-pipe-ok" /> : <KeyRound size={14} className="shrink-0 text-amber" />}
        <input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={i.hasApiKey ? "API key stored in keychain — paste to replace" : "n8n API key"} className="field !h-8 !py-1 font-mono text-[12px]" aria-label={`${i.label} n8n API key`} />
        <button className="pill-glass !h-8 shrink-0 text-xs" disabled={!key}>
          Save
        </button>
        {i.hasApiKey && (
          <button type="button" aria-label="Delete API key" onClick={async () => (await cmd("secret_delete", { provider: i.id, slot: "api" }), onChange())} className="text-ink-3 hover:text-alert">
            <Trash2 size={13} />
          </button>
        )}
      </form>
    </li>
  );
}

const SCOPES: { id: BridgeScope; label: string; hint: string }[] = [
  { id: "read", label: "Read", hint: "status polling, reading files to back up" },
  { id: "write", label: "Write", hint: "changing local configuration" },
  { id: "execute", label: "Execute", hint: "running workflows, pausing, Drive dispatch" },
  { id: "network", label: "Network", hint: "any call to n8n or a webhook" },
];

/** Permission Bridge tiers + where the synaptic training log is written. */
export function BridgeCard() {
  const [b, setB] = useState<BridgeView | null>(null);
  useEffect(() => void cmd("bridge_get").then(setB), []);
  if (!b) return null;
  return (
    <Card
      title="Permission Bridge"
      hint="Every pipeline action declares the scopes it needs. Allow = runs; Ask = shows the confirmation card first; Deny = always refused, including background jobs. Turning on auto-sync is your standing consent for scheduled backups."
    >
      <div className="grid gap-2 sm:grid-cols-2">
        {SCOPES.map((s) => (
          <label key={s.id} className="flex items-center gap-3 rounded-[12px] border border-white/[0.06] px-3 py-2">
            <span className="min-w-0 flex-1">
              <span className="block text-sm text-ink">{s.label}</span>
              <span className="block truncate text-[11px] text-ink-3">{s.hint}</span>
            </span>
            <Select value={b.policy[s.id]} onChange={async (e) => setB(await cmd("bridge_set", { scope: s.id, tier: e.target.value as BridgeTier }))} className="!h-8 !w-24 !py-0 text-[12px]" aria-label={`${s.label} tier`}>
              <option value="allow">Allow</option>
              <option value="ask">Ask</option>
              <option value="deny">Deny</option>
            </Select>
          </label>
        ))}
      </div>
      {b.logDir && (
        <p className="mt-3 text-xs text-ink-3">
          Decisions and dispatch outcomes are logged for fine-tuning to <span className="font-mono text-ink-2">{b.logDir}</span> (one JSONL file per day).
        </p>
      )}
    </Card>
  );
}
