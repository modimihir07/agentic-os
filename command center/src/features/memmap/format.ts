import type { BusStatus, DevTask, DevTaskCategory, DevTaskPriority, DevTaskStatus, OsConfig, OsKeyStatus, OsSecret, SnapAgent, SnapBus, SnapLoop, SnapStore, SystemSnapshot, TraceStep } from "@/lib/platform";
import type { VoiceState } from "@/features/voice/voice-store";

/**
 * System Map: pure formatting and state helpers (no stores, no DOM), unit-tested in
 * format.test.ts. Every value here comes from a live source; `null` means "no source",
 * which the UI shows as "—" with a tooltip saying why.
 */

export const DASH = "—";

/**
 * Frame gate for a capped rAF loop: due on the first frame, then once `frameMs` has passed,
 * with `slackMs` of tolerance for vsync jitter and coarsened timestamps. Without it, two 60 Hz
 * vsyncs (≈33.3 ms, often measured as 33.3) fall just under a 33.33 ms cap and get skipped,
 * so a 30 fps loop wobbles between 30 and 20 fps.
 */
export function frameDue(now: number, last: number, frameMs: number, slackMs = 4): boolean {
  return !last || now - last >= frameMs - slackMs;
}

/** "3d 04h", "4h 12m", "12m 05s", "45s". Null / negative → null. */
export function fmtUptime(secs: number | null | undefined): string | null {
  if (secs == null || !Number.isFinite(secs) || secs < 0) return null;
  const s = Math.floor(secs);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (d > 0) return `${d}d ${pad(h)}h`;
  if (h > 0) return `${h}h ${pad(m)}m`;
  if (m > 0) return `${m}m ${pad(s % 60)}s`;
  return `${s}s`;
}

