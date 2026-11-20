import { useEffect, useState } from "react";
import { Archive, Database, HardDriveDownload, Loader2, RefreshCw, Search } from "lucide-react";
import { Card, Chip, Field, Input, Stat } from "@/components/ui";
import { cc, type BackupInfo, type CcConfig, type Collection, type VaultResults } from "@/lib/cc-api";
import { useNav } from "@/stores/nav";
import { isTauri } from "@/lib/platform";
import { MemoryLifecycleCard } from "@/sections/settings/MemorySettings";

const FILTERS: { id: Collection; label: string }[] = [
  { id: "notes", label: "Brainstorms" },
  { id: "receipts", label: "Receipts" },
  { id: "invoices", label: "Invoices" },
  { id: "checks", label: "Cheques" },
  { id: "pipeline", label: "Scripts & auditions" },
  { id: "projects", label: "Jobs" },
  { id: "documents", label: "Documents" },
];

const OPEN: Partial<Record<Collection, Parameters<ReturnType<typeof useNav.getState>["go"]>[0]>> = {
  notes: "brainstorm",
  receipts: "finance",
  invoices: "finance",
  checks: "finance",
};

/** Local vector vault (semantic + keyword search) and offline backups. */
export function VaultSection() {
  const [q, setQ] = useState("");
  const [filters, setFilters] = useState<Set<Collection>>(new Set());
  const [res, setRes] = useState<VaultResults | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = useNav((s) => s.go);

  const search = async () => {
    if (!q.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      setRes(await cc.search(q, [...filters], 20));
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto h-full w-full max-w-5xl space-y-4 overflow-y-auto px-4 pb-32 md:px-6 md:pb-8">
      <Card title="Vault search" hint="Everything you scan, write or say is embedded locally (LM Studio embeddings) — ask in plain language. Falls back to keyword search if no embedding model is loaded.">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <div className="relative flex-1">
            <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="“the Home Depot receipts for the deck job”, “that idea about a car reel”…" className="!pl-10" aria-label="Search the vault" autoFocus />
          </div>
          <button className="pill-primary shrink-0" disabled={busy || !q.trim()}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />} Search
          </button>
        </form>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <Chip
              key={f.id}
              active={filters.has(f.id)}
              onClick={() => {
                const next = new Set(filters);
                if (next.has(f.id)) next.delete(f.id);
                else next.add(f.id);
                setFilters(next);
              }}
            >
              {f.label}
            </Chip>
          ))}
        </div>
        {err && <p className="mt-3 text-sm text-alert">{err}</p>}
        {res && (
          <div className="mt-4 space-y-2">
            <p className="label-caps text-ink-3">
              {res.results.length} results · {res.mode === "hybrid" ? "semantic + keyword" : res.mode}
            </p>
            {res.results.map((r) => (
              <button
                key={r.id}
                onClick={() => OPEN[r.collection] && go(OPEN[r.collection]!)}
                className="block w-full rounded-[14px] border border-white/[0.07] bg-white/[0.02] p-3 text-left hover:border-amber/40"
              >
                <div className="mb-1 flex items-center gap-2">
                  <span className="label-caps text-amber-soft">{FILTERS.find((f) => f.id === r.collection)?.label ?? r.collection}</span>
                  <span className="ml-auto font-mono text-[11px] text-ink-3">{(r.score * 100).toFixed(0)}%</span>
                </div>
                <p className="line-clamp-3 whitespace-pre-line text-sm text-ink">{r.snippet}</p>
              </button>
            ))}
            {!res.results.length && <p className="text-sm text-ink-3">Nothing matched.</p>}
          </div>
        )}
      </Card>
      <BackupCard />
      {isTauri() && <MemoryLifecycleCard />}
    </div>
  );
}

