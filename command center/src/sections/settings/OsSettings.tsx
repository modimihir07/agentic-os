import { useEffect, useState } from "react";
import { Eye, Loader2, Network, PlugZap, RefreshCw, RotateCw, X } from "lucide-react";
import { Card, Field, Input, Select } from "@/components/ui";
import { cmd, type EndpointProbe, type ListenFinding, type OverseerEngine, type RedactionRecord } from "@/lib/platform";
import { ComputeModeSwitch } from "@/features/os/OsControls";
import { setWakeMode } from "@/features/voice/voice-controller";
import { useSettings } from "@/stores/settings";
import { CfgError, SecretRow, TierSelect, Toggle, useOsCfg } from "./os-ui";
import { ROLE_IDS, roleLabel, type RoleId } from "@/features/dispatcher/roles";

/** Text input that saves on blur (re-keyed so it resets to the saved value). */
function BlurInput({ value, onSave, ...rest }: { value: string; onSave: (v: string) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onBlur" | "defaultValue">) {
  return <Input key={value} defaultValue={value} onBlur={(e) => e.target.value.trim() !== value && onSave(e.target.value.trim())} spellCheck={false} {...rest} />;
}

// ── Identity ────────────────────────────────────────────────────────────────

export function OsIdentityCard() {
  const { cfg, error, save } = useOsCfg();
  const wakeMode = useSettings((s) => s.wakeMode);
  const osAlarms = useSettings((s) => s.reminders.osFallback);
  const setSettings = useSettings((s) => s.set);
  const [preview, setPreview] = useState<string | null>(null);
  if (!cfg) return <Card title="OS identity">{error ?? "Loading…"}</Card>;
  return (
    <Card
      title={`OS identity · ${cfg.osName}`}
      hint="Your OS's name is used everywhere — headers, chat badges, the voice HUD, the system prompt and wake words. MASTER_IDENTITY.md is injected into every turn so it knows who you are."
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
        <Field label="OS name / callsign">
          <BlurInput value={cfg.osName} onSave={(v) => save({ osName: v, wakeWords: [`hey ${v.toLowerCase()}`, `yo ${v.toLowerCase()}`, v.toLowerCase()] })} />
        </Field>
        <Field label="Wake words (comma-separated)">
          <BlurInput value={cfg.wakeWords.join(", ")} onSave={(v) => save({ wakeWords: v.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean) })} />
        </Field>
        <Field label="Identity file" className="sm:col-span-2">
          <div className="flex gap-1.5">
            <BlurInput value={cfg.identityPath} onSave={(v) => save({ identityPath: v })} className="font-mono !text-[12px]" />
            <button className="pill-glass !h-10 shrink-0 text-xs" onClick={() => void cmd("os_identity").then(setPreview).catch((e) => setPreview(`⚠ ${e}`))}>
              <Eye size={13} /> Preview
            </button>
          </div>
        </Field>
      </div>
      {preview && <pre className="well mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-[12px] p-3 text-[11px] text-ink-2">{preview.slice(0, 2000)}</pre>}
      <div className="mt-2">
        <Toggle
          on={cfg.rootDirective}
          onChange={(v) => save({ rootDirective: v })}
          label="Root authority directive"
          hint={`Standing instruction: ${cfg.osName} is pre-authorized to query your AnythingLLM agents, summarize booking/email threads and run local MCP tools — and must use live dashboard data instead of claiming it has no real-time access. Mutating actions still need your yes.`}
        />
        <Toggle
          on={wakeMode}
          onChange={setWakeMode}
          label={`Hands-free wake word (“${cfg.wakeWords[0] ?? "hey tony"}”)`}
          hint="Keeps the mic listening through Whisper and acts only on sentences that start with a wake word. Uses some CPU; the mic button and Ctrl+Shift+Space still work either way."
        />
        <Toggle
          on={osAlarms}
          onChange={(v) => setSettings({ reminders: { osFallback: v } })}
          label="Alarms ring with the app closed (Windows)"
          hint="Each alarm, timer or reminder also gets a one-time Windows Task Scheduler alarm (folder \AgenticOS) that shows a toast at the due time. While the app runs it rings first and removes that task, so nothing rings twice."
        />
      </div>
      <CfgError error={error} />
    </Card>
  );
}