/** "840 ms", "1.2 s", "12 s". */
export function fmtMs(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 1000)} s`;
}

/** MiB → "11.8 GB" / "512 MB". */
export function fmtMb(mb: number | null | undefined): string | null {
  if (mb == null || !Number.isFinite(mb) || mb < 0) return null;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/** Bytes → "1.2 MB" / "820 KB" / "96 B". */
export function fmtBytes(b: number | null | undefined): string | null {
  if (b == null || !Number.isFinite(b) || b < 0) return null;
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${Math.round(b / 1024)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

/** used / total as 0–100, or null when either side is missing or total is 0. */
export function pct(used: number | null | undefined, total: number | null | undefined): number | null {
  if (used == null || total == null || !Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
  return Math.max(0, Math.min(100, (used / total) * 100));
}

/** "14:02:07" (local time). */
export function fmtClock(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** "now", "12s ago", "4m ago", "3h ago", "2d ago". */
export function fmtAgo(at: number | null | undefined, now: number): string | null {
  if (at == null || !Number.isFinite(at)) return null;
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

// ── Agents ──────────────────────────────────────────────────────────────────

/**
 * Mirror of Rust `introspect::role_active`: is the agent on `slug` holding the GPU slot?
 * Labels look like "anythingllm · coder", "anythingllm · coder (streaming)" or, for
 * Tony's own turns, "lmstudio · Tony". Lets `gpu-slot` events update the roster live.
 */
export function roleActive(labels: readonly string[], slug: string, isTony: boolean): boolean {
  return labels.some((l) => {
    const i = l.lastIndexOf(" · ");
    if (i < 0) return false;
    const who = l.slice(i + 3).split(" (")[0].trim();
    return (!!slug && who === slug) || (isTony && who === "Tony");
  });
}

/** Recompute each agent's `active` flag from fresh slot labels. Same array when nothing changed. */
export function applySlot(agents: SnapAgent[], labels: readonly string[]): SnapAgent[] {
  let changed = false;
  const next = agents.map((a) => {
    const active = roleActive(labels, a.slug, a.role === "general");
    if (active === a.active) return a;
    changed = true;
    return { ...a, active };
  });
  return changed ? next : agents;
}

/** Roster tag: Active (teal) when it holds the slot, Idle (amber) otherwise, Missing when the slug isn't in AnythingLLM. */
export function agentTag(a: SnapAgent): { text: "Active" | "Idle" | "Missing"; tone: "ok" | "idle" | "down" } {
  if (a.active) return { text: "Active", tone: "ok" };
  if (a.found === false) return { text: "Missing", tone: "down" };
  return { text: "Idle", tone: "idle" };
}

// ── Bus (MCP servers & APIs) ────────────────────────────────────────────────

export type Tone = "ok" | "warn" | "down" | "idle";

const BUS_TEXT: Record<BusStatus, string> = {
  ok: "Connected",
  needs_token: "Awaiting token",
  auth_failed: "Auth Failed",
  starting: "Starting…",
  error: "Error",
  off: "Off",
  unknown: DASH,
};
// needs_token is muted (no call is made until a token is added); starting is in progress, not a failure.
const BUS_TONE: Record<BusStatus, Tone> = { ok: "ok", needs_token: "idle", auth_failed: "down", starting: "warn", error: "down", off: "idle", unknown: "idle" };

export function busText(status: string): string {
  return BUS_TEXT[status as BusStatus] ?? status;
}
export function busTone(status: string): Tone {
  return BUS_TONE[status as BusStatus] ?? "idle";
}
/** Does fixing this row mean a trip to Settings (a token, a failing server)? */
export function busNeedsFix(status: string): boolean {
  return status === "needs_token" || status === "auth_failed" || status === "error";
}
/** Tooltip for a bus row: why it looks the way it does (error text only — never a credential). */
export function busWhy(b: SnapBus): string {
  if (b.status === "unknown") return "Not listed in the last 10 minutes — run a deep scan to check it.";
  if (b.status === "off") return "Disabled in Settings → Integrations → MCP registry.";
  const err = b.error ?? (b.lastOk === false ? b.lastError : null);
  if (err) return err;
  if (b.status === "ok") return b.tools != null ? `${b.tools} tools listed` : "Listed OK";
  return busText(b.status);
}
/**
 * The bus card header's fix link: `failing` servers (auth failed, error) make it loud;
 * servers merely awaiting a token keep it muted.
 */
export function busHeaderFix(bus: readonly Pick<SnapBus, "status">[]): { failing: number; awaiting: number } {
  return { failing: bus.filter((b) => b.status === "auth_failed" || b.status === "error").length, awaiting: bus.filter((b) => b.status === "needs_token").length };
}
/** Problems first (auth, errors), then connected, then unknown, then off; stable by name. */
export function sortBus(bus: readonly SnapBus[]): SnapBus[] {
  const rank: Record<string, number> = { auth_failed: 0, error: 1, needs_token: 2, ok: 3, unknown: 4, off: 5 };
  return [...bus].sort((a, b) => (rank[a.status] ?? 4) - (rank[b.status] ?? 4) || a.name.localeCompare(b.name));
}

// ── Stores ──────────────────────────────────────────────────────────────────

/** Each store's share of the total bytes on disk (0–100), null when its size is unknown. */
export function storeShares(stores: readonly SnapStore[]): Map<string, number | null> {
  const total = stores.reduce((n, s) => n + (s.bytes ?? 0), 0);
  return new Map(stores.map((s) => [s.id, s.bytes == null || total <= 0 ? null : (s.bytes / total) * 100]));
}
/** Sum of known table rows, or null when no table could be counted. */
export function storeRows(s: SnapStore): number | null {
  const counted = s.tables.filter((t) => t.rows != null);
  return counted.length ? counted.reduce((n, t) => n + (t.rows ?? 0), 0) : null;
}

// ── Daemon (Rust background loops) ──────────────────────────────────────────

/** How many loops ran on schedule. `null` when none has run since the app started. */
export function daemonState(loops: readonly SnapLoop[]): { healthy: number; ran: number; total: number } | null {
  const ran = loops.filter((l) => l.lastRun != null);
  if (!ran.length) return null;
  return { healthy: ran.filter((l) => !l.overdue && l.lastOk !== false).length, ran: ran.length, total: loops.length };
}

// ── Top bar ─────────────────────────────────────────────────────────────────

/** Gateway round trip from the snapshot's loopback probe: `{ms}` when up, `{why}` otherwise. */
export function gatewayRtt(snap: SystemSnapshot | null): { ms: number } | { why: string } {
  if (!snap) return { why: "No system snapshot yet" };
  const gw = snap.services.find((s) => s.id === "gateway");
  if (!gw) return { why: "The gateway isn't configured" };
  if (!gw.up) return { why: `Gateway down: ${gw.detail || "no answer"}` };
  return { ms: gw.latencyMs };
}

/** A short hardware chip: the GPU name, else the CPU brand (vendor noise trimmed). */
export function hardwareChip(snap: SystemSnapshot | null): string | null {
  const h = snap?.host;
  if (!h) return null;
  const tidy = (s: string) =>
    s
      .replace(/\b(NVIDIA|GeForce|AMD|Intel\(R\)|Core\(TM\)|\(R\)|\(TM\)|Processor|CPU|with Radeon Graphics)\b/gi, "")
      .replace(/\s+\d+-Core\b/i, "")
      .replace(/@.*$/, "")
      .replace(/\s+/g, " ")
      .trim();
  if (h.gpu?.name) return tidy(h.gpu.name);
  if (h.cpuBrand) return tidy(h.cpuBrand);
  return null;
}

// ── Dev task queue ──────────────────────────────────────────────────────────

const CYCLE: Record<DevTaskStatus, DevTaskStatus> = { Pending: "Queued", Queued: "In Progress", "In Progress": "Done", Done: "Pending" };

/** The status pill's click: Pending → Queued → In Progress → Done → Pending. */
export function nextStatus(s: DevTaskStatus): DevTaskStatus {
  return CYCLE[s] ?? "Pending";
}

export function nextPriority(p: DevTaskPriority): DevTaskPriority {
  return ((p + 1) % 4) as DevTaskPriority;
}

export const PRIORITY_LABEL: Record<DevTaskPriority, string> = { 0: "P0 urgent", 1: "P1 high", 2: "P2 normal", 3: "P3 low" };

/** Same order as Rust `dev_task_list`: In Progress, Pending, Queued, Done; then priority; then oldest first. */
export function sortTasks(tasks: readonly DevTask[]): DevTask[] {
  const rank: Record<DevTaskStatus, number> = { "In Progress": 0, Pending: 1, Queued: 2, Done: 3 };
  return [...tasks].sort((a, b) => rank[a.status] - rank[b.status] || a.priority - b.priority || a.createdAt - b.createdAt);
}

/** Replace (or add) one task and keep the list in queue order. */
export function upsertTask(tasks: readonly DevTask[], t: DevTask): DevTask[] {
  return sortTasks([...tasks.filter((x) => x.id !== t.id), t]);
}

export type CategoryFilter = DevTaskCategory | "all";

/** What the dock shows under a filter chip (Done rows only when asked for). */
export function visibleTasks(tasks: readonly DevTask[], filter: CategoryFilter, showDone: boolean): DevTask[] {
  return tasks.filter((t) => (filter === "all" || t.category === filter) && (showDone || t.status !== "Done"));
}

/** Open (not Done) tasks per category, plus "all". */
export function openCounts(tasks: readonly DevTask[]): Record<CategoryFilter, number> {
  const out: Record<CategoryFilter, number> = { all: 0, mcp: 0, auth: 0, ui: 0, backend: 0, routing: 0 };
  for (const t of tasks) {
    if (t.status === "Done") continue;
    out.all++;
    out[t.category]++;
  }
  return out;
}

/** The Export Session Brief button. */
export function briefButtonState(o: { desktop: boolean; exporting: boolean; open: number }): { label: string; disabled: boolean; title: string } {
  if (!o.desktop) return { label: "Export Session Brief", disabled: true, title: "The dev queue lives in the desktop app" };
  if (o.exporting) return { label: "Exporting…", disabled: true, title: "Writing memory/session_handoffs/…" };
  const what = o.open ? `${o.open} open task${o.open === 1 ? "" : "s"}` : "no open tasks";
  return { label: "Export Session Brief", disabled: false, title: `Write a handoff brief (${what}, connector diagnostics, git state) to memory/session_handoffs/ and copy it` };
}

/** A dev-task title from free text: the first non-empty line, trimmed and capped. The rest becomes the body. */
export function splitNote(text: string, max = 200): { title: string; body: string } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const first = lines.findIndex((l) => l.trim());
  if (first < 0) return { title: "", body: "" };
  const line = lines[first].trim();
  const rest = lines.slice(first + 1).join("\n").trim();
  if (line.length <= max) return { title: line, body: rest };
  // A long single line: cut the title at a word boundary and keep the whole text as the body.
  const cut = line.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return { title: `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).trim()}…`, body: text.trim() };
}

/** Title for a failing trace step queued as a fix. */
export function fixTitle(step: { hop: string; label: string }): string {
  return `Fix ${step.hop}: ${step.label || "failed step"}`.slice(0, 200);
}

// ── Trace / dictation ───────────────────────────────────────────────────────

/** The newest model step's tokens/s, if any turn measured it. */
export function latestTps(steps: readonly TraceStep[]): number | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    const t = steps[i].tps;
    if (steps[i].hop === "model" && t != null) return t;
  }
  return null;
}

export type DictPhase = "idle" | "waiting" | "speech" | "transcribing";

/** Map the note bar's dictation phase onto the voice states `toggleAction` knows. */
export function dictVoiceState(p: DictPhase): VoiceState {
  return p === "transcribing" ? "transcribing" : p === "idle" ? "idle" : "listening";
}

/** Tony's mic is open (or about to transcribe): dictation must not compete for it. */
export const tonyMicBusy = (s: VoiceState) => s === "listening" || s === "transcribing";

/** The hop to flag as slowest in Dev X-Ray: the longest real hop. `ui` (end-to-end turn time)
 * and `input` (a marker) never count; null when fewer than two hops took measurable time. */
export function slowestHop(steps: readonly TraceStep[]): TraceStep | null {
  const timed = steps.filter((s) => s.hop !== "ui" && s.hop !== "input" && s.ms > 0);
  if (timed.length < 2) return null;
  return timed.reduce((m, s) => (s.ms > m.ms ? s : m));
}

// ── Future runs (the dock's Scheduled tab) ──────────────────────────────────

export interface FutureRun {
  key: string;
  kind: "job" | "loop" | "n8n" | "slot";
  label: string;
  /** Unix ms it is next due; null = no schedule known (event-driven, or never ran). */
  due: number | null;
  overdue: boolean;
  detail: string;
}

/**
 * What the OS will run next, from the snapshot only: gateway scheduler jobs (enabled, with a
 * next run), the Rust background loops (last run + interval), active n8n workflows and the
 * GPU slot's queue. Sorted by due time, unknown last. `notes` say why a source is missing.
 */
export function futureRuns(snap: SystemSnapshot | null, now: number): { runs: FutureRun[]; notes: string[] } {
  if (!snap) return { runs: [], notes: [] };
  const r = snap.routines;
  const runs: FutureRun[] = [];
  const notes: string[] = [];

  if (r.schedulerJobs == null) notes.push(r.schedulerNote ?? "The gateway scheduler didn't answer");
  for (const [i, j] of (r.schedulerJobs ?? []).entries()) {
    if (!j.enabled || !j.nextRun) continue;
    const t = Date.parse(j.nextRun);
    const due = Number.isFinite(t) ? t : null;
    runs.push({
      key: `job:${j.id ?? i}`,
      kind: "job",
      label: j.name ?? j.skill ?? j.id ?? "Scheduled job",
      due,
      overdue: due != null && due < now,
      detail: [j.skill && `skill ${j.skill}`, j.cron && `cron ${j.cron}`, due == null && `next ${j.nextRun}`].filter(Boolean).join(" · ") || "gateway scheduler",
    });
  }

  for (const l of r.loops) {
    const iv = l.intervalSecs * 1000;
    let due: number | null = null;
    if (l.lastRun != null && iv > 0) {
      due = l.lastRun + iv;
      // A healthy loop seen through a stale snapshot (10 s poll + 10 s Rust cache) is not late:
      // roll forward to its next expected pass. Overdue is Rust's verdict alone (3 intervals + 10 s grace).
      if (!l.overdue && due < now) due = l.lastRun + Math.ceil((now - l.lastRun) / iv) * iv;
    }
    runs.push({
      key: `loop:${l.id}`,
      kind: "loop",
      label: l.label,
      due,
      overdue: l.overdue,
      detail: `every ${fmtUptime(l.intervalSecs) ?? `${l.intervalSecs}s`}${l.lastRun == null ? " · not run yet" : l.lastOk === false ? ` · last run failed${l.detail ? `: ${l.detail}` : ""}` : ""}`,
    });
  }

  if (r.n8nNote) notes.push(r.n8nNote);
  for (const inst of r.n8n)
    for (const [j, w] of inst.workflows.entries())
      // n8n allows duplicate workflow names: key by id, else by position.
      if (w.active) runs.push({ key: `n8n:${inst.id}:${w.id ?? `#${j}`}`, kind: "n8n", label: w.name, due: null, overdue: false, detail: `${inst.label} · active${w.lastStatus ? ` · last ${w.lastStatus}` : ""}` });

  const fg = snap.slot.queuedForeground;
  const bg = snap.slot.queuedBackground;
  if (fg + bg > 0) runs.push({ key: "slot", kind: "slot", label: "GPU slot queue", due: null, overdue: false, detail: `${fg} foreground · ${bg} background waiting (capacity ${snap.slot.capacity})` });

  runs.sort((a, b) => (a.due == null ? 1 : 0) - (b.due == null ? 1 : 0) || (a.due ?? 0) - (b.due ?? 0) || a.label.localeCompare(b.label));
  return { runs, notes };
}

/** "in 4m", "in 2h", "now", or fmtAgo-style "overdue 3m". */
export function fmtDue(due: number | null, now: number): string | null {
  if (due == null || !Number.isFinite(due)) return null;
  const s = Math.round((due - now) / 1000);
  if (s < -4) return `overdue ${(fmtAgo(due, now) ?? "").replace(" ago", "")}`;
  if (s < 5) return "now";
  if (s < 60) return `in ${s}s`;
  if (s < 3600) return `in ${Math.floor(s / 60)}m`;
  if (s < 86_400) return `in ${Math.floor(s / 3600)}h`;
  return `in ${Math.floor(s / 86_400)}d`;
}

// ── Active API keys (presence only) ─────────────────────────────────────────

export interface KeyPresence {
  /** Service name (never a key value). */
  name: string;
  /** true = a credential is configured; false = none; null = no presence source here. */
  present: boolean | null;
  /** Where presence was read from ("env", "keychain", ...) or why it is unknown. */
  via: string;
}

/** OS secrets (env / .env / keychain) that aren't covered by a bus credential source. */
const SECRET_SERVICES: [OsSecret, string][] = [
  ["anthropic", "Anthropic"],
  ["gemini", "Gemini"],
  ["twelvedata", "Twelve Data"],
  ["anythingllm-remote", "AnythingLLM (remote)"],
  ["github-pat", "GitHub"],
  ["sentry-token", "Sentry"],
  ["agentmail-key", "AgentMail"],
  ["vault", "Vault"],
  ["gateway-token", "Gateway token"],
];

/**
 * Which services have a credential, by name only. The bus `source` wins for Brave / Gmail /
 * Spotify; everything else (and Brave / Gmail without a bus source) comes from the shared
 * key-sources store (`os_secret_sources`: process env → repo-root .env → keychain), so a key
 * that lives only in .env counts. ElevenLabs has no presence source on this page. `warn` only
 * when a bus server rejected its token; a server merely awaiting one (needs_token) is muted.
 */
export function apiKeyPresence(bus: readonly SnapBus[] | null, sources: Partial<Record<OsSecret, OsKeyStatus>> | null): { keys: KeyPresence[]; active: number; known: number; warn: boolean } {
  const b = (id: string) => bus?.find((x) => x.id === id);
  const st = (n: OsSecret) => sources?.[n];
  const fromBus = (id: string, isSet: (src: string) => boolean, fallback: OsSecret[]): Pick<KeyPresence, "present" | "via"> => {
    const src = b(id)?.source;
    if (src) return { present: isSet(src), via: src };
    if (sources && fallback.length) {
      const ss = fallback.map(st);
      if (!ss.every(Boolean)) return { present: null, via: "not reported" };
      if (ss.some((s) => s!.pairIncomplete)) return { present: false, via: "pair incomplete" };
      const present = ss.every((s) => s!.source !== "missing");
      return { present, via: present ? ss[0]!.source : "not set" };
    }
    return { present: null, via: bus ? `${id} reports no key source` : "No system snapshot yet" };
  };
  const keys: KeyPresence[] = [
    { name: "Brave Search", ...fromBus("brave-search", (s) => s === "env" || s === "keychain", ["brave"]) },
    { name: "Gmail", ...fromBus("gmail", (s) => s !== "none", ["gmail-script-id", "gmail-script-key"]) },
    // The Spotify refresh token is an internal secret (not in os_secret_sources): bus source only.
    { name: "Spotify", ...fromBus("spotify", (s) => s !== "none", []) },
    ...SECRET_SERVICES.map(([id, name]): KeyPresence => {
      const s = st(id);
      if (s) return { name, present: s.source !== "missing", via: s.source === "missing" ? "not set" : s.source };
      return { name, present: null, via: sources ? "not reported" : "Key status unavailable" };
    }),
    { name: "ElevenLabs", present: null, via: "No presence source on this page" },
  ];
  const warn = !!bus?.some((x) => x.status === "auth_failed");
  return { keys, active: keys.filter((k) => k.present === true).length, known: keys.filter((k) => k.present != null).length, warn };
}

// ── In-page os.json switches ────────────────────────────────────────────────

/**
 * Why an in-page switch must not write, judged against the live os.json re-read just before
 * the write (null = OK). os.json can change outside this page (the phone's compute-mode
 * command goes straight to Rust), so a toggle built on the cached config could otherwise
 * silently move the OS out of cloud mode or past a delegation deny.
 */
export function osSwitchBlock(kind: "delegation" | "overload", fresh: Pick<OsConfig, "permissions" | "compute"> | null): string | null {
  if (!fresh) return "Couldn't re-read os.json, so nothing was changed.";
  if (kind === "overload" && fresh.compute.mode === "cloud") return "Compute mode is now cloud (changed elsewhere), so nothing was changed.";
  if (kind === "delegation" && fresh.permissions.delegation === "deny") return "Delegation is now deny (changed elsewhere), so nothing was changed.";
  return null;
}