function BackupCard() {
  const [cfg, setCfg] = useState<CcConfig | null>(null);
  const [list, setList] = useState<{ dir: string; last: BackupInfo | null; backups: { name: string; size: number; at: number }[] } | null>(null);
  const [health, setHealth] = useState<Awaited<ReturnType<typeof cc.health>> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = async () => {
    try {
      const [c, l, h] = await Promise.all([cc.config(), cc.backups(), cc.health()]);
      setCfg(c);
      setList(l);
      setHealth(h);
    } catch (e) {
      setMsg(`Gateway: ${String(e)}`);
    }
  };
  useEffect(() => void load(), []);

  const saveBackup = async (patch: Partial<CcConfig["backup"]>) => {
    try {
      setCfg(await cc.setConfig({ backup: patch }));
      setMsg("Schedule saved.");
    } catch (e) {
      setMsg(String(e));
    }
  };

  return (
    <Card
      title="Offline backups"
      hint="Mirrors the shared database (notes, finance, reminders…), scanned documents, gateway config and each device's UI settings into a local folder as timestamped zips. Secrets stay in the OS keychain and are never included."
      action={
        <button onClick={() => void load()} aria-label="Refresh" className="pill-glass !h-8 !w-8 !p-0">
          <RefreshCw size={13} />
        </button>
      }
    >
      {health && (
        <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-4">
          <Stat label="Items" value={Object.values(health.counts).reduce((a, b) => a + b, 0)} sub={Object.entries(health.counts).map(([k, v]) => `${k} ${v}`).join(" · ") || "—"} />
          <Stat label="Vault" value={`${health.vault.embedded}/${health.vault.items}`} sub="embedded / indexed" tone="teal" />
          <Stat label="Local LLM" value={health.llm.ok ? "online" : "offline"} sub={health.llm.ok ? `${health.llm.models?.length ?? 0} models` : health.llm.error} tone={health.llm.ok ? "teal" : "alert"} />
          <Stat label="Last backup" value={list?.last ? new Date(list.last.at * 1000).toLocaleDateString() : "never"} sub={list?.last ? `${(list.last.size / 1024).toFixed(0)} KB · ${list.last.reason}` : undefined} tone="amber" />
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          className="pill-primary"
          disabled={!!busy}
          onClick={async () => {
            setBusy("backup");
            try {
              const b = await cc.backupNow();
              setMsg(`Backed up to ${b.file}`);
              await load();
            } catch (e) {
              setMsg(String(e));
            } finally {
              setBusy(null);
            }
          }}
        >
          {busy === "backup" ? <Loader2 size={15} className="animate-spin" /> : <HardDriveDownload size={15} />} Backup now
        </button>
        <button
          className="pill-glass"
          disabled={!!busy}
          onClick={async () => {
            setBusy("reindex");
            try {
              const r = await cc.reindex();
              setMsg(`Re-embedding ${r.queued} items in the background.`);
            } finally {
              setBusy(null);
            }
          }}
        >
          <Database size={15} /> Re-index vault
        </button>
      </div>
      {cfg && (
        <div className="mt-4 grid gap-3 sm:grid-cols-[auto_1fr_1fr_2fr]">
          <label className="flex items-center gap-2 self-end pb-2.5 text-sm text-ink-2">
            <input type="checkbox" checked={cfg.backup.enabled} onChange={(e) => void saveBackup({ enabled: e.target.checked })} className="accent-amber" /> Scheduled
          </label>
          <Field label="Every (hours)">
            <Input type="number" min={1} max={720} defaultValue={cfg.backup.intervalHours} onBlur={(e) => void saveBackup({ intervalHours: Number(e.target.value) })} className="font-mono" />
          </Field>
          <Field label="Keep last">
            <Input type="number" min={1} max={365} defaultValue={cfg.backup.keep} onBlur={(e) => void saveBackup({ keep: Number(e.target.value) })} className="font-mono" />
          </Field>
          <Field label="Backup folder (on the gateway machine)">
            <Input defaultValue={cfg.backup.dir} onBlur={(e) => e.target.value !== cfg.backup.dir && void saveBackup({ dir: e.target.value })} className="font-mono !text-[12px]" spellCheck={false} />
          </Field>
        </div>
      )}
      {msg && <p className="mt-3 break-all text-xs text-ink-2">{msg}</p>}
      {list && list.backups.length > 0 && (
        <ul className="mt-4 max-h-56 space-y-1 overflow-y-auto font-mono text-[12px]">
          {list.backups.map((b) => (
            <li key={b.name} className="flex items-center gap-2 rounded-[10px] border border-white/[0.05] px-3 py-1.5 text-ink-2">
              <Archive size={12} className="text-ink-3" />
              <span className="flex-1 truncate">{b.name}</span>
              <span>{(b.size / 1024).toFixed(0)} KB</span>
              <span className="text-ink-3">{new Date(b.at * 1000).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
