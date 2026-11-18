import { useCallback, useEffect, useMemo, useState } from "react";
import { Cloud, FolderOpen, KeyRound, Loader2, Plus, RefreshCw, Trash2, Wrench, X } from "lucide-react";
import { Card, Field, Input, Select } from "@/components/ui";
import { cmd, type AllmSyncReport, type McpServer, type ServerTools, type SkillInfo } from "@/lib/platform";
import { SUB_AGENT_IDS, roleLabel, toggleGrant } from "@/features/dispatcher/roles";
import { CfgError, SecretRow, useOsCfg } from "./os-ui";
import { useOnIntegrationsChanged } from "@/features/integrations/changed";
import { useSpotifyAuthRefresh } from "@/features/integrations/spotify-connect";

/** Every id a skill or MCP server's "All" pill stands in for. Skills also
 * accept the special "claude" grant (the Overseer), which isn't one of the
 * 7 OS agent roles and so isn't covered by "all". */
const ALL_AGENT_IDS = ["tony", ...SUB_AGENT_IDS] as const;

const AGENTS: [string, string][] = [
  ["all", "All"],
  ["tony", "OS"],
  ...SUB_AGENT_IDS.map((id): [string, string] => [id, roleLabel(id)]),
  ["claude", "Claude"],
];

/**
 * Russian-doll skill pool: one folder of skills (C:\ai-hub\skills by default),
 * attached per agent. Attached skills are listed in that agent's prompt; the
 * OS can also open a skill's full SKILL.md with its skills.read tool.
 */
export function SkillsLibraryCard() {
  const { cfg, error, save } = useOsCfg();
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [onlyAttached, setOnlyAttached] = useState(false);
  const scan = () => void cmd("skills_scan").then((s) => (setSkills(s), setErr(null))).catch((e) => (setSkills([]), setErr(String(e))));
  useEffect(scan, [cfg?.skills.dir]); // eslint-disable-line react-hooks/exhaustive-deps
  const grants = cfg?.skills.grants ?? {};
  const list = useMemo(
    () =>
      (skills ?? []).filter((s) => (!q || `${s.name} ${s.description}`.toLowerCase().includes(q.toLowerCase())) && (!onlyAttached || (grants[s.name]?.length ?? 0) > 0)),
    [skills, q, onlyAttached, grants],
  );
  if (!cfg) return null;
  const toggle = (skill: string, agent: string) => {
    const cur = grants[skill] ?? [];
    const next = toggleGrant(cur, agent, ALL_AGENT_IDS);
    const g = { ...grants, [skill]: next };
    if (!next.length) delete g[skill];
    save({ skills: { grants: g } });
  };
  // "all" covers every one of the 7 OS agent roles, but never the separate "claude" (Overseer) grant.
  const has = (list: string[], agent: string) => list.includes(agent) || (agent !== "claude" && list.includes("all"));
  const count = (agent: string) => Object.values(grants).filter((a) => has(a, agent)).length;

  return (
    <Card
      title="OS skills & MCP library — skills pool"
      hint={`Attach or detach any skill for ${cfg.osName}, each AnythingLLM sub-agent, or the Claude Overseer. Attached skills ride along in that agent's prompt.`}
      action={
        <button onClick={scan} className="pill-glass !h-8 text-xs">
          <RefreshCw size={13} /> Rescan
        </button>
      }
    >
      <div className="flex flex-wrap gap-2">
        <div className="flex min-w-[260px] flex-1 gap-1.5">
          <FolderOpen size={16} className="mt-3 shrink-0 text-ink-3" />
          <Input key={cfg.skills.dir} defaultValue={cfg.skills.dir} onBlur={(e) => e.target.value.trim() !== cfg.skills.dir && save({ skills: { dir: e.target.value.trim() } })} className="font-mono !text-[12px]" aria-label="Skills folder" spellCheck={false} />
        </div>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter skills…" className="!w-48" aria-label="Filter skills" />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-3">
        {AGENTS.map(([id, label]) => (
          <span key={id} className="rounded-full border border-white/10 px-2 py-0.5">
            {id === "tony" ? cfg.osName : label}: <span className="font-mono text-ink">{count(id)}</span>
          </span>
        ))}
        <label className="ml-auto flex items-center gap-1.5">
          <input type="checkbox" checked={onlyAttached} onChange={(e) => setOnlyAttached(e.target.checked)} className="accent-teal" /> attached only
        </label>
      </div>
      {err && <p className="mt-2 text-xs text-alert">{err}</p>}
      {!skills && <p className="mt-3 flex items-center gap-2 text-xs text-ink-3"><Loader2 size={13} className="animate-spin" /> Scanning…</p>}
      <ul className="mt-3 max-h-[420px] space-y-1.5 overflow-y-auto pr-1">
        {list.map((s) => {
          const on = grants[s.name] ?? [];
          return (
            <li key={s.path} className="rounded-[12px] border border-white/[0.06] bg-white/[0.02] px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[13px] text-ink">{s.name}</span>
                <span className="label-caps text-ink-3">{s.kind}</span>
                <div className="ml-auto flex flex-wrap gap-1">
                  {AGENTS.map(([id, label]) => {
                    const active = has(on, id);
                    return (
                      <button
                        key={id}
                        aria-pressed={active}
                        onClick={() => toggle(s.name, id)}
                        className={`h-6 rounded-full border px-2 text-[11px] transition-colors ${active ? "border-teal/60 bg-teal/15 text-teal" : "border-white/10 text-ink-3 hover:text-ink"}`}
                        title={`${active ? "Detach from" : "Attach to"} ${id === "tony" ? cfg.osName : label}`}
                      >
                        {id === "tony" ? cfg.osName : label}
                      </button>
                    );
                  })}
                </div>
              </div>
              {s.description && <p className="mt-0.5 line-clamp-2 text-xs text-ink-3">{s.description}</p>}
            </li>
          );
        })}
        {skills && !list.length && !err && <li className="py-3 text-center text-xs text-ink-3">No skills match.</li>}
      </ul>
      <CfgError error={error} />
    </Card>
  );
}