// ── Compute & droplet ───────────────────────────────────────────────────────

export function ComputeCard() {
  const { cfg, error, save } = useOsCfg();
  if (!cfg) return null;
  return (
    <Card title="Compute routing" hint="Where thinking happens. HYBRID watches the RTX 3060: when VRAM crosses the threshold (or a prompt is huge) that turn goes to the droplet / cloud instead.">
      <ComputeModeSwitch />
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-sm text-ink-2">
          VRAM offload threshold
          <div className="mt-1 flex items-center gap-3">
            <input type="range" min={50} max={99} value={cfg.compute.vramThresholdPct} onChange={(e) => save({ compute: { vramThresholdPct: Number(e.target.value) } })} className="flex-1 accent-amber" />
            <span className="w-12 font-mono text-ink">{cfg.compute.vramThresholdPct}%</span>
          </div>
        </label>
        <Field label="Heavy-context offload (characters)">
          <BlurInput value={String(cfg.compute.heavyContextChars)} onSave={(v) => Number(v) > 0 && save({ compute: { heavyContextChars: Math.round(Number(v)) } })} className="font-mono" inputMode="numeric" />
        </Field>
      </div>
      <div className="mt-2">
        <Toggle
          on={cfg.compute.deepThinking}
          onChange={(v) => save({ compute: { deepThinking: v } })}
          label="Deep thinking for answers"
          hint="Lets reasoning models (Qwen3.5) think before replying: smarter on hard questions, but 10–60 s slower. Planning, tool routing and the verifier never think."
        />
      </div>
      <CfgError error={error} />
    </Card>
  );
}

export function DropletCard() {
  const { cfg, error, save } = useOsCfg();
  const [probes, setProbes] = useState<EndpointProbe[] | null>(null);
  const [testing, setTesting] = useState(false);
  if (!cfg) return null;
  const d = cfg.droplet;
  const test = async () => {
    setTesting(true);
    try {
      setProbes(await cmd("droplet_test"));
    } finally {
      setTesting(false);
    }
  };
  return (
    <Card
      title="Cloud droplet"
      hint="Master switch: off shows OFFLINE (MANUAL) everywhere and nothing is ever sent to it. Reached over NetBird; with the network lock on, requests carry your gateway bearer token."
      action={
        <button onClick={() => void test()} className="pill-glass !h-8 text-xs" disabled={testing}>
          {testing ? <Loader2 size={13} className="animate-spin" /> : <RotateCw size={13} />} Test & reconnect
        </button>
      }
    >
      <Toggle on={d.enabled} onChange={(v) => save({ droplet: { enabled: v } })} label={d.enabled ? "Droplet enabled" : "Droplet OFFLINE (manual)"} hint={`Host ${d.host}`} />
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        <Field label="Model / proxy endpoint (OpenAI-compatible)">
          <BlurInput value={d.modelUrl} onSave={(v) => save({ droplet: { modelUrl: v } })} className="font-mono !text-[12px]" />
        </Field>
        <Field label="Qdrant vector DB">
          <BlurInput value={d.qdrantUrl} onSave={(v) => save({ droplet: { qdrantUrl: v } })} className="font-mono !text-[12px]" />
        </Field>
        <Field label="n8n webhooks">
          <BlurInput value={d.n8nUrl} onSave={(v) => save({ droplet: { n8nUrl: v } })} className="font-mono !text-[12px]" />
        </Field>
        <Field label="Remote AnythingLLM">
          <BlurInput value={d.anythingllmUrl} onSave={(v) => save({ droplet: { anythingllmUrl: v } })} className="font-mono !text-[12px]" />
        </Field>
        <Field label="NetBird host">
          <BlurInput value={d.host} onSave={(v) => save({ droplet: { host: v } })} className="font-mono !text-[12px]" />
        </Field>
      </div>
      <SecretRow name="anythingllm-remote" label="Remote AnythingLLM API key" />
      {probes && (
        <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
          {probes.map((p) => (
            <li key={p.id} className="well flex items-center gap-2 rounded-[10px] px-3 py-2 text-xs">
              <span className={`size-2 rounded-full ${p.up ? "bg-teal" : "bg-alert"}`} />
              <span className="text-ink">{p.label}</span>
              <span className="ml-auto font-mono text-ink-3">{p.up ? `${p.detail} · ${p.latencyMs}ms` : p.detail}</span>
            </li>
          ))}
        </ul>
      )}
      <CfgError error={error} />
    </Card>
  );
}

