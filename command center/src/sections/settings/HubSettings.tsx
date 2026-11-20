import { useEffect, useState } from "react";
import { CheckCircle2, Download, FolderSearch, Link2, Loader2, PlugZap, RefreshCw, Wrench, XCircle } from "lucide-react";
import { Card, Field, Select } from "@/components/ui";
import { gateway } from "@/lib/gateway";
import { cmd, type BenchResult, type CliStatus, type LabModel, type SchedulerConfig } from "@/lib/platform";
import { gated } from "@/features/bridge/gate";
import { CfgError, SecretRow, Toggle, useOsCfg } from "./os-ui";
import { overseerFamilyOn, toggleOverseer, type OverseerFamily } from "./overseer-toggle";

// ── Compute Router: split sliders + hardware presets ─────────────────────────

const PRESETS: { id: SchedulerConfig["profile"]; label: string; hint: string; patch: Partial<SchedulerConfig> }[] = [
  { id: "sequential", label: "12 GB local GPU — Tony priority (sequential)", hint: "One generation at a time; Tony always jumps the queue.", patch: { profile: "sequential", tonyPriorityPct: 90, maxConcurrency: 1, offloadPct: 0 } },
  { id: "hybrid", label: "Hybrid local + cloud / CLI split", hint: "Tony stays local; heavy coding goes to the CLI/cloud engine.", patch: { profile: "hybrid", tonyPriorityPct: 85, maxConcurrency: 1, offloadPct: 60 } },
  { id: "parallel", label: "High-VRAM server / multi-GPU (parallel agents)", hint: "Several agents generate at once.", patch: { profile: "parallel", tonyPriorityPct: 70, maxConcurrency: 4, offloadPct: 20 } },
];