const BLANK: McpServer = { id: "", name: "", transport: "stdio", command: "npx", args: [], env: {}, url: "", enabled: true, builtin: false, description: "", agents: null };

/** Does this server's grant list cover `agent`? Mirrors `McpServer::grants` in os_core.rs:
 * missing/empty/containing "all" = every agent. */
function mcpGrants(agents: string[] | null | undefined, agent: string): boolean {
  if (!agents || agents.length === 0) return true;
  return agents.includes("all") || agents.includes(agent);
}

export function McpRegistryCard() {
  const { cfg, error, save } = useOsCfg();
  const [tools, setTools] = useState<ServerTools[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [testOut, setTestOut] = useState<Record<string, string>>({});
  const [configuring, setConfiguring] = useState<string | null>(null);
  const [sync, setSync] = useState<{ loading: boolean; report: AllmSyncReport | null; err: string | null }>({ loading: false, report: null, err: null });
  const reloadOnAuth = useCallback(() => load(), []); // eslint-disable-line react-hooks/exhaustive-deps
  const load = (refresh = false) => {
    setLoading(true);
    void cmd("mcp_list_tools", { refresh })
      .then(setTools)
      .catch(() => setTools(null))
      .finally(() => setLoading(false));
  };
  useEffect(() => load(), [cfg?.mcps.map((m) => `${m.id}:${m.enabled}`).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  // A key saved, Gmail imported or Spotify (dis)connected changes the builtins' status too.
  useOnIntegrationsChanged(() => load());
  useSpotifyAuthRefresh(reloadOnAuth);
  const syncAllm = () => {
    setSync((s) => ({ ...s, loading: true, err: null }));
    void cmd("mcp_sync_anythingllm")
      .then((report) => setSync({ loading: false, report, err: null }))
      .catch((e) => setSync({ loading: false, report: null, err: String(e) }));
  };
  if (!cfg) return null;
  const setMcps = (mcps: McpServer[]) => {
    save({ mcps });
    // Best-effort: keep AnythingLLM's own MCP file in step whenever the
    // registry changes (new server, toggled on/off, grants edited). The
    // explicit button below covers the case where this races the save.
    syncAllm();
  };
  // Tony isn't part of this list at all — he bypasses grants entirely (see
  // `McpServer::grants` in os_core.rs) — so expanding "all" here only ever
  // spells out the 6 sub-agents, never an inert "tony" entry. `null`/missing/
  // empty all mean "all" on the Rust side too, so normalize to an explicit
  // `["all"]` before toggling — otherwise clicking one specific pill from an
  // unrestricted server would (wrongly) read as "restrict to just this one".
  const setGrants = (id: string, agent: string) =>
    setMcps(cfg.mcps.map((x) => (x.id === id ? { ...x, agents: toggleGrant(x.agents && x.agents.length > 0 ? x.agents : ["all"], agent, SUB_AGENT_IDS) } : x)));
  const quick: Record<string, Record<string, unknown>> = { "weather.current": {}, "time.now": {}, "kg.search": { query: "Nic" }, "git.status": { path: cfg.fsRoots[0] ?? "" } };

  return (
    <Card
      title={`${cfg.osName}'s MCP registry`}
      hint="The OS's own tools. Built-ins run natively in Rust (no process to spawn); add any stdio or HTTP MCP server and its tools appear here and become available to the OS. Pills choose which agents may use each server's tools (Tony always has every one); tools themselves are read-only from the model's side."
      action={
        <>
          <button onClick={() => load(true)} className="pill-glass !h-8 text-xs" disabled={loading}>
            {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Reload tools
          </button>
          <button onClick={syncAllm} className="pill-glass !h-8 text-xs" disabled={sync.loading} title="Add any missing stdio/HTTP servers to AnythingLLM's own MCP config, without touching entries it already has.">
            {sync.loading ? <Loader2 size={13} className="animate-spin" /> : <Cloud size={13} />} Sync to AnythingLLM
          </button>
          <button onClick={() => setAdding(true)} className="pill-primary !h-8 text-xs">
            <Plus size={13} /> Add MCP server
          </button>
        </>
      }
    >
      {(sync.report || sync.err) && (
        <p className="mb-2 text-xs text-ink-3">
          {sync.err ? (
            <span className="text-alert">AnythingLLM sync failed: {sync.err}</span>
          ) : (
            <>
              AnythingLLM sync — added: <span className="font-mono text-teal">{sync.report!.added.join(", ") || "none"}</span>; kept: <span className="font-mono text-ink">{sync.report!.kept.join(", ") || "none"}</span>
              {sync.report!.skipped.length > 0 && (
                <>
                  ; skipped: <span className="font-mono text-ink-3">{sync.report!.skipped.join(", ")}</span>
                </>
              )}
            </>
          )}
        </p>
      )}
      <ul className="space-y-1.5">
        {cfg.mcps.map((m) => {
          const t = tools?.find((x) => x.id === m.id);
          return (
            <li key={m.id} className="rounded-[12px] border border-white/[0.06] bg-white/[0.02] px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  role="switch"
                  aria-checked={m.enabled}
                  aria-label={`${m.enabled ? "Disable" : "Enable"} ${m.name}`}
                  onClick={() => setMcps(cfg.mcps.map((x) => (x.id === m.id ? { ...x, enabled: !x.enabled } : x)))}
                  className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${m.enabled ? "bg-teal/80" : "bg-white/15"}`}
                >
                  <span className={`absolute top-0.5 size-4 rounded-full bg-white shadow transition-[left] duration-200 ${m.enabled ? "left-[18px]" : "left-0.5"}`} />
                </button>
                <span className="text-sm text-ink">{m.name}</span>
                <span className="label-caps text-ink-3">{m.transport}</span>
                {m.enabled && t && <ServerStatus t={t} />}
                {t?.auth && (
                  <button onClick={() => setConfiguring(configuring === m.id ? null : m.id)} className="pill-glass !h-6 !px-2 text-[11px]" aria-expanded={configuring === m.id}>
                    <KeyRound size={11} /> {t.status === "needs_token" ? "Add token" : t.status === "auth_failed" ? "Update token" : "Configure"}
                  </button>
                )}
                {!m.builtin && (
                  <button onClick={() => setMcps(cfg.mcps.filter((x) => x.id !== m.id))} className="ml-auto text-ink-3 hover:text-alert" aria-label={`Remove ${m.name}`}>
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
              {m.description && <p className="mt-0.5 text-xs text-ink-3">{m.description}</p>}
              {t?.auth && configuring === m.id && (
                <div className="well mt-1.5 rounded-[10px] px-2">
                  <SecretRow name={t.auth.secret} label={t.auth.label} hint={`Sent only to ${m.url ? new URL(m.url).host : "this server"}. ${t.auth.env} in the repo-root .env takes priority over this keychain value.`} onChange={() => load(true)} />
                </div>
              )}
              {m.transport !== "builtin" && <p className="mt-0.5 truncate font-mono text-[11px] text-ink-3">{m.transport === "http" ? m.url : `${m.command} ${m.args.join(" ")}`}</p>}
              <div className="mt-1.5 flex flex-wrap gap-1">
                {AGENTS.filter(([id]) => id !== "claude").map(([id, label]) => {
                  const isTony = id === "tony";
                  const active = isTony || mcpGrants(m.agents, id);
                  return (
                    <button
                      key={id}
                      aria-pressed={active}
                      disabled={isTony}
                      onClick={() => !isTony && setGrants(m.id, id)}
                      className={`h-6 rounded-full border px-2 text-[11px] transition-colors ${active ? "border-teal/60 bg-teal/15 text-teal" : "border-white/10 text-ink-3 hover:text-ink"} ${isTony ? "cursor-default opacity-80" : ""}`}
                      title={isTony ? `${cfg.osName} has full access` : `${active ? "Revoke from" : "Grant to"} ${id === "all" ? "every agent" : label}`}
                    >
                      {id === "tony" ? cfg.osName : label}
                    </button>
                  );
                })}
              </div>
              {m.enabled && t?.ok && t.tools.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {t.tools.map((tool) => (
                    <button
                      key={tool.name}
                      title={`${tool.description}${quick[tool.name] ? " — click to test" : ""}`}
                      onClick={() =>
                        quick[tool.name] &&
                        void cmd("mcp_call", { name: tool.name, args: quick[tool.name] })
                          .then((o) => setTestOut((s) => ({ ...s, [m.id]: o.slice(0, 600) })))
                          .catch((e) => setTestOut((s) => ({ ...s, [m.id]: `✗ ${e}` })))
                      }
                      className="flex items-center gap-1 rounded-full border border-white/10 px-2 py-0.5 font-mono text-[10px] text-ink-2 hover:text-ink"
                    >
                      <Wrench size={10} /> {tool.name}
                    </button>
                  ))}
                </div>
              )}
              {testOut[m.id] && <pre className="well mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded-[8px] p-2 text-[11px] text-ink-2">{testOut[m.id]}</pre>}
            </li>
          );
        })}
      </ul>
      <SecretRow name="brave" label="Brave Search API key" hint="Needed by the Brave Search built-in." />
      <CfgError error={error} />
      {adding && <AddMcp existing={cfg.mcps.map((m) => m.id)} onCancel={() => setAdding(false)} onAdd={(m) => (setMcps([...cfg.mcps, m]), setAdding(false))} />}
    </Card>
  );
}

function AddMcp({ existing, onAdd, onCancel }: { existing: string[]; onAdd: (m: McpServer) => void; onCancel: () => void }) {
  const [m, setM] = useState<McpServer>(BLANK);
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const submit = () => {
    const id = (m.id || m.name).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
    if (!id || !m.name.trim()) return setErr("Give it a name.");
    if (existing.includes(id)) return setErr(`An MCP with id “${id}” already exists.`);
    if (m.transport === "stdio" && !m.command.trim()) return setErr("stdio servers need a command.");
    if (m.transport === "http" && !/^https?:\/\//.test(m.url)) return setErr("HTTP servers need an http(s) URL.");
    const envMap = Object.fromEntries(
      env
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.includes("="))
        .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
    );
    onAdd({ ...m, id, name: m.name.trim(), args: args.match(/"[^"]*"|\S+/g)?.map((a) => a.replace(/^"|"$/g, "")) ?? [], env: envMap, builtin: false });
  };
  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Add MCP server" onClick={onCancel}>
      <div className="glass w-full max-w-xl rounded-[20px] p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center">
          <h2 className="label-caps text-amber-soft">Add MCP server</h2>
          <button onClick={onCancel} aria-label="Close" className="ml-auto text-ink-2 hover:text-ink">
            <X size={16} />
          </button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <Input value={m.name} onChange={(e) => setM({ ...m, name: e.target.value })} placeholder="Playwright" autoFocus />
          </Field>
          <Field label="Transport">
            <Select value={m.transport} onChange={(e) => setM({ ...m, transport: e.target.value as McpServer["transport"] })}>
              <option value="stdio">stdio (local process)</option>
              <option value="http">HTTP / SSE (streamable)</option>
            </Select>
          </Field>
          {m.transport === "stdio" ? (
            <>
              <Field label="Command">
                <Input value={m.command} onChange={(e) => setM({ ...m, command: e.target.value })} placeholder="npx · uvx · node · python" className="font-mono" />
              </Field>
              <Field label="Args">
                <Input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y @playwright/mcp@latest" className="font-mono" />
              </Field>
            </>
          ) : (
            <Field label="URL" className="sm:col-span-2">
              <Input value={m.url} onChange={(e) => setM({ ...m, url: e.target.value })} placeholder="http://127.0.0.1:9000/mcp" className="font-mono" />
            </Field>
          )}
          <Field label={m.transport === "http" ? "Headers (KEY=value per line)" : "Env vars (KEY=value per line)"} className="sm:col-span-2">
            <textarea value={env} onChange={(e) => setEnv(e.target.value)} rows={3} className="field font-mono !text-[12px]" placeholder="API_KEY=…" />
          </Field>
          <Field label="Description (optional)" className="sm:col-span-2">
            <Input value={m.description} onChange={(e) => setM({ ...m, description: e.target.value })} />
          </Field>
        </div>
        <p className="mt-2 text-xs text-ink-3">Values here are stored in os.json on this machine. The command runs exactly as typed — only add servers you trust.</p>
        {err && <p className="mt-2 text-xs text-alert">{err}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onCancel} className="pill-glass !h-9 text-sm">
            Cancel
          </button>
          <button onClick={submit} className="pill-primary !h-9 text-sm">
            <Plus size={14} /> Add
          </button>
        </div>
      </div>
    </div>
  );
}

/** One server's listing state: tool count, a token to add / update (amber, not an error), or a failure. */
function ServerStatus({ t }: { t: ServerTools }) {
  if (t.ok) return <span className="text-[11px] text-teal">{`${t.tools.length} tool${t.tools.length === 1 ? "" : "s"}`}</span>;
  const text = t.status === "needs_token" ? "needs a token" : t.status === "auth_failed" ? "token rejected — update it" : (t.error ?? "error").slice(0, 80);
  return (
    <span className={`text-[11px] ${t.status === "needs_token" ? "text-amber-light" : "text-alert"}`} title={t.error ?? undefined}>
      {text}
    </span>
  );
}