// ── AnythingLLM workspaces ──────────────────────────────────────────────────

// Curated display order for this card; derived from the shared ROLE_IDS so a role added or
// removed there can't silently drift out of sync — any id not listed here is appended.
const ROLE_ORDER: RoleId[] = ["librarian", "coder", "booking", "ops", "general", "prompter", "designer"];
const ROLE_LABEL_OVERRIDES: Partial<Record<RoleId, string>> = { general: "Tony (own RAG)", prompter: "Prompter / dispatcher" };
const ROLES: [RoleId, string][] = [...ROLE_ORDER, ...ROLE_IDS.filter((id) => !ROLE_ORDER.includes(id))].map((id) => [id, ROLE_LABEL_OVERRIDES[id] ?? roleLabel(id)]);

export function WorkspacesCard() {
  const { cfg, error, save } = useOsCfg();
  const [ws, setWs] = useState<{ slug: string; name: string }[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const discover = () => void cmd("anythingllm_workspaces").then((w) => (setWs(w), setErr(null))).catch((e) => setErr(String(e)));
  useEffect(discover, []);
  if (!cfg) return null;
  const map = cfg.anythingllm.workspaces;
  return (
    <Card
      title="Sub-agent workspaces (AnythingLLM)"
      hint={`${cfg.osName} talks to each specialist through POST /api/v1/workspace/{slug}/chat, in a monthly “${cfg.osName} · YYYY-MM” thread so it can be archived and flushed later.`}
      action={
        <button onClick={discover} className="pill-glass !h-8 text-xs">
          <RefreshCw size={13} /> Discover
        </button>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {ROLES.map(([role, label]) => (
          <Field key={role} label={label}>
            <Select value={map[role] ?? ""} onChange={(e) => save({ anythingllm: { workspaces: { ...map, [role]: e.target.value } } })} className="font-mono !text-[13px]">
              <option value="">— not delegated —</option>
              {[...new Set([...(ws?.map((w) => w.slug) ?? []), ...(map[role] ? [map[role]] : [])])].map((s) => (
                <option key={s} value={s}>
                  {s}
                  {ws && !ws.some((w) => w.slug === s) ? " (not found)" : ""}
                </option>
              ))}
            </Select>
          </Field>
        ))}
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-[2fr_1fr]">
        <Field label="AnythingLLM API base">
          <BlurInput value={cfg.anythingllm.baseUrl} onSave={(v) => save({ anythingllm: { baseUrl: v } })} className="font-mono !text-[12px]" />
        </Field>
        <Field label="Sub-agent timeout (s)">
          <BlurInput value={String(cfg.anythingllm.timeoutSecs)} onSave={(v) => Number(v) > 0 && save({ anythingllm: { timeoutSecs: Math.round(Number(v)) } })} className="font-mono" inputMode="numeric" />
        </Field>
      </div>
      {err && <p className="mt-2 text-xs text-alert">{err}</p>}
      {ws && <p className="mt-2 text-xs text-ink-3">Found {ws.length} workspace{ws.length === 1 ? "" : "s"}: {ws.map((w) => w.slug).join(", ")}</p>}
      <CfgError error={error} />
    </Card>
  );
}

// ── Permissions ─────────────────────────────────────────────────────────────

export function OsPermissionsCard() {
  const { cfg, error, save } = useOsCfg();
  if (!cfg) return null;
  const p = cfg.permissions;
  return (
    <Card title={`${cfg.osName} master permissions`} hint="Root permissions for the OS itself. Allow = runs; Ask = a confirmation card first; Deny = refused (enforced in Rust). Mutating actions always confirm regardless.">
      <TierSelect label="AnythingLLM inter-agent delegation" hint="Tony → Booking / Coder / Librarian / Ops" value={p.delegation} onChange={(t) => save({ permissions: { delegation: t } })} />
      <TierSelect label="Direct OS tool & MCP execution" hint="Weather, time, fetch, git, knowledge graph, your added MCP servers" value={p.mcp} onChange={(t) => save({ permissions: { mcp: t } })} />
      <TierSelect label="Local filesystem read" hint={`Only inside: ${cfg.fsRoots.join(", ")} + this project. Secrets (.env, keys) are never read.`} value={p.filesystem} onChange={(t) => save({ permissions: { filesystem: t } })} />
      <TierSelect label="External cloud / droplet routing" hint="Cloud models, droplet, Overseer, remote memory mounts" value={p.cloud} onChange={(t) => save({ permissions: { cloud: t } })} />
      <Field label="Filesystem roots (comma-separated)" className="mt-2">
        <BlurInput value={cfg.fsRoots.join(", ")} onSave={(v) => save({ fsRoots: v.split(",").map((x) => x.trim()).filter(Boolean) })} className="font-mono !text-[12px]" />
      </Field>
      <CfgError error={error} />
    </Card>
  );
}

// ── Privacy shield ──────────────────────────────────────────────────────────

export function PrivacyShieldCard() {
  const { cfg, error, save } = useOsCfg();
  const [last, setLast] = useState<RedactionRecord | null | undefined>(undefined);
  const [test, setTest] = useState("Email maria@acme.ca or call 416-555-0199 about the $1,250 deposit at 22 Queen St W.");
  const [preview, setPreview] = useState<string | null>(null);
  const [audit, setAudit] = useState<ListenFinding[] | null>(null);
  const [token, setToken] = useState<string | null>(null);
  if (!cfg) return null;
  const p = cfg.privacy;
  return (
    <Card title="Security, privacy & firewall shield" hint="Four switches, plain English. These apply to every path out of this machine: cloud chat, the verifier, the Overseer, the droplet and memory mounts.">
      <Toggle
        on={p.diffuser}
        onChange={(v) => save({ privacy: { diffuser: v } })}
        label="PII & content privacy diffuser"
        hint="Before anything leaves MORTADELLA, emails, phones, addresses, postal codes, dollar figures, keys and your listed client names become [EMAIL_1], [PHONE_1], [AMOUNT_1], [CLIENT_1]… Replies are re-hydrated locally."
      />
      <Field label="Always redact these names / terms (comma-separated)" className="mb-1 ml-12">
        <BlurInput value={p.sensitiveTerms.join(", ")} onSave={(v) => save({ privacy: { sensitiveTerms: v.split(",").map((x) => x.trim()).filter(Boolean) } })} placeholder="Client names, venues, projects…" />
      </Field>
      <div className="mb-2 ml-12 flex flex-wrap gap-2">
        <button className="pill-glass !h-8 text-xs" onClick={() => void cmd("privacy_last_payload").then(setLast)}>
          <Eye size={13} /> View last redacted payload
        </button>
        <input value={test} onChange={(e) => setTest(e.target.value)} className="field !h-8 min-w-0 flex-1 !py-1 !text-[12px]" aria-label="Diffuser test text" />
        <button className="pill-glass !h-8 text-xs" onClick={() => void cmd("privacy_preview", { text: test }).then((r) => setPreview(r.redacted))}>
          Test
        </button>
      </div>
      {preview && <p className="well mb-2 ml-12 rounded-[10px] px-3 py-2 font-mono text-[11px] text-teal">{preview}</p>}

      <Toggle
        on={p.networkLock}
        onChange={(v) => save({ privacy: { networkLock: v } })}
        label="NetBird / localhost zero-trust network lock"
        hint="The gateway accepts the desktop on 127.0.0.1 freely; anything else (your phone over NetBird) must present the gateway bearer token. Gateway and droplet calls carry it too."
      />
      <div className="mb-2 ml-12 flex flex-wrap gap-2">
        <button className="pill-glass !h-8 text-xs" onClick={() => void cmd("network_audit").then(setAudit)}>
          <Network size={13} /> Audit listening ports
        </button>
        <button className="pill-glass !h-8 text-xs" onClick={() => void cmd("gateway_token_rotate").then(setToken)}>
          <RotateCw size={13} /> New phone token
        </button>
      </div>
      {token && (
        <p className="well mb-2 ml-12 break-all rounded-[10px] px-3 py-2 text-xs text-ink-2">
          Type this into the phone's Settings → Gateway token (shown once): <span className="font-mono text-amber-light">{token}</span>
        </p>
      )}
      {audit && (
        <ul className="mb-2 ml-12 space-y-1">
          {audit.map((a) => (
            <li key={a.port} className="text-xs">
              <span className={a.exposed ? "text-alert" : "text-teal"}>{a.exposed ? "EXPOSED" : "local"}</span> <span className="font-mono text-ink">:{a.port}</span> <span className="text-ink-2">{a.service}</span>{" "}
              <span className="font-mono text-ink-3">{a.bind}</span>
              {a.fix && <span className="block text-ink-3">↳ {a.fix}</span>}
            </li>
          ))}
        </ul>
      )}

      <Toggle on={p.killSwitch} onChange={(v) => save({ privacy: { killSwitch: v } })} tone="alert" label="Outbound cloud kill switch (instant local lockdown)" hint="Severs cloud models, the verifier/Overseer, the droplet, ElevenLabs (speech falls back to Kokoro) and web fetch/search. Also in the top bar." />
      <Toggle
        on={p.destructiveGate}
        onChange={(v) => save({ privacy: { destructiveGate: v } })}
        label="Destructive action confirmation gate"
        hint="Wiping remote memory and similar destructive steps wait for the confirmation card. (Sending, booking, paying and deleting always confirm — that gate can't be turned off.)"
      />
      <CfgError error={error} />
      {last !== undefined && <PayloadModal record={last} onClose={() => setLast(undefined)} />}
    </Card>
  );
}

function PayloadModal({ record, onClose }: { record: RedactionRecord | null; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Last redacted payload" onClick={onClose}>
      <div className="glass max-h-[85vh] w-full max-w-3xl overflow-y-auto rounded-[20px] p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center gap-2">
          <h2 className="label-caps text-amber-soft">What last left this machine</h2>
          <button onClick={onClose} aria-label="Close" className="ml-auto text-ink-2 hover:text-ink">
            <X size={16} />
          </button>
        </div>
        {!record ? (
          <p className="text-sm text-ink-2">Nothing has been sent out through the diffuser since the app started.</p>
        ) : (
          <>
            <p className="mb-2 text-xs text-ink-3">
              To <span className="font-mono text-ink">{record.destination}</span> · {new Date(record.at * 1000).toLocaleString()}
            </p>
            {record.replacements.length > 0 && (
              <table className="mb-3 w-full text-xs">
                <tbody>
                  {record.replacements.map((r) => (
                    <tr key={r.token} className="border-b border-white/5">
                      <td className="py-1 font-mono text-teal">{r.token}</td>
                      <td className="py-1 text-ink-2">{r.original}</td>
                      <td className="py-1 text-right text-ink-3">stayed local</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {record.payload.map((m, i) => (
              <div key={i} className="mb-2">
                <p className="label-caps text-ink-3">{m.role}</p>
                <pre className="well whitespace-pre-wrap rounded-[10px] p-2 text-[11px] text-ink-2">{m.content.slice(0, 6000)}</pre>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

// ── Overseer ────────────────────────────────────────────────────────────────

const ENGINES: [OverseerEngine, string][] = [
  ["claude-cli", "Claude Code (CLI — your Claude subscription)"],
  ["claude-api", "Claude (API key)"],
  ["gemini-cli", "Gemini (CLI)"],
  ["gemini-api", "Gemini (API key)"],
  ["droplet", "Remote droplet model"],
  ["local", "Local secondary model (verifier)"],
];

export function OverseerCard() {
  const { cfg, error, save } = useOsCfg();
  const [probe, setProbe] = useState<string | null>(null);
  if (!cfg) return null;
  const o = cfg.overseer;
  return (
    <Card
      title="Overseer escalation"
      hint={`“Ask Overseer” on any message sends that exchange (privacy-diffused) for a second opinion. Claude API calls use ${o.claudeModel} with server-side refusal fallbacks enabled.`}
      action={
        <button
          className="pill-glass !h-8 text-xs"
          onClick={() => {
            setProbe("…");
            void cmd("overseer_ask", { req: { question: "Reply with exactly: overseer online", transcript: [], context: "" } })
              .then((r) => setProbe(`✓ ${r.engine} · ${r.latencyMs}ms · “${r.answer.slice(0, 40)}”`))
              .catch((e) => setProbe(`✗ ${String(e).slice(0, 160)}`));
          }}
        >
          <PlugZap size={13} /> Test
        </button>
      }
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Engine" className="sm:col-span-3">
          <Select value={o.engine} onChange={(e) => save({ overseer: { engine: e.target.value as OverseerEngine } })}>
            {ENGINES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Claude model">
          <BlurInput value={o.claudeModel} onSave={(v) => save({ overseer: { claudeModel: v } })} className="font-mono !text-[12px]" />
        </Field>
        <Field label="Gemini model">
          <BlurInput value={o.geminiModel} onSave={(v) => save({ overseer: { geminiModel: v } })} className="font-mono !text-[12px]" />
        </Field>
      </div>
      {probe && <p className={`mt-2 font-mono text-[11px] ${probe.startsWith("✓") ? "text-teal" : "text-ink-2"}`}>{probe}</p>}
      <div className="mt-2">
        <Toggle on={o.autoEscalate} onChange={(v) => save({ overseer: { autoEscalate: v } })} label="Auto-escalate when the local chain fails" />
        <Toggle on={o.manualMode} onChange={(v) => save({ overseer: { manualMode: v } })} label="Manual Overseer Mode" hint="Every confirmation card also gets an Overseer review while you decide." />
      </div>
      <SecretRow name="anthropic" label="Anthropic API key" hint="ANTHROPIC_API_KEY (environment or repo-root .env) takes priority over the keychain." />
      <SecretRow name="gemini" label="Gemini API key" hint="GEMINI_API_KEY (environment or repo-root .env) takes priority over the keychain." />
      <CfgError error={error} />
    </Card>
  );
}

export function MarketDataCard() {
  return (
    <Card title="Market data" hint="Candles load straight from Yahoo Finance on the desktop (no key). Add a free Twelve Data key as an automatic fallback when Yahoo rate-limits. Research only — no broker connection.">
      <SecretRow name="twelvedata" label="Twelve Data API key" hint="TWELVEDATA_API_KEY (environment or repo-root .env) takes priority over the keychain." />
    </Card>
  );
}