export function ComputeRouterCard() {
  const { cfg, error, save } = useOsCfg();
  if (!cfg) return null;
  const s = cfg.scheduler;
  const set = (p: Partial<SchedulerConfig>) => save({ scheduler: p });
  return (
    <Card
      title="Compute router — delegation split"
      hint="Every local generation takes the single GPU slot (“baton”). Tony's turns go first; pipeline steps, the verifier and memory work wait their turn — that's what keeps Tony under a second."
    >
      <div className="grid gap-2 sm:grid-cols-3">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            onClick={() => set(p.patch)}
            className={`rounded-[14px] border p-3 text-left text-xs transition-colors ${s.profile === p.id ? "border-amber/60 bg-amber/10 text-ink" : "border-white/10 text-ink-2 hover:text-ink"}`}
          >
            <span className="block font-medium">{p.label}</span>
            <span className="mt-1 block text-ink-3">{p.hint}</span>
          </button>
        ))}
      </div>
      <div className="mt-4 space-y-4">
        <label className="block text-sm text-ink-2">
          Main OS (Tony) vs background agent queue
          <div className="mt-1 flex items-center gap-3">
            <span className="w-24 font-mono text-[11px] text-ink-3">{s.tonyPriorityPct}% Tony</span>
            <input type="range" min={50} max={100} step={5} value={s.tonyPriorityPct} onChange={(e) => set({ tonyPriorityPct: Number(e.target.value) })} className="flex-1 accent-amber" aria-label="Tony priority" />
            <span className="w-28 text-right font-mono text-[11px] text-ink-3">{100 - s.tonyPriorityPct}% background</span>
          </div>
        </label>
        <label className="block text-sm text-ink-2">
          Local GPU vs cloud / CLI auto-offload
          <div className="mt-1 flex items-center gap-3">
            <span className="w-24 font-mono text-[11px] text-ink-3">{100 - s.offloadPct}% local</span>
            <input type="range" min={0} max={100} step={10} value={s.offloadPct} onChange={(e) => set({ offloadPct: Number(e.target.value) })} className="flex-1 accent-teal" aria-label="Offload share" />
            <span className="w-28 text-right font-mono text-[11px] text-ink-3">{s.offloadPct}% offload</span>
          </div>
          <span className="mt-1 block text-xs text-ink-3">≥ 50 %: the Coder's build step runs on the offload engine. ≥ 80 %: the Designer's too. Blocked by the kill switch / LOCAL ONLY.</span>
        </label>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Offload engine">
            <Select value={s.offloadEngine} onChange={(e) => set({ offloadEngine: e.target.value as SchedulerConfig["offloadEngine"] })}>
              <option value="claude-cli">Claude Code CLI</option>
              <option value="gemini-cli">Gemini CLI</option>
              <option value="llm-cli">llm CLI (default model)</option>
              <option value="claude-api">Claude API</option>
              <option value="gemini-api">Gemini API</option>
            </Select>
          </Field>
          <Field label="GPU slots (max concurrency)">
            <Select value={String(s.maxConcurrency)} onChange={(e) => set({ maxConcurrency: Number(e.target.value) })}>
              {[1, 2, 3, 4, 6, 8].map((n) => (
                <option key={n} value={n}>
                  {n} {n === 1 ? "(12 GB card)" : ""}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Chat history sent to Tony">
            <Select value={String(s.historyTurns)} onChange={(e) => set({ historyTurns: Number(e.target.value) })}>
              {[4, 6, 8, 12].map((n) => (
                <option key={n} value={n}>
                  last {n} turns
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </div>
      <CfgError error={error} />
    </Card>
  );
}

// ── CLI Hub ─────────────────────────────────────────────────────────────────

export function CliHubCard() {
  const [list, setList] = useState<CliStatus[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [out, setOut] = useState<Record<string, string>>({});
  const load = () => void cmd("cli_status").then(setList);
  useEffect(load, []);
  const install = async (c: CliStatus) => {
    setBusy(c.name);
    try {
      const r = await gated({ action: "cli-install", summary: `${c.installed ? "Repair" : "Install"} ${c.label}`, detail: { command: c.how } }, (approved) => cmd("cli_install", { name: c.name, approved }), (x) => x);
      if (r !== null) setOut((o) => ({ ...o, [c.name]: r }));
      load();
    } catch (e) {
      setOut((o) => ({ ...o, [c.name]: `✗ ${e}` }));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card
      title="CLI agents hub"
      hint="Agent CLIs the OS (and the gateway's “Agentic OS” backend) can run. Paths are resolved explicitly, so npm/uv shims like opencode.cmd work on Windows."
      action={
        <button onClick={load} className="pill-glass !h-8 text-xs">
          <RefreshCw size={13} /> Re-check
        </button>
      }
    >
      {!list && <Loader2 size={14} className="animate-spin text-ink-3" />}
      <ul className="divide-y divide-white/5">
        {list?.map((c) => (
          <li key={c.name} className="flex flex-wrap items-center gap-2 py-2">
            {c.installed && !c.error ? <CheckCircle2 size={15} className="text-teal" /> : <XCircle size={15} className={c.installed ? "text-amber-soft" : "text-alert"} />}
            <span className="w-40 text-sm text-ink">{c.label}</span>
            <span className="font-mono text-[11px] text-ink-2">{c.version ?? (c.installed ? "installed (no version)" : "not installed")}</span>
            <span className="ml-auto flex items-center gap-2">
              {c.canInstall ? (
                <button disabled={busy === c.name} onClick={() => void install(c)} className="pill-glass !h-8 text-xs">
                  {busy === c.name ? <Loader2 size={12} className="animate-spin" /> : c.installed ? <Wrench size={12} /> : <Download size={12} />} {c.installed ? "Repair" : "Install"}
                </button>
              ) : (
                !c.installed && <span className="text-[11px] text-ink-3">{c.how}</span>
              )}
            </span>
            {(c.error || out[c.name]) && <pre className="well w-full whitespace-pre-wrap rounded-[8px] p-2 text-[11px] text-ink-2">{(out[c.name] ?? c.error ?? "").slice(0, 600)}</pre>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ── Claude & Gemini (API key or CLI subscription) ───────────────────────────

const CLAUDE_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-4-6", "claude-sonnet-4-6"];
const GEMINI_MODELS = ["gemini-2.5-pro", "gemini-2.5-flash"];

export function AiProvidersCard() {
  const { cfg, error, save } = useOsCfg();
  const [probe, setProbe] = useState<Record<string, string>>({});
  if (!cfg) return null;
  const o = cfg.overseer;
  // Off → the local model; on keeps an existing API/CLI choice (see overseer-toggle.ts).
  const setOverseer = (family: OverseerFamily, on: boolean) => {
    const next = toggleOverseer(o.engine, family, on);
    if (next !== o.engine) save({ overseer: { engine: next } });
  };
  const test = (engine: string) => {
    setProbe((p) => ({ ...p, [engine]: "…" }));
    void cmd("overseer_ask", { req: { question: "Reply with exactly: connected", transcript: [], context: "", engine } })
      .then((r) => setProbe((p) => ({ ...p, [engine]: `✓ ${r.latencyMs}ms · “${r.answer.slice(0, 30)}”` })))
      .catch((e) => setProbe((p) => ({ ...p, [engine]: `✗ ${String(e).slice(0, 140)}` })));
  };
  const Row = ({ engine, label }: { engine: string; label: string }) => (
    <div className="flex flex-wrap items-center gap-2 py-1">
      <span className="w-44 text-sm text-ink-2">{label}</span>
      <button onClick={() => test(engine)} className="pill-glass !h-8 text-xs">
        <PlugZap size={12} /> Test connection
      </button>
      {probe[engine] && <span className={`font-mono text-[11px] ${probe[engine].startsWith("✓") ? "text-teal" : "text-ink-2"}`}>{probe[engine]}</span>}
    </div>
  );
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Anthropic Claude" hint="API key mode (ANTHROPIC_API_KEY in the environment / repo-root .env, else the key saved here in the keychain) or your Claude subscription through the Claude Code CLI. Used by the Overseer, the verifier (External) and offloaded pipeline steps.">
        <Field label="Model (API mode)">
          <Select value={o.claudeModel} onChange={(e) => save({ overseer: { claudeModel: e.target.value } })}>
            {[...new Set([o.claudeModel, ...CLAUDE_MODELS])].map((m) => (
              <option key={m}>{m}</option>
            ))}
          </Select>
        </Field>
        <SecretRow name="anthropic" label="Anthropic API key" />
        <Row engine="claude-api" label="API key mode" />
        <Row engine="claude-cli" label="CLI subscription (claude)" />
        <Toggle on={overseerFamilyOn(o.engine, "claude")} onChange={(v) => setOverseer("claude", v)} label="Use Claude as the Overseer" />
      </Card>
      <Card title="Google Gemini" hint="API key mode (GEMINI_API_KEY in the environment / repo-root .env, else the key saved here in the keychain) or your Google account through the Gemini CLI (run `gemini` once to sign in).">
        <Field label="Model (API mode)">
          <Select value={o.geminiModel} onChange={(e) => save({ overseer: { geminiModel: e.target.value } })}>
            {[...new Set([o.geminiModel, ...GEMINI_MODELS])].map((m) => (
              <option key={m}>{m}</option>
            ))}
          </Select>
        </Field>
        <SecretRow name="gemini" label="Gemini API key" />
        <Row engine="gemini-api" label="API key mode" />
        <Row engine="gemini-cli" label="CLI subscription (gemini)" />
        <Toggle on={overseerFamilyOn(o.engine, "gemini")} onChange={(v) => setOverseer("gemini", v)} label="Use Gemini as the Overseer" />
      </Card>
      <CfgError error={error} />
    </div>
  );
}

// ── Local model library (D:\ scan) ──────────────────────────────────────────

interface ScanModel {
  name: string;
  path: string;
  category: string;
  sizeGb: number;
  formats: string[];
  ggufs: { file: string; gb: number }[];
  status: string;
  lmstudioLoadable: boolean;
  registered: boolean;
  note: string;
}
const GROUP_ORDER = ["Productivity & Coding LLMs", "Vision & Media Models", "Embedding Models", "Voice STT / TTS Models"];
const STATUS_TONE: Record<string, string> = { gguf: "text-teal", "needs-conversion": "text-amber-soft", "partial-download": "text-alert", incomplete: "text-ink-3", "unknown-format": "text-ink-3" };

export function ModelLibraryCard() {
  const [scan, setScan] = useState<{ groups: Record<string, ScanModel[]>; count: number; scannedAt: number } | null>(null);
  const [busy, setBusy] = useState<"scan" | "sync" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [clis, setClis] = useState<CliStatus[]>([]);
  const rescan = async () => {
    setBusy("scan");
    try {
      setScan(await gateway("/api/models/local-scan", { timeoutMs: 120_000 }));
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(null);
    }
  };
  useEffect(() => {
    void rescan();
    void cmd("cli_status").then(setClis).catch(() => undefined);
  }, []);
  const sync = async () => {
    setBusy("sync");
    try {
      const r = await gateway<{ linked: string[]; alreadyLinked: string[]; errors: string[] }>("/api/models/sync-lmstudio", { method: "POST", timeoutMs: 120_000 });
      setMsg(`Linked ${r.linked.length} new · ${r.alreadyLinked.length} already linked${r.errors.length ? ` · errors: ${r.errors.join("; ")}` : ""}. They appear in every model dropdown via Bionic.`);
      await rescan();
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card
      title="Local model library (D:\ drive)"
      hint="Scans D:\AI Models Productivity, D:\AI Models Media and Vision and D:\ai model voices. GGUF folders can be linked into Bionic (a directory junction — nothing is copied) and then show up in every model dropdown."
      action={
        <>
          <button onClick={() => void rescan()} disabled={!!busy} className="pill-glass !h-8 text-xs">
            {busy === "scan" ? <Loader2 size={13} className="animate-spin" /> : <FolderSearch size={13} />} Rescan D:\
          </button>
          <button onClick={() => void sync()} disabled={!!busy} className="pill-primary !h-8 text-xs">
            {busy === "sync" ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} />} Register GGUFs with Bionic
          </button>
        </>
      }
    >
      {msg && <p className="mb-2 text-xs text-teal">{msg}</p>}
      {!scan && <Loader2 size={14} className="animate-spin text-ink-3" />}
      {scan &&
        [...GROUP_ORDER.filter((g) => scan.groups[g]), ...Object.keys(scan.groups).filter((g) => !GROUP_ORDER.includes(g))].map((g) => (
          <details key={g} open={g === GROUP_ORDER[0]} className="mb-2">
            <summary className="cursor-pointer text-sm text-ink">
              {g} <span className="font-mono text-[11px] text-ink-3">({scan.groups[g].length})</span>
            </summary>
            <ul className="mt-1 space-y-1">
              {scan.groups[g].map((m) => (
                <li key={m.path} className="grid grid-cols-[1fr_auto] gap-x-2 rounded-[10px] px-2 py-1 text-xs hover:bg-white/[0.03]" title={m.path}>
                  <span className="truncate text-ink">
                    {m.name} {m.registered && <span className="ml-1 rounded-full bg-teal/15 px-1.5 text-[10px] text-teal">in Bionic</span>}
                  </span>
                  <span className="font-mono text-[11px] text-ink-3">{m.sizeGb} GB</span>
                  <span className={`col-span-2 text-[11px] ${STATUS_TONE[m.status] ?? "text-ink-3"}`}>
                    {m.status} — {m.note}
                    {m.ggufs.length > 0 && ` · ${m.ggufs.map((x) => x.file.split(/[\\/]/).pop()).join(", ")}`}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ))}
      <details className="mb-1">
        <summary className="cursor-pointer text-sm text-ink">
          CLI agents <span className="font-mono text-[11px] text-ink-3">({clis.filter((c) => c.installed).length} installed)</span>
        </summary>
        <ul className="mt-1 flex flex-wrap gap-1.5">
          {clis.map((c) => (
            <li key={c.name} className={`rounded-full border px-2 py-0.5 font-mono text-[11px] ${c.installed ? "border-teal/40 text-teal" : "border-white/10 text-ink-3"}`}>
              {c.name} {c.version ? `· ${c.version.slice(0, 24)}` : ""}
            </li>
          ))}
        </ul>
      </details>
    </Card>
  );
}


// ── Model Lab: try Tony's brain on different local models ────────────────────

/** Well-suited for a 12 GB RTX 3060 — not on disk yet; get them in Bionic → Discover. */
const SUGGESTED: { name: string; search: string; why: string }[] = [
  { name: "Qwen3-8B (Q4_K_M, ~5 GB)", search: "qwen3-8b", why: "Strong all-rounder, fast, fits with 32k context." },
  { name: "Qwen2.5-Coder-7B-Instruct (Q4_K_M, ~4.7 GB)", search: "qwen2.5-coder-7b-instruct", why: "Most of the 14B's coding skill at about twice the speed, full context." },
  { name: "Mistral-Nemo-Instruct-2407 12B (Q4_K_M, ~7 GB)", search: "mistral-nemo-instruct-2407", why: "Great writing and tool calling; 16k context fits." },
  { name: "Llama-3.1-8B-Instruct (Q4_K_M, ~4.9 GB)", search: "meta-llama-3.1-8b-instruct", why: "Reliable general assistant (your D:\\ copy is HF weights, not GGUF)." },
  { name: "Gemma-3-12B-it (Q4_K_M, ~7.3 GB)", search: "gemma-3-12b-it", why: "Very good reasoning plus vision in one model." },
];

export function ModelLabCard() {
  const [list, setList] = useState<LabModel[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, BenchResult>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const load = () => void cmd("model_lab_list").then(setList).catch((e) => setMsg(String(e)));
  useEffect(load, []);
  const bench = async (m: LabModel) => {
    setBusy(m.key);
    setMsg(`Loading ${m.name} alone on the GPU and timing an answer…`);
    try {
      const r = await cmd("model_bench", { model: m.key });
      setResults((x) => ({ ...x, [m.key]: r }));
      setMsg(r.error ? `${m.name}: ${r.error}` : null);
    } finally {
      setBusy(null);
      load();
    }
  };
  const use = async (m: LabModel) => {
    setBusy(m.key);
    try {
      const notes = await cmd("model_use", { model: m.key });
      setMsg(`Tony now runs on ${m.name}. ${notes.slice(1).join(" · ")}`);
      load();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card
      title="Model Lab — choose Tony's brain"
      hint="Benchmark loads ONE model alone at a context that fits your 12 GB card and times a real answer. “Use for Tony” switches Tony and every AnythingLLM agent to that model, so a second model never auto-loads next to it."
      action={
        <button onClick={load} className="pill-glass !h-8 text-xs">
          <RefreshCw size={13} /> Refresh
        </button>
      }
    >
      {msg && <p className="mb-2 text-xs text-teal">{msg}</p>}
      {!list && <Loader2 size={14} className="animate-spin text-ink-3" />}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] text-left text-xs">
          <thead className="label-caps text-ink-3">
            <tr>
              <th className="py-1 font-normal">Model</th>
              <th className="font-normal">Size</th>
              <th className="font-normal">Fit (context)</th>
              <th className="font-normal">First word · speed · VRAM</th>
              <th className="text-right font-normal">Try</th>
            </tr>
          </thead>
          <tbody>
            {list?.map((m) => {
              const r = results[m.key];
              return (
                <tr key={m.key} className="border-t border-white/5 align-top">
                  <td className="py-2">
                    <span className="text-ink">{m.name || m.key}</span>
                    {m.tony && <span className="ml-1.5 rounded-full bg-amber/20 px-1.5 text-[10px] text-amber-light">TONY</span>}
                    {m.loaded && <span className="ml-1 rounded-full bg-teal/15 px-1.5 text-[10px] text-teal">loaded</span>}
                    {m.vision && <span className="ml-1 text-[10px] text-ink-3">vision</span>}
                    <span className="block font-mono text-[10px] text-ink-3">
                      {m.params} {m.quant}
                    </span>
                  </td>
                  <td className="py-2 font-mono text-ink-2">{m.sizeGb} GB</td>
                  <td className={`py-2 ${m.fit === "fits" ? "text-teal" : m.fit === "tight" ? "text-amber-soft" : "text-alert"}`}>
                    {m.fit} · {Math.round(m.context / 1024)}k
                  </td>
                  <td className="py-2 font-mono text-ink-2">
                    {r ? (r.error ? <span className="text-alert">{r.error.slice(0, 80)}</span> : `${(r.firstTokenMs / 1000).toFixed(2)}s · ${r.tokensPerSec} tok/s · ${r.vramUsedGb}/${Math.round(r.vramTotalGb)} GB`) : "—"}
                    {r?.reply && (
                      <span className="block max-w-[320px] truncate font-sans text-[11px] text-ink-3" title={r.reply}>
                        “{r.reply}”
                      </span>
                    )}
                  </td>
                  <td className="py-2">
                    <div className="flex justify-end gap-1">
                      <button disabled={!!busy} onClick={() => void bench(m)} className="pill-glass !h-7 !px-2.5 text-[11px]">
                        {busy === m.key ? <Loader2 size={11} className="animate-spin" /> : <PlugZap size={11} />} Benchmark
                      </button>
                      <button disabled={!!busy || m.tony} onClick={() => void use(m)} className="pill-primary !h-7 !px-2.5 text-[11px]">
                        Use for Tony
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <details className="mt-3">
        <summary className="cursor-pointer text-sm text-ink">More models well-suited to a 12 GB RTX 3060</summary>
        <ul className="mt-2 space-y-1.5 text-xs">
          {SUGGESTED.map((x) => (
            <li key={x.search}>
              <span className="text-ink">{x.name}</span> — <span className="text-ink-2">{x.why}</span> <span className="font-mono text-ink-3">(Bionic → Discover → “{x.search}”)</span>
            </li>
          ))}
        </ul>
      </details>
    </Card>
  );
}
