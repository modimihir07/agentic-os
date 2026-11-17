import { useEffect, useState } from "react";
import { CloudOff, CloudUpload, Download, HardDrive, Loader2, Lock, LockOpen, Sparkles, Trash2 } from "lucide-react";
import { Card, Field, Input, Select } from "@/components/ui";
import { cmd, onNativeEvent, type LedgerEntry } from "@/lib/platform";
import { gated } from "@/features/bridge/gate";
import { CfgError, SecretRow, Toggle, useOsCfg } from "./os-ui";

const month = () => new Date().toISOString().slice(0, 7);

/**
 * RAG memory lifecycle: Harvest → Condense → Fine-tune dataset → Locked vault,
 * cloud cache flush, and a ledger of Memory Books you can mount into RAG and
 * unmount again.
 */
export function MemoryLifecycleCard() {
  const { cfg, error, save } = useOsCfg();
  const [ledger, setLedger] = useState<LedgerEntry[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [target, setTarget] = useState(month());
  const [includeLocal, setIncludeLocal] = useState(false);

  const refresh = () => void cmd("memory_ledger").then(setLedger).catch(() => setLedger([]));
  useEffect(() => {
    refresh();
    let off: (() => void) | undefined;
    void onNativeEvent<{ step: string; detail: string }>("memory-progress", (p) => setProgress(`${p.step} · ${p.detail}`)).then((u) => (off = u));
    return () => off?.();
  }, []);
  if (!cfg) return null;
  const m = cfg.memory;

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setMsg(null);
    try {
      await fn();
      refresh();
    } catch (e) {
      setMsg({ tone: "err", text: String(e) });
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const harvest = () =>
    run("harvest", async () => {
      const l = await cmd("memory_harvest", { req: { month: target } });
      setMsg({ tone: "ok", text: `Memory Book ${l.month}: ${l.records} records → ${l.pairs} training pairs · sha256 ${l.sha256.slice(0, 12)}… ${l.encrypted ? "· AES-256 locked" : "· NOT encrypted (set a vault password)"}` });
    });

  const flush = (mo: string) =>
    run(`flush-${mo}`, async () => {
      const r = await gated(
        { action: "memory-flush", summary: `Flush cloud / droplet RAG cache for ${mo}`, detail: { month: mo, includeLocal } },
        (approved) => cmd("memory_flush", { req: { month: mo, includeLocal, approved } }),
        (x) => x.join(" · "),
      );
      if (r) setMsg({ tone: "ok", text: r.join(" · ") });
    });

  const mount = (mo: string, t: "local" | "droplet", on: boolean) =>
    run(`mount-${mo}-${t}`, async () => {
      if (on) {
        await gated(
          { action: "memory-mount", summary: `Reload the ${mo} Memory Book into ${t === "droplet" ? "the droplet" : "local"} RAG`, detail: { month: mo, target: t } },
          (approved) => cmd("memory_mount", { req: { month: mo, target: t, approved } }),
          () => "Mounted.",
        );
      } else await cmd("memory_unmount", { req: { month: mo, target: t } });
    });

  return (
    <Card
      title="RAG memory & vault lifecycle"
      hint="Harvest pulls every agent's conversations + training logs (and droplet cache), checksums them, condenses a Memory Book, builds a de-duplicated fine-tuning dataset, and locks it all in your local vault. Then the cloud copy can be wiped and selected books re-mounted whenever you need them."
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="RAG storage">
          <Select value={m.storage} onChange={(e) => save({ memory: { storage: e.target.value as typeof m.storage } })}>
            <option value="local">Local storage</option>
            <option value="droplet">Droplet vector DB / remote AnythingLLM</option>
            <option value="hybrid">Hybrid sync</option>
          </Select>
        </Field>
        <Field label="Dataset format">
          <Select value={m.datasetFormat} onChange={(e) => save({ memory: { datasetFormat: e.target.value as typeof m.datasetFormat } })}>
            <option value="chatml">ChatML (messages)</option>
            <option value="sharegpt">ShareGPT</option>
            <option value="alpaca">Alpaca</option>
          </Select>
        </Field>
        <Field label="Mount Memory Books into workspace">
          <Input key={m.mountWorkspace} defaultValue={m.mountWorkspace} onBlur={(e) => e.target.value.trim() !== m.mountWorkspace && save({ memory: { mountWorkspace: e.target.value.trim() } })} className="font-mono !text-[12px]" />
        </Field>
        <Field label="Locked vault folder" className="sm:col-span-2">
          <Input key={m.vaultDir} defaultValue={m.vaultDir} onBlur={(e) => e.target.value.trim() !== m.vaultDir && save({ memory: { vaultDir: e.target.value.trim() } })} className="font-mono !text-[12px]" spellCheck={false} />
        </Field>
        <Field label="Droplet cache collections (Qdrant)">
          <Input
            key={m.cacheCollections.join(",")}
            defaultValue={m.cacheCollections.join(", ")}
            onBlur={(e) => save({ memory: { cacheCollections: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) } })}
            placeholder="tony-cache, chat-logs"
            className="font-mono !text-[12px]"
          />
        </Field>
      </div>
      <SecretRow name="vault" label="Vault password (AES-256-GCM)" placeholder="10+ characters" hint="Stored in the Windows Credential Manager. Without it archives are written unencrypted. Lose it and locked archives can't be opened." />
      <div className="mt-1">
        <Toggle on={m.autoMonthly} onChange={(v) => save({ memory: { autoMonthly: v } })} label="Auto-run monthly (1st of the month)" hint="Harvests the previous month in the background — turning this on is your standing consent." />
        <Toggle on={m.autoFlush} onChange={(v) => save({ memory: { autoFlush: v } })} label="Auto-flush cloud after a verified local backup" disabled={!m.autoMonthly} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Input type="month" value={target} onChange={(e) => setTarget(e.target.value)} className="!h-10 !w-40 font-mono" aria-label="Month to harvest" />
        <button onClick={() => void harvest()} disabled={!!busy} className="pill-primary !h-10 text-sm">
          {busy === "harvest" ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />} Harvest & condense memory now
        </button>
        <label className="flex items-center gap-1.5 text-xs text-ink-3">
          <input type="checkbox" checked={includeLocal} onChange={(e) => setIncludeLocal(e.target.checked)} className="accent-alert" /> flush also clears {cfg.osName}'s local AnythingLLM threads
        </label>
      </div>
      {progress && <p className="mt-2 font-mono text-[11px] text-amber-soft">{progress}</p>}
      {msg && <p className={`mt-2 text-xs ${msg.tone === "ok" ? "text-teal" : "text-alert"}`}>{msg.text}</p>}

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-xs">
          <thead className="label-caps text-ink-3">
            <tr>
              <th className="py-1.5 font-normal">Memory Book</th>
              <th className="font-normal">Tokens</th>
              <th className="font-normal">Agents</th>
              <th className="font-normal">Status</th>
              <th className="text-right font-normal">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(ledger ?? []).map((l) => {
              const local = l.mounts.some((x) => x.target === "local");
              const remote = l.mounts.some((x) => x.target === "droplet");
              return (
                <tr key={l.id} className="border-t border-white/5 align-top">
                  <td className="py-2">
                    <span className="font-mono text-ink">{l.month}</span>
                    <span className="ml-1.5 inline-flex items-center gap-1 text-ink-3">
                      {l.encrypted ? <Lock size={11} className="text-teal" /> : <LockOpen size={11} className="text-amber-soft" />}
                      {l.records} rec · {l.pairs} pairs
                    </span>
                    {l.topics.length > 0 && <span className="block text-ink-3">{l.topics.slice(0, 4).join(" · ")}</span>}
                  </td>
                  <td className="py-2 font-mono text-ink-2">{l.summaryTokens.toLocaleString()}</td>
                  <td className="py-2 text-ink-2">{l.agents.join(", ") || "—"}</td>
                  <td className="py-2">
                    <span className={remote ? "text-volt" : local ? "text-teal" : "text-ink-2"}>{remote ? "Mounted in cloud RAG" : local ? "Mounted locally" : "Local only"}</span>
                    {l.flushedAt && <span className="block text-ink-3">cloud flushed {new Date(l.flushedAt * 1000).toLocaleDateString()}</span>}
                  </td>
                  <td className="py-2">
                    <div className="flex flex-wrap justify-end gap-1">
                      <SmallBtn busy={busy === `mount-${l.month}-local`} onClick={() => void mount(l.month, "local", !local)} title={local ? "Remove from local RAG" : "Load into local AnythingLLM"}>
                        <HardDrive size={11} /> {local ? "Unmount" : "Local RAG"}
                      </SmallBtn>
                      <SmallBtn busy={busy === `mount-${l.month}-droplet`} onClick={() => void mount(l.month, "droplet", !remote)} title={remote ? "Unmount & wipe from cloud" : "Reload to cloud / RAG"}>
                        {remote ? <CloudOff size={11} /> : <CloudUpload size={11} />} {remote ? "Unmount cloud" : "Cloud RAG"}
                      </SmallBtn>
                      <SmallBtn busy={busy === `flush-${l.month}`} onClick={() => void flush(l.month)} title="Flush cloud / droplet RAG cache (after checksum re-verify)" danger>
                        <Trash2 size={11} /> Flush
                      </SmallBtn>
                      {(["summary", "dataset"] as const).map((k) => (
                        <SmallBtn
                          key={k}
                          onClick={() =>
                            void cmd("memory_export", { month: l.month, kind: k })
                              .then((p) => setMsg({ tone: "ok", text: `Unlocked copy: ${p}` }))
                              .catch((e) => setMsg({ tone: "err", text: String(e) }))
                          }
                          title={`Decrypt the ${k} to <vault>/${l.month}/unlocked/`}
                        >
                          <Download size={11} /> {k === "summary" ? "Book" : ".jsonl"}
                        </SmallBtn>
                      ))}
                    </div>
                  </td>
                </tr>
              );
            })}
            {ledger && !ledger.length && (
              <tr>
                <td colSpan={5} className="py-4 text-center text-ink-3">
                  No Memory Books yet — run your first harvest.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <CfgError error={error} />
    </Card>
  );
}

function SmallBtn({ children, onClick, title, busy, danger }: { children: React.ReactNode; onClick: () => void; title: string; busy?: boolean; danger?: boolean }) {
  return (
    <button onClick={onClick} title={title} disabled={busy} className={`flex h-7 items-center gap-1 rounded-full border px-2 text-[11px] text-ink-2 hover:text-ink ${danger ? "border-alert/30 hover:border-alert/60" : "border-white/10"}`}>
      {busy ? <Loader2 size={11} className="animate-spin" /> : children}
    </button>
  );
}
